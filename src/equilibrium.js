/* ======================================================
   EQUILIBRIUM — simulateur d'équilibrage (Admin → Equilibrium)
   Pour une carte donnée, le bot joue des centaines de parties contre lui-même :
   - « avec » : un deck au hasard qui contient la carte (2 exemplaires, 1 si
     légendaire) contre un deck au hasard ;
   - « sans » : exactement le même deck, où la carte est remplacée par
     d'autres cartes au hasard, contre le même adversaire.
   L'écart de taux de victoire entre les deux mesure l'impact de la carte.
   Les simulations tournent par petits paquets pour ne pas bloquer le serveur.
   ====================================================== */
const game = require('./game');
const bot = require('./bot');
const { analyzeMatch } = require('./deckstats');

const MAX_TURNS = 90;
const R = (a, rng) => a[Math.floor(rng() * a.length)];

function randomDeck(pool, limits, rng, forced) {
  const deck = [], count = {};
  const add = c => { const lim = limits[c.rarity] || 2; if ((count[c.id] || 0) < lim && deck.length < 30) { deck.push(c.id); count[c.id] = (count[c.id] || 0) + 1; return true; } return false; };
  (forced || []).forEach(c => add(c));
  let guard = 0;
  while (deck.length < 30 && guard++ < 5000) add(R(pool, rng));
  return deck;
}

/* Une partie bot contre bot. testSeat = côté du deck testé (on alterne qui commence). */
function playOne(pool, deckA, deckB, testSeat, rng) {
  const decks = testSeat === 0 ? [deckA, deckB] : [deckB, deckA];
  const m = game.createMatch('eq-' + Math.random().toString(36).slice(2, 8),
    { slug: 'p0', pseudo: 'Bot A', deck: decks[0] }, { slug: 'p1', pseudo: 'Bot B', deck: decks[1] });
  m.rng = rng;
  game.submitMulligan(m, 0, []); game.submitMulligan(m, 1, []);
  for (let t = 0; t < MAX_TURNS && m.status === 'active'; t++) {
    const it = bot.botTurnSteps(m, pool, m.turn);
    let guard = 0;
    while (!it.next().done && guard++ < 200) { /* le bot joue tout son tour */ }
    if (m.status === 'active' && guard >= 200) game.endTurn(m);
  }
  return m;
}

function createJob(pool, cardId, games, limits) {
  const card = pool.find(c => c.id === cardId);
  if (!card) return { error: 'Carte introuvable.' };
  const n = Math.max(100, Math.min(5000, Math.round(Number(games) || 1000)));
  const job = { id: 'eq-' + Math.random().toString(36).slice(2, 10), cardId, cardName: card.name, games: n, done: 0, startedAt: Date.now(), finished: false,
    acc: { with: { w: 0, l: 0, d: 0 }, without: { w: 0, l: 0, d: 0 }, played: 0, gamesPlayed: 0, winsWhenPlayed: 0, damage: 0, kills: 0, heal: 0, turnSum: 0, turnN: 0, length: 0 } };
  const others = pool.filter(c => c.id !== cardId);
  const copies = (limits[card.rarity] || 2);
  const rng = Math.random;
  const step = () => {
    const end = Math.min(job.games, job.done + 10);
    for (; job.done < end; job.done++) {
      const seat = job.done % 2; // alterne qui commence
      const deckWith = randomDeck(others, limits, rng, Array(copies).fill(card));
      const deckOpp = randomDeck(pool, limits, rng);
      // même deck, carte remplacée par d'autres au hasard
      const deckWithout = deckWith.filter(id => id !== cardId);
      while (deckWithout.length < 30) { const c = R(others, rng); if (deckWithout.filter(x => x === c.id).length < (limits[c.rarity] || 2)) deckWithout.push(c.id); }
      const a = job.acc;
      const res = (m, slug) => m.winner === slug ? 'w' : m.winner ? 'l' : 'd';
      const m1 = playOne(pool, deckWith, deckOpp, seat, rng);
      const r1 = res(m1, 'p' + seat); a.with[r1]++;
      a.length += m1.turnNumber;
      const rep = analyzeMatch(m1, seat, 'sim');
      const pc = rep.perCard[cardId];
      if (pc && pc.played) {
        a.played += pc.played; a.gamesPlayed++; a.damage += pc.damage; a.kills += pc.kills; a.heal += pc.heal;
        if (r1 === 'w') a.winsWhenPlayed++;
        const firstPlay = (m1.events || []).find(e => e.type === 'play' && e.by === 'p' + seat && e.card && e.card.id === cardId);
        if (firstPlay) { a.turnSum += Math.ceil(firstPlay.turn / 2); a.turnN++; }
      }
      const m2 = playOne(pool, deckWithout, deckOpp, seat, rng);
      a.without[res(m2, 'p' + seat)]++;
    }
    if (job.done < job.games) setImmediate(step);
    else { job.finished = true; job.finishedAt = Date.now(); job.result = summarize(job, card); }
  };
  setImmediate(step);
  return { ok: true, job };
}

function rate(x) { const n = x.w + x.l + x.d; return n ? Math.round(x.w / n * 1000) / 10 : 0; }
function summarize(job, card) {
  const a = job.acc;
  const withRate = rate(a.with), withoutRate = rate(a.without);
  const delta = Math.round((withRate - withoutRate) * 10) / 10;
  const playRate = Math.round(a.gamesPlayed / job.games * 100);
  const winWhenPlayed = a.gamesPlayed ? Math.round(a.winsWhenPlayed / a.gamesPlayed * 1000) / 10 : 0;
  // Marge d'erreur approximative (95 %) sur l'écart, pour ne pas sur-interpréter
  const margin = Math.round(1.96 * Math.sqrt(2 * 0.25 / job.games) * 1000) / 10;
  let verdict = 'balanced', label = 'Équilibrée';
  if (delta >= Math.max(6, margin)) { verdict = 'strong'; label = 'Probablement trop forte'; }
  else if (delta >= Math.max(3, margin * 0.6)) { verdict = 'good'; label = 'Forte (dans la norme haute)'; }
  else if (delta <= -Math.max(6, margin)) { verdict = 'weak'; label = 'Probablement trop faible'; }
  else if (delta <= -Math.max(3, margin * 0.6)) { verdict = 'meh'; label = 'Un peu faible'; }
  if (playRate < 25 && verdict === 'balanced') { verdict = 'unplayed'; label = 'Rarement jouée par le bot : résultat peu fiable'; }
  return {
    cardId: card.id, cardName: card.name, games: job.games,
    withRate, withoutRate, delta, margin, verdict, label,
    playRate, winWhenPlayed,
    damagePerGame: a.gamesPlayed ? Math.round(a.damage / a.gamesPlayed * 10) / 10 : 0,
    killsPerGame: a.gamesPlayed ? Math.round(a.kills / a.gamesPlayed * 10) / 10 : 0,
    healPerGame: a.gamesPlayed ? Math.round(a.heal / a.gamesPlayed * 10) / 10 : 0,
    avgTurnPlayed: a.turnN ? Math.round(a.turnSum / a.turnN * 10) / 10 : null,
    avgLength: Math.round(a.length / job.games / 2 * 10) / 10,
    draws: a.with.d + a.without.d, seconds: Math.round((job.finishedAt - job.startedAt) / 100) / 10
  };
}

module.exports = { createJob, playOne, randomDeck };

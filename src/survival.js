/* ======================================================
   Mode Survie
   - un deck de 30 cartes tiré au hasard au début de la partie, impossible à changer
   - des manches contre le bot, de plus en plus difficiles
   - les PV du héros sont conservés d'une manche à l'autre (+ un petit soin)
   - pause possible entre deux manches (la partie reste enregistrée)
   - une défaite termine la partie ; record = nombre de manches gagnées d'affilée
   ====================================================== */

const DECK_SIZE = 30;
const START_HP = 30;
const HEAL_BETWEEN = 5;       // PV rendus après chaque manche gagnée
const MILESTONE_EVERY = 5;    // petite récompense toutes les 5 manches

/* Difficulté d'une manche : plus de PV et d'armure pour le bot, un meilleur
   deck, puis de la mana en plus dès le départ. */
function roundConfig(round) {
  const n = Math.max(1, Math.round(Number(round) || 1));
  return {
    round: n,
    botHp: Math.min(60, 18 + 3 * n),
    botArmor: Math.min(20, Math.max(0, (n - 3) * 2)),
    botMana: Math.min(3, Math.floor((n - 1) / 4)),
    quality: Math.min(1, (n - 1) * 0.08),
    botName: n >= 15 ? 'Gardien du Néant' : n >= 10 ? 'Champion de la Survie' : n >= 5 ? 'Vétéran de la Survie' : 'Rôdeur de la Survie'
  };
}

/* Deck aléatoire : au moins 15 serviteurs quand c'est possible, limites de copies respectées */
function randomDeck(pool, limits, rng) {
  rng = rng || Math.random;
  const shuffled = pool.slice();
  for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
  const deck = [], count = {};
  const add = c => {
    const lim = (limits && limits[c.rarity]) || 2;
    if ((count[c.id] || 0) >= lim || deck.length >= DECK_SIZE) return false;
    deck.push(c.id); count[c.id] = (count[c.id] || 0) + 1; return true;
  };
  const minions = shuffled.filter(c => c.type === 'minion');
  for (let pass = 0; pass < 2 && deck.filter(id => minions.some(m => m.id === id)).length < 15; pass++) {
    minions.forEach(c => { if (deck.length < 15) add(c); });
  }
  for (let pass = 0; pass < 3 && deck.length < DECK_SIZE; pass++) shuffled.forEach(c => add(c));
  return deck;
}

function ensure(user) {
  const s = user.survival = user.survival && typeof user.survival === 'object' ? user.survival : {};
  if (typeof s.best !== 'number') s.best = 0;
  if (typeof s.runs !== 'number') s.runs = 0;
  if (s.run === undefined) s.run = null;
  return s;
}

function start(user, pool, limits, rng) {
  const s = ensure(user);
  if (s.run) return { error: 'Tu as déjà une partie de Survie en cours : reprends-la ou abandonne-la.' };
  const deck = randomDeck(pool, limits, rng);
  if (deck.length < DECK_SIZE) return { error: 'Pas assez de cartes dans le jeu pour composer un deck de Survie.' };
  s.run = { round: 1, hp: START_HP, deck, wins: 0, startedAt: Date.now() };
  return { ok: true, run: s.run };
}

function abandon(user) {
  const s = ensure(user);
  if (!s.run) return { error: 'Aucune partie de Survie en cours.' };
  s.run = null; s.runs++;
  return { ok: true };
}

/* Fin d'une manche. hpLeft = PV du héros à la fin du combat. */
function recordResult(user, won, hpLeft) {
  const s = ensure(user);
  const run = s.run;
  if (!run) return null;
  const round = run.round;
  if (won) {
    run.wins = round;
    run.round = round + 1;
    run.hp = Math.min(START_HP, Math.max(1, Math.round(Number(hpLeft) || 1)) + HEAL_BETWEEN);
    let newRecord = false;
    if (round > s.best) { s.best = round; s.bestAt = Date.now(); newRecord = true; }
    const milestone = round % MILESTONE_EVERY === 0 ? { credits: 50 + 10 * round, dust: 5 * round } : null;
    return { won: true, round, nextRound: run.round, hp: run.hp, best: s.best, newRecord, milestone, over: false };
  }
  s.run = null; s.runs++;
  return { won: false, round, best: s.best, wins: round - 1, over: true };
}

/* Top 3 : meilleur nombre de manches gagnées d'affilée (à égalité, le premier à l'avoir fait) */
function leaderboard(users, n) {
  return users.filter(u => u.survival && u.survival.best > 0)
    .sort((a, b) => (b.survival.best - a.survival.best) || ((a.survival.bestAt || 0) - (b.survival.bestAt || 0)))
    .slice(0, n || 3)
    .map(u => ({ slug: u.slug, pseudo: u.pseudo, avatar: u.avatar || null, ornament: u.ornament || 'none', best: u.survival.best }));
}

module.exports = { roundConfig, randomDeck, ensure, start, abandon, recordResult, leaderboard, START_HP, HEAL_BETWEEN, MILESTONE_EVERY };

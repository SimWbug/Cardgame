/* ======================================================
   Mode Draft (Arène)
   - le joueur construit un deck de 30 cartes en choisissant 1 carte parmi 3,
     trente fois de suite (les cartes ne viennent pas de sa collection)
   - puis il enchaîne les combats contre le bot, de plus en plus forts,
     jusqu'à 3 défaites (ou 12 victoires)
   - les récompenses dépendent du nombre de victoires
   - une entrée gratuite par jour (heure de Paris), ensuite elle coûte des crédits
   ====================================================== */

const DECK_SIZE = 30;
const MAX_WINS = 12;
const MAX_LOSSES = 3;
const ENTRY_PRICE = 150; // crédits, après l'entrée gratuite du jour
const OFFER_SIZE = 3;
const RARITY_WEIGHTS = { commun: 60, rare: 25, epique: 12, legendaire: 3 };
// Choix « spéciaux » (1er, 10e, 20e, 30e) : que des cartes rares ou mieux
const SPECIAL_PICKS = [1, 10, 20, 30];
const SPECIAL_WEIGHTS = { commun: 0, rare: 60, epique: 30, legendaire: 10 };

function dayKey(now) {
  return new Date(now || Date.now()).toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' });
}

function ensure(user) {
  const d = user.draft = user.draft && typeof user.draft === 'object' ? user.draft : {};
  if (typeof d.best !== 'number') d.best = 0;
  if (typeof d.runs !== 'number') d.runs = 0;
  if (!Array.isArray(d.history)) d.history = [];
  if (d.run === undefined) d.run = null;
  return d;
}

function freeAvailable(user, now) { return ensure(user).freeDay !== dayKey(now); }

function pickRarity(weights, rng) {
  const entries = Object.entries(weights).filter(([, w]) => w > 0);
  const total = entries.reduce((a, [, w]) => a + w, 0);
  let r = rng() * total;
  for (const [k, w] of entries) { if ((r -= w) < 0) return k; }
  return entries[entries.length - 1][0];
}

/* Trois cartes différentes, qui respectent encore la limite d'exemplaires du deck */
function makeOffer(pool, picks, limits, rng) {
  rng = rng || Math.random;
  const count = {};
  picks.forEach(id => { count[id] = (count[id] || 0) + 1; });
  const allowed = pool.filter(c => (count[c.id] || 0) < ((limits && limits[c.rarity]) || 2));
  const pickNo = picks.length + 1;
  const weights = SPECIAL_PICKS.includes(pickNo) ? SPECIAL_WEIGHTS : RARITY_WEIGHTS;
  const offer = [];
  for (let tries = 0; offer.length < OFFER_SIZE && tries < 60; tries++) {
    const rarity = pickRarity(weights, rng);
    let cands = allowed.filter(c => c.rarity === rarity && !offer.includes(c.id));
    // Rareté épuisée : une autre rareté permise pour ce choix, sinon n'importe quelle carte
    if (!cands.length) cands = allowed.filter(c => (weights[c.rarity] || 0) > 0 && !offer.includes(c.id));
    if (!cands.length) cands = allowed.filter(c => !offer.includes(c.id));
    if (!cands.length) break;
    offer.push(cands[Math.floor(rng() * cands.length)].id);
  }
  return offer;
}

function start(user, pool, limits, opts) {
  opts = opts || {};
  const d = ensure(user);
  if (d.run) return { error: 'Tu as déjà un Draft en cours : termine-le ou abandonne-le.' };
  if (pool.length < 10) return { error: 'Pas assez de cartes dans le jeu pour un Draft.' };
  const free = freeAvailable(user, opts.now);
  if (!free && (user.credits || 0) < ENTRY_PRICE) return { error: `L'entrée coûte ${ENTRY_PRICE} crédits (il t'en manque ${ENTRY_PRICE - (user.credits || 0)}). Reviens demain pour l'entrée gratuite !` };
  if (free) d.freeDay = dayKey(opts.now);
  else { user.credits -= ENTRY_PRICE; if (user.stats) user.stats.creditsSpent = (user.stats.creditsSpent || 0) + ENTRY_PRICE; }
  d.run = { picks: [], offer: makeOffer(pool, [], limits, opts.rng), wins: 0, losses: 0, startedAt: Date.now(), paid: free ? 0 : ENTRY_PRICE };
  return { ok: true, run: d.run, free };
}

function pick(user, cardId, pool, limits, rng) {
  const d = ensure(user), run = d.run;
  if (!run) return { error: 'Aucun Draft en cours.' };
  if (run.picks.length >= DECK_SIZE || !run.offer) return { error: 'Ton deck est déjà complet.' };
  if (!run.offer.includes(cardId)) return { error: "Cette carte ne fait pas partie du choix proposé." };
  run.picks.push(cardId);
  run.offer = run.picks.length < DECK_SIZE ? makeOffer(pool, run.picks, limits, rng) : null;
  // Choix impossible (cartes supprimées entre-temps) : on complète au hasard
  if (run.picks.length < DECK_SIZE && run.offer.length === 0) run.offer = makeOffer(pool, [], limits, rng);
  return { ok: true, done: run.picks.length >= DECK_SIZE };
}

/* Récompenses selon le nombre de victoires */
function rewardsFor(wins) {
  const w = Math.max(0, Math.min(MAX_WINS, wins | 0));
  return {
    credits: 20 + 25 * w,
    dust: 10 * w,
    boosters: w >= 12 ? 3 : w >= 7 ? 2 : w >= 3 ? 1 : 0,
    title: w >= MAX_WINS ? "Maître de l'Arène" : null
  };
}

/* Difficulté du prochain combat : le bot joue de meilleurs decks à chaque victoire */
function botConfig(wins) {
  const w = Math.max(0, wins | 0);
  return {
    quality: Math.min(1, 0.15 + w * 0.08),
    botHp: 30 + Math.min(10, Math.max(0, w - 5) * 2),
    botName: w >= 9 ? "Champion de l'Arène" : w >= 6 ? 'Gladiateur' : w >= 3 ? 'Duelliste' : 'Challenger'
  };
}

function finish(d, now) {
  const run = d.run;
  const rewards = rewardsFor(run.wins);
  let newRecord = false;
  if (run.wins > d.best) { d.best = run.wins; d.bestAt = now || Date.now(); newRecord = true; }
  d.runs++;
  d.history.unshift({ wins: run.wins, losses: run.losses, at: now || Date.now() });
  d.history = d.history.slice(0, 10);
  d.run = null;
  return { rewards, newRecord, best: d.best };
}

/* Fin d'un combat de Draft */
function recordResult(user, won, now) {
  const d = ensure(user), run = d.run;
  if (!run || run.picks.length < DECK_SIZE) return null;
  if (won) run.wins++; else run.losses++;
  const out = { won, wins: run.wins, losses: run.losses, over: false };
  if (run.wins >= MAX_WINS || run.losses >= MAX_LOSSES) Object.assign(out, { over: true }, finish(d, now));
  return out;
}

/* Abandon : le Draft s'arrête et on reçoit les récompenses des victoires déjà gagnées
   (rien si le deck n'était pas terminé, sauf le remboursement de l'entrée payée). */
function abandon(user, now) {
  const d = ensure(user), run = d.run;
  if (!run) return { error: 'Aucun Draft en cours.' };
  if (run.picks.length < DECK_SIZE && run.wins === 0 && run.losses === 0) {
    const refund = run.paid || 0;
    if (refund) user.credits = (user.credits || 0) + refund;
    else d.freeDay = null; // entrée gratuite rendue
    d.run = null;
    return { ok: true, refunded: refund, rewards: null };
  }
  return Object.assign({ ok: true }, finish(d, now));
}

function leaderboard(users, n) {
  return users.filter(u => u.draft && u.draft.best > 0)
    .sort((a, b) => (b.draft.best - a.draft.best) || ((a.draft.bestAt || 0) - (b.draft.bestAt || 0)))
    .slice(0, n || 3)
    .map(u => ({ slug: u.slug, pseudo: u.pseudo, avatar: u.avatar || null, ornament: u.ornament || 'none', best: u.draft.best }));
}

module.exports = { DECK_SIZE, MAX_WINS, MAX_LOSSES, ENTRY_PRICE, SPECIAL_PICKS, dayKey, ensure, freeAvailable, makeOffer, start, pick, rewardsFor, botConfig, recordResult, abandon, leaderboard };

/* ======================================================
   Bagarre de la semaine
   Un mode contre le bot avec une règle spéciale qui change chaque lundi
   (heure de Paris). Première victoire de la semaine : un booster + des crédits ;
   les victoires suivantes rapportent un peu de poussière.
   ====================================================== */
const community = require('./community');

const RULES = [
  { id: 'braderie', icon: '🏷️', name: 'Grande braderie', desc: 'Toutes les cartes coûtent 1 mana de moins.', deck: 'own', costMod: -1 },
  { id: 'mini', icon: '🃏', name: 'Mini-decks', desc: 'Decks de 15 cartes seulement, tirées au hasard dans ton deck actif.', deck: 'own15' },
  { id: 'sources', icon: '🌱', name: 'Retour aux sources', desc: 'Que des cartes communes : un deck est tiré au hasard pour toi.', deck: 'commons' },
  { id: 'geants', icon: '🛡️', name: 'Héros géants', desc: 'Les deux héros commencent avec 50 PV.', deck: 'own', hp: 50 },
  { id: 'trombe', icon: '⚡', name: 'Démarrage en trombe', desc: 'Les deux joueurs commencent avec 5 mana.', deck: 'own', manaBonus: [4, 4] },
  { id: 'lourd', icon: '💎', name: 'Que du lourd', desc: 'Que des cartes rares, épiques et légendaires : un deck est tiré au hasard pour toi.', deck: 'rares' }
];
const REWARD_FIRST = { credits: 50, booster: 1 };
const DUST_PER_WIN = 15;
const DUST_WINS_MAX = 5; // victoires suivantes récompensées par semaine

/* Numéro de la semaine (depuis le 1er janvier 2024) : la règle tourne chaque lundi */
function weekIndex(key) { return Math.round((Date.parse(key + 'T00:00:00Z') - Date.parse('2024-01-01T00:00:00Z')) / (7 * 86400000)); }
function ruleFor(key, override) {
  if (override) { const r = RULES.find(x => x.id === override); if (r) return r; }
  const n = weekIndex(key);
  return RULES[((n % RULES.length) + RULES.length) % RULES.length];
}

function shuffle(list, rng) {
  const a = list.slice(); rng = rng || Math.random;
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
/* Deck de 30 cartes tiré dans une sélection de cartes (limites d'exemplaires
   respectées ; s'il n'y a pas assez de cartes différentes, on autorise des copies en plus) */
function randomDeckFrom(cards, limits, size, rng) {
  const deck = [], count = {};
  const order = shuffle(cards, rng);
  for (let pass = 0; pass < 3 && deck.length < size; pass++) {
    order.forEach(c => { if (deck.length < size && (count[c.id] || 0) < ((limits && limits[c.rarity]) || 2)) { deck.push(c.id); count[c.id] = (count[c.id] || 0) + 1; } });
  }
  for (let i = 0; deck.length < size && order.length && i < 500; i++) deck.push(order[i % order.length].id);
  return deck;
}
/* Decks du joueur et du bot selon la règle. ownDeck = deck actif du joueur (30 cartes) */
function decksFor(rule, ownDeck, pool, limits, botDeckFn, rng) {
  if (rule.deck === 'own15') {
    return { player: shuffle(ownDeck, rng).slice(0, 15), bot: shuffle(botDeckFn(), rng).slice(0, 15) };
  }
  if (rule.deck === 'commons' || rule.deck === 'rares') {
    const sel = pool.filter(c => rule.deck === 'commons' ? c.rarity === 'commun' : c.rarity !== 'commun');
    const src = sel.length >= 5 ? sel : pool;
    return { player: randomDeckFrom(src, limits, 30, rng), bot: randomDeckFrom(src, limits, 30, rng) };
  }
  return { player: ownDeck.slice(), bot: botDeckFn() };
}
/* Champs du combat (voir matchmaking.startBotMatch) */
function matchFields(rule) {
  const f = { brawl: { id: rule.id, name: rule.name, icon: rule.icon } };
  if (rule.costMod) f.costMod = rule.costMod;
  if (rule.hp) f.bothHeroHealth = rule.hp;
  if (rule.manaBonus) f.manaBonus = rule.manaBonus;
  return f;
}
function needsOwnDeck(rule) { return rule.deck === 'own' || rule.deck === 'own15'; }

function ensure(user, now) {
  const key = community.weekKey(now);
  const b = user.brawl = user.brawl && typeof user.brawl === 'object' ? user.brawl : {};
  if (b.week !== key) { b.week = key; b.wins = 0; b.played = 0; b.firstDone = false; }
  if (typeof b.totalWins !== 'number') b.totalWins = 0;
  return b;
}
function recordResult(user, won, now) {
  const b = ensure(user, now);
  b.played++;
  if (!won) return { won: false, wins: b.wins, played: b.played, reward: null };
  b.wins++; b.totalWins++;
  let reward = null;
  if (!b.firstDone) { b.firstDone = true; reward = Object.assign({ first: true }, REWARD_FIRST); }
  else if (b.wins - 1 <= DUST_WINS_MAX) reward = { dust: DUST_PER_WIN };
  return { won: true, wins: b.wins, played: b.played, reward };
}
function view(user, now, override) {
  const key = community.weekKey(now), b = ensure(user, now);
  const rule = ruleFor(key, override);
  const nextKey = new Date(Date.parse(key + 'T00:00:00Z') + 7 * 86400000).toISOString().slice(0, 10);
  return {
    week: key, endsAt: community.weekEndsAt(key), rule, next: ruleFor(nextKey, null),
    wins: b.wins, played: b.played, firstDone: b.firstDone, totalWins: b.totalWins,
    rewards: { first: REWARD_FIRST, dustPerWin: DUST_PER_WIN, dustWinsMax: DUST_WINS_MAX },
    needsOwnDeck: needsOwnDeck(rule)
  };
}

module.exports = { RULES, ruleFor, weekIndex, decksFor, randomDeckFrom, matchFields, needsOwnDeck, ensure, recordResult, view, REWARD_FIRST, DUST_PER_WIN, DUST_WINS_MAX };

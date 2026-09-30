const { readJSON, writeJSON } = require('./store');
const { SEED_CARDS, SEED_EMOTES, ORNAMENTS: SEED_ORNAMENTS } = require('./cards');

let users = readJSON('users.json', {});
let cardPool = readJSON('cards.json', null);
if (!cardPool) {
  cardPool = SEED_CARDS.slice();
  writeJSON('cards.json', cardPool);
}
let emotePool = readJSON('emotes.json', null);
if (!emotePool) {
  emotePool = SEED_EMOTES.slice();
  writeJSON('emotes.json', emotePool);
}
let ornaments = readJSON('ornaments.json', null);
if (!ornaments) {
  ornaments = SEED_ORNAMENTS.slice();
  writeJSON('ornaments.json', ornaments);
}
function saveOrnaments() { writeJSON('ornaments.json', ornaments); }
function getOrnaments() { return ornaments; }
function ornamentById(id) { return ornaments.find(o => o.id === id) || null; }
function addOrnament(o) { ornaments.push(o); saveOrnaments(); return o; }
function updateOrnament(id, patch) {
  const o = ornamentById(id);
  if (!o) return null;
  Object.assign(o, patch);
  saveOrnaments();
  return o;
}
function removeOrnament(id) { ornaments = ornaments.filter(o => o.id !== id); saveOrnaments(); }

let trades = readJSON('trades.json', []);
let meta = readJSON('meta.json', { currentSeason: null, seasonHistory: [] });
let settings = readJSON('settings.json', null);
if (!settings) {
  settings = { matchDropChance: 0.5 }; // % de chance d'un booster bonus en fin de match gagné
  writeJSON('settings.json', settings);
}
function getSettings() { return settings; }
function updateSettings(patch) { Object.assign(settings, patch); writeJSON('settings.json', settings); return settings; }

let content = readJSON('content.json', null);
if (!content) {
  content = { strings: {}, icons: {}, media: {}, sfx: {} }; // uniquement les REMPLACEMENTS, fusionnés aux défauts à la lecture
  writeJSON('content.json', content);
}
function getContentOverrides() { return content; }
function updateContentOverrides(patch) {
  if (patch.strings) Object.assign(content.strings, patch.strings);
  if (patch.icons) Object.assign(content.icons, patch.icons);
  if (patch.media) Object.assign(content.media, patch.media);
  if (patch.sfx) Object.assign(content.sfx, patch.sfx);
  writeJSON('content.json', content);
  return content;
}
function resetContentKey(category, key) {
  if (content[category]) delete content[category][key];
  writeJSON('content.json', content);
  return content;
}

const DEFAULT_CASINO_SYMBOLS = [
  { id: 'cherry', icon: '🍒', weight: 40, payout: 2 },
  { id: 'lemon', icon: '🍋', weight: 30, payout: 3 },
  { id: 'bell', icon: '🔔', weight: 15, payout: 5 },
  { id: 'gem', icon: '💎', weight: 10, payout: 10 },
  { id: 'seven', icon: '7️⃣', weight: 5, payout: 20 }
];
const DEFAULT_EVENTS = {
  tabEnabled: false,
  casino: { enabled: false, costPerSpinDust: 10, costPerSpinCredits: 0, symbols: DEFAULT_CASINO_SYMBOLS, startDate: null, endDate: null },
  boss: {
    enabled: false, name: 'Boss', image: null, heroHealth: 60,
    rewardDust: 50, rewardCredits: 0, startDate: null, endDate: null,
    deckCardIds: [], entrySound: null, dialogue: []
  },
  blackjack: { enabled: false, costDust: 10, costCredits: 0, startDate: null, endDate: null }
};
let events = readJSON('events.json', null);
if (!events) { events = JSON.parse(JSON.stringify(DEFAULT_EVENTS)); writeJSON('events.json', events); }
// Rétrocompatibilité : un fichier events.json existant créé par une version antérieure
// peut ne pas avoir les champs récemment ajoutés (dates, deck du boss, son, dialogues).
events.casino = Object.assign({}, DEFAULT_EVENTS.casino, events.casino);
// Rétrocompatibilité : un fichier events.json créé avant le casino en double
// monnaie avait un seul "costPerSpin" (poussière uniquement) — on le migre.
if (events.casino.costPerSpin !== undefined) {
  if (!events.casino.costPerSpinDust) events.casino.costPerSpinDust = events.casino.costPerSpin;
  delete events.casino.costPerSpin;
}
events.boss = Object.assign({}, DEFAULT_EVENTS.boss, events.boss);
events.blackjack = Object.assign({}, DEFAULT_EVENTS.blackjack, events.blackjack);
function getEvents() { return events; }
function updateEvents(patch) {
  if (patch.tabEnabled !== undefined) events.tabEnabled = !!patch.tabEnabled;
  if (patch.casino) Object.assign(events.casino, patch.casino);
  if (patch.boss) Object.assign(events.boss, patch.boss);
  if (patch.blackjack) Object.assign(events.blackjack, patch.blackjack);
  writeJSON('events.json', events);
  return events;
}

let achievements = readJSON('achievements.json', null);
if (!achievements) { achievements = []; writeJSON('achievements.json', achievements); }
function getAchievements() { return achievements; }
function achievementById(id) { return achievements.find(a => a.id === id) || null; }
function addAchievement(a) { achievements.push(a); writeJSON('achievements.json', achievements); return a; }
function updateAchievement(id, patch) {
  const a = achievementById(id);
  if (!a) return null;
  Object.assign(a, patch);
  writeJSON('achievements.json', achievements);
  return a;
}
function removeAchievement(id) { achievements = achievements.filter(a => a.id !== id); writeJSON('achievements.json', achievements); }

/* Packs de crédits achetables contre de la poussière (sens inverse de la
   poussière habituelle, pour donner un débouché à un surplus de poussière). */
let creditPacks = readJSON('creditpacks.json', null);
if (!creditPacks) { creditPacks = []; writeJSON('creditpacks.json', creditPacks); }
function getCreditPacks() { return creditPacks; }
function creditPackById(id) { return creditPacks.find(p => p.id === id) || null; }
function addCreditPack(p) { creditPacks.push(p); writeJSON('creditpacks.json', creditPacks); return p; }
function updateCreditPack(id, patch) {
  const p = creditPackById(id);
  if (!p) return null;
  Object.assign(p, patch);
  writeJSON('creditpacks.json', creditPacks);
  return p;
}
function removeCreditPack(id) { creditPacks = creditPacks.filter(p => p.id !== id); writeJSON('creditpacks.json', creditPacks); }

const DEFAULT_EXTENSION = {
  id: 'base', name: 'Édition de Base', description: "L'extension d'origine, incluse par défaut.",
  backImage: null, packImage: null, boosterCreditPrice: 100, boosterDustPrice: null, matchDropEligible: true, createdAt: Date.now()
};
let extensions = readJSON('extensions.json', null);
if (!extensions || extensions.length === 0) {
  extensions = [DEFAULT_EXTENSION];
  writeJSON('extensions.json', extensions);
}
// Rétrocompatibilité : des extensions créées avant l'ajout de l'image de
// booster n'ont pas ce champ — on le complète sans rien écraser d'existant.
extensions.forEach(e => { if (e.packImage === undefined) e.packImage = null; });
function saveExtensions() { writeJSON('extensions.json', extensions); }
function getExtensions() { return extensions; }
function extensionById(id) { return extensions.find(e => e.id === id) || null; }
function addExtension(ext) { extensions.push(ext); saveExtensions(); return ext; }
function updateExtension(id, patch) {
  const e = extensionById(id);
  if (!e) return null;
  Object.assign(e, patch);
  saveExtensions();
  return e;
}
function removeExtension(id) { extensions = extensions.filter(e => e.id !== id); saveExtensions(); }

function saveUsers() { writeJSON('users.json', users); }
function saveCards() { writeJSON('cards.json', cardPool); }
function saveTrades() { writeJSON('trades.json', trades); }
function saveEmotes() { writeJSON('emotes.json', emotePool); }
function saveMeta(m) { meta = m || meta; writeJSON('meta.json', meta); }

function getUser(slug) { return users[slug] || null; }
function createUser(profile) { users[profile.slug] = profile; saveUsers(); return profile; }
function updateUser(slug, profile) { users[slug] = profile; saveUsers(); return profile; }
function deleteUser(slug) { delete users[slug]; saveUsers(); }
function allUsers() { return Object.values(users); }
function publicUser(u) {
  if (!u) return null;
  const { passHash, ...rest } = u;
  return rest;
}

function getCardPool() { return cardPool; }
function cardById(id) { return cardPool.find(c => c.id === id); }
function addCard(card) { cardPool.push(card); saveCards(); return card; }
function updateCard(id, patch) {
  const card = cardPool.find(c => c.id === id);
  if (!card) return null;
  Object.assign(card, patch);
  saveCards();
  return card;
}
function removeCard(id) { cardPool = cardPool.filter(c => c.id !== id); saveCards(); addDeletedCardIds([id]); }

/* Registre des cartes supprimées VOLONTAIREMENT (bouton ✕ ou nettoyage admin).
   Seules ces cartes-là sont retirées des collections et des decks des joueurs :
   si cards.json était un jour illisible ou absent, le jeu ne prendrait pas les
   cartes manquantes pour des cartes supprimées et ne viderait aucune collection. */
let deletedCardIds = readJSON('deleted-cards.json', []);
if (!Array.isArray(deletedCardIds)) deletedCardIds = [];
function getDeletedCardIds() { return deletedCardIds; }
function addDeletedCardIds(ids) {
  let changed = false;
  ids.forEach(id => { if (id && !deletedCardIds.includes(id)) { deletedCardIds.push(id); changed = true; } });
  if (changed) writeJSON('deleted-cards.json', deletedCardIds);
}

/* Statistiques mensuelles des cartes jouées (page Admin → Stats).
   months["2026-09"] = { cards: { id: { name, plays, botPlays, matches, wins } }, days: { "14": n }, pvpMatches }
   - plays / botPlays : poses de la carte par de vrais joueurs (dont contre le bot)
   - matches / wins   : parties JcJ terminées où la carte a été jouée, et victoires de celui qui l'a jouée */
let cardStats = readJSON('card-stats.json', null);
if (!cardStats || typeof cardStats.months !== 'object') cardStats = { months: {} };
function statsMonth(month) {
  if (!cardStats.months[month]) cardStats.months[month] = { cards: {}, days: {}, pvpMatches: 0 };
  return cardStats.months[month];
}
function statsCard(bucket, id, name) {
  if (!bucket.cards[id]) bucket.cards[id] = { name: name || null, plays: 0, botPlays: 0, matches: 0, wins: 0 };
  if (name) bucket.cards[id].name = name; // garde le nom même si la carte est supprimée plus tard
  return bucket.cards[id];
}
function recordCardPlay(card, month, day, vsBot) {
  const b = statsMonth(month);
  const s = statsCard(b, card.id, card.name);
  s.plays += 1;
  if (vsBot) s.botPlays += 1;
  b.days[day] = (b.days[day] || 0) + 1;
  writeJSON('card-stats.json', cardStats);
}
function recordMatchCards(month, entries) {
  const b = statsMonth(month);
  b.pvpMatches += 1;
  entries.forEach(e => e.cardIds.forEach(id => {
    const card = cardById(id);
    const s = statsCard(b, id, card ? card.name : null);
    s.matches += 1;
    if (e.won) s.wins += 1;
  }));
  writeJSON('card-stats.json', cardStats);
}
function getCardStats() { return cardStats; }

function getEmotePool() { return emotePool; }
function emoteById(id) { return emotePool.find(e => e.id === id) || null; }
function addEmote(emote) { emotePool.push(emote); saveEmotes(); return emote; }
function updateEmote(id, patch) {
  const e = emotePool.find(x => x.id === id);
  if (!e) return null;
  Object.assign(e, patch);
  saveEmotes();
  return e;
}
function removeEmote(id) { emotePool = emotePool.filter(e => e.id !== id); saveEmotes(); }

function getTrades() { return trades; }
function addTrade(t) { trades.push(t); saveTrades(); return t; }
function saveTradesNow() { saveTrades(); }

function getMeta() { return meta; }

module.exports = {
  getUser, createUser, updateUser, deleteUser, allUsers, publicUser,
  getCardPool, cardById, addCard, updateCard, removeCard, getDeletedCardIds, addDeletedCardIds,
  recordCardPlay, recordMatchCards, getCardStats,
  getEmotePool, emoteById, addEmote, updateEmote, removeEmote,
  getExtensions, extensionById, addExtension, updateExtension, removeExtension,
  getSettings, updateSettings,
  getEvents, updateEvents,
  getAchievements, achievementById, addAchievement, updateAchievement, removeAchievement,
  getCreditPacks, creditPackById, addCreditPack, updateCreditPack, removeCreditPack,
  getContentOverrides, updateContentOverrides, resetContentKey,
  getOrnaments, ornamentById, addOrnament, updateOrnament, removeOrnament,
  getTrades, addTrade, saveTradesNow,
  getMeta, saveMeta
};

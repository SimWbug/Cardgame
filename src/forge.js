/* ======================================================
   Ressources et Forge
   Les ressources (bois, pierre, métal, cristal) se récoltent en Expédition.
   Avec assez de ressources, le joueur construit sa Forge (une seule fois),
   puis il y forge des boosters contre des ressources.
   Coûts réglables par l'admin (data/forge.json).
   ====================================================== */
const { readJSON, writeJSON } = require('./store');

const FILE = 'forge.json';
const RESOURCES = {
  bois: { icon: '🪵', name: 'Bois' },
  pierre: { icon: '🪨', name: 'Pierre' },
  metal: { icon: '⛓️', name: 'Métal' },
  cristal: { icon: '💎', name: 'Cristal' }
};
const KEYS = Object.keys(RESOURCES);
const DEFAULT_BUILD = { bois: 25, pierre: 20, metal: 8, cristal: 0 };
const DEFAULT_RECIPE = { bois: 6, pierre: 4, metal: 2, cristal: 0 };

let data = null;
function load() {
  if (data) return data;
  data = readJSON(FILE, null) || {};
  if (!data.buildCost) data.buildCost = Object.assign({}, DEFAULT_BUILD);
  if (!data.recipes || typeof data.recipes !== 'object') data.recipes = {};
  return data;
}
function save() { writeJSON(FILE, data); }
function cleanCost(c, def) {
  const out = {};
  KEYS.forEach(k => { const n = Math.round(Number((c || {})[k])); out[k] = Number.isFinite(n) ? Math.max(0, Math.min(100000, n)) : (def ? def[k] : 0); });
  return out;
}

function ensure(user) {
  if (!user.resources || typeof user.resources !== 'object') user.resources = {};
  KEYS.forEach(k => { user.resources[k] = Math.max(0, Number(user.resources[k]) || 0); });
  if (!user.forge || typeof user.forge !== 'object') user.forge = { built: false, forged: 0 };
  return user;
}
function add(user, gains) {
  ensure(user);
  KEYS.forEach(k => { if (gains && gains[k]) user.resources[k] += Math.max(0, Math.round(gains[k])); });
}
function canPay(user, cost) { ensure(user); return KEYS.every(k => user.resources[k] >= (cost[k] || 0)); }
function missing(user, cost) {
  ensure(user);
  return KEYS.filter(k => user.resources[k] < (cost[k] || 0)).map(k => `${(cost[k] || 0) - user.resources[k]} ${RESOURCES[k].name.toLowerCase()}`);
}
function pay(user, cost) { KEYS.forEach(k => { user.resources[k] -= (cost[k] || 0); }); }

function buildCost() { return Object.assign({}, load().buildCost); }
/* Recette « booster » d'une extension : coût et activation (actif par défaut) */
function recipeFor(extId) {
  const r = load().recipes[extId] || {};
  return { extensionId: extId, cost: cleanCost(r.cost, DEFAULT_RECIPE), enabled: r.enabled !== false };
}
function build(user) {
  ensure(user);
  if (user.forge.built) return { error: 'Ta forge est déjà construite.' };
  const cost = buildCost();
  if (!canPay(user, cost)) return { error: `Il te manque ${missing(user, cost).join(', ')}.` };
  pay(user, cost);
  user.forge.built = true; user.forge.builtAt = Date.now();
  return { ok: true };
}
/* Forger prend du temps : chaque commande a son minuteur (1 h au maximum).
   Selon l'humeur du forgeron, l'attente varie. */
const MAX_ORDERS = 3;
const MAX_WAIT_MS = 60 * 60 * 1000;
const MOODS = [
  { id: 'travail', weight: 50, min: 3, max: 10, icon: '🔨', text: 'Le forgeron se met tout de suite au travail.' },
  { id: 'cafe', weight: 15, min: 8, max: 18, icon: '☕', text: 'Le forgeron finit son café avant de s\'y mettre.' },
  { id: 'mine', weight: 18, min: 20, max: 45, icon: '⛏️', text: 'Le forgeron est parti chercher du charbon à la mine : il s\'y mettra à son retour.' },
  { id: 'demandes', weight: 17, min: 30, max: 60, icon: '📜', text: 'Le forgeron croule sous les commandes : patience !' }
];
const timeScale = () => { const n = Number(process.env.FORGE_TIME_SCALE); return Number.isFinite(n) && n > 0 ? n : 1; };
function rollMood(rng) {
  rng = rng || Math.random;
  const total = MOODS.reduce((a, m) => a + m.weight, 0);
  let r = rng() * total;
  const mood = MOODS.find(m => (r -= m.weight) < 0) || MOODS[0];
  const minutes = mood.min + rng() * (mood.max - mood.min);
  return { mood, ms: Math.min(MAX_WAIT_MS, Math.round(minutes * 60000)) };
}
function ensureOrders(user) { if (!Array.isArray(user.forge.orders)) user.forge.orders = []; return user.forge.orders; }
/* Objets cosmétiques qu'on ne trouve qu'à la forge (une seule fois chacun) */
const COSMETICS = [
  { id: 'c-orn-fer', kind: 'ornament', refId: 'forge-fer', name: 'Anneau de fer forgé', icon: '⭕', cost: { bois: 10, pierre: 10, metal: 15, cristal: 0 } },
  { id: 'c-orn-or', kind: 'ornament', refId: 'forge-or', name: "Anneau d'or martelé", icon: '🟡', cost: { bois: 0, pierre: 10, metal: 25, cristal: 2 } },
  { id: 'c-orn-cristal', kind: 'ornament', refId: 'forge-cristal', name: 'Anneau de cristal', icon: '💎', cost: { bois: 0, pierre: 0, metal: 12, cristal: 6 } },
  { id: 'c-orn-lave', kind: 'ornament', refId: 'forge-lave', name: 'Anneau de lave', icon: '🌋', cost: { bois: 0, pierre: 20, metal: 20, cristal: 4 } },
  { id: 'c-ban-acier', kind: 'banner', refId: 'acier-trempe', name: 'Bannière « Acier trempé »', icon: '🎏', cost: { bois: 0, pierre: 15, metal: 30, cristal: 0 } },
  { id: 'c-ban-ardente', kind: 'banner', refId: 'forge-ardente', name: 'Bannière « Forge ardente »', icon: '🔥', cost: { bois: 30, pierre: 0, metal: 20, cristal: 3 } },
  { id: 'c-title', kind: 'title', refId: 'Maître forgeron', name: 'Titre « Maître forgeron »', icon: '🏷️', cost: { bois: 0, pierre: 0, metal: 40, cristal: 5 } }
];
/* Runes d'Expédition : objets à usage unique, forgés ici et équipés au départ
   d'une Expédition (2 emplacements au plus, 2 runes différentes). */
const RUNES = [
  { id: 'vigueur', icon: '❤️‍🔥', name: 'Rune de vigueur', desc: '+8 PV max pendant toute l\'Expédition.', cost: { bois: 0, pierre: 8, metal: 4, cristal: 0 } },
  { id: 'garde', icon: '🛡️', name: 'Rune de garde', desc: 'Ton héros commence chaque combat avec 3 d\'armure.', cost: { bois: 0, pierre: 10, metal: 6, cristal: 0 } },
  { id: 'fortune', icon: '🪙', name: 'Rune de fortune', desc: 'Tu pars avec 75 or de plus.', cost: { bois: 8, pierre: 0, metal: 4, cristal: 0 } },
  { id: 'prospecteur', icon: '⛏️', name: 'Rune du prospecteur', desc: 'Les ressources récoltées sont doublées.', cost: { bois: 12, pierre: 6, metal: 4, cristal: 0 } },
  { id: 'eveil', icon: '🔷', name: "Rune d'éveil", desc: 'Tu commences chaque combat avec 1 mana de plus.', cost: { bois: 0, pierre: 0, metal: 10, cristal: 2 } },
  { id: 'anciens', icon: '🏺', name: 'Rune des anciens', desc: 'Tu pars avec une relique au hasard.', cost: { bois: 0, pierre: 0, metal: 12, cristal: 3 } }
];
const MAX_RUNES_EQUIPPED = 2;
function ensureRunes(user) { if (!user.runes || typeof user.runes !== 'object' || Array.isArray(user.runes)) user.runes = {}; return user.runes; }
function forgeRune(user, runeId, now, rng) {
  ensure(user);
  const r = RUNES.find(x => x.id === runeId);
  if (!r) return { error: 'Rune inconnue.' };
  return startOrder(user, r.cost, { kind: 'rune', runeId: r.id, name: r.name, extensionName: r.name }, now, rng);
}
/* Vérifie et retire du stock les runes choisies pour une Expédition */
function takeRunes(user, ids) {
  const stock = ensureRunes(user);
  const list = [...new Set((Array.isArray(ids) ? ids : []).map(String))];
  if (list.length > MAX_RUNES_EQUIPPED) return { error: `Tu peux équiper ${MAX_RUNES_EQUIPPED} runes au plus.` };
  for (const id of list) {
    if (!RUNES.some(r => r.id === id)) return { error: 'Rune inconnue.' };
    if (!(stock[id] > 0)) return { error: `Tu n'as pas de « ${RUNES.find(r => r.id === id).name} ».` };
  }
  return { ok: true, runes: list, commit: () => list.forEach(id => { stock[id] -= 1; if (stock[id] <= 0) delete stock[id]; }) };
}
/* Lance une commande (ressources payées tout de suite) ; item : { kind, extensionId?, cosmeticId?, name } */
function startOrder(user, cost, item, now, rng) {
  ensure(user);
  if (!user.forge.built) return { error: "Construis d'abord ta forge." };
  const orders = ensureOrders(user);
  if (orders.length >= MAX_ORDERS) return { error: `Le forgeron a déjà ${MAX_ORDERS} commandes de ta part : récupère-en une d'abord.` };
  if (!canPay(user, cost)) return { error: `Il te manque ${missing(user, cost).join(', ')}.` };
  pay(user, cost);
  now = now || Date.now();
  const { mood, ms } = rollMood(rng);
  const order = Object.assign({ id: 'fo-' + Math.random().toString(36).slice(2, 9), kind: 'booster' }, item, {
    startedAt: now, readyAt: now + Math.max(1000, Math.round(ms / timeScale())), mood: mood.id, moodIcon: mood.icon, moodText: mood.text, notified: false });
  orders.push(order);
  return { ok: true, order };
}
function forgeBooster(user, extId, extName, now, rng) {
  ensure(user);
  if (!user.forge.built) return { error: "Construis d'abord ta forge." };
  const r = recipeFor(extId);
  if (!r.enabled) return { error: "Ce booster ne se forge pas pour l'instant." };
  return startOrder(user, r.cost, { kind: 'booster', extensionId: extId, extensionName: extName || extId, name: `Booster « ${extName || extId} »` }, now, rng);
}
/* Objets forgeables réglés par l'admin : chaque objet de forge peut être activé / désactivé
   et son coût changé ; n'importe quel ornement du jeu (boutique, PNG perso, niveaux…) peut
   aussi devenir forgeable (désactivé par défaut). */
const DEFAULT_ORN_COST = { bois: 0, pierre: 10, metal: 20, cristal: 2 };
const ornCosId = ornId => 'c-orn:' + ornId;
function cosmeticSetting(id) { const c = load().cosmetics; return (c && typeof c === 'object' && c[id]) || {}; }
function cosmeticsList(ornaments) {
  const builtinOrn = new Set(COSMETICS.filter(c => c.kind === 'ornament').map(c => c.refId));
  const out = COSMETICS.map(c => { const st = cosmeticSetting(c.id); return Object.assign({}, c, { cost: cleanCost(st.cost, c.cost), enabled: st.enabled !== false, builtin: true }); });
  (ornaments || []).forEach(o => {
    if (!o || !o.id || o.id === 'none' || builtinOrn.has(o.id)) return;
    const id = ornCosId(o.id), st = cosmeticSetting(id);
    out.push({ id, kind: 'ornament', refId: o.id, name: o.name || o.id, icon: '💍', cost: cleanCost(st.cost, DEFAULT_ORN_COST), enabled: st.enabled === true, builtin: false });
  });
  const rank = k => (k === 'ornament' ? 0 : k === 'banner' ? 1 : 2);
  return out.map((c, i) => [c, i]).sort((a, b) => rank(a[0].kind) - rank(b[0].kind) || a[1] - b[1]).map(x => x[0]);
}
function setCosmetic(id, patch) {
  const d = load();
  if (!d.cosmetics || typeof d.cosmetics !== 'object') d.cosmetics = {};
  const cur = d.cosmetics[id] || {};
  const base = COSMETICS.find(c => c.id === id);
  if (patch.cost !== undefined) cur.cost = cleanCost(patch.cost, base ? base.cost : DEFAULT_ORN_COST);
  if (patch.enabled !== undefined) cur.enabled = !!patch.enabled;
  d.cosmetics[id] = cur; save();
}
/* owned(cosmétique) → déjà possédé ? (vérifié par le serveur) ; list : objets forgeables (cosmeticsList) */
function forgeCosmetic(user, cosId, owned, now, rng, list) {
  ensure(user);
  const c = (list || cosmeticsList([])).find(x => x.id === cosId);
  if (!c) return { error: 'Objet inconnu.' };
  if (!c.enabled) return { error: "Cet objet ne se forge pas pour l'instant." };
  if (owned(c)) return { error: 'Tu possèdes déjà cet objet.' };
  if (ensureOrders(user).some(o => o.cosmeticId === c.id)) return { error: 'Le forgeron travaille déjà sur cet objet.' };
  return startOrder(user, c.cost, { kind: 'cosmetic', cosmeticId: c.id, cosKind: c.kind, refId: c.refId, name: c.name, extensionName: c.name }, now, rng);
}
/* Récupérer une commande terminée (la remise du booster est faite par le serveur) */
function claim(user, orderId, now) {
  ensure(user);
  const orders = ensureOrders(user);
  const o = orders.find(x => x.id === orderId);
  if (!o) return { error: 'Commande introuvable.' };
  if ((now || Date.now()) < o.readyAt) return { error: "Le forgeron n'a pas encore fini." };
  user.forge.orders = orders.filter(x => x.id !== orderId);
  user.forge.forged = (user.forge.forged || 0) + 1;
  return { ok: true, order: o };
}
/* Commandes terminées pas encore signalées (pour la notification) */
function readyToNotify(user, now) {
  ensure(user);
  return ensureOrders(user).filter(o => !o.notified && (now || Date.now()) >= o.readyAt);
}
/* ---------- Quêtes du forgeron : 3 par jour (heure de Paris) ----------
   « deliver » : livrer des ressources (elles sont prises) ; les autres avancent
   tout seuls en jouant (Expédition, forge). */
const QUESTS = [
  { id: 'livrer-metal', type: 'deliver', res: 'metal', n: 12, text: 'Rapporte-moi 12 métal, j\'en manque !', reward: { credits: 120, dust: 30 } },
  { id: 'livrer-bois', type: 'deliver', res: 'bois', n: 20, text: 'Il me faut 20 bois pour le feu.', reward: { credits: 90, dust: 20 } },
  { id: 'livrer-pierre', type: 'deliver', res: 'pierre', n: 15, text: 'Apporte 15 pierres pour réparer le four.', reward: { credits: 90, dust: 25 } },
  { id: 'livrer-cristal', type: 'deliver', res: 'cristal', n: 2, text: 'Deux cristaux pour mes outils fins ?', reward: { credits: 150, booster: 1 } },
  { id: 'elites', type: 'elite', n: 2, text: 'Bats 2 élites en Expédition.', reward: { credits: 120, cristal: 1 } },
  { id: 'etages', type: 'floor', n: 8, text: 'Explore 8 nouvelles cases en Expédition.', reward: { credits: 100, metal: 5 } },
  { id: 'combats', type: 'fight', n: 5, text: 'Gagne 5 combats en Expédition.', reward: { credits: 100, bois: 8, pierre: 6 } },
  { id: 'forger', type: 'forge', n: 2, text: 'Récupère 2 objets à la forge.', reward: { dust: 60, metal: 4 } },
  { id: 'boss', type: 'boss', n: 1, text: 'Terrasse un boss d\'Expédition.', reward: { credits: 200, cristal: 2 } }
];
function dayKey(now) { return new Date(now || Date.now()).toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' }); }
function hashStr(str) { let h = 2166136261; for (const ch of str) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; } return h; }
function questsOf(user, now) {
  ensure(user);
  const d = dayKey(now);
  const q = user.forge.quests;
  if (q && q.day === d && Array.isArray(q.list)) return q.list;
  // 3 quêtes différentes, dont au plus 2 livraisons, tirées selon le jour et le joueur
  let h = hashStr(d + '|' + (user.slug || '')), list = [], deliveries = 0;
  const pool = QUESTS.slice();
  while (list.length < 3 && pool.length) {
    h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
    const qd = pool.splice(h % pool.length, 1)[0];
    if (qd.type === 'deliver' && deliveries >= 2) continue;
    if (qd.type === 'deliver') deliveries++;
    list.push({ id: qd.id, progress: 0, done: false, claimed: false });
  }
  user.forge.quests = { day: d, list };
  return list;
}
function questDef(id) { return QUESTS.find(q => q.id === id) || null; }
/* Avancement automatique (type : elite, floor, fight, forge, boss) */
function questProgress(user, type, n, now) {
  const list = questsOf(user, now);
  const done = [];
  list.forEach(q => {
    const def = questDef(q.id);
    if (!def || def.type !== type || q.done) return;
    q.progress = Math.min(def.n, q.progress + (n || 1));
    if (q.progress >= def.n) { q.done = true; done.push(def); }
  });
  return done;
}
function questDeliver(user, id, now) {
  const q = questsOf(user, now).find(x => x.id === id), def = questDef(id);
  if (!q || !def) return { error: 'Quête introuvable.' };
  if (def.type !== 'deliver') return { error: 'Cette quête avance toute seule en jouant.' };
  if (q.done) return { error: 'Déjà livré.' };
  if ((user.resources[def.res] || 0) < def.n) return { error: `Il te manque ${def.n - (user.resources[def.res] || 0)} ${RESOURCES[def.res].name.toLowerCase()}.` };
  user.resources[def.res] -= def.n;
  q.progress = def.n; q.done = true;
  return { ok: true };
}
/* Récompense (la remise des crédits/poussière/boosters est faite par le serveur ; les ressources ici) */
function questClaim(user, id, now) {
  const q = questsOf(user, now).find(x => x.id === id), def = questDef(id);
  if (!q || !def) return { error: 'Quête introuvable.' };
  if (!q.done) return { error: 'Quête pas encore terminée.' };
  if (q.claimed) return { error: 'Récompense déjà récupérée.' };
  q.claimed = true;
  add(user, def.reward);
  return { ok: true, reward: def.reward };
}
function questsView(user, now) {
  return questsOf(user, now).map(q => { const def = questDef(q.id) || {}; return Object.assign({}, q, { text: def.text, type: def.type, n: def.n, res: def.res || null, reward: def.reward }); });
}

/* Admin */
function setBuildCost(c) { load().buildCost = cleanCost(c, DEFAULT_BUILD); save(); }
function setRecipe(extId, patch) {
  const cur = load().recipes[extId] || {};
  if (patch.cost !== undefined) cur.cost = cleanCost(patch.cost, DEFAULT_RECIPE);
  if (patch.enabled !== undefined) cur.enabled = !!patch.enabled;
  data.recipes[extId] = cur; save();
}
function _reset() { data = null; }

module.exports = { RUNES, MAX_RUNES_EQUIPPED, ensureRunes, forgeRune, takeRunes, QUESTS, questsOf, questProgress, questDeliver, questClaim, questsView, COSMETICS, DEFAULT_ORN_COST, cosmeticsList, setCosmetic, forgeCosmetic, RESOURCES, KEYS, DEFAULT_BUILD, DEFAULT_RECIPE, MAX_ORDERS, MAX_WAIT_MS, MOODS, rollMood, ensure, add, canPay, missing, buildCost, recipeFor, build, forgeBooster, claim, readyToNotify, setBuildCost, setRecipe, _reset };

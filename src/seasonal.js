/* ======================================================
   Événements saisonniers (Halloween, Noël…)
   L'admin crée un événement daté : un nom, une icône de jeton, une règle
   spéciale facultative (reprise de la Bagarre) et une boutique limitée.
   Pendant l'événement, les « combats de l'événement » contre le bot
   rapportent des jetons (plafond par jour), à dépenser dans la boutique.
   Les jetons ne servent qu'à cet événement.
   ====================================================== */
const { readJSON, writeJSON } = require('./store');

const FILE = 'seasonal.json';
const KINDS = { banner: 'Bannière', emote: 'Provocation', board: 'Plateau', ornament: "Contour d'avatar", title: 'Titre', booster: 'Booster', credits: 'Crédits', dust: 'Poussière', card: 'Carte' };
const TEMPLATES = {
  halloween: { name: 'Halloween', icon: '🎃', tokenName: 'Bonbons', tokenIcon: '🍬', color: '#ff7a1a', rule: 'geants',
    desc: 'Les héros commencent avec 50 PV. Gagne des bonbons et dépense-les dans la boutique de l\'événement !' },
  noel: { name: 'Noël', icon: '🎄', tokenName: 'Cadeaux', tokenIcon: '🎁', color: '#2fbf71', rule: 'trombe',
    desc: 'Démarrage en trombe : les deux joueurs commencent avec 5 mana. Gagne des cadeaux pour la boutique de Noël !' },
  printemps: { name: 'Fête du printemps', icon: '🌸', tokenName: 'Pétales', tokenIcon: '🌸', color: '#ff7ab8', rule: 'braderie',
    desc: 'Grande braderie : toutes les cartes coûtent 1 mana de moins. Récolte des pétales !' },
  ete: { name: "Vacances d'été", icon: '🏖️', tokenName: 'Coquillages', tokenIcon: '🐚', color: '#22b8e6', rule: 'mini',
    desc: 'Mini-decks de 15 cartes. Ramasse des coquillages pour la boutique de la plage !' }
};

let data = null;
function load() {
  if (data) return data;
  data = readJSON(FILE, null) || {};
  if (!Array.isArray(data.events)) data.events = [];
  return data;
}
function save() { writeJSON(FILE, data); }
const clampInt = (v, min, max, def) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : def; };
const slug = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'evt';
function dayKey(now) { return new Date(now || Date.now()).toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' }); }

function all() { return load().events; }
function byId(id) { return load().events.find(e => e.id === id) || null; }
/* L'événement en cours (actif et dans ses dates) */
function current(now) {
  now = now || Date.now();
  return load().events.find(e => e.enabled !== false && e.startsAt <= now && now < e.endsAt) || null;
}

function cleanFields(e, b) {
  if (b.name !== undefined) { const n = String(b.name).trim().slice(0, 40); if (!n) return 'Donne un nom à l\'événement.'; e.name = n; }
  if (b.icon !== undefined) e.icon = String(b.icon).trim().slice(0, 4) || '🎉';
  if (b.desc !== undefined) e.desc = String(b.desc).trim().slice(0, 300);
  if (b.tokenName !== undefined) e.tokenName = String(b.tokenName).trim().slice(0, 20) || 'Jetons';
  if (b.tokenIcon !== undefined) e.tokenIcon = String(b.tokenIcon).trim().slice(0, 4) || '🪙';
  if (b.color !== undefined) e.color = /^#[0-9a-f]{6}$/i.test(b.color) ? b.color : (e.color || '#7a5cff');
  if (b.rule !== undefined) e.rule = b.rule ? String(b.rule) : null;
  if (b.tokensWin !== undefined) e.tokensWin = clampInt(b.tokensWin, 0, 1000, 10);
  if (b.tokensLoss !== undefined) e.tokensLoss = clampInt(b.tokensLoss, 0, 1000, 3);
  if (b.dailyCap !== undefined) e.dailyCap = clampInt(b.dailyCap, 1, 100000, 100);
  if (b.startsAt !== undefined) { const t = Date.parse(b.startsAt); if (!Number.isFinite(t)) return 'Date de début invalide.'; e.startsAt = t; }
  if (b.endsAt !== undefined) { const t = Date.parse(b.endsAt); if (!Number.isFinite(t)) return 'Date de fin invalide.'; e.endsAt = t; }
  if (e.endsAt <= e.startsAt) return 'La fin doit être après le début.';
  if (b.enabled !== undefined) e.enabled = !!b.enabled;
  return null;
}
function create(b) {
  const tpl = TEMPLATES[b.template] || {};
  const now = Date.now();
  const e = Object.assign({ icon: '🎉', tokenName: 'Jetons', tokenIcon: '🪙', color: '#7a5cff', rule: null, desc: '' }, tpl,
    { tokensWin: 10, tokensLoss: 3, dailyCap: 100, startsAt: now, endsAt: now + 14 * 86400000, enabled: true, shop: [] });
  const err = cleanFields(e, Object.assign({ name: tpl.name || 'Événement' }, b, { template: undefined }));
  if (err) return { error: err };
  let id = slug(e.name), n = 2;
  while (byId(id)) id = slug(e.name) + '-' + n++;
  e.id = id;
  load().events.push(e); save();
  return { ok: true, event: e };
}
function update(id, b) {
  const e = byId(id);
  if (!e) return { error: 'Événement introuvable.' };
  const copy = Object.assign({}, e);
  const err = cleanFields(copy, b);
  if (err) return { error: err };
  Object.assign(e, copy); save();
  return { ok: true, event: e };
}
function remove(id) {
  if (!byId(id)) return { error: 'Événement introuvable.' };
  data.events = data.events.filter(e => e.id !== id); save();
  return { ok: true };
}
/* Boutique : { kind, refId, amount, price, limit } */
function addItem(id, it) {
  const e = byId(id);
  if (!e) return { error: 'Événement introuvable.' };
  if (!KINDS[it.kind]) return { error: "Type d'article inconnu." };
  const item = { id: 'it-' + Math.random().toString(36).slice(2, 8), kind: it.kind, refId: it.refId ? String(it.refId).slice(0, 80) : null,
    amount: clampInt(it.amount, 1, 100000, 1), price: clampInt(it.price, 1, 1000000, 50), limit: clampInt(it.limit, 1, 999, 1), label: String(it.label || '').trim().slice(0, 60) };
  if (['banner', 'emote', 'board', 'ornament', 'card', 'title'].includes(item.kind) && !item.refId) return { error: 'Choisis l\'objet à vendre.' };
  if (['banner', 'emote', 'board', 'ornament', 'title'].includes(item.kind)) item.limit = 1;
  e.shop.push(item); save();
  return { ok: true, event: e };
}
function removeItem(id, itemId) {
  const e = byId(id);
  if (!e) return { error: 'Événement introuvable.' };
  e.shop = e.shop.filter(x => x.id !== itemId); save();
  return { ok: true, event: e };
}

/* Progression d'un joueur pour un événement */
function stateOf(user, ev, now) {
  if (!user.seasonal || typeof user.seasonal !== 'object') user.seasonal = {};
  const st = user.seasonal[ev.id] = user.seasonal[ev.id] || { tokens: 0, earned: 0, wins: 0, games: 0, bought: {}, day: null, today: 0 };
  const d = dayKey(now);
  if (st.day !== d) { st.day = d; st.today = 0; }
  return st;
}
/* Fin d'un combat de l'événement : jetons gagnés (plafond du jour) */
function recordResult(user, ev, won, now) {
  const st = stateOf(user, ev, now);
  st.games++; if (won) st.wins++;
  const base = won ? ev.tokensWin : ev.tokensLoss;
  const gain = Math.max(0, Math.min(base, ev.dailyCap - st.today));
  st.tokens += gain; st.earned += gain; st.today += gain;
  return { won, gain, tokens: st.tokens, capped: gain < base, tokenName: ev.tokenName, tokenIcon: ev.tokenIcon, eventName: ev.name };
}
/* Achat : vérifie et débite ; la remise de l'objet est faite par le serveur (grant) */
function buy(user, ev, itemId, now) {
  const it = (ev.shop || []).find(x => x.id === itemId);
  if (!it) return { error: 'Article introuvable.' };
  const st = stateOf(user, ev, now);
  if ((st.bought[it.id] || 0) >= it.limit) return { error: 'Tu as déjà acheté cet article (limite atteinte).' };
  if (st.tokens < it.price) return { error: `Il te manque ${it.price - st.tokens} ${ev.tokenName.toLowerCase()}.` };
  return { ok: true, item: it, commit: () => { st.tokens -= it.price; st.bought[it.id] = (st.bought[it.id] || 0) + 1; } };
}
function view(user, ev, now) {
  if (!ev) return null;
  const st = stateOf(user, ev, now);
  return {
    id: ev.id, name: ev.name, icon: ev.icon, desc: ev.desc, color: ev.color, tokenName: ev.tokenName, tokenIcon: ev.tokenIcon,
    rule: ev.rule, startsAt: ev.startsAt, endsAt: ev.endsAt, tokensWin: ev.tokensWin, tokensLoss: ev.tokensLoss, dailyCap: ev.dailyCap,
    tokens: st.tokens, today: st.today, wins: st.wins, games: st.games,
    shop: (ev.shop || []).map(it => Object.assign({}, it, { bought: st.bought[it.id] || 0 }))
  };
}
function _reset() { data = null; }

module.exports = { KINDS, TEMPLATES, all, byId, current, create, update, remove, addItem, removeItem, stateOf, recordResult, buy, view, dayKey, _reset };

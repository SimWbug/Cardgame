/* ======================================================
   Codes de deck
   Un deck se partage avec un code court (ex. « CG-7KX2QM ») : le même deck
   donne toujours le même code. Celui qui l'importe récupère les cartes qu'il
   possède, et le jeu lui liste celles qui lui manquent.
   ====================================================== */
const crypto = require('crypto');
const { readJSON, writeJSON } = require('./store');

const FILE = 'deckcodes.json';
const MAX_CODES = 5000;
const DECK_MAX = 30;
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // pas de 0/O ni de 1/I : plus facile à recopier

let store = null;
function load() {
  if (store) return store;
  const saved = readJSON(FILE, null);
  store = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  return store;
}
function save() { writeJSON(FILE, store); }

function codeFor(cardIds) {
  const h = crypto.createHash('sha1').update(cardIds.slice().sort().join('|')).digest();
  let s = '';
  for (let i = 0; i < 6; i++) s += ALPHABET[h[i] % ALPHABET.length];
  return 'CG-' + s;
}
/* « cg 7kx2qm », « 7KX2QM », « CG-7KX2QM » → « CG-7KX2QM » */
function normalize(raw) {
  const s = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const body = s.startsWith('CG') && s.length === 8 ? s.slice(2) : s;
  return body.length === 6 ? 'CG-' + body : null;
}

/* Vérifie la liste de cartes : de 1 à 30 cartes qui existent, limites d'exemplaires respectées */
function check(cardIds, cardById, limits) {
  if (!Array.isArray(cardIds) || !cardIds.length) return { error: 'Le deck est vide.' };
  if (cardIds.length > DECK_MAX) return { error: `Un deck a au plus ${DECK_MAX} cartes.` };
  const counts = {};
  for (const id of cardIds) {
    const c = cardById(id);
    if (!c) return { error: "Ce deck contient une carte qui n'existe plus." };
    counts[id] = (counts[id] || 0) + 1;
    if (counts[id] > ((limits && limits[c.rarity]) || 2)) return { error: `Trop d'exemplaires de « ${c.name} ».` };
  }
  return { ok: true };
}

function create(cardIds, name, bySlug, byPseudo, cardById, limits) {
  const ok = check(cardIds, cardById, limits);
  if (ok.error) return ok;
  const s = load();
  const code = codeFor(cardIds);
  const prev = s[code];
  s[code] = { cardIds: cardIds.slice(), name: String(name || '').trim().slice(0, 40) || (prev && prev.name) || 'Deck partagé',
    by: prev ? prev.by : bySlug, byPseudo: prev ? prev.byPseudo : byPseudo, at: Date.now(), uses: prev ? prev.uses || 0 : 0 };
  const keys = Object.keys(s);
  if (keys.length > MAX_CODES) keys.sort((a, b) => s[a].at - s[b].at).slice(0, keys.length - MAX_CODES).forEach(k => { delete s[k]; });
  save();
  return { ok: true, code };
}

/* Ce que donne le code pour un joueur : cartes qu'il a, cartes qui lui manquent */
function resolve(raw, collection, cardById, opts) {
  const code = normalize(raw);
  if (!code) return { error: 'Code invalide : il ressemble à « CG-7KX2QM ».' };
  const d = load()[code];
  if (!d) return { error: 'Aucun deck ne correspond à ce code.' };
  if (opts && opts.countUse) { d.uses = (d.uses || 0) + 1; save(); }
  const need = {};
  d.cardIds.forEach(id => { need[id] = (need[id] || 0) + 1; });
  const cards = [], missing = [], usable = [];
  Object.keys(need).forEach(id => {
    const c = cardById(id);
    if (!c) return;
    const have = Math.max(0, Number((collection || {})[id]) || 0);
    const take = Math.min(have, need[id]);
    for (let i = 0; i < take; i++) usable.push(id);
    cards.push({ id, name: c.name, cost: c.cost, rarity: c.rarity, need: need[id], have });
    if (have < need[id]) missing.push({ id, name: c.name, rarity: c.rarity, count: need[id] - have });
  });
  cards.sort((a, b) => (a.cost - b.cost) || a.name.localeCompare(b.name));
  return { ok: true, code, name: d.name, byPseudo: d.byPseudo || null, total: d.cardIds.length, cards, missing, usable, uses: d.uses || 0 };
}
function _reset() { store = null; }

module.exports = { codeFor, normalize, check, create, resolve, _reset, DECK_MAX };

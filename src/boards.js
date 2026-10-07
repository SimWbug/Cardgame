/* ======================================================
   Plateaux de combat personnalisés
   - « Classique » : le plateau en bois dessiné par le jeu, toujours possédé
   - les autres sont des images ajoutées par l'admin et vendues en crédits :
     une version PC (modèle 2480×2008) et, en option, une version téléphone
     (modèle 1095×2436) ; sans version téléphone, l'image PC est recadrée
   - chaque joueur choisit son plateau ; il le voit dans tous ses combats
   ====================================================== */
const { readJSON, writeJSON } = require('./store');

const FILE = 'boards.json';
const DEFAULT_ID = 'classique';
// Plateaux fournis avec le jeu (ajoutés au catalogue s'ils n'y sont pas encore)
const BUILTIN = [
  { id: 'halloween', name: "Nuit d'Halloween", image: '/boards/halloween.webp', thumb: '/boards/halloween-mini.webp', price: 800, enabled: true, builtin: true, createdAt: 1791324000000 }
];

let list = null, seeded = [];
/* Fichier : { boards: [...], seeded: [ids des plateaux fournis déjà ajoutés une fois] }.
   Un plateau fourni supprimé par l'admin ne revient donc pas tout seul. */
function load() {
  if (list) return list;
  const saved = readJSON(FILE, null);
  list = saved && Array.isArray(saved.boards) ? saved.boards : [];
  seeded = saved && Array.isArray(saved.seeded) ? saved.seeded : [];
  let changed = !saved;
  BUILTIN.forEach(b => {
    if (seeded.includes(b.id)) return;
    seeded.push(b.id); changed = true;
    if (!list.some(x => x.id === b.id)) list.push(Object.assign({}, b));
  });
  if (changed) save();
  return list;
}
function save() { writeJSON(FILE, { boards: list, seeded }); }

const slugify = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'plateau';
const cleanPrice = p => Math.max(0, Math.min(1000000, Math.round(Number(p) || 0)));

function all() { return load(); }
function byId(id) { return load().find(b => b.id === id) || null; }
/* Catalogue vu par les joueurs : le plateau classique + les plateaux actifs */
function catalog() {
  return [{ id: DEFAULT_ID, name: 'Classique', image: null, price: 0, enabled: true, builtin: true }]
    .concat(load().filter(b => b.enabled !== false).map(b => ({ id: b.id, name: b.name, image: b.image, imageMobile: b.imageMobile || null, imageMulligan: b.imageMulligan || null, music: b.music || null, thumb: b.thumb || b.image, price: b.price })));
}
function add({ name, image, imageMobile, imageMulligan, music, price }) {
  if (!String(name || '').trim()) return { error: 'Donne un nom au plateau.' };
  if (!image) return { error: 'Ajoute une image.' };
  let id = slugify(name), n = 2;
  while (id === DEFAULT_ID || byId(id)) id = slugify(name) + '-' + n++;
  const b = { id, name: String(name).trim().slice(0, 40), image, imageMobile: imageMobile || null, imageMulligan: imageMulligan || null, music: music || null, thumb: image, price: cleanPrice(price), enabled: true, createdAt: Date.now() };
  load().push(b); save();
  return { ok: true, board: b };
}
function update(id, patch) {
  const b = byId(id);
  if (!b) return { error: 'Plateau introuvable.' };
  if (patch.name !== undefined) { if (!String(patch.name).trim()) return { error: 'Le nom ne peut pas être vide.' }; b.name = String(patch.name).trim().slice(0, 40); }
  if (patch.price !== undefined) b.price = cleanPrice(patch.price);
  if (patch.enabled !== undefined) b.enabled = !!patch.enabled;
  if (patch.image) { b.image = patch.image; b.thumb = patch.image; }
  if (patch.imageMobile) b.imageMobile = patch.imageMobile;
  if (patch.removeMobile) b.imageMobile = null;
  if (patch.imageMulligan) b.imageMulligan = patch.imageMulligan;
  if (patch.removeMulligan) b.imageMulligan = null;
  if (patch.music) b.music = patch.music;
  if (patch.removeMusic) b.music = null;
  save();
  return { ok: true, board: b };
}
function remove(id) {
  const b = byId(id);
  if (!b) return { error: 'Plateau introuvable.' };
  list = load().filter(x => x.id !== id);
  save();
  return { ok: true };
}

/* Profil du joueur : plateaux possédés et plateau choisi */
function ensure(user) {
  if (!Array.isArray(user.ownedBoards)) user.ownedBoards = [];
  if (!user.board || (user.board !== DEFAULT_ID && (!user.ownedBoards.includes(user.board) || !byId(user.board)))) user.board = DEFAULT_ID;
  return user;
}
function owns(user, id) { return id === DEFAULT_ID || (user.ownedBoards || []).includes(id); }
function grant(user, id) {
  ensure(user);
  if (!byId(id) || user.ownedBoards.includes(id)) return false;
  user.ownedBoards.push(id);
  return true;
}
function _reset() { list = null; seeded = []; }

module.exports = { DEFAULT_ID, BUILTIN, all, byId, catalog, add, update, remove, ensure, owns, grant, _reset };

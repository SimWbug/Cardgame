/* ======================================================
   Provocations animées (« autocollants »)
   Une provocation peut avoir une icône (un emoji) et une animation :
   en combat, l'icône apparaît en grand près du héros et s'anime,
   avec le texte dans une bulle. Quelques-unes sont fournies avec le jeu
   et vendues en poussière dans Boutique → Provocations.
   ====================================================== */
const { readJSON, writeJSON } = require('./store');

const ANIMS = {
  bounce: 'Rebond', shake: 'Tremblement', spin: 'Tourbillon', pulse: 'Battement',
  rain: 'Pluie', float: 'Flottement', zoom: 'Explosion'
};
const BUILTIN = [
  { id: 'st-rire', text: 'Mort de rire !', icon: '😂', anim: 'shake', price: 120, tone: 'piquant' },
  { id: 'st-feu', text: 'Je suis en feu !', icon: '🔥', anim: 'rain', price: 160, tone: 'fier' },
  { id: 'st-roi', text: 'Qui est le roi ?', icon: '👑', anim: 'spin', price: 180, tone: 'fier' },
  { id: 'st-larmes', text: 'Pitié…', icon: '😭', anim: 'rain', price: 120, tone: 'neutre' },
  { id: 'st-cerveau', text: 'Big brain.', icon: '🧠', anim: 'pulse', price: 100, tone: 'fier' },
  { id: 'st-respect', text: 'Respect.', icon: '🫡', anim: 'bounce', price: 80, tone: 'amical' },
  { id: 'st-dodo', text: 'Tu joues quand ?', icon: '😴', anim: 'float', price: 100, tone: 'piquant' },
  { id: 'st-boom', text: 'BOUM !', icon: '💥', anim: 'zoom', price: 140, tone: 'fier' },
  { id: 'st-coeur', text: 'Bisous !', icon: '😘', anim: 'rain', price: 90, tone: 'amical' }
];
const SEED_FILE = 'emote-stickers.json';

/* Ajoute une fois les provocations animées fournies (une provocation supprimée
   par l'admin ne revient pas toute seule) */
function seed(db) {
  const saved = readJSON(SEED_FILE, null);
  const seeded = saved && Array.isArray(saved.seeded) ? saved.seeded : [];
  let changed = !saved;
  BUILTIN.forEach(st => {
    if (seeded.includes(st.id)) return;
    seeded.push(st.id); changed = true;
    if (!db.emoteById(st.id) && !db.getEmotePool().some(e => e.text.toLowerCase() === st.text.toLowerCase())) db.addEmote(Object.assign({}, st));
  });
  if (changed) writeJSON(SEED_FILE, { seeded });
}

/* Icône : un emoji ou un symbole court (pas de HTML) */
function cleanIcon(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  if (/[<>"'&]/.test(s)) return null;
  return [...s].length <= 4 ? s : null;
}
function cleanAnim(v) { return ANIMS[v] ? v : ''; }

module.exports = { ANIMS, BUILTIN, seed, cleanIcon, cleanAnim };

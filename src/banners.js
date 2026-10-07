/* ======================================================
   Bannières de profil : fond décoratif de la fiche joueur.
   source : 'shop' (achetée en crédits), 'secret' (succès secret),
            'tournament' (offerte par un tournoi), 'community' (objectif de la semaine)
   bg : fond CSS (dégradés uniquement : rien à télécharger)
   ====================================================== */
const BANNERS = [
  { id: 'nuit-violette', name: 'Nuit violette', source: 'shop', price: 300, bg: 'linear-gradient(135deg,#2a1450 0%,#5b2a9e 55%,#1a0f33 100%)' },
  { id: 'aurore', name: 'Aurore', source: 'shop', price: 400, bg: 'linear-gradient(120deg,#ff7eb3 0%,#ff9a5a 45%,#6a3df0 100%)' },
  { id: 'braise', name: 'Braise', source: 'shop', price: 400, bg: 'radial-gradient(circle at 20% 120%,#ffb347 0%,#e2401c 35%,#3a0b05 80%)' },
  { id: 'ocean', name: 'Océan', source: 'shop', price: 400, bg: 'linear-gradient(160deg,#0b3d91 0%,#1fa2c9 50%,#0a1f3d 100%)' },
  { id: 'foret', name: 'Forêt profonde', source: 'shop', price: 400, bg: 'linear-gradient(150deg,#0f3d22 0%,#2f8f4e 50%,#0a1f12 100%)' },
  { id: 'neon', name: 'Néon', source: 'shop', price: 600, bg: 'linear-gradient(90deg,#00f0ff 0%,#7a2cff 50%,#ff2bd6 100%)' },
  { id: 'or-royal', name: 'Or royal', source: 'shop', price: 900, bg: 'linear-gradient(135deg,#5a3b06 0%,#d9a52b 40%,#fff1b8 55%,#b07a12 75%,#3d2703 100%)' },
  { id: 'galaxie', name: 'Galaxie', source: 'shop', price: 1200, bg: 'radial-gradient(circle at 30% 30%,rgba(255,255,255,.35) 0 2px,transparent 3px),radial-gradient(circle at 70% 60%,rgba(255,255,255,.3) 0 1.5px,transparent 2.5px),radial-gradient(ellipse at 60% 40%,#6b2fd6 0%,#1b0e4a 45%,#05030f 100%)' },
  // Bannières animées : une pluie de boosters, ou une pluie des 3 cartes de la vitrine du joueur
  { id: 'pluie-boosters', name: 'Pluie de boosters', source: 'shop', price: 1500, anim: 'boosters', bg: 'radial-gradient(ellipse at 50% 0%,#5b2a9e 0%,#2a1450 45%,#120a26 100%)' },
  { id: 'pluie-cartes', name: 'Pluie de cartes', source: 'shop', price: 2000, anim: 'cards', bg: 'radial-gradient(ellipse at 50% 0%,#1f4f9a 0%,#162a5a 45%,#0a1126 100%)' },
  { id: 'champion', name: 'Champion', source: 'tournament', bg: 'repeating-linear-gradient(45deg,rgba(255,215,90,.18) 0 12px,transparent 12px 24px),linear-gradient(135deg,#4a2a00 0%,#c08a1e 50%,#4a2a00 100%)' },
  { id: 'finaliste', name: 'Finaliste', source: 'tournament', bg: 'repeating-linear-gradient(-45deg,rgba(200,220,255,.16) 0 10px,transparent 10px 20px),linear-gradient(135deg,#1d2a44 0%,#7f93b8 50%,#1d2a44 100%)' },
  { id: 'communaute', name: 'Esprit de gang', source: 'community', bg: 'linear-gradient(135deg,#123a5a 0%,#2fb7a0 50%,#5a2bb0 100%)' },
  { id: 'fil-du-rasoir', name: 'Fil du rasoir', source: 'secret', bg: 'linear-gradient(115deg,#120208 0%,#7a0b1c 48%,#ff3d5a 50%,#7a0b1c 52%,#120208 100%)' },
  { id: 'intouchable', name: 'Intouchable', source: 'secret', bg: 'radial-gradient(circle at 50% 50%,#e8f7ff 0%,#7cc8ff 30%,#183a6b 75%,#081426 100%)' },
  { id: 'faucheuse', name: 'Faucheuse', source: 'secret', bg: 'linear-gradient(180deg,#000 0%,#1c1c1c 40%,#4b0f0f 100%)' },
  { id: 'veteran', name: 'Vétéran', source: 'secret', bg: 'repeating-linear-gradient(90deg,#3b3326 0 18px,#4a4030 18px 36px)' },
  { id: 'trefle', name: 'Trèfle à quatre feuilles', source: 'secret', bg: 'radial-gradient(circle at 25% 50%,#9dffb0 0 8%,transparent 9%),radial-gradient(circle at 75% 50%,#9dffb0 0 8%,transparent 9%),linear-gradient(135deg,#0d4a22 0%,#2fbf5a 100%)' },
  { id: 'survivant', name: 'Survivant', source: 'secret', bg: 'linear-gradient(160deg,#e8ecf2 0%,#8fa2b8 35%,#2b3a4d 70%,#0e141c 100%)' },
  { id: 'nuit-blanche', name: 'Nuit blanche', source: 'secret', bg: 'radial-gradient(circle at 80% 20%,#fff6c9 0 6%,transparent 7%),linear-gradient(180deg,#0a0f2c 0%,#1d2b6b 100%)' }
];
const SOURCE_LABELS = { shop: 'Boutique', secret: 'Succès secret', tournament: 'Tournoi', community: 'Objectif communautaire' };

function byId(id) { return BANNERS.find(b => b.id === id) || null; }
function ensure(user) {
  if (!Array.isArray(user.ownedBanners)) user.ownedBanners = [];
  if (user.banner && !user.ownedBanners.includes(user.banner)) user.banner = null;
  return user;
}
/* Ajoute une bannière (renvoie true si elle est nouvelle) */
function grant(user, id) {
  ensure(user);
  if (!byId(id) || user.ownedBanners.includes(id)) return false;
  user.ownedBanners.push(id);
  return true;
}
function catalog() { return BANNERS.map(b => Object.assign({ sourceLabel: SOURCE_LABELS[b.source] }, b)); }

module.exports = { BANNERS, SOURCE_LABELS, byId, ensure, grant, catalog };

/* ======================================================
   Statistiques de carrière et titres de joueur
   - recordMatch : met à jour la carrière après chaque combat (tous modes)
   - titlesFor   : titres débloqués (conditions intégrées + titres gagnés
                   par les succès et les tournois)
   ====================================================== */

function ensureCareer(user) {
  const c = user.career = user.career || {};
  ['games', 'wins', 'losses', 'bestStreak', 'curStreak', 'damage', 'kills'].forEach(k => { if (typeof c[k] !== 'number') c[k] = 0; });
  if (!c.byMode || typeof c.byMode !== 'object') c.byMode = {};
  if (!c.cards || typeof c.cards !== 'object') c.cards = {};
  if (!c.opponents || typeof c.opponents !== 'object') c.opponents = {};
  if (!Array.isArray(user.titlesEarned)) user.titlesEarned = [];
  return c;
}

/* report = bilan de deckstats.analyzeMatch ; opp = { slug, pseudo } */
function recordMatch(user, report, opp) {
  const c = ensureCareer(user);
  c.games++;
  const m = c.byMode[report.mode] = c.byMode[report.mode] || { w: 0, l: 0 };
  if (report.result === 'win') { c.wins++; m.w++; c.curStreak++; c.bestStreak = Math.max(c.bestStreak, c.curStreak); }
  else if (report.result === 'loss') { c.losses++; m.l++; c.curStreak = 0; }
  Object.keys(report.perCard || {}).forEach(id => {
    const s = report.perCard[id];
    if (s.played) c.cards[id] = (c.cards[id] || 0) + s.played;
    c.damage += s.damage || 0; c.kills += s.kills || 0;
  });
  // Adversaires : seulement les vrais joueurs (pas le bot ni les boss)
  if (opp && report.mode !== 'practice' && report.mode !== 'bot' && report.mode !== 'boss' && report.mode !== 'story') {
    const o = c.opponents[opp.slug] = c.opponents[opp.slug] || { pseudo: opp.pseudo, w: 0, l: 0 };
    o.pseudo = opp.pseudo;
    if (report.result === 'win') o.w++; else if (report.result === 'loss') o.l++;
  }
}

/* Résumé affiché dans Mon profil (et sur la fiche publique) */
function summary(user, cardById) {
  const c = ensureCareer(user);
  const topCard = Object.keys(c.cards).filter(id => cardById(id)).sort((a, b) => c.cards[b] - c.cards[a])[0];
  const opps = Object.keys(c.opponents).map(slug => Object.assign({ slug }, c.opponents[slug]));
  const fav = opps.slice().sort((a, b) => (b.w + b.l) - (a.w + a.l))[0];
  const nemesis = opps.filter(o => o.l > 0).sort((a, b) => (b.l - b.w) - (a.l - a.w) || b.l - a.l)[0];
  return {
    games: c.games, wins: c.wins, losses: c.losses,
    winRate: c.wins + c.losses ? Math.round(c.wins / (c.wins + c.losses) * 100) : 0,
    bestStreak: c.bestStreak, curStreak: c.curStreak, damage: c.damage, kills: c.kills,
    byMode: c.byMode,
    topCard: topCard ? { id: topCard, count: c.cards[topCard] } : null,
    favoriteOpponent: fav ? { pseudo: fav.pseudo, w: fav.w, l: fav.l } : null,
    nemesis: nemesis && nemesis.l > nemesis.w ? { pseudo: nemesis.pseudo, w: nemesis.w, l: nemesis.l } : null
  };
}

/* Titres intégrés : débloqués automatiquement selon la carrière */
const BUILTIN_TITLES = [
  { id: 'debutant', name: 'Nouvelle recrue', desc: 'Jouer son premier combat.', test: u => u.career.games >= 1 },
  { id: 'veteran', name: 'Vétéran', desc: 'Jouer 100 combats.', test: u => u.career.games >= 100 },
  { id: 'inarretable', name: 'Inarrêtable', desc: 'Gagner 5 combats de suite.', test: u => u.career.bestStreak >= 5 },
  { id: 'tueur-boss', name: 'Tueur de boss', desc: "Vaincre 3 boss (événement ou mode Histoire).", test: u => ((u.stats && u.stats.bossDefeats) || 0) + (u.storyCleared || []).length >= 3 },
  { id: 'heros-ville', name: 'Héros de la ville', desc: 'Terminer tous les chapitres ouverts du mode Histoire.', test: (u, ctx) => ctx.storyCount > 0 && (u.storyCleared || []).length >= ctx.storyCount },
  { id: 'maitre', name: 'Maître du gang', desc: 'Atteindre le rang Maître.', test: u => ((u.stats && u.stats.ranksReached) || []).some(r => (r && r.key) === 'maitre') },
  { id: 'bourreau', name: 'Bourreau', desc: 'Détruire 200 serviteurs.', test: u => u.career.kills >= 200 }
];

/* Tous les titres du joueur : intégrés débloqués + gagnés (succès, tournois) */
function titlesFor(user, ctx) {
  ensureCareer(user);
  const out = BUILTIN_TITLES.filter(t => { try { return t.test(user, ctx || {}); } catch (e) { return false; } })
    .map(t => ({ id: t.id, name: t.name, desc: t.desc, source: 'Succès de carrière' }));
  user.titlesEarned.forEach(t => { if (!out.some(x => x.id === t.id)) out.push(t); });
  return out;
}
/* Titre gagné par un succès ou un tournoi (« Champion d'automne »…) */
function grantTitle(user, title) {
  ensureCareer(user);
  if (!title || !title.name) return false;
  const id = title.id || ('t-' + String(title.name).toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').slice(0, 40));
  if (user.titlesEarned.some(t => t.id === id)) return false;
  user.titlesEarned.push({ id, name: String(title.name).slice(0, 40), desc: title.desc || '', source: title.source || '' });
  return true;
}

module.exports = { ensureCareer, recordMatch, summary, titlesFor, grantTitle, BUILTIN_TITLES };

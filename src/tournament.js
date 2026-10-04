/* ======================================================
   Tournoi : inscription, arbre à élimination directe, système « Prêt »
   - Un seul tournoi à la fois (current), l'historique garde les anciens.
   - Lancé par l'admin à partir de MIN_PLAYERS inscrits.
   - Arbre complété par des « exempts » quand le nombre n'est pas une
     puissance de 2 : un exempt passe directement au tour suivant.
   - Chaque match se lance quand LES DEUX joueurs ont cliqué « Prêt ».
   - Le vainqueur final reçoit l'ornement d'avatar exclusif du tournoi.
   Ce module ne gère que les données ; le serveur lance les combats.
   ====================================================== */
const { readJSON, writeJSON } = require('./store');

const MIN_PLAYERS = 4;
let data = readJSON('tournament.json', null);
if (!data || typeof data !== 'object') data = { tabEnabled: false, current: null, history: [] };
if (!Array.isArray(data.history)) data.history = [];
function save() { writeJSON('tournament.json', data); }
function get() { return data; }
const uid = p => p + '-' + Math.random().toString(36).slice(2, 10);

function setTabEnabled(on) { data.tabEnabled = !!on; save(); }

function create({ name, desc, rewardOrnamentId }) {
  if (data.current && ['registration', 'running'].includes(data.current.status)) return { error: 'Un tournoi est déjà en cours : termine-le ou annule-le d\'abord.' };
  if (data.current) archive();
  data.current = {
    id: uid('t'), name: String(name || 'Tournoi').slice(0, 80), desc: String(desc || '').slice(0, 400),
    rewardOrnamentId, status: 'registration', createdAt: Date.now(),
    players: [], rounds: [], champion: null
  };
  save();
  return { ok: true, tournament: data.current };
}

function register(user) {
  const t = data.current;
  if (!t || t.status !== 'registration') return { error: 'Les inscriptions ne sont pas ouvertes.' };
  if (t.players.some(p => p.slug === user.slug)) return { error: 'Tu es déjà inscrit.' };
  t.players.push({ slug: user.slug, pseudo: user.pseudo });
  save();
  return { ok: true };
}
function unregister(slug) {
  const t = data.current;
  if (!t || t.status !== 'registration') return { error: 'Les inscriptions sont fermées.' };
  t.players = t.players.filter(p => p.slug !== slug);
  save();
  return { ok: true };
}

function shuffle(a) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

/* Construit l'arbre complet. Les exempts (null) sont placés face aux premiers
   joueurs : il n'y a jamais deux exempts face à face. */
function start(rng) {
  const t = data.current;
  if (!t || t.status !== 'registration') return { error: 'Aucun tournoi en inscription.' };
  if (t.players.length < MIN_PLAYERS) return { error: `Il faut au moins ${MIN_PLAYERS} joueurs inscrits (actuellement ${t.players.length}).` };
  const seeds = rng ? t.players.slice() : shuffle(t.players);
  let size = 2; while (size < seeds.length) size *= 2;
  const slots = seeds.map(p => p.slug).concat(Array(size - seeds.length).fill(null));
  const rounds = [];
  const first = [];
  for (let i = 0; i < size / 2; i++) first.push(newMatch(slots[i], slots[size - 1 - i]));
  rounds.push(first);
  for (let n = size / 4; n >= 1; n /= 2) rounds.push(Array.from({ length: n }, () => newMatch(null, null)));
  t.rounds = rounds; t.status = 'running'; t.startedAt = Date.now();
  // Exempts : qualifiés d'office
  first.forEach((m, i) => { if (m.a && !m.b) settle(t, 0, i, m.a, true); else if (!m.a && m.b) settle(t, 0, i, m.b, true); });
  save();
  return { ok: true };
}
function newMatch(a, b) { return { id: uid('m'), a, b, winner: null, ready: {}, status: a && b ? 'pending' : 'waiting', matchId: null, bye: false }; }

/* Enregistre le vainqueur d'un match et le fait avancer dans l'arbre */
function settle(t, r, i, winner, bye) {
  const m = t.rounds[r][i];
  m.winner = winner; m.status = 'done'; m.bye = !!bye; m.ready = {}; m.matchId = null;
  if (r === t.rounds.length - 1) { t.champion = winner; t.status = 'finished'; t.finishedAt = Date.now(); return { champion: winner }; }
  const next = t.rounds[r + 1][Math.floor(i / 2)];
  if (i % 2 === 0) next.a = winner; else next.b = winner;
  if (next.a && next.b) next.status = 'pending';
  return { ok: true };
}

function find(matchRef) {
  const t = data.current; if (!t) return null;
  for (let r = 0; r < t.rounds.length; r++) for (let i = 0; i < t.rounds[r].length; i++) {
    const m = t.rounds[r][i];
    if (m.id === matchRef || (m.matchId && m.matchId === matchRef)) return { t, r, i, m };
  }
  return null;
}
/* Le match en attente d'un joueur (celui qu'il doit jouer maintenant) */
function currentMatchOf(slug) {
  const t = data.current; if (!t || t.status !== 'running') return null;
  for (let r = 0; r < t.rounds.length; r++) for (let i = 0; i < t.rounds[r].length; i++) {
    const m = t.rounds[r][i];
    if (!m.winner && (m.a === slug || m.b === slug)) return { t, r, i, m };
  }
  return null;
}

/* Le joueur se déclare prêt ; renvoie bothReady quand les deux le sont */
function setReady(slug, ready) {
  const f = currentMatchOf(slug);
  if (!f) return { error: "Tu n'as pas de match à jouer pour l'instant." };
  const { m } = f;
  if (!m.a || !m.b) return { error: 'Ton adversaire n\'est pas encore connu.' };
  if (m.status === 'playing') return { error: 'Le combat est déjà lancé.' };
  m.ready[slug] = !!ready;
  m.status = m.ready[m.a] && m.ready[m.b] ? 'ready' : 'pending';
  save();
  return { ok: true, bothReady: m.status === 'ready', match: m };
}
function markPlaying(matchRefId, gameMatchId) { const f = find(matchRefId); if (!f) return; f.m.status = 'playing'; f.m.matchId = gameMatchId; save(); }
function resetReady(matchRefId) { const f = find(matchRefId); if (!f) return; f.m.ready = {}; f.m.status = 'pending'; f.m.matchId = null; save(); }

/* Résultat d'un combat de tournoi (ou désignation par l'admin) */
function reportWinner(matchRef, winnerSlug) {
  const f = find(matchRef);
  if (!f || f.m.winner) return { error: 'Match introuvable ou déjà terminé.' };
  if (winnerSlug !== f.m.a && winnerSlug !== f.m.b) return { error: 'Ce joueur ne fait pas partie de ce match.' };
  const res = settle(f.t, f.r, f.i, winnerSlug, false);
  save();
  return Object.assign({ ok: true }, res);
}

function cancel() {
  const t = data.current;
  if (!t) return { error: 'Aucun tournoi.' };
  t.status = 'cancelled';
  archive();
  return { ok: true };
}
function archive() {
  const t = data.current; if (!t) return;
  data.history.unshift({ id: t.id, name: t.name, status: t.status, champion: t.champion,
    championPseudo: (t.players.find(p => p.slug === t.champion) || {}).pseudo || null,
    rewardOrnamentId: t.rewardOrnamentId, players: t.players.length, finishedAt: t.finishedAt || Date.now() });
  data.history = data.history.slice(0, 30);
  data.current = null;
  save();
}

module.exports = { MIN_PLAYERS, get, setTabEnabled, create, register, unregister, start, setReady, markPlaying, resetReady,
  reportWinner, cancel, archive, currentMatchOf, find };

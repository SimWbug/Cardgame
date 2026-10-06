/* ======================================================
   Objectif communautaire de la semaine
   - chaque lundi (heure de Paris), un nouvel objectif est tiré au hasard
   - tous les joueurs y contribuent avec leurs combats et leurs boosters
   - objectif atteint : chaque participant reçoit un booster et des crédits
     (ceux qui participent après coup le reçoivent à leur première contribution)
   ====================================================== */
const { readJSON, writeJSON } = require('./store');

const FILE = 'community.json';
const GOALS = [
  { type: 'destroy_minions', label: n => `Détruire ${n} serviteurs ennemis`, base: 150, icon: '💀' },
  { type: 'play_spells', label: n => `Lancer ${n} sorts`, base: 120, icon: '✨' },
  { type: 'play_minions', label: n => `Poser ${n} serviteurs`, base: 250, icon: '🃏' },
  { type: 'deal_damage', label: n => `Infliger ${n} dégâts`, base: 2500, icon: '⚔️' },
  { type: 'win_games', label: n => `Gagner ${n} combats`, base: 40, icon: '🏆' },
  { type: 'play_games', label: n => `Jouer ${n} combats`, base: 70, icon: '🎮' },
  { type: 'open_boosters', label: n => `Ouvrir ${n} boosters`, base: 60, icon: '🎁' },
  { type: 'survival_rounds', label: n => `Gagner ${n} manches de Survie`, base: 30, icon: '🏔️' }
];
const REWARD = { credits: 100, booster: true };

let data = null;
function load() {
  if (!data) data = readJSON(FILE, null) || {};
  if (!data.contributors) data.contributors = {};
  if (!Array.isArray(data.rewarded)) data.rewarded = [];
  if (!Array.isArray(data.history)) data.history = [];
  return data;
}
function save() { writeJSON(FILE, data); }
function _reset() { data = {}; }

/* Clé de la semaine : date du lundi, heure de Paris (AAAA-MM-JJ) */
function weekKey(now) {
  const d = new Date(now || Date.now());
  const ymd = d.toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' }); // AAAA-MM-JJ
  const [y, m, day] = ymd.split('-').map(Number);
  const utc = new Date(Date.UTC(y, m - 1, day));
  const dow = (utc.getUTCDay() + 6) % 7; // lundi = 0
  utc.setUTCDate(utc.getUTCDate() - dow);
  return utc.toISOString().slice(0, 10);
}
/* Fin de la semaine en cours (lundi suivant, minuit à Paris ≈ 22 h/23 h UTC la veille) */
function weekEndsAt(key) {
  const d = new Date(key + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 7);
  // Décalage de Paris ce jour-là (1 h ou 2 h)
  const off = new Date(d).toLocaleString('en-US', { timeZone: 'Europe/Paris', hour12: false, hour: '2-digit' });
  return d.getTime() - (Number(off) || 0) * 3600000;
}
const nice = n => n >= 1000 ? Math.round(n / 100) * 100 : n >= 100 ? Math.round(n / 10) * 10 : Math.max(5, Math.round(n / 5) * 5);

/* Tire un objectif pour la semaine si elle a changé. players = nombre de joueurs inscrits. */
function ensureWeek(players, rng, now) {
  const d = load();
  const key = weekKey(now);
  if (d.weekKey === key && d.goal) return d;
  if (d.weekKey && d.goal) {
    d.history.unshift({ weekKey: d.weekKey, label: d.goal.text, target: d.goal.target, progress: d.progress || 0, completed: !!d.completedAt, players: Object.keys(d.contributors).length });
    d.history = d.history.slice(0, 8);
  }
  rng = rng || Math.random;
  const prevType = d.goal && d.goal.type;
  const choices = GOALS.filter(g => g.type !== prevType);
  const g = choices[Math.floor(rng() * choices.length)];
  const scale = Math.max(0.6, Math.min(4, (Number(players) || 6) / 6));
  const target = nice(g.base * scale);
  d.weekKey = key;
  d.goal = { type: g.type, target, text: g.label(target), icon: g.icon };
  d.progress = 0; d.contributors = {}; d.rewarded = []; d.completedAt = null;
  save();
  return d;
}

/* deltas = { destroy_minions: 3, play_spells: 2, … } d'un joueur.
   Renvoie la liste des joueurs à récompenser maintenant. */
function contribute(slug, deltas) {
  const d = load();
  if (!d.goal) return { reward: [] };
  const n = Math.max(0, Math.round(Number((deltas || {})[d.goal.type]) || 0));
  if (!n) return { reward: [] };
  d.progress = (d.progress || 0) + n;
  d.contributors[slug] = (d.contributors[slug] || 0) + n;
  const reward = [];
  let completedNow = false;
  if (!d.completedAt && d.progress >= d.goal.target) {
    d.completedAt = Date.now(); completedNow = true;
    Object.keys(d.contributors).forEach(s => { if (!d.rewarded.includes(s)) { d.rewarded.push(s); reward.push(s); } });
  } else if (d.completedAt && !d.rewarded.includes(slug)) {
    d.rewarded.push(slug); reward.push(slug);
  }
  save();
  return { reward, completedNow };
}

function view(slug) {
  const d = load();
  if (!d.goal) return null;
  const top = Object.keys(d.contributors).map(s => ({ slug: s, amount: d.contributors[s] })).sort((a, b) => b.amount - a.amount).slice(0, 3);
  return {
    weekKey: d.weekKey, endsAt: weekEndsAt(d.weekKey), goal: d.goal, progress: Math.min(d.progress || 0, d.goal.target), rawProgress: d.progress || 0,
    completed: !!d.completedAt, players: Object.keys(d.contributors).length, mine: d.contributors[slug] || 0,
    rewarded: d.rewarded.includes(slug), reward: REWARD, top, history: d.history.slice(0, 4)
  };
}

module.exports = { GOALS, REWARD, weekKey, weekEndsAt, ensureWeek, contribute, view, _reset, load };

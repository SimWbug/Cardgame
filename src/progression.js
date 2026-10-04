/* ======================================================
   PROGRESSION : niveaux de compte, défis du jour, évolution des cartes
   - XP gagnée en combattant (tous modes), en ouvrant des boosters, en
     débloquant des succès et en réussissant les défis du jour.
   - Chaque niveau donne une récompense (crédits, poussière, booster, titre,
     contour d'avatar exclusif).
   - 3 défis du jour, générés automatiquement chaque jour pour chaque joueur.
   - Évolution des cartes : plus on joue une carte, plus son cadre devient
     prestigieux (Bronze, Argent, Or, Légende), avec de la poussière à chaque palier.
   Les notifications (niveau gagné, défi réussi, carte évoluée…) sont posées
   dans user.notices et affichées par le client.
   ====================================================== */
const LEVEL_MAX = Infinity; // pas de niveau maximum : on peut monter indéfiniment
const xpForLevel = n => 100 + (n - 1) * 40; // XP pour passer du niveau n au niveau n+1

const XP = { pvpWin: 50, pvpLoss: 20, tournament: 40, storyWin: 35, storyLoss: 10, botWin: 15, botLoss: 5, practice: 10, booster: 10, achievement: 50 };

/* Contours exclusifs de niveau (dessinés en CSS, jamais vendus) */
const LEVEL_ORNAMENTS = [
  { level: 10, id: 'lvl-10', name: "Anneau d'émeraude", css: 'orn-lvl10', desc: 'Récompense du niveau 10.' },
  { level: 25, id: 'lvl-25', name: 'Couronne de braise', css: 'orn-lvl25', desc: 'Récompense du niveau 25.' },
  { level: 50, id: 'lvl-50', name: 'Halo prismatique', css: 'orn-lvl50', desc: 'Récompense du niveau 50, le maximum.' }
];
const LEVEL_TITLES = { 5: 'Habitué', 15: 'Pilier du gang', 20: 'Vétéran', 30: 'Légende du quartier', 40: 'Intouchable' };

/* Récompense d'un niveau atteint */
function rewardFor(level) {
  const orn = LEVEL_ORNAMENTS.find(o => o.level === level);
  if (orn) return { kind: 'ornament', ornamentId: orn.id, label: `Contour « ${orn.name} »` };
  if (LEVEL_TITLES[level]) return { kind: 'title', title: LEVEL_TITLES[level], label: `Titre « ${LEVEL_TITLES[level]} »` };
  // Au-delà du niveau 50 : un titre de prestige tous les 50 niveaux (Prestige 2 au niveau 100, etc.)
  if (level > 50 && level % 50 === 0) { const t = `Prestige ${level / 50}`; return { kind: 'title', title: t, label: `Titre « ${t} »` }; }
  if (level % 3 === 0) return { kind: 'booster', label: 'Un booster' };
  if (level % 3 === 1) { const n = 50 + level * 5; return { kind: 'credits', amount: n, label: `${n} crédits` }; }
  const n = 40 + level * 5; return { kind: 'dust', amount: n, label: `${n} poussière` };
}

function ensure(user) {
  if (typeof user.xp !== 'number') user.xp = 0;
  if (typeof user.level !== 'number' || user.level < 1) user.level = 1;
  if (!Array.isArray(user.notices)) user.notices = [];
  if (!user.cardEvo || typeof user.cardEvo !== 'object') user.cardEvo = {}; // palier déjà récompensé par carte
  return user;
}
function notice(user, n) { ensure(user); user.notices.push(Object.assign({ at: Date.now() }, n)); user.notices = user.notices.slice(-30); }

/* Ajoute de l'XP ; gère les passages de niveau et leurs récompenses.
   apply(user, reward) est fourni par le serveur (booster, titre, contour…). */
function grantXp(user, amount, reason, apply) {
  ensure(user);
  const n = Math.max(0, Math.round(amount || 0));
  if (!n) return { gained: 0, levelUps: [] };
  user.xp += n;
  const ups = [];
  while (user.xp >= xpForLevel(user.level)) {
    user.xp -= xpForLevel(user.level);
    user.level++;
    const reward = rewardFor(user.level);
    if (apply) apply(user, reward);
    ups.push({ level: user.level, reward });
    notice(user, { kind: 'level', level: user.level, text: `Niveau ${user.level} atteint ! Récompense : ${reward.label}.` });
  }
  return { gained: n, levelUps: ups, reason };
}

/* ---------- Défis du jour ---------- */
const DAILY_TYPES = [
  { type: 'win_games', target: 2, text: n => `Gagner ${n} combats (hors entraînement)` },
  { type: 'play_games', target: 3, text: n => `Jouer ${n} combats` },
  { type: 'play_minions', target: 10, text: n => `Poser ${n} serviteurs` },
  { type: 'play_spells', target: 5, text: n => `Lancer ${n} sorts` },
  { type: 'deal_damage', target: 40, text: n => `Infliger ${n} dégâts avec tes cartes` },
  { type: 'destroy_minions', target: 6, text: n => `Détruire ${n} serviteurs ennemis` },
  { type: 'open_boosters', target: 2, text: n => `Ouvrir ${n} boosters` },
  { type: 'win_story', target: 1, text: () => 'Gagner un combat du mode Histoire' }
];
function dayKey(d) { d = d || new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function hash(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
/* 3 défis différents, tirés au sort chaque jour pour chaque joueur (toujours les mêmes dans la journée) */
function ensureDaily(user, today) {
  ensure(user);
  const key = today || dayKey();
  if (user.daily && user.daily.date === key) return user.daily;
  let seed = hash(key + user.slug);
  const pool = DAILY_TYPES.slice(), list = [];
  for (let i = 0; i < 3; i++) {
    const t = pool.splice(seed % pool.length, 1)[0];
    seed = hash(String(seed) + i);
    const reward = i === 1 ? { credits: 60 } : { xp: 120 };
    list.push({ id: t.type, type: t.type, target: t.target, text: t.text(t.target), progress: 0, done: false, reward });
  }
  user.daily = { date: key, list };
  return user.daily;
}
/* Avance les défis ; renvoie ceux qui viennent d'être réussis */
function progressDaily(user, deltas, apply) {
  const d = ensureDaily(user);
  const done = [];
  d.list.forEach(ch => {
    if (ch.done || !deltas[ch.type]) return;
    ch.progress = Math.min(ch.target, ch.progress + deltas[ch.type]);
    if (ch.progress >= ch.target) {
      ch.done = true;
      done.push(ch);
      if (ch.reward.credits) user.credits = (user.credits || 0) + ch.reward.credits;
      notice(user, { kind: 'daily', text: `Défi du jour réussi : ${ch.text} ! ${ch.reward.credits ? `+${ch.reward.credits} crédits` : `+${ch.reward.xp} XP`}` });
      if (ch.reward.xp) grantXp(user, ch.reward.xp, 'défi', apply);
    }
  });
  return done;
}

/* ---------- Évolution des cartes ---------- */
const EVO_TIERS = [
  { tier: 1, plays: 10, name: 'Bronze', dust: 10 },
  { tier: 2, plays: 30, name: 'Argent', dust: 25 },
  { tier: 3, plays: 75, name: 'Or', dust: 50 },
  { tier: 4, plays: 150, name: 'Légende', dust: 100 }
];
function evoTier(plays) { let t = 0; EVO_TIERS.forEach(x => { if ((plays || 0) >= x.plays) t = x.tier; }); return t; }
/* Après un combat : récompense les cartes qui viennent de passer un palier */
function checkCardEvolution(user, plays, cardName) {
  ensure(user);
  const out = [];
  Object.keys(plays || {}).forEach(id => {
    const t = evoTier(plays[id]);
    const already = user.cardEvo[id] || 0;
    if (t > already) {
      for (let k = already + 1; k <= t; k++) {
        const tier = EVO_TIERS[k - 1];
        user.dust = (user.dust || 0) + tier.dust;
        notice(user, { kind: 'evo', cardId: id, text: `${cardName(id) || 'Une carte'} évolue : cadre ${tier.name} ! +${tier.dust} poussière` });
        out.push({ id, tier: k });
      }
      user.cardEvo[id] = t;
    }
  });
  return out;
}

module.exports = { LEVEL_MAX, XP, xpForLevel, rewardFor, LEVEL_ORNAMENTS, LEVEL_TITLES, ensure, grantXp, notice,
  dayKey, ensureDaily, progressDaily, DAILY_TYPES, EVO_TIERS, evoTier, checkCardEvolution };

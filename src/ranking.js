/* Classement mensuel : cumul des points de victoire, distribution des
   récompenses au changement de mois, et remise à zéro de la saison. */
const { MONTHLY_REWARDS, rankFor } = require('./cards');
const achievementsEngine = require('./achievements');

function currentSeason(date) {
  const d = date || new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/* Renvoie le classement trié de la saison en cours. */
function buildLeaderboard(users) {
  return users
    .map(u => ({
      slug: u.slug, pseudo: u.pseudo, avatar: u.avatar || null,
      ornament: u.ornament || 'none',
      vp: u.seasonVP || 0, wins: u.seasonWins || 0, losses: u.seasonLosses || 0,
      rank: rankFor(u.seasonVP || 0)
    }))
    .sort((a, b) => b.vp - a.vp || b.wins - a.wins || a.pseudo.localeCompare(b.pseudo));
}

/* Si le mois a changé depuis la dernière clôture, on distribue les récompenses
   du podium et on remet les compteurs de saison à zéro. */
function closeSeasonIfNeeded(db) {
  const meta = db.getMeta();
  const season = currentSeason();
  if (meta.currentSeason === season) return null;

  // Première initialisation : pas de saison précédente à clôturer
  if (!meta.currentSeason) {
    meta.currentSeason = season;
    db.saveMeta(meta);
    return null;
  }

  const users = db.allUsers();
  const board = buildLeaderboard(users).filter(e => e.vp > 0);
  const podium = [];
  board.slice(0, MONTHLY_REWARDS.length).forEach((entry, i) => {
    const user = db.getUser(entry.slug);
    if (!user) return;
    const reward = MONTHLY_REWARDS[i];
    user.dust = (user.dust || 0) + reward;
    podium.push({ position: i + 1, pseudo: user.pseudo, slug: user.slug, vp: entry.vp, reward });
    if (i === 0) {
      // Succès "finir 1er du classement mensuel"
      achievementsEngine.ensureStatsFields(user);
      user.stats.monthlyTop1Count += 1;
      achievementsEngine.checkAchievements(user, db.getAchievements(), { cardPool: db.getCardPool() });
    }
    db.updateUser(user.slug, user);
  });

  // Archivage puis remise à zéro
  const history = meta.seasonHistory || [];
  history.unshift({ season: meta.currentSeason, podium, closedAt: Date.now() });
  meta.seasonHistory = history.slice(0, 12);

  users.forEach(u => {
    const user = db.getUser(u.slug);
    if (!user) return;
    user.lifetimeWins = (user.lifetimeWins || 0) + (user.seasonWins || 0);
    user.lifetimeLosses = (user.lifetimeLosses || 0) + (user.seasonLosses || 0);
    user.seasonVP = 0; user.seasonWins = 0; user.seasonLosses = 0;
    db.updateUser(user.slug, user);
  });

  meta.currentSeason = season;
  db.saveMeta(meta);
  return { closedSeason: history[0] };
}

module.exports = { currentSeason, buildLeaderboard, closeSeasonIfNeeded };

/* ----------------------------------------------------------------------
   Moteur de succès déblocables. Chaque succès (créé par l'admin) a une
   CONDITION à une seule "métrique" comparée à une cible. Les métriques
   lisent soit des compteurs cumulés sur le profil (user.stats), soit
   l'état courant (collection, rang). Ajouter un nouveau type de condition
   ne demande qu'une entrée dans CONDITION_TYPES et un cas dans
   evaluateCondition — le reste (déverrouillage, récompense, listing
   admin) est déjà générique.
   ---------------------------------------------------------------------- */

const RANK_ORDER = ['Bronze', 'Argent', 'Or', 'Diamant', 'Maître'];

/* Catalogue des types de condition disponibles, avec un libellé et le type
   de paramètre attendu — sert à construire le formulaire admin et à valider
   les succès créés. */
const CONDITION_TYPES = {
  cards_played_type: { label: 'Jouer des cartes d\'un type', paramType: 'cardType', targetLabel: 'Nombre de cartes jouées' },
  card_played_specific: { label: 'Jouer une carte précise', paramType: 'cardId', targetLabel: 'Nombre de fois jouée' },
  defeat_opponent: { label: 'Battre un adversaire précis', paramType: 'playerSlug', targetLabel: 'Nombre de victoires contre lui' },
  leaderboard_top1: { label: 'Finir 1er du classement mensuel', paramType: 'none', targetLabel: 'Nombre de fois 1er' },
  reach_rank: { label: 'Atteindre un rang', paramType: 'rank', targetLabel: 'Toujours 1 (atteint ou non)' },
  collection_complete: { label: 'Compléter une collection', paramType: 'extensionOrAll', targetLabel: 'Toujours 1 (complète ou non)' },
  credits_spent: { label: 'Dépenser des crédits', paramType: 'none', targetLabel: 'Montant total dépensé (🪙)' },
  dust_spent: { label: 'Dépenser de la poussière', paramType: 'none', targetLabel: 'Montant total dépensé (✧)' },
  total_wins: { label: 'Gagner des combats (classés)', paramType: 'none', targetLabel: 'Nombre de victoires' },
  boss_defeats: { label: 'Vaincre le boss d\'événement', paramType: 'none', targetLabel: 'Nombre de victoires contre le boss' },
  casino_jackpots: { label: 'Décrocher un jackpot au casino', paramType: 'none', targetLabel: 'Nombre de jackpots' }
};

function emptyStats() {
  return {
    cardsPlayedByType: {}, cardsPlayedById: {}, winsVsPlayer: {},
    creditsSpent: 0, dustSpent: 0, totalWins: 0, bossDefeats: 0, casinoJackpots: 0,
    monthlyTop1Count: 0, ranksReached: []
  };
}

/* S'assure qu'un profil chargé depuis un fichier plus ancien a bien tous
   les champs de suivi nécessaires, sans jamais écraser ce qui existe déjà. */
function ensureStatsFields(user) {
  if (!user.stats || typeof user.stats !== 'object') user.stats = emptyStats();
  const defaults = emptyStats();
  Object.keys(defaults).forEach(k => { if (user.stats[k] === undefined) user.stats[k] = defaults[k]; });
  if (!Array.isArray(user.achievementsUnlocked)) user.achievementsUnlocked = [];
}

function evaluateCondition(user, cond, ctx) {
  const stats = user.stats;
  switch (cond.type) {
    case 'cards_played_type':
      return (stats.cardsPlayedByType[cond.param] || 0) >= cond.target;
    case 'card_played_specific':
      return (stats.cardsPlayedById[cond.param] || 0) >= cond.target;
    case 'defeat_opponent':
      return (stats.winsVsPlayer[cond.param] || 0) >= cond.target;
    case 'leaderboard_top1':
      return (stats.monthlyTop1Count || 0) >= cond.target;
    case 'reach_rank': {
      const need = RANK_ORDER.indexOf(cond.param);
      if (need === -1) return false;
      return (stats.ranksReached || []).some(r => RANK_ORDER.indexOf(r) >= need);
    }
    case 'collection_complete': {
      if (!ctx || !ctx.cardPool) return false;
      const pool = cond.param === 'all' ? ctx.cardPool : ctx.cardPool.filter(c => (c.extensionId || 'base') === cond.param);
      return pool.length > 0 && pool.every(c => (user.collection[c.id] || 0) > 0);
    }
    case 'credits_spent': return (stats.creditsSpent || 0) >= cond.target;
    case 'dust_spent': return (stats.dustSpent || 0) >= cond.target;
    case 'total_wins': return (stats.totalWins || 0) >= cond.target;
    case 'boss_defeats': return (stats.bossDefeats || 0) >= cond.target;
    case 'casino_jackpots': return (stats.casinoJackpots || 0) >= cond.target;
    default: return false;
  }
}

/* Vérifie tous les succès non encore débloqués pour ce joueur, en débloque
   ceux dont la condition est désormais satisfaite (récompense créditée
   immédiatement), et renvoie la liste des succès NOUVELLEMENT débloqués
   (pour notifier le client). N'écrit rien sur disque : c'est à l'appelant
   de persister le user après coup, comme pour le reste du profil. */
function checkAchievements(user, definitions, ctx) {
  ensureStatsFields(user);
  const unlockedIds = new Set(user.achievementsUnlocked.map(a => a.id));
  const newly = [];
  definitions.forEach(def => {
    if (unlockedIds.has(def.id)) return;
    if (!def.condition || !CONDITION_TYPES[def.condition.type]) return;
    if (evaluateCondition(user, def.condition, ctx)) {
      user.achievementsUnlocked.push({ id: def.id, unlockedAt: Date.now() });
      user.credits += Math.max(0, Number(def.rewardCredits) || 0);
      user.dust += Math.max(0, Number(def.rewardDust) || 0);
      newly.push(def);
    }
  });
  return newly;
}

/* Progression 0-1 vers un succès non débloqué, pour l'affichage d'une barre
   de progression côté joueur. Les conditions "booléennes" (rang, collection,
   top1 au moins une fois) n'ont pas vraiment de progression graduelle : on
   renvoie 0 ou 1. */
function progressFor(user, cond, ctx) {
  if (!cond || !CONDITION_TYPES[cond.type]) return 0;
  const stats = user.stats || emptyStats();
  let current = 0;
  switch (cond.type) {
    case 'cards_played_type': current = stats.cardsPlayedByType[cond.param] || 0; break;
    case 'card_played_specific': current = stats.cardsPlayedById[cond.param] || 0; break;
    case 'defeat_opponent': current = stats.winsVsPlayer[cond.param] || 0; break;
    case 'leaderboard_top1': current = stats.monthlyTop1Count || 0; break;
    case 'credits_spent': current = stats.creditsSpent || 0; break;
    case 'dust_spent': current = stats.dustSpent || 0; break;
    case 'total_wins': current = stats.totalWins || 0; break;
    case 'boss_defeats': current = stats.bossDefeats || 0; break;
    case 'casino_jackpots': current = stats.casinoJackpots || 0; break;
    case 'reach_rank': case 'collection_complete':
      return evaluateCondition(user, cond, ctx) ? 1 : 0;
    default: return 0;
  }
  return Math.max(0, Math.min(1, current / (cond.target || 1)));
}

module.exports = { CONDITION_TYPES, RANK_ORDER, emptyStats, ensureStatsFields, evaluateCondition, checkAchievements, progressFor };

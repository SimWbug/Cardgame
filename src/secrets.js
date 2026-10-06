/* ======================================================
   100 succès secrets, générés automatiquement.
   Ils restent cachés (« ??? ») tant qu'ils ne sont pas débloqués.
   Chaque succès suit une « métrique » (compteur ou record) mise à jour par
   les combats (analyzeMatch) ou par des actions (boosters, échanges, chat…).
   ====================================================== */

/* Métriques « record » : on garde la meilleure valeur, pas un cumul */
const MAX_METRICS = ['kills_one_turn', 'plays_one_turn', 'survival_round', 'favorites', 'banners_owned'];

/* [métrique, [ [cible, nom, description], … ] ] */
const TABLE = [
  ['played', [
    [1, 'Premier pas', 'Jouer ton tout premier combat.'],
    [10, 'Habitué de la table', 'Jouer 10 combats.'],
    [50, 'Accro aux cartes', 'Jouer 50 combats.'],
    [100, 'Centurion', 'Jouer 100 combats.'],
    [250, 'Pilier du gang', 'Jouer 250 combats.'],
    [500, 'Légende vivante', 'Jouer 500 combats.']]],
  ['won', [
    [1, 'Goût de la victoire', 'Gagner un combat.'],
    [25, 'Ça devient une habitude', 'Gagner 25 combats.'],
    [100, 'Machine à gagner', 'Gagner 100 combats.'],
    [250, 'Inarrêtable', 'Gagner 250 combats.']]],
  ['losses', [
    [5, "L'apprentissage", 'Perdre 5 combats.'],
    [25, 'Toujours debout… ou presque', 'Perdre 25 combats.'],
    [100, 'Le courage de revenir', 'Perdre 100 combats.']]],
  ['win_low_hp3', [
    [1, 'Sueurs froides', 'Gagner un combat avec 3 PV ou moins.'],
    [5, 'Habitué du précipice', 'Gagner 5 combats avec 3 PV ou moins.']]],
  ['win_hp1', [
    [1, 'Sur le fil', 'Gagner un combat avec exactement 1 PV.']]],
  ['win_flawless', [
    [1, 'Sans une égratignure', 'Gagner un combat sans perdre le moindre PV.'],
    [5, 'Intouchable', 'Gagner 5 combats sans perdre le moindre PV.']]],
  ['win_comeback', [
    [1, 'Retour du diable', 'Gagner après être tombé à 5 PV ou moins.'],
    [10, 'Roi du comeback', 'Gagner 10 combats après être tombé à 5 PV ou moins.']]],
  ['win_fast', [
    [1, 'Éclair', 'Gagner en 6 tours ou moins.'],
    [5, 'Tempête', 'Gagner 5 combats en 6 tours ou moins.']]],
  ['win_long', [
    [1, 'Marathon', 'Gagner un combat qui a duré 30 tours ou plus.'],
    [5, 'Endurance infinie', 'Gagner 5 combats de 30 tours ou plus.']]],
  ['silence_own', [
    [1, 'Chut… toi aussi', 'Réduire au silence un de tes propres serviteurs.']]],
  ['silence_enemy', [
    [1, 'Bouche cousue', 'Réduire au silence un serviteur ennemi.'],
    [10, 'Bibliothécaire', 'Réduire au silence 10 serviteurs ennemis.'],
    [50, 'Le grand silence', 'Réduire au silence 50 serviteurs ennemis.']]],
  ['kills', [
    [10, 'Premiers trophées', 'Détruire 10 serviteurs ennemis.'],
    [100, 'Chasseur', 'Détruire 100 serviteurs ennemis.'],
    [500, 'Massacre', 'Détruire 500 serviteurs ennemis.'],
    [1000, 'La Faucheuse', 'Détruire 1 000 serviteurs ennemis.']]],
  ['kills_one_turn', [
    [3, 'Triplé', 'Détruire 3 serviteurs ennemis en un seul tour.'],
    [5, 'Grand ménage', 'Détruire 5 serviteurs ennemis en un seul tour.']]],
  ['plays_one_turn', [
    [4, 'Mains agiles', 'Jouer 4 cartes en un seul tour.'],
    [6, 'Feu d’artifice', 'Jouer 6 cartes en un seul tour.']]],
  ['spells_played', [
    [10, 'Apprenti sorcier', 'Lancer 10 sorts.'],
    [100, 'Mage confirmé', 'Lancer 100 sorts.'],
    [300, 'Archimage', 'Lancer 300 sorts.']]],
  ['minions_played', [
    [25, 'Recruteur', 'Poser 25 serviteurs.'],
    [200, 'Chef de bande', 'Poser 200 serviteurs.'],
    [600, 'Général', 'Poser 600 serviteurs.']]],
  ['weapons_played', [
    [5, 'Armurier', "S'équiper de 5 armes."],
    [50, 'Arsenal ambulant', "S'équiper de 50 armes."]]],
  ['board_full', [
    [1, 'Salle comble', 'Avoir 7 serviteurs sur ton plateau.'],
    [10, 'Embouteillage', 'Remplir ton plateau dans 10 combats.']]],
  ['big_minion', [
    [1, 'Colosse', 'Avoir un serviteur avec 10 ATQ ou plus.']]],
  ['face_damage', [
    [100, 'Droit au but', 'Infliger 100 dégâts aux héros adverses.'],
    [1000, 'Briseur de héros', 'Infliger 1 000 dégâts aux héros adverses.'],
    [5000, 'Fléau des héros', 'Infliger 5 000 dégâts aux héros adverses.']]],
  ['big_hit', [
    [1, 'Coup de massue', 'Infliger 10 dégâts ou plus en une seule attaque.'],
    [10, 'Démolisseur', 'Réussir 10 attaques de 10 dégâts ou plus.']]],
  ['heal_total', [
    [50, 'Infirmier', 'Rendre 50 PV.'],
    [500, 'Grand guérisseur', 'Rendre 500 PV.']]],
  ['armor_total', [
    [50, 'Blindé', "Gagner 50 points d'armure."],
    [500, 'Forteresse', "Gagner 500 points d'armure."]]],
  ['traps', [
    [1, "C'était un piège !", 'Déclencher un de tes pièges.'],
    [25, 'Maître des embuscades', 'Déclencher 25 de tes pièges.']]],
  ['combos', [
    [1, 'Duo de choc', 'Réussir un combo.'],
    [20, 'Chef d’orchestre', 'Réussir 20 combos.']]],
  ['deathrattles', [
    [10, 'Dernier souffle', "Déclencher 10 Râles d'agonie."],
    [100, 'Nécromancien', "Déclencher 100 Râles d'agonie."]]],
  ['standing_max', [
    [1, 'Indestructible', "Amener un serviteur « Toujours debout » à son niveau maximum."],
    [10, 'Les immortels', "Amener 10 serviteurs « Toujours debout » au niveau maximum."]]],
  ['sleeps', [
    [10, 'Marchand de sable', 'Endormir 10 serviteurs.'],
    [50, 'Berceuse fatale', 'Endormir 50 serviteurs.']]],
  ['destroys', [
    [10, 'Effaceur', 'Détruire 10 serviteurs avec un effet « Détruire ».']]],
  ['win_no_spell', [
    [1, 'Muscles seulement', 'Gagner un combat sans lancer un seul sort.'],
    [10, 'Allergique à la magie', 'Gagner 10 combats sans lancer un seul sort.']]],
  ['win_no_minion', [
    [1, 'Armée invisible', 'Gagner un combat sans poser un seul serviteur.']]],
  ['boss_wins', [
    [1, 'Tueur de boss', "Vaincre le boss d'événement."],
    [10, 'Chasseur de géants', "Vaincre 10 fois le boss d'événement."]]],
  ['story_wins', [
    [5, 'Conteur', 'Gagner 5 combats du mode Histoire.'],
    [30, 'Héros du quartier', 'Gagner 30 combats du mode Histoire.']]],
  ['survival_round', [
    [3, 'Survivant en herbe', 'Gagner 3 manches de Survie d’affilée.'],
    [5, 'Coriace', 'Gagner 5 manches de Survie d’affilée.'],
    [10, 'Increvable', 'Gagner 10 manches de Survie d’affilée.'],
    [15, 'Dernier debout', 'Gagner 15 manches de Survie d’affilée.'],
    [20, 'Le Survivant', 'Gagner 20 manches de Survie d’affilée.'],
    [30, 'Immortel', 'Gagner 30 manches de Survie d’affilée.']]],
  ['blitz_wins', [
    [1, 'Vif comme l’éclair', 'Gagner un combat Blitz.'],
    [10, 'Réflexes de chat', 'Gagner 10 combats Blitz.'],
    [50, 'Roi du Blitz', 'Gagner 50 combats Blitz.']]],
  ['tournament_wins', [
    [1, 'Premier tour passé', 'Gagner un match de tournoi.'],
    [5, 'Compétiteur', 'Gagner 5 matchs de tournoi.']]],
  ['night_wins', [
    [1, 'Oiseau de nuit', 'Gagner un combat entre minuit et 5 h.'],
    [10, 'Nuit blanche', 'Gagner 10 combats entre minuit et 5 h.']]],
  ['draws', [
    [1, 'Match nul', 'Finir un combat sur une égalité.']]],
  ['forfeit_wins', [
    [1, 'Il a pris la fuite', 'Gagner parce que ton adversaire a abandonné.']]],
  ['boosters_opened', [
    [10, 'Déballeur', 'Ouvrir 10 boosters.'],
    [100, 'Chasseur de cartes', 'Ouvrir 100 boosters.'],
    [500, 'Collectionneur fou', 'Ouvrir 500 boosters.']]],
  ['legendary_pulled', [
    [1, 'Brillant !', 'Obtenir une carte légendaire dans un booster.'],
    [10, 'Main en or', 'Obtenir 10 cartes légendaires dans des boosters.']]],
  ['double_legendary', [
    [1, 'Trèfle à quatre feuilles', 'Obtenir 2 légendaires dans le même booster.']]],
  ['trades_done', [
    [1, 'Marché conclu', 'Réussir un échange de cartes.'],
    [10, 'Négociant', 'Réussir 10 échanges de cartes.']]],
  ['chat_messages', [
    [50, 'Bavard', 'Envoyer 50 messages dans le chat.']]],
  ['favorites', [
    [10, 'Coup de cœur', 'Avoir 10 cartes favorites.']]],
  ['banners_owned', [
    [5, 'Décorateur', 'Posséder 5 bannières de profil.']]]
];

/* Récompenses spéciales (bannière et/ou titre) pour certains succès */
const SPECIAL = {
  'win_hp1:1': { banner: 'fil-du-rasoir', title: 'Sur le fil' },
  'win_flawless:5': { banner: 'intouchable' },
  'kills:1000': { banner: 'faucheuse', title: 'La Faucheuse' },
  'played:500': { banner: 'veteran', title: 'Légende vivante' },
  'double_legendary:1': { banner: 'trefle' },
  'survival_round:20': { banner: 'survivant' },
  'survival_round:30': { title: 'Immortel' },
  'night_wins:10': { banner: 'nuit-blanche' },
  'blitz_wins:50': { title: 'Roi du Blitz' }
};

/* Construction des 100 succès. Récompense selon la difficulté (rang dans la série). */
const DEFS = [];
TABLE.forEach(([metric, tiers]) => {
  tiers.forEach(([target, name, desc], i) => {
    const level = tiers.length === 1 ? 0.5 : i / (tiers.length - 1); // 0 = facile, 1 = dur (succès unique : moyen)
    const credits = Math.round((40 + 260 * level) / 5) * 5;
    const dust = Math.round((5 + 45 * level) / 5) * 5;
    const sp = SPECIAL[metric + ':' + target] || {};
    DEFS.push({ id: `sec-${metric}-${target}`, metric, target, name, desc, credits, dust, banner: sp.banner || null, title: sp.title || null });
  });
});

function ensure(user) {
  if (!user.secretStats || typeof user.secretStats !== 'object') user.secretStats = {};
  if (!Array.isArray(user.secretsUnlocked)) user.secretsUnlocked = [];
  return user;
}

/* Ajoute des valeurs aux métriques (cumul, ou record pour MAX_METRICS) puis
   débloque les succès atteints. onReward(user, def) applique la récompense.
   Renvoie les succès nouvellement débloqués. */
function record(user, facts, onReward) {
  ensure(user);
  const st = user.secretStats;
  Object.keys(facts || {}).forEach(k => {
    const v = Number(facts[k]) || 0;
    if (!v) return;
    if (MAX_METRICS.includes(k)) st[k] = Math.max(st[k] || 0, v);
    else st[k] = (st[k] || 0) + v;
  });
  const have = new Set(user.secretsUnlocked.map(x => x.id));
  const newly = [];
  DEFS.forEach(d => {
    if (have.has(d.id) || (st[d.metric] || 0) < d.target) return;
    user.secretsUnlocked.push({ id: d.id, at: Date.now() });
    user.credits = (user.credits || 0) + d.credits;
    user.dust = (user.dust || 0) + d.dust;
    if (onReward) onReward(user, d);
    newly.push(d);
  });
  return newly;
}

/* Ce que le joueur voit : les succès débloqués en clair, les autres cachés */
function viewFor(user) {
  ensure(user);
  const got = new Map(user.secretsUnlocked.map(x => [x.id, x.at]));
  return {
    total: DEFS.length,
    unlocked: DEFS.filter(d => got.has(d.id)).map(d => ({ id: d.id, name: d.name, desc: d.desc, at: got.get(d.id), credits: d.credits, dust: d.dust, banner: d.banner, title: d.title }))
      .sort((a, b) => b.at - a.at)
  };
}

/* ---------- Analyse d'un combat pour un joueur ---------- */
function parisHour(t) {
  return Number(new Date(t || Date.now()).toLocaleString('en-US', { timeZone: 'Europe/Paris', hour12: false, hour: '2-digit' })) % 24;
}
function analyzeMatch(match, playerIndex, mode, now) {
  const me = match.players[playerIndex], opp = match.players[1 - playerIndex];
  const evs = match.events || [];
  const won = match.winner === me.slug, lost = match.winner === opp.slug, draw = match.status === 'finished' && !match.winner;
  const f = { played: 1 };
  if (won) f.won = 1;
  if (lost) f.losses = 1;
  if (draw) f.draws = 1;
  const hp = me.heroHealth;
  const minHp = me.minHp == null ? Infinity : me.minHp;
  const myTurns = Math.ceil((match.turnNumber || 1) / 2);
  const playsByTurn = {}, killsByTurn = {};
  let spells = 0, minions = 0, weapons = 0;
  const kill = e => { killsByTurn[e.turn] = (killsByTurn[e.turn] || 0) + 1; };
  evs.forEach(e => {
    const mine = e.by === me.slug;
    if (e.type === 'play' && mine && e.card) {
      playsByTurn[e.turn] = (playsByTurn[e.turn] || 0) + 1;
      if (e.card.type === 'minion') minions++; else if (e.card.type === 'weapon') weapons++; else spells++;
    }
    if (e.type === 'attack' && mine) {
      if (e.target && e.target.kind === 'hero') f.face_damage = (f.face_damage || 0) + (e.dmg || 0);
      if (e.target && e.target.kind === 'minion' && e.targetDied) kill(e);
      if ((e.dmg || 0) >= 10) f.big_hit = (f.big_hit || 0) + 1;
    }
    if (e.type === 'damage' && mine) (e.targets || []).forEach(t => {
      if (t.kind === 'hero' && t.owner !== me.slug) f.face_damage = (f.face_damage || 0) + (t.amount || 0);
      if (t.kind === 'minion' && t.owner !== me.slug && t.died) kill(e);
    });
    if (e.type === 'destroy' && mine) (e.targets || []).forEach(t => { if (t.owner !== me.slug) { kill(e); f.destroys = (f.destroys || 0) + 1; } });
    if (e.type === 'heal' && mine) (e.targets || []).forEach(t => { f.heal_total = (f.heal_total || 0) + (t.amount || 0); });
    if (e.type === 'armor' && mine) (e.targets || []).forEach(t => { f.armor_total = (f.armor_total || 0) + (t.amount || 0); });
    if (e.type === 'trap' && mine) f.traps = (f.traps || 0) + 1;
    if (e.type === 'combo' && mine) f.combos = (f.combos || 0) + 1;
    if (e.type === 'deathrattle' && mine) f.deathrattles = (f.deathrattles || 0) + 1;
    if (e.type === 'levelup' && mine && e.level >= 3) f.standing_max = (f.standing_max || 0) + 1;
    if (e.type === 'sleep' && mine) f.sleeps = (f.sleeps || 0) + (e.targets || []).length;
    if (e.type === 'silence' && mine) (e.targets || []).forEach(t => {
      if (t.owner === me.slug) f.silence_own = (f.silence_own || 0) + 1; else f.silence_enemy = (f.silence_enemy || 0) + 1;
    });
  });
  const kills = Object.values(killsByTurn).reduce((a, b) => a + b, 0);
  if (kills) f.kills = kills;
  const maxKills = Math.max(0, ...Object.values(killsByTurn));
  if (maxKills) f.kills_one_turn = maxKills;
  const maxPlays = Math.max(0, ...Object.values(playsByTurn));
  if (maxPlays) f.plays_one_turn = maxPlays;
  if (spells) f.spells_played = spells;
  if (minions) f.minions_played = minions;
  if (weapons) f.weapons_played = weapons;
  if ((me.maxBoard || 0) >= 7) f.board_full = 1;
  if ((me.maxMinionAtk || 0) >= 10) f.big_minion = 1;
  if (won) {
    if (hp <= 3) f.win_low_hp3 = 1;
    if (hp === 1) f.win_hp1 = 1;
    if (minHp === Infinity) f.win_flawless = 1;
    if (minHp <= 5) f.win_comeback = 1;
    if (myTurns <= 6 && !match.forfeitBy) f.win_fast = 1;
    if ((match.turnNumber || 0) >= 30) f.win_long = 1;
    if (!spells) f.win_no_spell = 1;
    if (!minions) f.win_no_minion = 1;
    if (mode === 'boss') f.boss_wins = 1;
    if (mode === 'story') f.story_wins = 1;
    if (mode === 'blitz') f.blitz_wins = 1;
    if (mode === 'tournament') f.tournament_wins = 1;
    if (parisHour(now) < 5) f.night_wins = 1;
    if (match.forfeitBy === opp.slug) f.forfeit_wins = 1;
  }
  return f;
}

module.exports = { DEFS, TABLE, MAX_METRICS, ensure, record, viewFor, analyzeMatch, parisHour };

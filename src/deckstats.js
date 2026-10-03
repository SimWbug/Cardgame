/* ======================================================
   Statistiques et analyse de deck (onglet Collection → Stats du deck)
   - analyzeMatch : bilan d'un combat pour un joueur, à partir du journal
     d'événements (cartes jouées, dégâts, éliminations, mana utilisée…)
   - analyzeDeck  : composition d'un deck (courbe, rôles) et conseils
   - suggestCards : cartes de la collection (puis du jeu) qui comblent les
     manques du deck ou créent une synergie
   Fonctions pures, sans accès à la base : faciles à tester.
   ====================================================== */

const REMOVAL = ['damage', 'destroy', 'aoe_damage', 'damage_all', 'board_wipe', 'sleep'];
const isSpell = c => c && c.type !== 'minion' && c.type !== 'weapon';
const effectsOf = c => [c.effectType, c.bcEffect].filter(Boolean);

function blankCardStat() { return { played: 0, damage: 0, kills: 0, heal: 0, died: 0, drawn: 0 }; }

function analyzeMatch(match, playerIndex, mode) {
  const me = match.players[playerIndex], opp = match.players[1 - playerIndex];
  const mine = e => e.by === me.slug;
  const events = match.events || [];
  const perCard = {};
  const stat = id => (perCard[id] = perCard[id] || blankCardStat());

  // Tours : mana disponible vs mana dépensée (coût des cartes jouées ce tour-là)
  const turns = {};
  events.forEach(e => {
    if (e.type === 'turn' && mine(e)) turns[e.turn] = { mana: e.mana || 0, spent: 0 };
  });
  events.forEach(e => {
    if (e.type === 'play' && mine(e)) {
      stat(e.card.id).played++;
      if (turns[e.turn]) turns[e.turn].spent += Number(e.card.cost) || 0;
    }
    if (e.type === 'draw' && mine(e) && e.source && e.source.id) stat(e.source.id).drawn += e.amount || 0;
    if (e.type === 'attack') {
      const atkId = e.attacker.kind === 'minion' ? e.attacker.cardId : e.attacker.weaponCardId;
      if (mine(e) && atkId) {
        stat(atkId).damage += e.dmg || 0;
        if (e.targetDied && e.target.kind !== 'hero' && e.target.owner !== me.slug) stat(atkId).kills++;
      }
      // mes serviteurs morts au combat (en attaquant ou en défendant)
      if (e.targetDied && e.target.kind === 'minion' && e.target.owner === me.slug && e.target.cardId) stat(e.target.cardId).died++;
      if (e.attackerDied && e.attacker.kind === 'minion' && e.attacker.owner === me.slug && e.attacker.cardId) stat(e.attacker.cardId).died++;
    }
    if ((e.type === 'damage' || e.type === 'destroy') && e.source && e.source.id) {
      (e.targets || []).forEach(t => {
        if (mine(e)) {
          if (t.owner !== me.slug) stat(e.source.id).damage += t.amount || 0;
          if (t.died && t.owner !== me.slug) stat(e.source.id).kills++;
        }
        if (t.died && t.kind === 'minion' && t.owner === me.slug && t.cardId) stat(t.cardId).died++;
      });
    }
    if (e.type === 'heal' && mine(e) && e.source && e.source.id) {
      (e.targets || []).forEach(t => { stat(e.source.id).heal += t.amount || 0; });
    }
  });

  const myTurns = Object.values(turns);
  const manaAvailable = myTurns.reduce((a, t) => a + t.mana, 0);
  const manaSpent = myTurns.reduce((a, t) => a + Math.min(t.spent, t.mana), 0);
  let result = 'draw';
  if (match.winner) result = match.winner === me.slug ? 'win' : 'loss';
  else if (match.forfeitBy) result = match.forfeitBy === me.slug ? 'loss' : 'win';
  else if (me.heroHealth <= 0 && opp.heroHealth > 0) result = 'loss';
  else if (opp.heroHealth <= 0 && me.heroHealth > 0) result = 'win';

  return {
    id: 'r-' + Math.random().toString(36).slice(2, 10),
    at: Date.now(), mode, result,
    opponent: opp.pseudo,
    turns: myTurns.length,
    heroHealth: Math.max(0, me.heroHealth), opponentHealth: Math.max(0, opp.heroHealth),
    manaAvailable, manaSpent,
    efficiency: manaAvailable ? Math.round(manaSpent / manaAvailable * 100) : 0,
    cardsPlayed: Object.values(perCard).reduce((a, c) => a + c.played, 0),
    damageDealt: Object.values(perCard).reduce((a, c) => a + c.damage, 0),
    leftInHand: me.hand.slice(),
    deck: (me.deckList || []).slice(),
    perCard
  };
}

/* Composition et conseils pour un deck (liste d'identifiants de cartes) */
function analyzeDeck(cardIds, pool) {
  const cards = cardIds.map(id => pool.find(c => c.id === id)).filter(Boolean);
  const n = cards.length;
  const cost = c => Number(c.cost) || 0;
  const curve = [0, 1, 2, 3, 4, 5, 6, 7].map(i => cards.filter(c => i === 7 ? cost(c) >= 7 : cost(c) === i).length);
  const has = (c, effs) => effectsOf(c).some(e => effs.includes(e));
  const roles = {
    minions: cards.filter(c => c.type === 'minion').length,
    spells: cards.filter(isSpell).length,
    weapons: cards.filter(c => c.type === 'weapon').length,
    early: cards.filter(c => cost(c) <= 2).length,
    late: cards.filter(c => cost(c) >= 6).length,
    removal: cards.filter(c => has(c, REMOVAL)).length,
    draw: cards.filter(c => has(c, ['draw'])).length,
    taunt: cards.filter(c => c.taunt).length,
    charge: cards.filter(c => c.charge).length,
    sustain: cards.filter(c => has(c, ['heal', 'aoe_heal', 'armor', 'buff_ally_and_heal']) || c.armor || c.battlecryHeal).length,
    buffs: cards.filter(c => has(c, ['buff_attack', 'buff_all_allies', 'modify_stats', 'buff_ally_and_heal'])).length
  };
  const avgCost = n ? Math.round(cards.reduce((a, c) => a + cost(c), 0) / n * 10) / 10 : 0;

  // Conseils : chaque règle explique un manque concret et ce qu'il faudrait ajouter
  const tips = [];
  const tip = (level, key, text) => tips.push({ level, key, text });
  if (n < 30) tip('warn', 'size', `Ton deck n'a que ${n} cartes sur 30.`);
  if (avgCost >= 4.5) tip('warn', 'expensive', `Coût moyen élevé (${avgCost}) : tu risques de ne rien jouer les premiers tours. Remplace des cartes chères par des cartes à 1-3 mana.`);
  if (roles.early < 6) tip('warn', 'early', `Seulement ${roles.early} carte(s) à 2 mana ou moins : ajoute de quoi jouer dès les premiers tours.`);
  if (roles.minions < 12) tip('warn', 'minions', `Peu de serviteurs (${roles.minions}) : sans présence sur la table, l'adversaire contrôle le plateau.`);
  if (roles.minions > 24) tip('info', 'spells', `Presque que des serviteurs (${roles.minions}) : quelques sorts de dégâts ou de destruction aideraient à répondre aux menaces.`);
  if (roles.removal < 3) tip('warn', 'removal', `Peu de cartes pour éliminer les serviteurs adverses (${roles.removal}) : ajoute des dégâts, une destruction ou un endormissement.`);
  if (roles.draw === 0) tip('info', 'draw', 'Aucune carte de pioche : en fin de partie, ta main risque de se vider.');
  if (roles.taunt === 0) tip('info', 'taunt', 'Aucun serviteur avec Provocation pour protéger ton héros.');
  if (roles.sustain === 0) tip('info', 'sustain', "Aucun soin ni armure : rien pour récupérer face à un deck agressif.");
  if (roles.late > 6) tip('info', 'late', `${roles.late} cartes à 6 mana ou plus : c'est beaucoup, garde les plus fortes.`);
  if (!tips.length) tip('good', 'ok', 'Deck équilibré : bonne courbe de mana, de quoi éliminer, piocher et se protéger.');
  return { size: n, avgCost, curve, roles, tips };
}

/* Bilan cumulé des combats joués avec ce deck : cartes efficaces, cartes qui dorment en main */
function aggregateReports(reports) {
  const perCard = {}, stuck = {};
  reports.forEach(r => {
    Object.keys(r.perCard || {}).forEach(id => {
      const a = perCard[id] = perCard[id] || Object.assign(blankCardStat(), { games: 0 });
      const s = r.perCard[id];
      ['played', 'damage', 'kills', 'heal', 'died', 'drawn'].forEach(k => { a[k] += s[k] || 0; });
      a.games++;
    });
    (r.leftInHand || []).forEach(id => { stuck[id] = (stuck[id] || 0) + 1; });
  });
  const wins = reports.filter(r => r.result === 'win').length;
  return {
    games: reports.length, wins,
    winRate: reports.length ? Math.round(wins / reports.length * 100) : 0,
    efficiency: reports.length ? Math.round(reports.reduce((a, r) => a + (r.efficiency || 0), 0) / reports.length) : 0,
    perCard, stuck
  };
}

/* Suggestions de cartes : d'abord dans la collection du joueur (pas déjà au
   maximum dans le deck), sinon dans le jeu (à obtenir dans les boosters).
   Chaque suggestion explique le manque qu'elle comble ou la synergie qu'elle crée. */
function suggestCards(cardIds, pool, collection, analysis, limits) {
  const counts = {};
  cardIds.forEach(id => { counts[id] = (counts[id] || 0) + 1; });
  const deckCards = cardIds.map(id => pool.find(c => c.id === id)).filter(Boolean);
  const r = analysis.roles;
  const wants = [];
  const want = (reason, test, score) => wants.push({ reason, test, score });
  const has = (c, effs) => effectsOf(c).some(e => effs.includes(e));
  const cost = c => Number(c.cost) || 0;
  if (r.early < 6) want('Pour les premiers tours (2 mana ou moins)', c => cost(c) <= 2 && c.type === 'minion', 6 - r.early);
  if (r.removal < 3) want('Pour éliminer les serviteurs adverses', c => has(c, REMOVAL), 4 - r.removal);
  if (r.draw === 0) want('Pour piocher et garder des cartes en main', c => has(c, ['draw']), 2);
  if (r.taunt === 0) want('Pour protéger ton héros (Provocation)', c => !!c.taunt, 2);
  if (r.sustain === 0) want('Pour tenir face à un deck agressif (soin, armure)', c => has(c, ['heal', 'aoe_heal', 'armor', 'buff_ally_and_heal']) || c.armor || c.battlecryHeal, 2);
  if (r.minions < 12) want('Pour occuper la table', c => c.type === 'minion' && cost(c) <= 4, 2);
  // Synergies : on renforce ce que le deck fait déjà
  if (r.minions >= 16) want(`Synergie : ton deck compte ${r.minions} serviteurs, un bonus de zone les renforce tous`, c => has(c, ['buff_all_allies', 'aoe_heal']), 2);
  if (r.charge >= 3) want('Synergie : avec tes serviteurs à Charge, un bonus d\'attaque fait vite mal', c => has(c, ['buff_attack', 'buff_all_allies']), 1.5);
  if (r.taunt >= 3) want('Synergie : tes Provocations tiennent la table, ajoute de quoi gagner la fin de partie', c => cost(c) >= 6 && c.type === 'minion', 1.5);
  if (r.removal >= 5 && r.draw === 0) want('Synergie : un deck de contrôle a besoin de pioche pour ne pas s\'essouffler', c => has(c, ['draw']), 1.5);

  const owned = id => (collection || {})[id] || 0;
  const roomFor = c => Math.min(limits[c.rarity] || 2, Math.max(owned(c.id), 1)) - (counts[c.id] || 0);
  const out = [], seen = new Set();
  wants.sort((a, b) => b.score - a.score).forEach(w => {
    const fits = pool.filter(c => w.test(c) && !seen.has(c.id) && (counts[c.id] || 0) < (limits[c.rarity] || 2));
    const inColl = fits.filter(c => owned(c.id) > 0 && roomFor(c) > 0).sort((a, b) => cost(a) - cost(b)).slice(0, 3);
    inColl.forEach(c => { seen.add(c.id); out.push({ cardId: c.id, reason: w.reason, owned: true }); });
    if (!inColl.length) {
      const toGet = fits.filter(c => !owned(c.id)).slice(0, 2);
      toGet.forEach(c => { seen.add(c.id); out.push({ cardId: c.id, reason: w.reason, owned: false }); });
    }
  });
  return out.slice(0, 9);
}

module.exports = { analyzeMatch, analyzeDeck, aggregateReports, suggestCards };

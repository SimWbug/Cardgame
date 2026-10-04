/* IA très simple pour le combat d'entraînement de l'admin.
   Objectif : jouer des tours raisonnables pour tester le déroulé d'un combat
   et le comportement des cartes, pas rivaliser avec un vrai joueur. */
const game = require('./game');
const { COPY_LIMITS, DECK_SIZE } = require('./cards');

/* Constitue un deck de test en piochant dans TOUT le pool de cartes
   (respecte les limites de copies), pour que les cartes fraîchement créées
   par l'admin apparaissent aussi dans les combats de test. */
function buildTestDeck(cardPool) {
  const shuffled = cardPool.slice().sort(() => Math.random() - 0.5);
  const deck = [];
  const counts = {};
  let i = 0;
  while (deck.length < DECK_SIZE && shuffled.length > 0) {
    const card = shuffled[i % shuffled.length];
    const limit = COPY_LIMITS[card.rarity] || 2;
    const owned = counts[card.id] || 0;
    if (owned < limit) {
      counts[card.id] = owned + 1;
      deck.push(card.id);
    }
    i++;
    if (i > shuffled.length * (DECK_SIZE + 5)) break; // garde-fou si le pool est trop petit
  }
  return deck;
}

/* Tour du bot découpé en étapes : chaque carte jouée et chaque attaque est
   une étape distincte. Le serveur envoie l'état après chacune avec une pause,
   pour que le joueur VOIE chaque action (sort lancé, puis attaque...) au lieu
   de recevoir d'un coup le résultat de tout le tour — ce qui donnait
   l'impression qu'une carte en détruisait une autre plus solide qu'elle. */
/* Cible d'un effet de sort pour le bot. null = ne pas jouer (aucune cible utile). */
function chooseTarget(effectType, value, value2, bot, human) {
  human = Object.assign({}, human, { board: human.board.filter(m => !m.stealth) }); // un serviteur camouflé ne peut pas être visé
  if (/^give_/.test(effectType)) {
    const best = bot.board.slice().sort((a, b) => (b.attack + b.health) - (a.attack + a.health))[0];
    return best ? { targetType: 'minion', targetId: best.instanceId } : null;
  }
  if (effectType === 'heal') return bot.heroHealth >= 25 ? null : { targetType: 'hero' };
  if (effectType === 'buff_attack' || effectType === 'buff_ally_and_heal') {
    const best = bot.board.slice().sort((a, b) => b.attack - a.attack)[0];
    return best ? { targetType: 'minion', targetId: best.instanceId } : null;
  }
  if (effectType === 'modify_stats') {
    const net = (Number(value) || 0) + (Number(value2) || 0);
    const best = (net >= 0 ? bot.board : human.board).slice().sort((a, b) => b.attack - a.attack)[0];
    return best ? { targetType: 'minion', targetId: best.instanceId } : null;
  }
  if (effectType === 'destroy') {
    // Détruit le serviteur adverse le plus menaçant (ATQ + PV) ; jamais un des siens
    const best = human.board.slice().sort((a, b) => (b.attack + b.health) - (a.attack + a.health))[0];
    return best ? { targetType: 'minion', targetId: best.instanceId } : null;
  }
  if (effectType === 'sleep') {
    // Endort le serviteur adverse le plus dangereux qui n'est pas déjà endormi
    const best = human.board.filter(m => !m.asleep).sort((a, b) => b.attack - a.attack)[0];
    return best ? { targetType: 'minion', targetId: best.instanceId } : null;
  }
  if (effectType === 'damage') {
    const weakest = human.board.slice().sort((a, b) => a.health - b.health)[0];
    return weakest && weakest.health <= value ? { targetType: 'minion', targetId: weakest.instanceId } : { targetType: 'hero' };
  }
  return {}; // effets sans cible
}

function* botTurnSteps(match, cardPool) {
  if (match.status !== 'active' || match.turn !== 1) return;
  const bot = match.players[1];
  const human = match.players[0];

  let guard = 0;
  while (guard++ < 20 && match.status === 'active') {
    const playable = bot.hand
      .map(id => cardPool.find(c => c.id === id))
      .filter(c => c && c.cost <= bot.mana)
      .sort((a, b) => b.cost - a.cost); // joue les plus chères d'abord (utilise mieux le mana)
    if (playable.length === 0) break;
    const card = playable[0];
    let options = {};
    if (card.type === 'sort') {
      options = chooseTarget(card.effectType, card.value, card.value2, bot, human);
      if (!options) break; // pas de cible utile : on garde la carte
    } else if (card.type === 'minion' && card.bcEffect && game.TARGETED_EFFECTS.includes(card.bcEffect)) {
      // Cri de guerre à cible : on vise comme pour un sort ; sans cible utile, il est posé sans effet
      options = chooseTarget(card.bcEffect, card.bcValue, card.bcValue2, bot, human) || {};
    }
    const res = game.playCard(match, cardPool, 1, card.id, options);
    if (!res.ok) break; // sécurité : on arrête plutôt que de boucler sur une erreur
    yield 'play';
  }

  // Phase d'attaque : simple et agressive. On recalcule la cible Provocation
  // à chaque coup. On parcourt une copie : un attaquant qui meurt pendant
  // l'échange ne doit pas décaler les suivants.
  for (const m of bot.board.slice()) {
    if (match.status !== 'active') return;
    if (!bot.board.includes(m) || m.sickness || !m.canAttack || m.attack <= 0) continue;
    const taunt = human.board.find(x => x.taunt && !x.stealth);
    const res = taunt ? game.attack(match, 1, m.instanceId, 'minion', taunt.instanceId) : game.attack(match, 1, m.instanceId, 'hero', null);
    if (res && res.ok) yield 'attack';
  }

  // Le bot utilise aussi son arme équipée, autant de fois que possible ce tour-ci
  let guard2 = 0;
  while (match.status === 'active' && bot.heroWeapon && bot.heroWeapon.durability > 0 && bot.heroWeapon.usesThisTurn < bot.heroWeapon.usesPerTurn && guard2++ < 10) {
    const taunt = human.board.find(x => x.taunt && !x.stealth);
    const res = taunt ? game.attack(match, 1, 'hero', 'minion', taunt.instanceId) : game.attack(match, 1, 'hero', 'hero', null);
    if (!res.ok) break;
    yield 'attack';
  }

  if (match.status === 'active') game.endTurn(match);
}

/* Version d'un seul bloc (tests, usages sans animation) */
function runBotTurn(match, cardPool) {
  const it = botTurnSteps(match, cardPool);
  while (!it.next().done) { /* toutes les étapes d'affilée */ }
}

/* Mulligan automatique du bot : garde les cartes bon marché (jouables tôt),
   renvoie les plus chères pour tenter de piocher une main plus jouable. */
function chooseMulligan(match, cardPool) {
  const bot = match.players[1];
  return bot.hand.filter(id => {
    const card = cardPool.find(c => c.id === id);
    return card && card.cost >= 5;
  });
}

module.exports = { buildTestDeck, runBotTurn, botTurnSteps, chooseMulligan };

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

/* Joue le tour complet du bot (index 1), puis termine son tour.
   Tout se déroule en synchrone côté serveur : pas de vrai socket pour le bot. */
function runBotTurn(match, cardPool) {
  if (match.status !== 'active' || match.turn !== 1) return;
  const bot = match.players[1];
  const human = match.players[0];

  let guard = 0;
  while (guard++ < 20) {
    const playable = bot.hand
      .map(id => cardPool.find(c => c.id === id))
      .filter(c => c && c.cost <= bot.mana)
      .sort((a, b) => b.cost - a.cost); // joue les plus chères d'abord (utilise mieux le mana)
    if (playable.length === 0) break;
    const card = playable[0];
    const options = {};
    if (card.type === 'sort') {
      if (card.effectType === 'heal') {
        if (bot.heroHealth >= 25) break; // pas besoin de se soigner, on garde la carte
        options.targetType = 'hero';
      } else if (card.effectType === 'buff_attack' || card.effectType === 'buff_ally_and_heal') {
        const best = bot.board.slice().sort((a, b) => b.attack - a.attack)[0];
        if (!best) break; // aucun allié à renforcer
        options.targetType = 'minion';
        options.targetId = best.instanceId;
      } else if (card.effectType === 'damage') {
        const weakest = human.board.slice().sort((a, b) => a.health - b.health)[0];
        if (weakest && weakest.health <= card.value) { options.targetType = 'minion'; options.targetId = weakest.instanceId; }
        else options.targetType = 'hero';
      }
      // aoe_damage, aoe_heal, damage_all, buff_all_allies, board_wipe : aucune cible requise
    }
    const res = game.playCard(match, cardPool, 1, card.id, options);
    if (!res.ok) break; // sécurité : on arrête plutôt que de boucler sur une erreur
  }

  // Phase d'attaque : simple et agressive. On recalcule la cible Provocation
  // à chaque coup (un premier serviteur à Provocation tué ne doit pas bloquer
  // les attaques suivantes s'il en reste un autre).
  bot.board.forEach(m => {
    if (m.sickness || !m.canAttack || m.attack <= 0) return;
    const taunt = human.board.find(x => x.taunt);
    if (taunt) game.attack(match, 1, m.instanceId, 'minion', taunt.instanceId);
    else game.attack(match, 1, m.instanceId, 'hero', null);
  });

  // Le bot utilise aussi son arme équipée, autant de fois que possible ce tour-ci
  let guard2 = 0;
  while (bot.heroWeapon && bot.heroWeapon.durability > 0 && bot.heroWeapon.usesThisTurn < bot.heroWeapon.usesPerTurn && guard2++ < 10) {
    const taunt = human.board.find(x => x.taunt);
    const res = taunt ? game.attack(match, 1, 'hero', 'minion', taunt.instanceId) : game.attack(match, 1, 'hero', 'hero', null);
    if (!res.ok) break;
  }

  game.endTurn(match);
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

module.exports = { buildTestDeck, runBotTurn, chooseMulligan };

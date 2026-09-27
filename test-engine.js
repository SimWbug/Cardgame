/* Vérification de la logique du moteur : mana, provocation, charge, soins, sorts de zone. */
const assert = require('assert');
const { SEED_CARDS, buildStarterCollection, rankFor, DUST_VALUES, RARITY_WEIGHTS } = require('./src/cards');
const { createMatch, submitMulligan, playCard, attack, endTurn, redactStateFor } = require('./src/game');

/* --- 1. Taux de drop --- */
const totalWeight = Object.values(RARITY_WEIGHTS).reduce((a, b) => a + b, 0);
assert.strictEqual(totalWeight, 100, 'Les taux de drop doivent totaliser 100%');
assert.strictEqual(RARITY_WEIGHTS.legendaire, 3, 'Le drop légendaire doit être de 3%');
console.log('✅ Taux de drop corrects (légendaire à 3%).');

/* --- 2. Valeurs de poussière --- */
assert.deepStrictEqual(DUST_VALUES, { commun: 1, rare: 2, epique: 10, legendaire: 250 });
console.log('✅ Valeurs de poussière correctes.');

/* --- 3. Rangs --- */
assert.strictEqual(rankFor(0).key, 'bronze');
assert.strictEqual(rankFor(500).key, 'argent');
assert.strictEqual(rankFor(1000).key, 'or');
assert.strictEqual(rankFor(2000).key, 'diamant');
assert.strictEqual(rankFor(5000).key, 'maitre');
console.log('✅ Paliers de rang corrects (Bronze → Maître).');

/* --- 4. Mise en place d'un match --- */
const a = buildStarterCollection(), b = buildStarterCollection();
let match = createMatch('t1', { slug: 'alice', pseudo: 'Alice', deck: a.deck }, { slug: 'bob', pseudo: 'Bob', deck: b.deck });
assert.strictEqual(match.players[0].hand.length, 4);
assert.strictEqual(match.phase, 'mulligan', 'la partie doit démarrer en phase mulligan');
assert.strictEqual(match.players[0].mana, 0, 'aucun mana tant que le mulligan n\'est pas terminé');
assert.strictEqual(match.players[0].heroHealth, 30);
console.log('✅ Match initialisé (4 cartes en main, phase mulligan, 30 PV).');

// On valide le mulligan des deux joueurs sans rien remplacer, pour passer au test du moteur de jeu
submitMulligan(match, 0, []);
submitMulligan(match, 1, []);
assert.strictEqual(match.phase, 'active');
assert.strictEqual(match.players[0].mana, 1);
console.log('✅ La partie démarre (1 mana) une fois le mulligan des deux joueurs validé.');

/* --- 5. Mal de l'invocation vs Charge --- */
match.players[0].mana = 10;
const chargeCard = SEED_CARDS.find(c => c.charge && c.rarity !== 'legendaire');
match.players[0].hand.push(chargeCard.id);
let res = playCard(match, SEED_CARDS, 0, chargeCard.id, {});
assert.ok(res.ok, 'La carte Charge doit se jouer');
const chargeMinion = match.players[0].board[match.players[0].board.length - 1];
assert.strictEqual(chargeMinion.sickness, false, 'Une carte avec Charge ne doit pas avoir le mal de l\'invocation');
assert.strictEqual(chargeMinion.canAttack, true, 'Une carte avec Charge doit pouvoir attaquer immédiatement');

const normalCard = SEED_CARDS.find(c => c.type === 'minion' && !c.charge);
match.players[0].hand.push(normalCard.id);
match.players[0].mana = 10;
playCard(match, SEED_CARDS, 0, normalCard.id, {});
const sickMinion = match.players[0].board[match.players[0].board.length - 1];
assert.strictEqual(sickMinion.sickness, true, 'Un serviteur normal doit avoir le mal de l\'invocation');
res = attack(match, 0, sickMinion.instanceId, 'hero', null);
assert.ok(res.error, 'Un serviteur avec le mal de l\'invocation ne doit pas pouvoir attaquer');
console.log('✅ Mal de l\'invocation et Charge fonctionnent.');

/* --- 6. Provocation --- */
const tauntCard = SEED_CARDS.find(c => c.taunt);
match.players[1].board.push({
  instanceId: 'taunt1', cardId: tauntCard.id, name: tauntCard.name, rarity: tauntCard.rarity,
  attack: tauntCard.attack, health: tauntCard.health, maxHealth: tauntCard.health,
  taunt: true, charge: false, canAttack: true, sickness: false
});
res = attack(match, 0, chargeMinion.instanceId, 'hero', null);
assert.ok(res.error, 'On ne doit pas pouvoir viser le héros quand une Provocation est en jeu');
res = attack(match, 0, chargeMinion.instanceId, 'minion', 'taunt1');
assert.ok(res.ok, 'On doit pouvoir attaquer le serviteur avec Provocation');
console.log('✅ Provocation respectée.');

/* --- 7. Sort de soin ciblé --- */
match.players[0].heroHealth = 20;
match.players[0].mana = 10;
const healCard = SEED_CARDS.find(c => c.effectType === 'heal');
match.players[0].hand.push(healCard.id);
res = playCard(match, SEED_CARDS, 0, healCard.id, { targetType: 'hero' });
assert.ok(res.ok, 'Le sort de soin doit se jouer');
assert.strictEqual(match.players[0].heroHealth, Math.min(20 + healCard.value, 30), 'Le héros doit être soigné');
console.log('✅ Sorts de soin fonctionnels.');

/* --- 8. Le soin ne dépasse pas le maximum --- */
match.players[0].heroHealth = 29;
match.players[0].mana = 10;
match.players[0].hand.push(healCard.id);
playCard(match, SEED_CARDS, 0, healCard.id, { targetType: 'hero' });
assert.strictEqual(match.players[0].heroHealth, 30, 'Le soin ne doit pas dépasser 30 PV');
console.log('✅ Le soin est plafonné à 30 PV.');

/* --- 9. Sort de zone --- */
match.players[1].board.push({ instanceId: 'z1', name: 'Cible A', attack: 1, health: 2, maxHealth: 2, canAttack: true, sickness: false });
match.players[1].board.push({ instanceId: 'z2', name: 'Cible B', attack: 1, health: 5, maxHealth: 5, canAttack: true, sickness: false });
const aoeCard = SEED_CARDS.find(c => c.effectType === 'aoe_damage');
match.players[0].mana = 10;
match.players[0].hand.push(aoeCard.id);
const boardBefore = match.players[1].board.length;
playCard(match, SEED_CARDS, 0, aoeCard.id, {});
assert.ok(match.players[1].board.length < boardBefore, 'Le sort de zone doit tuer au moins un petit serviteur');
console.log('✅ Sorts de zone fonctionnels.');

/* --- 10. Un sort sur cible invalide ne consomme ni mana ni carte --- */
const buffCard = SEED_CARDS.find(c => c.effectType === 'buff_attack' && c.rarity !== 'legendaire');
match.players[0].mana = 10;
const manaBefore = match.players[0].mana;
match.players[0].hand.push(buffCard.id);
const handBefore = match.players[0].hand.length;
res = playCard(match, SEED_CARDS, 0, buffCard.id, { targetId: 'inexistant' });
assert.ok(res.error, 'Un buff sans cible valide doit échouer');
assert.strictEqual(match.players[0].mana, manaBefore, 'Le mana ne doit pas être consommé sur un échec');
assert.strictEqual(match.players[0].hand.length, handBefore, 'La carte ne doit pas être défaussée sur un échec');
console.log('✅ Une cible invalide ne gaspille ni mana ni carte.');

/* --- 11. Fin de partie --- */
match.players[0].board.push({ instanceId: 'x9', name: 'Finisseur', attack: 99, health: 5, maxHealth: 5, canAttack: true, sickness: false });
match.players[1].board = [];
match.turn = 0;
attack(match, 0, 'x9', 'hero', null);
assert.strictEqual(match.status, 'finished');
assert.strictEqual(match.winner, 'alice');
console.log('✅ Détection de fin de partie correcte.');

/* --- 12. L'état transmis ne révèle pas la main adverse --- */
const view = redactStateFor(match, SEED_CARDS, 0);
assert.ok(view.opponent.handCount !== undefined, 'On doit connaître le nombre de cartes adverses');
assert.ok(view.opponent.hand === undefined, 'On ne doit PAS voir le contenu de la main adverse');
console.log('✅ La main de l\'adversaire reste cachée.');

console.log('\n✅ Tous les tests du moteur sont passés.');

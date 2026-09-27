/* Vérifie la mécanique des armes de héros : équipement, attaque du héros,
   durabilité qui décroît puis brise l'arme, limite d'utilisations par tour,
   riposte des serviteurs sur le héros, remplacement d'une arme, Provocation. */
const assert = require('assert');
const { SEED_CARDS, buildStarterCollection } = require('./src/cards');
const { createMatch, submitMulligan, playCard, attack } = require('./src/game');

function freshMatch() {
  const a = buildStarterCollection(), b = buildStarterCollection();
  const match = createMatch('t', { slug: 'alice', pseudo: 'Alice', deck: a.deck }, { slug: 'bob', pseudo: 'Bob', deck: b.deck });
  submitMulligan(match, 0, []);
  submitMulligan(match, 1, []);
  return match;
}

const weaponCard = { id: 'w1', name: 'Lame Rouillée', type: 'weapon', rarity: 'commun', cost: 2, attack: 3, durability: 2, usesPerTurn: 1, desc: 'Test' };
const weaponCard2 = { id: 'w2', name: 'Hache de Guerre', type: 'weapon', rarity: 'rare', cost: 3, attack: 5, durability: 3, usesPerTurn: 1, battlecryHeal: 4, desc: 'Test' };
const multiUseWeapon = { id: 'w3', name: 'Dague Jumelle', type: 'weapon', rarity: 'epique', cost: 2, attack: 1, durability: 4, usesPerTurn: 2, desc: 'Test' };
const pool = [...SEED_CARDS, weaponCard, weaponCard2, multiUseWeapon];

/* --- 1. Équiper une arme --- */
let match = freshMatch();
match.players[0].mana = 10;
match.players[0].hand.push('w1');
let res = playCard(match, pool, 0, 'w1', {});
assert.ok(res.ok, 'équiper une arme doit réussir : ' + JSON.stringify(res));
assert.deepStrictEqual(
  { attack: match.players[0].heroWeapon.attack, durability: match.players[0].heroWeapon.durability, usesPerTurn: match.players[0].heroWeapon.usesPerTurn },
  { attack: 3, durability: 2, usesPerTurn: 1 }
);
console.log('✅ Une arme s\'équipe avec ses bonnes statistiques.');

/* --- 2. Le héros attaque avec son arme --- */
res = attack(match, 0, 'hero', 'hero', null);
assert.ok(res.ok, 'attaque du héros avec arme : ' + JSON.stringify(res));
assert.strictEqual(match.players[1].heroHealth, 27, 'le héros adverse doit perdre 3 PV (attaque de l\'arme)');
assert.strictEqual(match.players[0].heroWeapon.durability, 1, 'la durabilité doit baisser de 1 après usage');
console.log('✅ Le héros attaque avec son arme et inflige bien les dégâts.');

/* --- 3. Une arme ne peut attaquer qu'une fois par tour (usesPerTurn=1) --- */
res = attack(match, 0, 'hero', 'hero', null);
assert.ok(res.error, 'une deuxième attaque avec la même arme ce tour-ci doit être refusée');
console.log('✅ Une arme à 1 utilisation/tour ne peut pas attaquer deux fois le même tour.');

/* --- 4. La durabilité tombe à 0 : l'arme se brise --- */
match.turn = 0; // on retente au "tour suivant" simulé directement (pas besoin de vrai changement de tour ici)
match.players[0].heroWeapon.usesThisTurn = 0; // simulate un nouveau tour pour l'arme
res = attack(match, 0, 'hero', 'hero', null);
assert.ok(res.ok);
assert.strictEqual(match.players[0].heroWeapon, null, 'l\'arme doit se briser (durabilité à 0) et disparaître');
console.log('✅ Une arme à 0 durabilité se brise et n\'est plus utilisable.');

/* --- 5. Riposte d'un serviteur sur le héros lors d'une attaque au corps à corps --- */
match = freshMatch();
match.players[0].mana = 10;
match.players[0].hand.push('w1');
playCard(match, pool, 0, 'w1', {});
match.players[1].board.push({ instanceId: 'm1', name: 'Cible', attack: 4, health: 5, maxHealth: 5, canAttack: true, sickness: false });
const heroHpBefore = match.players[0].heroHealth;
res = attack(match, 0, 'hero', 'minion', 'm1');
assert.ok(res.ok);
assert.strictEqual(match.players[0].heroHealth, heroHpBefore - 4, 'le héros doit encaisser la riposte du serviteur (4 dégâts)');
const target = match.players[1].board.find(m => m.instanceId === 'm1');
assert.strictEqual(target.health, 2, 'le serviteur ciblé doit prendre les dégâts de l\'arme (5-3=2 PV restants)');
console.log('✅ Attaquer un serviteur avec son arme fait encaisser la riposte au héros (pas à l\'arme).');

/* --- 6. Provocation : le héros doit aussi la respecter --- */
match = freshMatch();
match.players[0].mana = 10;
match.players[0].hand.push('w1');
playCard(match, pool, 0, 'w1', {});
match.players[1].board.push({ instanceId: 'nt', name: 'Sans provoc', attack: 1, health: 5, maxHealth: 5, canAttack: true, sickness: false, taunt: false });
match.players[1].board.push({ instanceId: 'taunt1', name: 'Avec Provoc', attack: 1, health: 5, maxHealth: 5, canAttack: true, sickness: false, taunt: true });
res = attack(match, 0, 'hero', 'hero', null);
assert.ok(res.error, 'le héros ne doit pas pouvoir viser le héros adverse quand une Provocation est en jeu');
res = attack(match, 0, 'hero', 'minion', 'nt');
assert.ok(res.error, 'le héros ne doit pas pouvoir viser un serviteur sans Provocation si une Provocation est présente');
res = attack(match, 0, 'hero', 'minion', 'taunt1');
assert.ok(res.ok, 'le héros doit pouvoir viser le serviteur avec Provocation');
console.log('✅ Le héros armé respecte la règle de Provocation comme un serviteur.');

/* --- 7. Équiper une nouvelle arme remplace l'ancienne (pas d'empilement) --- */
match = freshMatch();
match.players[0].mana = 10;
match.players[0].hand.push('w1');
playCard(match, pool, 0, 'w1', {});
assert.strictEqual(match.players[0].heroWeapon.name, 'Lame Rouillée');
match.players[0].mana = 10;
match.players[0].hand.push('w2');
res = playCard(match, pool, 0, 'w2', {});
assert.ok(res.ok);
assert.strictEqual(match.players[0].heroWeapon.name, 'Hache de Guerre', 'la nouvelle arme doit remplacer l\'ancienne');
assert.strictEqual(match.players[0].heroWeapon.durability, 3);
console.log('✅ Équiper une nouvelle arme remplace l\'ancienne sans empilement.');

/* --- 8. Le soin à l'équipement (battlecryHeal) fonctionne pour une arme --- */
match.players[0].heroHealth = 20;
match.players[0].mana = 10;
match.players[0].hand.push('w2');
playCard(match, pool, 0, 'w2', {});
assert.strictEqual(match.players[0].heroHealth, 24, 'l\'arme doit soigner 4 PV en s\'équipant');
console.log('✅ Une arme peut soigner le héros en s\'équipant (battlecryHeal).');

/* --- 9. Une arme avec usesPerTurn > 1 peut attaquer plusieurs fois le même tour --- */
match = freshMatch();
match.players[0].mana = 10;
match.players[0].hand.push('w3');
playCard(match, pool, 0, 'w3', {});
res = attack(match, 0, 'hero', 'hero', null);
assert.ok(res.ok, 'première attaque avec une arme à 2 utilisations/tour');
res = attack(match, 0, 'hero', 'hero', null);
assert.ok(res.ok, 'deuxième attaque le même tour doit être autorisée (usesPerTurn=2) : ' + JSON.stringify(res));
res = attack(match, 0, 'hero', 'hero', null);
assert.ok(res.error, 'une troisième attaque le même tour doit être refusée (limite atteinte)');
assert.strictEqual(match.players[0].heroWeapon.durability, 2, 'la durabilité doit avoir baissé de 2 (4-2)');
console.log('✅ Une arme à plusieurs utilisations/tour respecte sa propre limite.');

/* --- 10. Sans arme équipée, le héros ne peut pas attaquer --- */
match = freshMatch();
res = attack(match, 0, 'hero', 'hero', null);
assert.ok(res.error, 'un héros sans arme ne doit pas pouvoir attaquer');
console.log('✅ Un héros sans arme équipée ne peut pas attaquer.');

/* --- 11. L'état renvoyé au client expose l'arme des deux côtés --- */
match = freshMatch();
match.players[0].mana = 10;
match.players[0].hand.push('w1');
playCard(match, pool, 0, 'w1', {});
const { redactStateFor } = require('./src/game');
const view0 = redactStateFor(match, pool, 0);
const view1 = redactStateFor(match, pool, 1);
assert.strictEqual(view0.you.weapon.name, 'Lame Rouillée');
assert.strictEqual(view1.opponent.weapon.name, 'Lame Rouillée', 'l\'arme équipée doit être visible par l\'adversaire aussi');
console.log('✅ L\'arme équipée est visible dans l\'état envoyé aux deux joueurs.');

console.log('\n✅ Mécanique des armes de héros validée.');

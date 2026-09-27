/* Vérifie : armure (absorption des dégâts), et les nouveaux effets de sort
   (destruction du plateau, dégâts globaux, buff collectif, buff+soin combiné). */
const assert = require('assert');
const { SEED_CARDS, buildStarterCollection } = require('./src/cards');
const { createMatch, submitMulligan, playCard, attack } = require('./src/game');

function freshMatch() {
  const a = buildStarterCollection(), b = buildStarterCollection();
  const match = createMatch('t', { slug: 'alice', pseudo: 'Alice', deck: a.deck }, { slug: 'bob', pseudo: 'Bob', deck: b.deck });
  // On valide le mulligan des deux joueurs sans rien remplacer, pour tester le moteur de jeu directement
  submitMulligan(match, 0, []);
  submitMulligan(match, 1, []);
  return match;
}

/* --- 1. L'armure absorbe les dégâts avant les PV --- */
let match = freshMatch();
match.players[1].board.push({ instanceId: 'armored', name: 'Blindé', attack: 1, health: 3, maxHealth: 3, armor: 2, canAttack: true, sickness: false });
match.players[0].board.push({ instanceId: 'atk1', name: 'Attaquant', attack: 2, health: 5, maxHealth: 5, armor: 0, canAttack: true, sickness: false });
match.turn = 0;
let res = attack(match, 0, 'atk1', 'minion', 'armored');
assert.ok(res.ok);
let armored = match.players[1].board.find(m => m.instanceId === 'armored');
assert.strictEqual(armored.armor, 0, "2 dégâts contre 2 d'armure : l'armure doit tomber à 0");
assert.strictEqual(armored.health, 3, "l'armure absorbe tout, les PV ne doivent pas bouger");
console.log('✅ L\'armure absorbe intégralement les dégâts inférieurs ou égaux à sa valeur.');

match.players[0].board.find(m => m.instanceId === 'atk1').canAttack = true; // second coup du même tour, pour le test
res = attack(match, 0, 'atk1', 'minion', 'armored');
assert.ok(res.ok, 'la deuxième attaque doit réussir : ' + JSON.stringify(res));
armored = match.players[1].board.find(m => m.instanceId === 'armored');
assert.ok(armored, 'le serviteur doit survivre (3 PV - 2 dégâts restants = 1)');
assert.strictEqual(armored.armor, 0);
assert.strictEqual(armored.health, 1, '2 dégâts sans armure restante : tout va aux PV');
console.log('✅ Une fois l\'armure épuisée, les dégâts excédentaires passent aux PV.');

/* --- 2. Destruction totale du plateau (board_wipe) --- */
match = freshMatch();
match.players[0].board.push({ instanceId: 'x1', name: 'A', attack: 1, health: 1, maxHealth: 1, armor: 0, canAttack: true, sickness: false });
match.players[0].board.push({ instanceId: 'x2', name: 'B', attack: 1, health: 99, maxHealth: 99, armor: 99, canAttack: true, sickness: false });
match.players[1].board.push({ instanceId: 'x3', name: 'C', attack: 1, health: 99, maxHealth: 99, armor: 99, canAttack: true, sickness: false });
const wipeCard = { id: 'wipe', name: 'Cataclysme', type: 'sort', rarity: 'legendaire', cost: 8, effectType: 'board_wipe', value: 0, desc: 'Test' };
match.players[0].hand.push('wipe');
match.players[0].mana = 10;
res = playCard(match, [...SEED_CARDS, wipeCard], 0, 'wipe', {});
assert.ok(res.ok);
assert.strictEqual(match.players[0].board.length, 0, 'le plateau du lanceur doit être vide, même les gros PV/armure');
assert.strictEqual(match.players[1].board.length, 0, 'le plateau adverse doit être vide aussi');
console.log('✅ board_wipe détruit tous les serviteurs des deux camps, armure ou pas.');

/* --- 3. Dégâts à tous les serviteurs (damage_all), armure prise en compte --- */
match = freshMatch();
match.players[0].board.push({ instanceId: 'y1', name: 'Faible', attack: 1, health: 1, maxHealth: 1, armor: 0, canAttack: true, sickness: false });
match.players[1].board.push({ instanceId: 'y2', name: 'Blindé', attack: 1, health: 3, maxHealth: 3, armor: 2, canAttack: true, sickness: false });
const dmgAllCard = { id: 'dmgall', name: 'Onde de choc', type: 'sort', rarity: 'epique', cost: 4, effectType: 'damage_all', value: 2, desc: 'Test' };
match.players[0].hand.push('dmgall');
match.players[0].mana = 10;
res = playCard(match, [...SEED_CARDS, dmgAllCard], 0, 'dmgall', {});
assert.ok(res.ok);
assert.strictEqual(match.players[0].board.length, 0, 'le serviteur à 1 PV du lanceur doit mourir');
const survivor = match.players[1].board.find(m => m.instanceId === 'y2');
assert.ok(survivor, 'le serviteur blindé adverse doit survivre');
assert.strictEqual(survivor.armor, 0, 'son armure doit tomber à 0 (2 dégâts absorbés)');
assert.strictEqual(survivor.health, 3, 'pas de dégâts résiduels sur les PV (armure = dégâts)');
console.log('✅ damage_all touche les DEUX camps et respecte l\'armure.');

/* --- 4. Buff collectif de sa propre équipe (buff_all_allies) --- */
match = freshMatch();
match.players[0].board.push({ instanceId: 'z1', name: 'Mien 1', attack: 1, health: 1, maxHealth: 1, armor: 0, canAttack: true, sickness: false });
match.players[0].board.push({ instanceId: 'z2', name: 'Mien 2', attack: 2, health: 1, maxHealth: 1, armor: 0, canAttack: true, sickness: false });
match.players[1].board.push({ instanceId: 'z3', name: 'Adverse', attack: 1, health: 1, maxHealth: 1, armor: 0, canAttack: true, sickness: false });
const buffAllCard = { id: 'buffall', name: 'Rugissement', type: 'sort', rarity: 'rare', cost: 3, effectType: 'buff_all_allies', value: 3, desc: 'Test' };
match.players[0].hand.push('buffall');
match.players[0].mana = 10;
playCard(match, [...SEED_CARDS, buffAllCard], 0, 'buffall', {});
assert.strictEqual(match.players[0].board.find(m => m.instanceId === 'z1').attack, 4);
assert.strictEqual(match.players[0].board.find(m => m.instanceId === 'z2').attack, 5);
assert.strictEqual(match.players[1].board.find(m => m.instanceId === 'z3').attack, 1, 'l\'adversaire ne doit PAS être affecté');
console.log('✅ buff_all_allies ne renforce que les serviteurs du lanceur.');

/* --- 5. Effet combiné : buff un allié + soigne le héros --- */
match = freshMatch();
match.players[0].heroHealth = 20;
match.players[0].board.push({ instanceId: 'w1', name: 'Allié', attack: 1, health: 1, maxHealth: 1, armor: 0, canAttack: true, sickness: false });
const comboCard = { id: 'combo', name: 'Bénédiction', type: 'sort', rarity: 'epique', cost: 3, effectType: 'buff_ally_and_heal', value: 2, value2: 5, desc: 'Test' };
match.players[0].hand.push('combo');
match.players[0].mana = 10;
res = playCard(match, [...SEED_CARDS, comboCard], 0, 'combo', { targetId: 'w1' });
assert.ok(res.ok);
assert.strictEqual(match.players[0].board.find(m => m.instanceId === 'w1').attack, 3, '+2 ATQ appliqué');
assert.strictEqual(match.players[0].heroHealth, 25, '+5 PV appliqué en même temps');
console.log('✅ buff_ally_and_heal applique les deux effets en un seul sort.');

// Sans cible valide, l'effet combiné échoue proprement (ni mana ni carte perdus)
match.players[0].hand.push('combo');
const manaBefore = match.players[0].mana;
res = playCard(match, [...SEED_CARDS, comboCard], 0, 'combo', { targetId: 'inexistant' });
assert.ok(res.error);
assert.strictEqual(match.players[0].mana, manaBefore);
console.log('✅ Sans cible valide, l\'effet combiné échoue sans gaspiller mana ni carte.');

console.log('\n✅ Armure et nouveaux effets de sort validés.');

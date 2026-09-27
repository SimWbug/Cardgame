/* Vérifie la logique de mulligan (main de départ) dans le moteur. */
const assert = require('assert');
const { buildStarterCollection, SEED_CARDS } = require('./src/cards');
const { createMatch, submitMulligan, playCard, endTurn } = require('./src/game');

function freshMatch() {
  const a = buildStarterCollection(), b = buildStarterCollection();
  return createMatch('t', { slug: 'alice', pseudo: 'Alice', deck: a.deck }, { slug: 'bob', pseudo: 'Bob', deck: b.deck });
}

// 1) La partie démarre en phase mulligan, sans mana distribué
let match = freshMatch();
assert.strictEqual(match.phase, 'mulligan');
assert.strictEqual(match.players[0].mana, 0, 'pas de mana tant que le mulligan n\'est pas terminé');
console.log('✅ La partie démarre en phase mulligan, sans mana.');

// 2) Aucune action de jeu n'est autorisée pendant le mulligan
let res = playCard(match, SEED_CARDS, 0, match.players[0].hand[0], {});
assert.ok(res.error);
res = endTurn(match);
assert.ok(res.error);
console.log('✅ Jouer une carte ou terminer le tour est refusé pendant le mulligan.');

// 3) Un joueur remplace 2 cartes : sa main garde la même taille, la pioche aussi (recyclées)
const handBefore = match.players[0].hand.slice();
const libBefore = match.players[0].library.length;
const toReplace = [handBefore[0], handBefore[1]];
res = submitMulligan(match, 0, toReplace);
assert.ok(res.ok);
assert.strictEqual(match.players[0].hand.length, 4, 'la main garde 4 cartes après remplacement');
assert.strictEqual(match.players[0].library.length, libBefore, 'la pioche retrouve sa taille (cartes recyclées puis redistribuées)');
// Pas d'assertion "la carte remplacée n'est plus en main" : le mulligan RECYCLE les
// cartes échangées dans la pioche avant de la mélanger et d'y repiocher les cartes de
// remplacement — une carte tout juste recyclée peut donc légitimement être repiochée
// par hasard, même sans doublon dans la main d'origine. Un précédent essai de cette
// assertion échouait par intermittence (~15% des lancers) pour exactement cette
// raison : un vrai comportement du mélange, pas un bug du moteur.
console.log('✅ Remplacer des cartes garde la taille de main et de pioche.');

// 4) Un seul joueur prêt : la partie ne démarre pas encore
assert.strictEqual(match.phase, 'mulligan');
assert.strictEqual(match.mulliganDone[0], true);
assert.strictEqual(match.mulliganDone[1], false);
console.log('✅ La partie attend le second joueur.');

// 5) On ne peut pas valider deux fois
res = submitMulligan(match, 0, []);
assert.ok(res.error);
console.log('✅ Un joueur ne peut pas valider sa main deux fois.');

// 6) Garder toute sa main (aucun remplacement) fonctionne aussi
const bHandBefore = match.players[1].hand.slice();
res = submitMulligan(match, 1, []);
assert.ok(res.ok);
assert.deepStrictEqual(match.players[1].hand, bHandBefore, 'ne rien remplacer garde exactement la même main');
console.log('✅ Garder toute sa main de départ fonctionne.');

// 7) Les deux joueurs prêts : la partie démarre normalement
assert.strictEqual(match.phase, 'active');
assert.strictEqual(match.players[0].mana, 1);
assert.strictEqual(match.players[0].maxMana, 1);
console.log('✅ La partie démarre dès que les deux joueurs ont validé (1 mana pour le premier joueur).');

// 8) Les actions fonctionnent normalement une fois la partie active
const playable = match.players[0].hand.find(id => {
  const c = SEED_CARDS.find(x => x.id === id);
  return c && c.cost <= 1;
});
if (playable) {
  res = playCard(match, SEED_CARDS, 0, playable, {});
  assert.ok(res.ok, 'une carte doit pouvoir être jouée une fois la partie active');
  console.log('✅ Jouer une carte fonctionne normalement après le mulligan.');
} else {
  console.log('ℹ️ Pas de carte à 1 mana en main pour ce tirage, étape sautée.');
}

// 9) Un ID de carte invalide dans le remplacement est ignoré sans planter
match = freshMatch();
res = submitMulligan(match, 0, ['carte-inexistante']);
assert.ok(res.ok, 'un ID invalide ne doit pas faire échouer tout le mulligan');
assert.strictEqual(match.players[0].hand.length, 4, 'la main ne doit pas changer de taille sur un ID invalide');
console.log('✅ Un identifiant de carte invalide dans le remplacement est ignoré proprement.');

console.log('\n✅ Logique de mulligan validée.');

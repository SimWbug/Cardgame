/* Vérifie la machine à états de la révélation de booster carte par carte :
   seule la TOUTE PREMIÈRE carte se présente face cachée et demande un clic
   dédié pour la retourner ; les suivantes arrivent déjà face visible (un
   seul clic les fait défiler) — logique isolée, sans DOM ni navigateur. */
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const src = fs.readFileSync('public/app.js', 'utf8');
const methodStart = src.indexOf('  flipTopPackCard() {');
const methodEnd = src.indexOf('  dismissMatchResult() {');
const methodBody = src.slice(methodStart, methodEnd).trim().replace(/,\s*$/, '');
assert.ok(methodBody.startsWith('flipTopPackCard'), 'la méthode doit être extraite correctement');

const wrapped = `function flipTopPackCard() {\n${methodBody.slice(methodBody.indexOf('{') + 1, methodBody.lastIndexOf('}'))}\n}`;

function freshSandbox(drawn) {
  const sandbox = {
    S: { packAnim: { phase: 'presenting', index: 0, flipped: false, collected: [] }, lastDrawn: drawn, soundOn: false },
    window: {}, render: () => {}, playGameSound: () => {}, console
  };
  vm.createContext(sandbox);
  vm.runInContext(wrapped, sandbox);
  return sandbox;
}

const fiveCards = [
  { id: 'c1', name: 'Commune', rarity: 'commun', type: 'minion', attack: 1, health: 1 },
  { id: 'c2', name: 'Rare', rarity: 'rare', type: 'minion', attack: 2, health: 2 },
  { id: 'c3', name: 'Épique', rarity: 'epique', type: 'minion', attack: 3, health: 3 },
  { id: 'c4', name: 'Commune 2', rarity: 'commun', type: 'minion', attack: 1, health: 1 },
  { id: 'c5', name: 'Légendaire', rarity: 'legendaire', type: 'minion', attack: 9, health: 9 }
];

/* 1) La toute première carte démarre bien face cachée (état initial, avant tout clic) */
let sandbox = freshSandbox(fiveCards);
assert.strictEqual(sandbox.S.packAnim.flipped, false, 'la première carte doit démarrer face cachée');
console.log('✅ La toute première carte démarre bien face cachée.');

/* 2) Premier clic sur la carte du dessus : la retourne (flipped=true), ne change pas d'index */
sandbox.flipTopPackCard();
assert.strictEqual(sandbox.S.packAnim.flipped, true);
assert.strictEqual(sandbox.S.packAnim.index, 0);
console.log('✅ Un clic sur la première carte la retourne sans changer d\'index.');

/* 3) Un second clic (déjà retournée) l'envoie dans les cartes obtenues et passe à la suivante —
      qui arrive DÉJÀ face visible (pas de nouvelle étape de retournement pour elle) */
sandbox.flipTopPackCard();
assert.strictEqual(sandbox.S.packAnim.collected.length, 1);
assert.strictEqual(sandbox.S.packAnim.collected[0].id, 'c1');
assert.strictEqual(sandbox.S.packAnim.index, 1);
assert.strictEqual(sandbox.S.packAnim.flipped, true, 'à partir de la 2e carte, elle doit arriver déjà face visible (pas de retournement séparé)');
console.log('✅ La carte suivante (2e et après) arrive déjà face visible, sans étape de retournement séparée.');

/* 4) Pour la 2e carte (déjà visible), UN SEUL clic suffit à passer à la 3e (pas deux comme pour la 1ère) */
sandbox.flipTopPackCard();
assert.strictEqual(sandbox.S.packAnim.collected.length, 2, 'un seul clic doit suffire à faire avancer une carte déjà visible');
assert.strictEqual(sandbox.S.packAnim.index, 2);
assert.strictEqual(sandbox.S.packAnim.flipped, true, 'la 3e carte doit aussi arriver déjà face visible');
console.log('✅ Un seul clic suffit à faire défiler une carte déjà visible (contrairement à la toute première qui en demande deux).');

/* 5) Cycle complet des 5 cartes : à la toute dernière, on bascule sur les résultats plutôt que d'avancer */
sandbox = freshSandbox(fiveCards);
sandbox.flipTopPackCard(); sandbox.flipTopPackCard(); // carte 1 : retourner puis passer (2 clics)
for (let i = 0; i < 3; i++) sandbox.flipTopPackCard(); // cartes 2, 3, 4 : déjà visibles, 1 clic chacune
assert.strictEqual(sandbox.S.packAnim.index, 4, 'on doit être arrivé à la 5e et dernière carte');
assert.strictEqual(sandbox.S.packAnim.collected.length, 4);
assert.strictEqual(sandbox.S.packAnim.flipped, true, 'la 5e carte doit aussi arriver déjà visible');
sandbox.flipTopPackCard(); // "passe" la dernière carte (déjà visible, 1 seul clic)
assert.strictEqual(sandbox.S.packAnim.phase, 'results', 'après la dernière carte, on doit basculer sur les résultats');
console.log('✅ Le cycle complet des 5 cartes (2 clics pour la 1ère, 1 clic pour chacune des suivantes) se termine bien sur la phase "résultats".');

/* 6) Cliquer alors qu'on est déjà en phase "results" ne fait rien (pas d'erreur, pas de changement) */
const beforeResults = JSON.stringify(sandbox.S.packAnim);
sandbox.flipTopPackCard();
assert.strictEqual(JSON.stringify(sandbox.S.packAnim), beforeResults, 'cliquer en phase résultats ne doit rien changer');
console.log('✅ Cliquer une fois en phase "résultats" ne fait rien (pas d\'erreur, état inchangé).');

/* 7) Sans manche en cours (S.packAnim null), aucune erreur */
sandbox = freshSandbox(fiveCards);
sandbox.S.packAnim = null;
assert.doesNotThrow(() => sandbox.flipTopPackCard());
console.log('✅ Sans révélation en cours, cliquer ne plante jamais.');

/* 8) L'ordre des cartes révélées suit fidèlement l'ordre de la donne (pas mélangé) */
sandbox = freshSandbox(fiveCards);
sandbox.flipTopPackCard(); sandbox.flipTopPackCard(); // carte 1 -> collected (2 clics)
sandbox.flipTopPackCard(); // carte 2 -> collected (1 clic, déjà visible)
assert.deepStrictEqual(sandbox.S.packAnim.collected.map(c => c.id), ['c1', 'c2']);
console.log('✅ L\'ordre des cartes déjà obtenues suit fidèlement l\'ordre de la donne.');

console.log('\n✅ Machine à états de la révélation de booster (1ère carte cachée, suivantes déjà visibles) validée.');

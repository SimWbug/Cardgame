/* Vérifie le calcul de l'échelle d'ajustement du plateau de combat à la
   fenêtre : aucun redimensionnement si tout tient déjà, un ratio correct
   sinon, jamais en dessous du plancher de lisibilité. */
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const src = fs.readFileSync('public/app.js', 'utf8');
const start = src.indexOf('function computeCombatFitScale');
const end = src.indexOf('function fitCombatToViewport');
const chunk = src.slice(start, end);
assert.ok(chunk.includes('minScale'), 'la fonction doit être présente dans l\'extrait');

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(chunk, sandbox);

/* 1) Le contenu tient déjà dans la hauteur disponible : aucune réduction */
assert.strictEqual(sandbox.computeCombatFitScale(600, 800), 1);
console.log('✅ Si le contenu tient déjà, aucune réduction (échelle 1).');

/* 2) Contenu légèrement plus grand que l'espace disponible : ratio exact */
assert.strictEqual(sandbox.computeCombatFitScale(1000, 800), 0.8);
console.log('✅ Le ratio est calculé exactement (1000 → 800 = ×0.8).');

/* 3) Un contenu énormément plus grand ne descend jamais sous le plancher (0.6 par défaut) */
assert.strictEqual(sandbox.computeCombatFitScale(3000, 500), 0.6);
console.log('✅ L\'échelle ne descend jamais sous le plancher de lisibilité (0.6 par défaut).');

/* 4) Un plancher personnalisé est bien respecté */
assert.strictEqual(sandbox.computeCombatFitScale(3000, 500, 0.5), 0.5);
console.log('✅ Un plancher personnalisé est bien pris en compte.');

/* 5) Des valeurs manquantes ou nulles ne plantent jamais (repli sur l'échelle 1) */
assert.strictEqual(sandbox.computeCombatFitScale(0, 800), 1);
assert.strictEqual(sandbox.computeCombatFitScale(600, 0), 1);
assert.strictEqual(sandbox.computeCombatFitScale(undefined, undefined), 1);
console.log('✅ Des valeurs manquantes ou nulles ne provoquent jamais d\'échelle absurde (repli sur 1).');

/* 6) Exactement à la limite (contenu = espace disponible) : aucune réduction */
assert.strictEqual(sandbox.computeCombatFitScale(800, 800), 1);
console.log('✅ Contenu exactement à la limite : aucune réduction inutile.');

console.log('\n✅ Calcul de l\'ajustement du plateau de combat validé.');

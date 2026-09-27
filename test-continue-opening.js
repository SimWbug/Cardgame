/* Vérifie que l'écran de résultats d'ouverture de booster propose bien de
   continuer avec le suivant SEULEMENT s'il en reste dans l'inventaire, et
   jamais un bouton "suivant" inconditionnel. Vérification structurelle du
   code source (le rendu complet dépend de trop de globales pour être extrait
   proprement) plutôt qu'une exécution isolée. */
const assert = require('assert');
const fs = require('fs');

const src = fs.readFileSync('public/app.js', 'utf8');
const start = src.indexOf("S.packAnim.phase === 'results'");
const end = src.indexOf('\n\n', start);
const block = src.slice(start, end);

assert.ok(block.includes('boosterInventory'), 'le bloc "résultats" doit consulter l\'inventaire du joueur');
assert.ok(block.includes('remaining > 0'), 'le bouton "suivant" doit être conditionné à un inventaire non vide');
assert.ok(block.includes("App.openInventoryBooster("), 'le bouton "suivant" doit appeler openInventoryBooster');
assert.ok(block.includes('App.closePackReveal()'), 'le bouton "Fermer" doit toujours rester disponible');
console.log('✅ L\'écran de résultats consulte bien l\'inventaire et conditionne le bouton "suivant".');

// Le bouton "suivant" ne doit JAMAIS apparaître hors du bloc conditionnel remaining>0
const continueButtonIdx = block.indexOf('Ouvrir le suivant');
const conditionIdx = block.indexOf('remaining > 0');
assert.ok(conditionIdx !== -1 && continueButtonIdx > conditionIdx, 'le texte "Ouvrir le suivant" doit apparaître APRÈS la condition qui le garde');
console.log('✅ Le bouton "Ouvrir le suivant" est bien à l\'intérieur du bloc conditionnel, pas affiché inconditionnellement.');

console.log('\n✅ Enchaînement de l\'ouverture de plusieurs boosters validé.');

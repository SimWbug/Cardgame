/* Vérifie la résolution côté client de l'image de booster à afficher pendant
   l'ouverture : celle de l'extension d'origine si réglée, repli propre
   (aucune image, pas d'erreur) sinon. */
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const src = fs.readFileSync('public/app.js', 'utf8');
const start = src.indexOf('function currentPackImage');
const end = src.indexOf('/* Un son de jeu personnalisé');
const chunk = src.slice(start, end);
assert.ok(chunk.includes('packOpeningExtensionId'), 'la fonction doit être présente dans l\'extrait');

const sandbox = { S: {} };
vm.createContext(sandbox);
vm.runInContext(chunk, sandbox);

/* 1) Extension avec une image réglée */
sandbox.S = { extensions: [{ id: 'base', packImage: '/uploads/cards/pack1.png' }, { id: 'ext-x', packImage: null }], packOpeningExtensionId: 'base' };
assert.strictEqual(sandbox.currentPackImage(), '/uploads/cards/pack1.png');
console.log('✅ Renvoie bien l\'image de l\'extension en cours d\'ouverture.');

/* 2) Extension sans image réglée : repli sur aucune image (pas de plantage) */
sandbox.S.packOpeningExtensionId = 'ext-x';
assert.strictEqual(sandbox.currentPackImage(), null);
console.log('✅ Sans image réglée pour cette extension, repli propre sur null.');

/* 3) Extension inconnue (jamais chargée, ID invalide) : repli sur null aussi */
sandbox.S.packOpeningExtensionId = 'ext-inexistante';
assert.strictEqual(sandbox.currentPackImage(), null);
console.log('✅ Une extension inconnue ne fait pas planter, renvoie null.');

/* 4) Sans aucune extension chargée (S.extensions absent) : pas d'erreur */
sandbox.S = { packOpeningExtensionId: 'base' };
assert.doesNotThrow(() => sandbox.currentPackImage());
assert.strictEqual(sandbox.currentPackImage(), null);
console.log('✅ Sans S.extensions chargé, aucune erreur, repli sur null.');

console.log('\n✅ Résolution de l\'image de booster par extension validée.');

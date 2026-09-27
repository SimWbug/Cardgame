/* Vérifie que applyDynamicMediaStyles() construit bien une feuille de style
   avec une règle par image d'interface configurée, et rien si aucune ne
   l'est — avec un DOM minimal simulé (pas de vrai navigateur nécessaire). */
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const src = fs.readFileSync('public/app.js', 'utf8');
const start = src.indexOf('function logoUrl()');
const end = src.indexOf('function playGameSound');
const chunk = src.slice(start, end);
assert.ok(chunk.includes('function applyDynamicMediaStyles'), 'la fonction doit être présente dans l\'extrait');
assert.ok(chunk.includes('function mediaUrl'), 'mediaUrl doit être présente dans l\'extrait');

function fakeDocument() {
  let created = null;
  const head = { appendChild: (el) => { created = el; } };
  return {
    getElementById: (id) => (created && created.id === id ? created : null),
    createElement: () => ({ id: '', textContent: '' }),
    head
  };
}

const sandbox = { S: { content: null }, document: fakeDocument(), console };
vm.createContext(sandbox);
vm.runInContext(chunk, sandbox);

/* 1) Sans contenu chargé (S.content === null), aucune erreur, feuille vide */
assert.doesNotThrow(() => sandbox.applyDynamicMediaStyles());
const styleEl1 = sandbox.document.getElementById('dynamic-media-styles');
assert.strictEqual(styleEl1.textContent, '');
console.log('✅ Sans contenu chargé, aucune erreur et feuille de style vide.');

/* 2) Un seul média configuré (fond du plateau) produit UNE règle ciblée */
sandbox.S.content = { media: { boardBackground: '/uploads/branding/board.png' } };
sandbox.applyDynamicMediaStyles();
const styleEl2 = sandbox.document.getElementById('dynamic-media-styles');
assert.ok(styleEl2.textContent.includes('.fullscreen-combat'), 'la règle doit cibler .fullscreen-combat');
assert.ok(styleEl2.textContent.includes('/uploads/branding/board.png'), 'l\'URL de l\'image doit être incluse');
assert.ok(!styleEl2.textContent.includes('.sidebar'), 'aucune règle ne doit être générée pour un média non configuré');
console.log('✅ Un seul média configuré produit une seule règle CSS ciblée, rien pour les autres.');

/* 3) Les quatre médias configurés produisent les quatre règles attendues */
sandbox.S.content = { media: {
  boardBackground: '/a.png', gateBackground: '/b.png', sidebarBackground: '/c.png', panelTexture: '/d.png'
} };
sandbox.applyDynamicMediaStyles();
const css = sandbox.document.getElementById('dynamic-media-styles').textContent;
['.fullscreen-combat', '.gate-screen', '.sidebar', '.panel'].forEach(sel => {
  assert.ok(css.includes(sel), 'la règle ' + sel + ' doit être présente');
});
console.log('✅ Les quatre images configurées produisent bien leurs quatre règles CSS respectives.');

/* 4) Le logo n'a jamais de règle générée ici (il s'affiche via <img>, pas en fond) */
assert.ok(!css.includes('.gate-logo{background') && !css.includes('.brand-logo{background'), 'le logo ne doit jamais devenir une image de fond');
console.log('✅ Le logo reste affiché via <img>, jamais transformé en image de fond.');

/* 5) Réutilise le même élément <style> à chaque appel (pas de doublon injecté) */
let createCount = 0;
const originalCreateElement = sandbox.document.createElement;
sandbox.document.createElement = (...args) => { createCount++; return originalCreateElement(...args); };
sandbox.applyDynamicMediaStyles();
sandbox.applyDynamicMediaStyles();
sandbox.applyDynamicMediaStyles();
assert.strictEqual(createCount, 0, 'un élément <style> déjà créé ne doit jamais être recréé');
console.log('✅ Le même élément <style> est réutilisé, jamais dupliqué, sur plusieurs rendus.');

console.log('\n✅ Application dynamique des images d\'interface validée.');

/* Vérifie que captureFocus/restoreFocus gardent bien le focus et la position
   du curseur d'un champ de recherche à travers un re-rendu complet (le bug
   signalé : "je dois recliquer dans le champ à chaque lettre tapée"). */
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const src = fs.readFileSync('public/app.js', 'utf8');
const start = src.indexOf('function captureFocus()');
const end = src.indexOf('function render()');
const chunk = src.slice(start, end);
assert.ok(chunk.includes('function restoreFocus'), 'restoreFocus doit être présent dans l\'extrait');

let focusedId = null;
function fakeInput(id) {
  let selStart = 3, selEnd = 3;
  const el = {
    id, tagName: 'INPUT',
    get selectionStart() { return selStart; }, get selectionEnd() { return selEnd; },
    setSelectionRange(a, b) { selStart = a; selEnd = b; },
    focus() { focusedId = id; }
  };
  return el;
}

const inputA = fakeInput('player-search');
const appEl = { contains: (el) => el === inputA || el === sandbox.document.getElementById('player-search-new') };
const sandbox = {
  document: {
    getElementById: (id) => {
      if (id === 'app') return appEl;
      if (id === 'player-search') return inputA; // avant le re-rendu
      if (id === 'player-search-new') return fakeInput('player-search-new'); // après le re-rendu (nouveau nœud)
      return null;
    },
    activeElement: inputA
  },
  console
};
vm.createContext(sandbox);
vm.runInContext(chunk, sandbox);

// 1) On capture le focus d'un champ texte actif à l'intérieur de #app
const saved = sandbox.captureFocus();
assert.ok(saved, 'un champ texte actif dans #app doit être capturé');
assert.strictEqual(saved.id, 'player-search');
assert.strictEqual(saved.start, 3);
console.log('✅ Le focus et la position du curseur d\'un champ actif sont capturés.');

// 2) Après un "re-rendu" (nouveau nœud DOM avec le même id), restoreFocus doit le retrouver et le refocus
focusedId = null;
sandbox.document.getElementById = (id) => {
  if (id === 'player-search') return fakeInput('player-search'); // nouveau nœud, même id, après re-rendu
  return null;
};
sandbox.restoreFocus(saved);
assert.strictEqual(focusedId, 'player-search', 'le nouveau champ (même id) doit recevoir le focus après le re-rendu');
console.log('✅ Après un re-rendu, le nouveau champ (même id) reprend le focus automatiquement.');

// 3) Aucun champ actif (ex: on avait cliqué un bouton) : rien à restaurer, pas d'erreur
sandbox.document.activeElement = { tagName: 'BUTTON', id: 'some-button' };
const savedNone = sandbox.captureFocus();
assert.strictEqual(savedNone, null, 'un élément non éditable ne doit rien capturer');
sandbox.restoreFocus(savedNone); // ne doit pas planter
console.log('✅ Aucune capture ni erreur quand ce n\'est pas un champ texte qui a le focus.');

// 4) Un champ texte SANS id n'est pas capturable (on ne pourrait pas le retrouver après coup)
sandbox.document.activeElement = { tagName: 'INPUT', id: '' };
const savedNoId = sandbox.captureFocus();
assert.strictEqual(savedNoId, null, 'un champ sans id ne doit pas être capturé (impossible à retrouver après re-rendu)');
console.log('✅ Un champ sans identifiant est ignoré proprement (pas de plantage).');

console.log('\n✅ Préservation du focus lors des re-rendus validée.');

/* Teste la logique de glisser-déposer d'une carte (seuil clic/glisser, et
   détection de la zone de dépôt), avec un DOM minimal simulé. */
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const src = fs.readFileSync('public/app.js', 'utf8');
const start = src.indexOf('let cardDrag = null;');
const end = src.indexOf("/* ---------------- Animations de combat");
const chunk = src.slice(start, end);
assert.ok(chunk.includes('function onCardDragMove'), 'onCardDragMove doit être présent dans l\'extrait');
assert.ok(chunk.includes('function onCardDragEnd'), 'onCardDragEnd doit être présent dans l\'extrait');
// 'let' au premier niveau d'un script vm ne s'attache pas à l'objet contexte (contrairement à 'var') :
// on le convertit pour pouvoir piloter cardDrag depuis le test.
const patchedChunk = chunk.replace('let cardDrag = null;', 'var cardDrag = null;');

let playedCardId = null;
let previewedCardId = null;
const listeners = { pointermove: [], pointerup: [] };

function fakeEl(rect, extra) {
  const classes = new Set();
  return Object.assign({
    style: {}, className: '',
    classList: { add: c => classes.add(c), remove: c => classes.delete(c), toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); }, has: c => classes.has(c) },
    getBoundingClientRect: () => rect,
    cloneNode: () => fakeEl(rect),
    remove() {},
  }, extra);
}

const handRowRect = { top: 500, left: 0, right: 800, bottom: 620 };
const boardRowRect = { top: 200, left: 0, right: 800, bottom: 360 };
const originRect = { left: 100, top: 520, width: 120, height: 170 };

const sandbox = {
  window: { addEventListener: (ev, fn) => listeners[ev] && listeners[ev].push(fn), removeEventListener: (ev, fn) => { listeners[ev] = (listeners[ev] || []).filter(f => f !== fn); } },
  document: {
    body: { appendChild: () => {} },
    querySelector: (sel) => {
      if (sel.includes('.hand-row')) return fakeEl(handRowRect);
      if (sel.includes('.board-row.mine')) return fakeEl(boardRowRect);
      return null;
    },
    querySelectorAll: () => ({ forEach: () => {} })
  },
  App: { clickHand: (id) => { playedCardId = id; }, open3DView: (id) => { previewedCardId = id; } },
  setTimeout, clearTimeout, console
};
vm.createContext(sandbox);
vm.runInContext(patchedChunk, sandbox);

// onCardDragMove/onCardDragEnd sont des déclarations de fonction au premier niveau :
// elles s'attachent directement à l'objet contexte, on peut les appeler telles quelles.
function firePointerMove(x, y) { sandbox.onCardDragMove({ clientX: x, clientY: y }); }
function firePointerUp() { sandbox.onCardDragEnd({}); }

// 1) Un tout petit mouvement (< seuil) puis relâcher = ouvre la visionneuse 3D (lecture de la carte), ne la joue PAS
playedCardId = null; previewedCardId = null;
sandbox.cardDrag = { cardId: 'c1', originEl: fakeEl(originRect), ghostEl: null, startX: 150, startY: 600, offsetX: 10, offsetY: 10, w: 120, h: 170, dragging: false };
firePointerMove(152, 601); // 2px, sous le seuil de 8px
firePointerUp();
assert.strictEqual(previewedCardId, 'c1', 'un mouvement infime doit ouvrir la visionneuse 3D (lecture de la carte)');
assert.strictEqual(playedCardId, null, 'un simple clic ne doit PAS jouer la carte');
assert.strictEqual(sandbox.cardDrag, null, 'l\'état de glisser doit être nettoyé après relâchement');
console.log('✅ Un mouvement sous le seuil ouvre la visionneuse 3D sans jouer la carte.');

// 2) Un vrai glisser au-dessus de la main (vers le plateau) → doit jouer la carte
playedCardId = null;
sandbox.cardDrag = { cardId: 'c2', originEl: fakeEl(originRect), ghostEl: null, startX: 150, startY: 600, offsetX: 10, offsetY: 10, w: 120, h: 170, dragging: false };
firePointerMove(150, 300); // largement au-dessus du haut de la main (500) → doit créer le fantôme
assert.ok(sandbox.cardDrag.dragging, 'le seuil dépassé doit activer le mode glisser');
assert.ok(sandbox.cardDrag.ghostEl, 'un fantôme doit être créé une fois le seuil dépassé');
assert.strictEqual(sandbox.cardDrag.overBoard, true, 'au-dessus de la main = zone de dépôt valide');
firePointerUp();
assert.strictEqual(playedCardId, 'c2', 'relâcher au-dessus du plateau doit jouer la carte');
console.log('✅ Glisser la carte au-dessus de la main déclenche la pose (comme sur le plateau).');

// 3) Un glisser qui reste dans la zone de la main (pas assez haut) → ne doit PAS jouer la carte
playedCardId = null;
sandbox.cardDrag = { cardId: 'c3', originEl: fakeEl(originRect), ghostEl: null, startX: 150, startY: 600, offsetX: 10, offsetY: 10, w: 120, h: 170, dragging: false };
firePointerMove(200, 605); // mouvement horizontal, reste dans la main (sous handTop - 10 = 490)
assert.strictEqual(sandbox.cardDrag.overBoard, false, 'rester dans la main ne doit pas compter comme une pose valide');
firePointerUp();
assert.strictEqual(playedCardId, null, 'relâcher dans la main ne doit PAS jouer la carte (retour à la main)');
console.log('✅ Relâcher sans être sorti de la zone de la main annule la pose (retour à la main).');

// 4) L'inclinaison 3D suit le déplacement horizontal, et se limite à ±28°
playedCardId = null;
sandbox.cardDrag = { cardId: 'c4', originEl: fakeEl(originRect), ghostEl: null, startX: 150, startY: 600, offsetX: 10, offsetY: 10, w: 120, h: 170, dragging: false };
firePointerMove(150, 300); // démarre le glisser
firePointerMove(500, 250); // grand déplacement vers la droite
const transform = sandbox.cardDrag.ghostEl.style.transform;
assert.ok(transform.includes('rotateY(28deg)'), 'l\'inclinaison doit être plafonnée à 28°, obtenu : ' + transform);
console.log('✅ L\'inclinaison 3D suit le curseur et se plafonne à ±28°.');
firePointerUp();

console.log('\n✅ Logique de glisser-déposer des cartes validée.');

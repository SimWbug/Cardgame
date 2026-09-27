/* Teste la logique de card3d.js (cycle de vie, condition de concurrence)
   avec un faux Three.js et un faux DOM, sans navigateur réel — on ne peut
   pas tester ici le rendu WebGL en lui-même, seulement la logique JS. */
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

let disposedGeoms = 0, disposedMats = 0, sceneAddCount = 0, sceneRemoveCount = 0;
let canvasesCreated = 0;

class FakeVec { set() {} }
class FakeObj3D {
  constructor() { this.position = { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } }; this.rotation = { x: 0, y: 0 }; }
}
class FakeGeometry { dispose() { disposedGeoms++; } }
class FakeMaterial { constructor(opts) { Object.assign(this, opts || {}); } dispose() { disposedMats++; } }
class FakeTexture { dispose() {} }
class FakeMesh extends FakeObj3D { constructor(geo, mat) { super(); this.geometry = geo; this.material = mat; } }
let capturedScene = null; // référence directe vers la scène réellement construite par card3d.js
class FakeScene { constructor() { this.children = []; capturedScene = this; } add(o) { this.children.push(o); sceneAddCount++; } remove(o) { this.children = this.children.filter(x => x !== o); sceneRemoveCount++; } }
class FakeCamera extends FakeObj3D { constructor() { super(); this.aspect = 1; } updateProjectionMatrix() {} }
class FakeRenderer {
  constructor() { this.domElement = { style: {}, addEventListener() {}, parentNode: null }; }
  setPixelRatio() {} setSize() {} render() {}
}
class FakeClock { getDelta() { return 0.016; } }
class FakeLight extends FakeObj3D {}

const THREE = {
  WebGLRenderer: FakeRenderer, Scene: FakeScene, PerspectiveCamera: FakeCamera,
  Clock: FakeClock, AmbientLight: FakeLight, DirectionalLight: FakeLight, PointLight: FakeLight,
  BoxGeometry: FakeGeometry, MeshStandardMaterial: FakeMaterial, CanvasTexture: FakeTexture,
  Color: function (c) { this.c = c; }, Mesh: FakeMesh, SRGBColorSpace: 'srgb',
  // Le module construit 4 plans de découpe au chargement (LOCAL_CLIP_PLANES),
  // même pour une carte sans parallaxe — il faut donc ces constructeurs pour
  // que le fichier se charge du tout, pas seulement pour les cartes à effet.
  Vector3: function (x, y, z) { this.x = x; this.y = y; this.z = z; },
  Plane: function (normal, constant) {
    this.normal = normal; this.constant = constant;
    this.clone = () => new THREE.Plane(this.normal, this.constant);
    this.copy = (p) => { this.normal = p.normal; this.constant = p.constant; return this; };
    this.applyMatrix4 = () => this;
  }
};

function fakeCtx() {
  return {
    fillRect(){}, strokeRect(){}, beginPath(){}, arc(){}, fill(){}, stroke(){}, clip(){}, rect(){}, save(){}, restore(){},
    drawImage(){}, fillText(){}, measureText: t => ({ width: String(t).length * 6 }),
    createLinearGradient: () => ({ addColorStop(){} }),
    set fillStyle(v){}, set strokeStyle(v){}, set lineWidth(v){}, set font(v){}, set textAlign(v){}, set textBaseline(v){}
  };
}

const sandbox = {
  THREE,
  window: { devicePixelRatio: 1, addEventListener(){}, removeEventListener(){}, dispatchEvent(){}, requestAnimationFrame: () => 1, cancelAnimationFrame(){} },
  document: {
    createElement: (tag) => {
      if (tag === 'canvas') { canvasesCreated++; return { width: 0, height: 0, getContext: () => fakeCtx() }; }
      return {};
    }
  },
  Image: class {
    set src(v) { setTimeout(() => { if (this.onload) this.onload(); }, 0); }
  },
  ResizeObserver: class { observe(){} disconnect(){} },
  requestAnimationFrame: () => 1,
  cancelAnimationFrame(){},
  Event: function (n) { this.n = n; },
  Math, Promise, setTimeout, console
};
vm.createContext(sandbox);

let src = fs.readFileSync('public/card3d.js', 'utf8');
src = src.replace(/^import \* as THREE from 'three';\n/m, ''); // le sandbox fournit déjà THREE
vm.runInContext(src, sandbox);
const Card3D = sandbox.window.Card3D;

function fakeContainer() {
  return {
    innerHTML: '', clientWidth: 300, clientHeight: 400,
    appendChild(el) { this._child = el; el.parentNode = this; },
    removeChild(el) { if (this._child === el) this._child = null; el.parentNode = null; }
  };
}

(async () => {
  // Amorce : le premier montage crée aussi les 3 lumières de la scène (ensureRenderer),
  // ce qui ne compte pas comme "un maillage de carte" pour la suite du test.
  await Card3D.showSingle({ id: 'warmup', name: 'Amorce', type: 'minion', rarity: 'commun', cost: 1, attack: 1, health: 1 }, fakeContainer());
  sceneAddCount = 0; sceneRemoveCount = 0; disposedGeoms = 0;

  // 1) Une visionneuse simple s'ouvre et ajoute UN maillage à la scène
  const el1 = fakeContainer();
  await Card3D.showSingle({ id: 'c1', name: 'Carte A', type: 'minion', rarity: 'commun', cost: 2, attack: 2, health: 2 }, el1);
  assert.strictEqual(sceneAddCount, 1, 'la scène doit contenir 1 maillage après showSingle');
  console.log('✅ showSingle ajoute un maillage à la scène.');

  // 2) LE BUG TROUVÉ À LA RELECTURE : deux appels rapides ne doivent laisser
  //    QU'UNE carte dans la scène réelle (scene.children), pas un fantôme de
  //    la première requête devenue obsolète entretemps.
  const el2 = fakeContainer();
  const p1 = Card3D.showSingle({ id: 'slow', name: 'Lente (avec image)', type: 'minion', rarity: 'legendaire', cost: 5, attack: 5, health: 5, image: '/x.png' }, el2);
  const p2 = Card3D.showSingle({ id: 'fast', name: 'Rapide (sans image)', type: 'sort', rarity: 'commun', cost: 1, value: 1, effectType: 'damage' }, el2);
  await Promise.all([p1, p2]);

  const meshesInScene = () => capturedScene.children.filter(c => c instanceof FakeMesh).length; // exclut les 3 lumières permanentes
  assert.strictEqual(meshesInScene(), 1,
    `la scène ne doit contenir qu'un seul maillage-carte après deux demandes rapprochées, or ${meshesInScene()} (>1 = fantôme laissé par l'appel obsolète)`);
  console.log('✅ Deux demandes rapprochées ne laissent aucun maillage fantôme dans la scène (correctif de concurrence validé).');

  // 3) unmount() nettoie bien la scène restante (dispose géométrie + matériaux)
  const before = disposedGeoms;
  Card3D.unmount();
  assert.ok(disposedGeoms > before, 'unmount doit disposer la géométrie du maillage restant');
  assert.strictEqual(meshesInScene(), 0, 'la scène ne doit plus contenir de maillage-carte après unmount');
  console.log('✅ unmount() libère les ressources GPU et vide la scène.');

  // 4) showBoosterReveal construit bien N maillages (un par carte)
  sceneAddCount = 0;
  const el3 = fakeContainer();
  const cards = [
    { id: 'b1', name: 'B1', type: 'minion', rarity: 'commun', cost: 1, attack: 1, health: 1 },
    { id: 'b2', name: 'B2', type: 'minion', rarity: 'rare', cost: 2, attack: 2, health: 2 },
    { id: 'b3', name: 'B3', type: 'sort', rarity: 'epique', cost: 3, value: 3, effectType: 'heal' },
    { id: 'b4', name: 'B4', type: 'minion', rarity: 'legendaire', cost: 8, attack: 8, health: 8 },
    { id: 'b5', name: 'B5', type: 'sort', rarity: 'commun', cost: 1, value: 1, effectType: 'damage' }
  ];
  await Card3D.showBoosterReveal(cards, el3, () => {});
  assert.strictEqual(sceneAddCount, 5, 'les 5 cartes du booster doivent être ajoutées à la scène');
  console.log('✅ showBoosterReveal construit bien un maillage par carte du booster (5/5).');

  // 5) Une carte SANS image ne plante pas (repli sur icône)
  await Card3D.showSingle({ id: 'noimg', name: 'Sans image', type: 'minion', rarity: 'commun', cost: 1, attack: 1, health: 1 }, fakeContainer());
  console.log('✅ Une carte sans image se compose sans erreur (repli visuel).');

  Card3D.unmount();
  console.log('\n✅ Logique des cartes 3D validée (rendu WebGL réel non testable hors navigateur — à vérifier manuellement).');
})().catch(e => { console.error('❌', e.message, '\n', e.stack); process.exit(1); });

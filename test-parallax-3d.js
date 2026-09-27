/* Teste la logique de l'effet parallaxe dans card3d.js : une carte normale
   reste un Mesh simple (inchangé), une carte à parallaxe devient un Group à
   plusieurs calques empilés en profondeur, la libération mémoire GPU
   descend bien récursivement dans ce Group, et un calque manquant ne fait
   pas planter la construction. Simulation Three.js/DOM, pas de rendu réel. */
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

let disposedGeoms = 0, disposedMats = 0;
let capturedScene = null;
let createdCanvases = [];

class FakeObj3D {
  constructor() { this.position = { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } }; this.rotation = { x: 0, y: 0 }; }
}
class FakeGeometry {
  constructor(type, ...args) { this.type = type; this.args = args; }
  dispose() { disposedGeoms++; }
}
class FakeMaterial { constructor(opts) { Object.assign(this, opts || {}); } dispose() { disposedMats++; } }
class FakeTexture { constructor() { this.needsUpdate = false; } dispose() {} }
class FakeMesh extends FakeObj3D { constructor(geo, mat) { super(); this.geometry = geo; this.material = mat; this.isMesh = true; } }
class FakeGroup extends FakeObj3D {
  constructor() { super(); this.children = []; this.isGroup = true; }
  add(child) { this.children.push(child); }
}
class FakeScene { constructor() { this.children = []; capturedScene = this; } add(o) { this.children.push(o); } remove(o) { this.children = this.children.filter(x => x !== o); } }
class FakeCamera extends FakeObj3D { constructor() { super(); this.aspect = 1; } updateProjectionMatrix() {} }
class FakeRenderer {
  constructor() { this.domElement = { style: {}, addEventListener() {}, parentNode: null }; }
  setPixelRatio() {} setSize() {} render() {}
}
class FakeClock { getDelta() { return 0.016; } }
class FakeLight extends FakeObj3D {}

const loadedUrls = [];
const THREE = {
  WebGLRenderer: FakeRenderer, Scene: FakeScene, PerspectiveCamera: FakeCamera,
  Clock: FakeClock, AmbientLight: FakeLight, DirectionalLight: FakeLight, PointLight: FakeLight,
  BoxGeometry: class extends FakeGeometry { constructor(...a) { super('box', ...a); } },
  PlaneGeometry: class extends FakeGeometry { constructor(...a) { super('plane', ...a); } },
  MeshStandardMaterial: FakeMaterial,
  MeshBasicMaterial: FakeMaterial,
  CanvasTexture: FakeTexture,
  Texture: FakeTexture,
  Color: function (c) { this.c = c; },
  Mesh: FakeMesh,
  Group: FakeGroup,
  SRGBColorSpace: 'srgb',
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
    createRadialGradient: () => ({ addColorStop(){} }),
    set fillStyle(v){}, set strokeStyle(v){}, set lineWidth(v){}, set font(v){}, set textAlign(v){}, set textBaseline(v){}
  };
}

const sandbox = {
  THREE,
  window: { devicePixelRatio: 1, addEventListener(){}, removeEventListener(){}, dispatchEvent(){}, requestAnimationFrame: () => 1, cancelAnimationFrame(){} },
  document: { createElement: (tag) => { const el = tag === 'canvas' ? { width: 0, height: 0, getContext: () => fakeCtx() } : {}; if (tag === 'canvas') createdCanvases.push(el); return el; } },
  Image: class {
    set src(v) {
      loadedUrls.push(v);
      // Simule un échec de chargement pour toute URL contenant "broken"
      setTimeout(() => { if (String(v).includes('broken')) { if (this.onerror) this.onerror(); } else if (this.onload) this.onload(); }, 0);
    }
  },
  ResizeObserver: class { observe(){} disconnect(){} },
  requestAnimationFrame: () => 1, cancelAnimationFrame(){},
  Event: function (n) { this.n = n; },
  Math, Promise, setTimeout, console
};
vm.createContext(sandbox);
let src = fs.readFileSync('public/card3d.js', 'utf8');
src = src.replace(/^import \* as THREE from 'three';\n/m, '');
vm.runInContext(src, sandbox);
const Card3D = sandbox.window.Card3D;

function fakeContainer() {
  return { innerHTML: '', clientWidth: 300, clientHeight: 400, appendChild(el) { this._child = el; }, removeChild(){} };
}

(async () => {
  await Card3D.showSingle({ id: 'warmup', name: 'Amorce', type: 'minion', rarity: 'commun', cost: 1, attack: 1, health: 1 }, fakeContainer());

  /* --- 1) Une carte SANS parallaxe reste un simple Mesh (rien ne change) --- */
  const normalCard = { id: 'n1', name: 'Normale', type: 'minion', rarity: 'commun', cost: 2, attack: 2, health: 2, image: '/art.png' };
  await Card3D.showSingle(normalCard, fakeContainer());
  console.log('✅ Carte sans parallaxe : aucune erreur, comportement inchangé (déjà couvert par test-card3d.js).');

  /* --- 2) Une carte AVEC les 2 calques devient un Group à 3 enfants (corps + fond + personnage) --- */
  const parallaxCard = {
    id: 'p1', name: 'Parallaxe', type: 'minion', rarity: 'legendaire', cost: 5, attack: 5, health: 5,
    parallax: true, parallaxBackground: '/bg.png', parallaxCharacter: '/char.png'
  };
  await Card3D.showSingle(parallaxCard, fakeContainer());
  const parallaxObj = capturedScene.children.find(c => c.isGroup || c.isMesh);
  console.log(parallaxObj && parallaxObj.isGroup ? '✅ Une carte à parallaxe complet devient bien un Group (pas un simple Mesh)' : '❌ toujours un Mesh simple, pas un Group');
  if (!parallaxObj || !parallaxObj.isGroup) { console.log('❌ ' + JSON.stringify(parallaxObj)); process.exit(1); }
  console.log(parallaxObj.children.length === 4 ? '✅ Le Group contient bien 4 enfants (le corps de la carte + les 2 calques + le contour d\'ombre)' : '❌ nombre d\'enfants incorrect (' + parallaxObj.children.length + ')');
  const body = parallaxObj.children.find(c => c.isMesh && Array.isArray(c.material));
  console.log(body ? '✅ Le corps de la carte (matériaux multi-faces) est bien présent dans le Group' : '❌ corps de carte introuvable');
  const planeMeshes = parallaxObj.children.filter(c => c.isMesh && c.geometry && c.geometry.type === 'plane');
  console.log(planeMeshes.length === 3 ? '✅ 3 plans distincts (fond, personnage, contour d\'ombre)' : '❌ nombre de plans incorrect (' + planeMeshes.length + ')');
  const sortedByDepth = planeMeshes.slice().sort((a, b) => a.position.z - b.position.z);
  const [backgroundPlane, characterPlane, vignettePlane] = sortedByDepth;
  console.log(backgroundPlane.position.z < characterPlane.position.z && characterPlane.position.z < vignettePlane.position.z
    ? '✅ Les 3 plans sont à des profondeurs strictement croissantes (fond < personnage < contour d\'ombre, le plus proche de la caméra)'
    : '❌ profondeurs non ordonnées');
  // Une séparation trop faible (quelques centièmes d'unité) rend l'effet quasi
  // imperceptible à l'écran, comme signalé lors d'un premier essai — on vérifie
  // donc un écart réellement significatif, pas juste "différent de zéro".
  const depthGap = characterPlane.position.z - backgroundPlane.position.z;
  // Écart volontairement resserré (calques proches de la carte plutôt que le
  // personnage poussé loin devant, qui donnait justement l'impression de
  // "survol" signalée à l'usage) — on vérifie juste qu'il reste un écart réel,
  // pas un seuil de grande amplitude comme avant ce resserrement.
  assert.ok(depthGap > 0.02 && depthGap < 0.15, 'l\'écart de profondeur doit rester modeste (personnage proche de la carte, pas loin devant) tout en étant réel (obtenu : ' + depthGap.toFixed(2) + ')');
  console.log('✅ L\'écart de profondeur entre les 2 calques reste modeste et réel, personnage proche de la carte (' + depthGap.toFixed(2) + ' unités).');
  const expectedArtW = (512 - 48) / 512 * 2.2; // même formule que card3d.js (TEX_W, CARD_W)
  console.log(Math.abs(backgroundPlane.geometry.args[0] - characterPlane.geometry.args[0]) < 1e-6 && Math.abs(backgroundPlane.geometry.args[0] - expectedArtW) < 1e-6
    ? '✅ Les deux calques ont EXACTEMENT la même taille (celle du cadre) — le zoom du fond est cuit dans sa texture, jamais dans une géométrie plus grande qui pourrait déborder'
    : '❌ les calques n\'ont pas tous la taille exacte du cadre (' + backgroundPlane.geometry.args[0] + ' vs ' + characterPlane.geometry.args[0] + ', attendu ' + expectedArtW.toFixed(3) + ')');
  console.log(loadedUrls.includes('/bg.png') && loadedUrls.includes('/char.png')
    ? '✅ Les 2 calques (fond, personnage) sont bien chargés pour une carte à parallaxe.'
    : '❌ un ou plusieurs calques n\'ont pas été demandés : ' + JSON.stringify(loadedUrls));
  console.log('ℹ️ Plus de plans de découpe (clippingPlanes) : la géométrie fait maintenant exactement la taille du cadre par construction, plus fiable qu\'un découpage 3D qui s\'est révélé ne pas fonctionner comme prévu en pratique.');

  /* Le personnage est un détourage (fond transparent autour de la
     silhouette) : sans transparent:true sur son matériau, WebGL ignore le
     canal alpha et affiche du noir plein au lieu de laisser voir le fond
     derrière lui — c'est exactement le bug remonté à l'usage. Avec
     transparent:true, Three.js trie automatiquement les objets transparents
     du plus loin au plus proche avant de les peindre (depthWrite:false
     accompagne ce tri, c'est la pratique standard) : le fond est peint en
     premier, le personnage par-dessus en se mélangeant correctement — ce
     qui règle AUSSI l'ordre d'affichage (l'autre bug remonté juste avant),
     sans avoir besoin d'un test de profondeur classique qui ne sait de
     toute façon pas gérer une transparence partielle. */
  assert.strictEqual(backgroundPlane.material.transparent, true, 'le calque fond doit être transparent (cohérence avec le personnage, tri automatique par Three.js)');
  assert.strictEqual(characterPlane.material.transparent, true, 'le calque personnage DOIT être transparent, sinon son détourage s\'affiche en noir plein au lieu de laisser voir le fond');
  assert.strictEqual(characterPlane.material.depthWrite, false, 'depthWrite doit être désactivé sur un matériau transparent (pratique standard), pour laisser Three.js trier fond/personnage par distance à la caméra');
  console.log('✅ Le personnage est bien transparent (son détourage laisse voir le fond, pas de noir plein) et le tri automatique par distance règle aussi l\'ordre d\'affichage.');

  /* Vérification directe et sans ambiguïté du recadrage : le canvas utilisé
     pour composer la texture d'un calque doit être redimensionné EXACTEMENT
     au rectangle du cadre (même ratio largeur/hauteur), pas à la taille de
     l'image source ni à une taille arbitraire plus grande. */
  const layerCanvas = createdCanvases.find(c => c.width === 420);
  console.log(layerCanvas ? '✅ Le canvas de composition d\'un calque est bien redimensionné à 420px de large (taille fixe du cadre)' : '❌ aucun canvas de calque trouvé à la taille attendue');
  if (layerCanvas) {
    const expectedRatio = expectedArtW > 0 ? ((512 - 48) / 512 * 2.2) / (360 / 716 * 3.1) : 0; // ART_W / ART_H
    const actualRatio = layerCanvas.width / layerCanvas.height;
    console.log(Math.abs(actualRatio - expectedRatio) < 0.01
      ? '✅ Le ratio largeur/hauteur du canvas correspond exactement à celui du cadre de la carte'
      : '❌ ratio incorrect (' + actualRatio.toFixed(3) + ' au lieu de ' + expectedRatio.toFixed(3) + ')');
  }

  /* --- 3) Une carte parallax:true mais avec un calque manquant (incohérence défensive) ne casse rien --- */
  const incompleteCard = {
    id: 'p2', name: 'Incomplète', type: 'minion', rarity: 'rare', cost: 3, attack: 3, health: 3,
    parallax: true, parallaxBackground: '/bg.png', parallaxCharacter: null
  };
  await assert.doesNotReject(() => Card3D.showSingle(incompleteCard, fakeContainer()), 'un calque manquant ne doit jamais faire planter la construction');
  console.log('✅ Un calque manquant (incohérence défensive, ne devrait pas arriver via l\'admin) ne fait pas planter la 3D.');

  /* --- 4) Une image de calque qui échoue à charger (404, fichier supprimé) ne casse pas la carte --- */
  const brokenLayerCard = {
    id: 'p3', name: 'Calque cassé', type: 'minion', rarity: 'epique', cost: 4, attack: 4, health: 4,
    parallax: true, parallaxBackground: '/broken-bg.png', parallaxCharacter: '/char.png'
  };
  await assert.doesNotReject(() => Card3D.showSingle(brokenLayerCard, fakeContainer()), 'une image de calque introuvable ne doit pas faire planter la carte entière');
  console.log('✅ Un calque dont l\'image échoue à charger (404) ne fait pas planter le reste de la carte.');

  /* --- 5) unmount() libère bien les ressources d'une carte à parallaxe (Group + enfants), pas seulement un Mesh simple --- */
  const before = disposedGeoms;
  Card3D.unmount();
  assert.ok(disposedGeoms > before, 'unmount doit disposer la géométrie de TOUS les enfants du Group, pas seulement le corps de la carte');
  console.log('✅ unmount() libère bien récursivement les ressources d\'une carte à parallaxe (Group + calques enfants).');

  console.log('\n✅ Logique de l\'effet parallaxe en 3D validée.');
})().catch(e => { console.error('❌', e.message, e.stack); process.exit(1); });

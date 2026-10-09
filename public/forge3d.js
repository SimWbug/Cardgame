/* ============================================================
   CLEAN GANG DECKS — la Forge en 3D (Three.js, low poly)

   Le forgeron est le modèle 3D /models/forgeron.glb (squelette « Rig_Medium »),
   animé en code os par os. Tant que le modèle charge (ou s'il manque), un nain
   construit en code le remplace. Il joue une petite scène selon l'état de la forge :
     - unbuilt     : la forge n'est pas construite, le nain attend à côté des matériaux
     - idle        : forge prête, aucune commande, le nain patiente
     - travail     : il martèle sur l'enclume (étincelles)
     - demandes    : il martèle à toute vitesse, une pile de commandes à côté
     - cafe        : il boit son café (vapeur), le marteau posé
     - exploration : il t'accompagne en Expédition, une pancarte l'annonce
     - mine        : il est parti chercher du charbon, une pancarte l'annonce
     - ready       : il brandit le booster terminé en sautillant
   Un seul renderer, créé à la première ouverture de la Forge, que l'on
   raccroche au DOM après chaque redessin de la page.
   ============================================================ */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';

let renderer = null, scene, camera, clock, rafId = null, host = null;

/* ---------- Sons du forgeron (synthétisés, aucun fichier) ----------
   Volume = réglage « effets » des Options ; rien si le son est coupé. */
let actx = null;
function sfxVol() { try { return typeof window.forgeSoundVolume === 'function' ? window.forgeSoundVolume() : 0.5; } catch (e) { return 0; } }
function ctx() {
  if (!actx) { const C = window.AudioContext || window.webkitAudioContext; if (!C) return null; actx = new C(); }
  if (actx.state === 'suspended') actx.resume().catch(() => {});
  return actx;
}
function tone(c, freq, start, dur, type, gain, out) {
  const o = c.createOscillator(), g = c.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, start);
  g.gain.setValueAtTime(0.0001, start); g.gain.exponentialRampToValueAtTime(gain, start + 0.005); g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  o.connect(g); g.connect(out); o.start(start); o.stop(start + dur + 0.02);
}
function noise(c, start, dur, freq, q, gain, out) {
  const len = Math.floor(c.sampleRate * dur), buf = c.createBuffer(1, len, c.sampleRate), d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = c.createBufferSource(); src.buffer = buf;
  const f = c.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = q;
  const g = c.createGain(); g.gain.value = gain;
  src.connect(f); f.connect(g); g.connect(out); src.start(start);
}
function sound(kind) {
  const v = sfxVol();
  if (!v || document.hidden) return;
  const c = ctx(); if (!c) return;
  const out = c.createGain(); out.gain.value = v; out.connect(c.destination);
  const t = c.currentTime + 0.01;
  if (kind === 'hit') { // coup de marteau sur l'enclume : « tiing » métallique
    const p = 0.92 + Math.random() * 0.16;
    tone(c, 1320 * p, t, 0.35, 'sine', 0.18, out); tone(c, 2790 * p, t, 0.18, 'sine', 0.08, out); tone(c, 4100 * p, t, 0.08, 'triangle', 0.04, out);
    noise(c, t, 0.05, 3000, 1.2, 0.25, out);
  } else if (kind === 'sip') { // gorgée de café
    noise(c, t, 0.22, 900, 3, 0.35, out); noise(c, t + 0.25, 0.15, 600, 4, 0.25, out);
  } else if (kind === 'ready') { // « Hop ! » : petite fanfare
    [523, 659, 784, 1047].forEach((f, i) => tone(c, f, t + i * 0.09, 0.28, 'triangle', 0.16, out));
    tone(c, 1568, t + 0.38, 0.4, 'sine', 0.08, out);
  } else if (kind === 'whoosh') {
    noise(c, t, 0.4, 500, 0.8, 0.25, out);
  }
}
let state = 'idle', stateSince = 0;
const P = {}; // pièces animées de la scène

const mat = (color, opts) => new THREE.MeshStandardMaterial(Object.assign({ color, flatShading: true, roughness: 0.85, metalness: 0.05 }, opts || {}));
const M = {
  skin: mat(0xf0b48a), beard: mat(0xc0522a), hair: mat(0xa8441f), tunic: mat(0x3f6db3), pants: mat(0x5a3a22), boots: mat(0x2d1e14),
  apron: mat(0x7a4a26), belt: mat(0x3a2414), gold: mat(0xe8b13d, { metalness: 0.7, roughness: 0.35 }), helm: mat(0x9aa3ad, { metalness: 0.75, roughness: 0.35 }),
  horn: mat(0xf2ead6), iron: mat(0x4a4f57, { metalness: 0.6, roughness: 0.45 }), wood: mat(0x8a5a32), woodDark: mat(0x5e3b1f),
  stone: mat(0x6e6a73), brick: mat(0x7d3f2c), ground: mat(0x2a2433), eye: mat(0x1a1410), mug: mat(0xd9d2c4), coffee: mat(0x4a2c18),
  scroll: mat(0xe9dcb8), ember: new THREE.MeshBasicMaterial({ color: 0xff7a1a }), hot: new THREE.MeshStandardMaterial({ color: 0xff8a2a, emissive: 0xff5a00, emissiveIntensity: 1.2, flatShading: true })
};
const box = (w, h, d, m) => new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
const cyl = (rt, rb, h, seg, m) => new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg || 6), m);

function textTexture(lines, w, h, bg, fg) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = fg; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  lines.forEach((l, i) => { ctx.font = `bold ${l.size || 40}px Inter, Arial, sans-serif`; ctx.fillText(l.text, w / 2, h / 2 + (i - (lines.length - 1) / 2) * (l.size || 40) * 1.25); });
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace || t.colorSpace;
  return t;
}

/* ---------- Le nain ---------- */
function buildDwarf() {
  const d = new THREE.Group();
  // Jambes et bottes
  [-0.17, 0.17].forEach(x => {
    const leg = cyl(0.12, 0.13, 0.42, 6, M.pants); leg.position.set(x, 0.33, 0); d.add(leg);
    const boot = box(0.24, 0.16, 0.34, M.boots); boot.position.set(x, 0.08, 0.05); d.add(boot);
  });
  // Corps (tunique), tablier, ceinture
  const body = cyl(0.36, 0.42, 0.62, 7, M.tunic); body.position.y = 0.84; d.add(body);
  const apron = box(0.5, 0.6, 0.06, M.apron); apron.position.set(0, 0.78, 0.36); apron.rotation.x = -0.12; d.add(apron);
  const belt = cyl(0.43, 0.43, 0.1, 7, M.belt); belt.position.y = 0.62; d.add(belt);
  const buckle = box(0.14, 0.11, 0.05, M.gold); buckle.position.set(0, 0.62, 0.44); d.add(buckle);
  // Tête
  const head = new THREE.Group(); head.position.y = 1.32; d.add(head);
  const skull = new THREE.Mesh(new THREE.IcosahedronGeometry(0.3, 0), M.skin); head.add(skull);
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.075, 0.16, 5), M.skin); nose.rotation.x = Math.PI / 2; nose.position.set(0, -0.02, 0.3); head.add(nose);
  [-0.11, 0.11].forEach(x => { const e = box(0.05, 0.06, 0.03, M.eye); e.position.set(x, 0.06, 0.26); head.add(e); const brow = box(0.12, 0.035, 0.04, M.hair); brow.position.set(x, 0.13, 0.26); brow.rotation.z = x > 0 ? -0.2 : 0.2; head.add(brow); });
  const beard = new THREE.Mesh(new THREE.ConeGeometry(0.3, 0.62, 6), M.beard); beard.rotation.x = Math.PI; beard.position.set(0, -0.3, 0.14); head.add(beard);
  [-1, 1].forEach(s => { const m = box(0.2, 0.06, 0.06, M.beard); m.position.set(s * 0.1, -0.07, 0.29); m.rotation.z = s * -0.35; head.add(m); });
  // Casque à cornes
  const helm = new THREE.Mesh(new THREE.SphereGeometry(0.33, 7, 4, 0, Math.PI * 2, 0, Math.PI / 2), M.helm); helm.position.y = 0.06; head.add(helm);
  const rim = cyl(0.35, 0.35, 0.06, 8, M.helm); rim.position.y = 0.06; head.add(rim);
  [-1, 1].forEach(s => { const h = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.3, 5), M.horn); h.position.set(s * 0.33, 0.22, 0); h.rotation.z = s * -0.9; head.add(h); });
  // Bras (pivot à l'épaule)
  const arm = (side) => {
    const pivot = new THREE.Group(); pivot.position.set(side * 0.44, 1.06, 0);
    const up = cyl(0.09, 0.1, 0.46, 6, M.tunic); up.position.y = -0.22; pivot.add(up);
    const hand = new THREE.Mesh(new THREE.IcosahedronGeometry(0.1, 0), M.skin); hand.position.y = -0.48; pivot.add(hand);
    d.add(pivot); return { pivot, hand };
  };
  const R = arm(-1), L = arm(1);
  // Marteau (dans la main droite)
  const hammer = new THREE.Group();
  const handle = cyl(0.03, 0.03, 0.55, 5, M.wood); handle.position.y = -0.2; hammer.add(handle);
  const hhead = box(0.26, 0.14, 0.14, M.iron); hhead.position.y = -0.48; hammer.add(hhead);
  hammer.position.y = -0.48; hammer.rotation.x = Math.PI / 2; R.pivot.add(hammer);
  // Tasse de café (main gauche)
  const mug = new THREE.Group();
  const cup = cyl(0.08, 0.07, 0.15, 7, M.mug); mug.add(cup);
  const cof = cyl(0.07, 0.07, 0.01, 7, M.coffee); cof.position.y = 0.07; mug.add(cof);
  const ear = new THREE.Mesh(new THREE.TorusGeometry(0.045, 0.015, 4, 6), M.mug); ear.position.x = 0.09; mug.add(ear);
  mug.position.set(0, -0.56, 0.06); L.pivot.add(mug);
  // Booster brandi (état « prêt »)
  const pack = box(0.36, 0.5, 0.05, new THREE.MeshStandardMaterial({ map: textTexture([{ text: '✦', size: 120 }], 128, 180, '#7a4cff', '#ffe08a'), roughness: 0.4, metalness: 0.3 }));
  pack.visible = false; d.add(pack);
  // Gouttes de sueur (état « demandes »)
  const sweat = new THREE.Group();
  [-0.22, 0.25].forEach((x, i) => { const s = new THREE.Mesh(new THREE.SphereGeometry(0.035, 4, 3), new THREE.MeshStandardMaterial({ color: 0x8fd3ff, transparent: true, opacity: 0.85 })); s.position.set(x, 0.22 - i * 0.05, 0.24); sweat.add(s); });
  head.add(sweat);
  Object.assign(P, { dwarf: d, head, R, L, hammer, mug, pack, sweat, body });
  return d;
}

/* ---------- Le forgeron en 3D (modèle .glb) ----------
   Le modèle n'a pas d'animations : on tourne ses os nous-mêmes. Chaque rotation
   est donnée dans le repère du personnage (X vers sa gauche, Y en haut, Z devant
   lui) et s'ajoute à sa pose de repos (bras à l'horizontale). */
const MODEL_URL = '/models/forgeron.glb';
const MODEL_HEIGHT = 1.7;
let rig = null, rigLoading = false;
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _qm = new THREE.Quaternion(), _e = new THREE.Euler();
const boneKey = n => String(n || '').toLowerCase().replace(/[^a-z]/g, '');
function loadRig() {
  if (rig || rigLoading) return;
  rigLoading = true;
  new GLTFLoader().load(MODEL_URL, (gltf) => {
    const m = gltf.scene;
    m.updateMatrixWorld(true);
    const bb = new THREE.Box3().setFromObject(m);
    const sc = MODEL_HEIGHT / Math.max(0.01, bb.max.y - bb.min.y);
    m.scale.setScalar(sc);
    m.position.y = -bb.min.y * sc;
    const bones = {};
    m.traverse(o => {
      if (o.isBone) bones[boneKey(o.name)] = o;
      if (o.isMesh) {
        o.frustumCulled = false;
        if (o.material && o.material.map) { o.material.map.colorSpace = THREE.SRGBColorSpace; o.material.map.needsUpdate = true; }
      }
    });
    if (!bones.upperarmr || !bones.upperarml || !bones.head) { rigLoading = false; return; }
    const rest = {};
    Object.entries(bones).forEach(([k, b]) => { rest[k] = b.quaternion.clone(); });
    rig = { model: m, bones, rest, scale: sc, cur: {} };
    // Les objets tenus en main suivent les os « handslot » (échelle du modèle compensée)
    const holder = (bone, obj, pos, rot) => {
      const g = new THREE.Group(); g.scale.setScalar(1 / sc); bone.add(g);
      obj.position.set(pos[0], pos[1], pos[2]); obj.rotation.set(rot[0], rot[1], rot[2]); g.add(obj); return g;
    };
    const HS = window.__forgeHold || {};
    // os « handslot.r » (bras à l'horizontale) : X le long du bras, Y devant, Z au-dessus.
    // Le manche part vers l'arrière du poing : bras tendu devant, le marteau pointe vers le bas.
    rig.hammerHolder = holder(bones.handslotr || bones.handr, P.hammer, HS.hp || [0, 0, 0], HS.hr || [0, 0, 0]);
    rig.mugHolder = holder(bones.handslotl || bones.handl, P.mug, HS.mp || [0, 0, 0], HS.mr || [0, 0, 0]);
    rig.sweatHolder = holder(bones.head, P.sweat, HS.sp || [0, 0.45, 0.1], [0, 0, 0]);
    // On remplace le nain construit en code
    P.dwarf.children.forEach(c => { if (c !== P.pack) c.visible = false; });
    P.dwarf.add(m);
    P.dwarf.position.set(-0.45, 0, 0.26); // un peu plus près de l'enclume, à portée de marteau
    rigLoading = false;
    setState(state);
    loadDrinkAnim();
  }, undefined, () => { rigLoading = false; });
}
/* Gobelet de café (modèle /models/tasse-cafe.fbx) : remplace la tasse dessinée en code */
const CUP_URL = '/models/tasse-cafe.fbx';
const CUP_HEIGHT = 0.24;
function loadCup() {
  new FBXLoader().load(CUP_URL, (cup) => {
    cup.updateMatrixWorld(true);
    const bb = new THREE.Box3().setFromObject(cup);
    const sc = CUP_HEIGHT / Math.max(0.001, bb.max.y - bb.min.y);
    cup.scale.setScalar(sc);
    // centré sur la main : le poing tient le gobelet par le milieu (sur la bague en carton)
    cup.position.set(-(bb.min.x + bb.max.x) / 2 * sc, -bb.min.y * sc - CUP_HEIGHT * 0.45, -(bb.min.z + bb.max.z) / 2 * sc);
    cup.traverse(o => {
      if (!o.isMesh) return;
      const mats = (Array.isArray(o.material) ? o.material : [o.material]).map(m => {
        const c = m.color ? m.color.clone() : new THREE.Color(0xffffff);
        if (c.getHSL({}).l < 0.06) c.setHex(0x2a1d16); // couvercle presque noir : un peu éclairci pour rester lisible
        return new THREE.MeshStandardMaterial({ color: c, roughness: 0.7, metalness: 0 });
      });
      o.material = Array.isArray(o.material) ? mats : mats[0];
    });
    P.mug.children.forEach(c => { c.visible = false; });
    P.mug.add(cup);
    P.mugTop = CUP_HEIGHT * 0.55;
  }, undefined, () => {});
}
/* Enclume (modèle /models/enclume.glb) : posée sur la souche, à la place de l'enclume dessinée en code.
   La bigorne du modèle est du côté +X, comme celle d'origine. */
const ANVIL_URL = '/models/enclume.glb';
const ANVIL_TOP = 0.86; // hauteur du dessus de l'enclume dans le groupe « enclume » (comme avant)
function loadAnvil() {
  new GLTFLoader().load(ANVIL_URL, (gltf) => {
    const a = gltf.scene;
    a.updateMatrixWorld(true);
    const bb = new THREE.Box3().setFromObject(a);
    const stumpTop = 0.45;
    const sc = (ANVIL_TOP - stumpTop) / Math.max(0.001, bb.max.y - bb.min.y);
    a.scale.setScalar(sc);
    a.position.set(-(bb.min.x + bb.max.x) / 2 * sc + 0.05, stumpTop - bb.min.y * sc, -(bb.min.z + bb.max.z) / 2 * sc);
    a.traverse(o => {
      if (!o.isMesh) return;
      const m = o.material;
      if (m && m.map) m.map.colorSpace = THREE.SRGBColorSpace;
    });
    (P.anvilIron || []).forEach(o => { o.visible = false; });
    P.anvil.add(a);
    P.ingot.position.y = ANVIL_TOP + 0.02;
    P.anvilModel = a;
  }, undefined, () => {});
}
/* Four (modèle /models/four.glb) : foyer ouvert à l'avant (+Z), braises dans la fosse.
   On le tourne vers la caméra et on fait rougeoyer le fond de la fosse sous le charbon. */
const FURNACE_URL = '/models/four.glb';
const FURNACE_HEIGHT = 1.95;
function loadFurnace() {
  new GLTFLoader().load(FURNACE_URL, (gltf) => {
    const f = gltf.scene;
    f.updateMatrixWorld(true);
    const bb = new THREE.Box3().setFromObject(f);
    const sc = FURNACE_HEIGHT / Math.max(0.001, bb.max.y - bb.min.y);
    const pivot = new THREE.Group(); pivot.rotation.y = P.furnaceTurn !== undefined ? P.furnaceTurn : 0.3; pivot.scale.setScalar(sc);
    f.position.set(-(bb.min.x + bb.max.x) / 2, -bb.min.y, -(bb.min.z + bb.max.z) / 2);
    f.traverse(o => { if (o.isMesh && o.material && o.material.map) o.material.map.colorSpace = THREE.SRGBColorSpace; });
    pivot.add(f);
    // Braises : fond de la fosse (sous les morceaux de charbon), même matériau incandescent que l'ancienne bouche du four
    const bed = new THREE.Mesh(new THREE.BoxGeometry(0.64, 0.03, 1.05), P.mouth.material);
    bed.position.set(0, 0.84 - bb.min.y, 0.32); f.add(bed);
    const glow = new THREE.PointLight(0xff6a1a, 1.6, 2.2, 1.5); glow.position.set(0, 1.15 - bb.min.y, 0.2); f.add(glow); P.hearthGlow = glow;
    P.fireLight.position.set(0, 1.5 - bb.min.y, 1.0); f.add(P.fireLight);
    (P.furnaceBricks || []).forEach(o => { o.visible = false; });
    P.furnace.add(pivot);
    P.furnaceModel = pivot;
  }, undefined, () => {});
}
/* Bâtiment de la forge (modèle /models/batiment-forge.obj, exporté de Blender avec Z en haut).
   C'est le décor : un atelier ouvert sur un côté, avec toit, étagère, seaux, meule, réserve de bois.
   Son enclume, sa souche, son marteau, son four et son charbon sont cachés : on garde nos modèles
   (enclume, four, forgeron), placés aux mêmes endroits. Pas de fichier .mtl : les couleurs sont
   données ici d'après le nom des matériaux, et le sol utilise sa texture (herbe et terre battue). */
const BUILDING_URL = '/models/batiment-forge.obj';
const BUILDING_GROUND_TEX = '/models/batiment-forge-sol.png';
const BUILDING_SCALE = 0.54; // l'enclume du bâtiment (1,42 de haut) → la nôtre (0,77)
const BUILDING_COLORS = {
  Wood: 0x7a4a28, Wood_Light: 0xa8743f, Stone_Light: 0xb9b2a4, Blue: 0x4f78a8, Brick: 0xa4543a, Brick_Light: 0xc47a52,
  Brick_Dark: 0x7c3a26, Brick_Tube: 0x8c4a2e, Anvil: 0x4a4f57, Walls: 0xe6d6b4, Metal: 0x8c939c, None: 0xc8c2b8,
  Grass: 0x6f9b3c, Coal: 0x2a2624, Furnace: 0x6a625a, Furnace_2: 0xff7a2a, Ground: 0xffffff
};
const BUILDING_HIDE = /^(Anvil|Stump|Hammer|Furnace|Coal)/;
/* Point du bâtiment (repère Blender) → point de la scène */
function buildingPoint(x, y, z) { return new THREE.Vector3(-y * BUILDING_SCALE + P.buildingT.x, z * BUILDING_SCALE, -x * BUILDING_SCALE + P.buildingT.z); }
function loadBuilding() {
  new OBJLoader().load(BUILDING_URL, (obj) => {
    const tex = new THREE.TextureLoader().load(BUILDING_GROUND_TEX);
    tex.colorSpace = THREE.SRGBColorSpace;
    obj.traverse(o => {
      if (!o.isMesh) return;
      if (BUILDING_HIDE.test(o.name)) { o.visible = false; return; }
      const conv = m => {
        const ground = m.name === 'Ground';
        return new THREE.MeshStandardMaterial({ color: BUILDING_COLORS[m.name] !== undefined ? BUILDING_COLORS[m.name] : 0xbbbbbb, map: ground ? tex : null,
          roughness: 0.9, metalness: m.name === 'Metal' ? 0.5 : 0, flatShading: !ground, side: THREE.DoubleSide });
      };
      o.material = Array.isArray(o.material) ? o.material.map(conv) : conv(o.material);
    });
    // Z en haut → Y en haut, côté ouvert de l'atelier tourné vers la caméra, enclume du bâtiment à la place de la nôtre
    const root = new THREE.Group();
    obj.rotation.x = -Math.PI / 2;
    const turn = new THREE.Group(); turn.rotation.y = Math.PI / 2; turn.add(obj);
    root.add(turn); root.scale.setScalar(BUILDING_SCALE);
    const anvilB = { x: -0.33, y: -4.24 }; // centre de l'enclume dans le bâtiment (repère Blender)
    P.buildingT = { x: P.anvil.position.x + anvilB.y * BUILDING_SCALE, z: P.anvil.position.z + anvilB.x * BUILDING_SCALE };
    root.position.set(P.buildingT.x, 0, P.buildingT.z);
    P.set.add(root);
    P.building = root;
    (P.oldDecor || []).forEach(o => { o.visible = false; });
    // Notre four à la place du four du bâtiment (même empreinte au sol, ouverture vers l'avant)
    const fp = buildingPoint(2.9, -2.65, 0);
    P.furnace.position.set(fp.x, 0, fp.z);
    if (P.furnaceModel) P.furnaceModel.rotation.y = 0;
    P.furnaceTurn = 0;
  }, undefined, () => {});
}
/* Panneau « parti en exploration » (modèle /models/panneau.glb).
   Modèle « Stylized Wooden Sign » de FrieDev (sketchfab.com/FrieDev), licence CC BY 4.0.
   Le texte est peint sur la planche (texture dessinée ici). Placé bien en vue, devant l'enclume. */
const SIGN_URL = '/models/panneau.glb';
const SIGN_HEIGHT = 1.9;
const SIGN_BOARD = { y0: 1.06, y1: 1.74, w: 1.05, z: 0.125 }; // planche dans le repère du modèle (hauteur 1,9)
function signTextTexture(lines) {
  lines = lines || ['PARTI EN', 'EXPLORATION', '— retour bientôt ! —'];
  const c = document.createElement('canvas'); c.width = 1024; c.height = 640;
  const g = c.getContext('2d');
  g.textAlign = 'center'; g.textBaseline = 'middle';
  const line = (txt, y, size) => {
    g.font = `bold ${size}px 'Trebuchet MS', Verdana, Arial, sans-serif`;
    const w = g.measureText(txt).width;
    if (w > 900) g.font = `bold ${Math.floor(size * 900 / w)}px 'Trebuchet MS', Verdana, Arial, sans-serif`; // tient dans la planche
    g.lineJoin = 'round';
    g.strokeStyle = 'rgba(255,231,180,.8)'; g.lineWidth = 26; g.strokeText(txt, 512, y); // liseré clair : lisible sur le bois
    g.strokeStyle = '#2a1408'; g.lineWidth = 9; g.strokeText(txt, 512, y); // lettres épaisses, comme peintes
    g.fillStyle = '#2a1408'; g.fillText(txt, 512, y);
  };
  line(lines[0], 140, 160);
  line(lines[1], 310, 160);
  line(lines[2], 500, 100);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}
function loadSign() {
  new GLTFLoader().load(SIGN_URL, (gltf) => {
    const m = gltf.scene;
    m.updateMatrixWorld(true);
    const bb = new THREE.Box3().setFromObject(m);
    const h = bb.max.y - bb.min.y, sc = SIGN_HEIGHT / Math.max(0.001, h);
    const g = new THREE.Group(); g.scale.setScalar(sc);
    m.position.y = -bb.min.y; g.add(m);
    const text = new THREE.Mesh(new THREE.PlaneGeometry(SIGN_BOARD.w, SIGN_BOARD.y1 - SIGN_BOARD.y0),
      new THREE.MeshStandardMaterial({ map: (P.signTexts = { exploration: signTextTexture(), mine: signTextTexture(['PARTI À', 'LA MINE', '— retour bientôt ! —']) }).exploration, transparent: true, roughness: 0.9, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
    text.position.set(0, (SIGN_BOARD.y0 + SIGN_BOARD.y1) / 2 * (h / 1.9), SIGN_BOARD.z);
    g.add(text);
    P.sign.children.forEach(c => { c.visible = false; });
    P.sign.add(g);
    P.sign.position.set(-0.3, 0, 1.65); P.sign.rotation.y = 0.1; // bien en vue, devant l'enclume, face à nous
    P.signText = text;
  }, undefined, () => {});
}
/* Animation « boire le café » (/models/forgeron-boire.fbx) : faite sur le même squelette (Rig_Medium),
   on ne garde que ses pistes d'os et on la joue sur notre forgeron pendant la pause café.
   Elle se mélange en douceur avec les poses faites en code (entrée et sortie de la pause). */
const DRINK_URL = '/models/forgeron-boire.fbx';
const DRINK_SIP_AT = 3.55; // instant de la gorgée dans l'animation (s) : bruit de gorgée
function loadDrinkAnim() {
  if (!rig || rig.drink) return;
  new FBXLoader().load(DRINK_URL, (fbx) => {
    const clip = fbx.animations && fbx.animations[0];
    if (!clip || !rig) return;
    // on ignore le déplacement de l'armature et les pistes immobiles
    clip.tracks = clip.tracks.filter(tr => !/^Rig_Medium\./.test(tr.name) && tr.times.length > 1);
    const names = [...new Set(clip.tracks.map(tr => tr.name.split('.')[0]))];
    const bones = names.map(n => { let b = null; rig.model.traverse(o => { if (!b && o.isBone && o.name === n) b = o; }); return b; }).filter(Boolean);
    if (!bones.length) return;
    const mixer = new THREE.AnimationMixer(rig.model);
    const action = mixer.clipAction(clip); action.play();
    // Gobelet : droit dans la main au début de l'animation, puis il suit le poignet (il se penche en buvant)
    const saved = bones.map(b => b.quaternion.clone());
    mixer.setTime(0); rig.model.updateMatrixWorld(true);
    const holder = P.mug.parent;
    const hq = new THREE.Quaternion(), mq = new THREE.Quaternion();
    holder.getWorldQuaternion(hq); rig.model.getWorldQuaternion(mq); mq.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -0.4, 0)));
    const mugQ = hq.invert().multiply(mq); // tasse droite (anse tournée vers l'extérieur) dans le repère de la main
    bones.forEach((b, i) => b.quaternion.copy(saved[i]));
    rig.drink = { mixer, clip, bones, w: 0, time: 0, mugQ, anim: bones.map(() => new THREE.Quaternion()), lastSip: -1 };
  }, undefined, () => {});
}
/* Pendant la pause café : joue l'animation et la mélange avec la pose calculée en code (poids w) */
function applyDrink(dt, mv) {
  const d = rig.drink;
  const on = state === 'cafe' && mv.atHome && !mv.walking;
  d.w += ((on ? 1 : 0) - d.w) * Math.min(1, dt * 3);
  if (d.w < 0.002) { d.w = 0; return 0; }
  if (on) d.time += dt;
  const proc = d.bones.map(b => b.quaternion.clone());
  d.mixer.setTime(d.time % d.clip.duration);
  d.bones.forEach((b, i) => { d.anim[i].copy(b.quaternion); b.quaternion.copy(proc[i]).slerp(d.anim[i], d.w); });
  rig.model.updateMatrixWorld(true);
  // bruit de gorgée quand le gobelet arrive aux lèvres
  const cyc = Math.floor(d.time / d.clip.duration), tt = d.time % d.clip.duration;
  if (on && tt >= DRINK_SIP_AT && d.lastSip !== cyc) { d.lastSip = cyc; sound('sip'); }
  return d.w;
}
/* Oriente un os : rotation (dans le repère du personnage) ajoutée à sa pose de repos */
function poseBone(key, x, y, z) {
  const b = rig.bones[key]; if (!b) return;
  // repère du personnage → repère du parent de l'os
  rig.model.getWorldQuaternion(_qm);
  b.parent.getWorldQuaternion(_q2);
  _q2.premultiply(_qm.invert()); // orientation du parent dans le repère du personnage
  _q.setFromEuler(_e.set(x || 0, y || 0, z || 0, 'YXZ'));
  // nouveau local = parent⁻¹ · delta · parent · repos
  const inv = _q2.clone().invert();
  b.quaternion.copy(inv.multiply(_q).multiply(_q2).multiply(rig.rest[key]));
  b.updateMatrixWorld(true);
}
/* Pose cible lissée (les valeurs bougent doucement vers la cible) */
function ease(key, target, dt, speed) {
  const c = rig.cur;
  if (c[key] === undefined) c[key] = target;
  c[key] += (target - c[key]) * Math.min(1, dt * (speed || 8));
  return c[key];
}
/* Déplacements du forgeron : derrière l'enclume (poste de travail) ↔ devant l'enclume, face à nous,
   pour brandir le booster terminé. Il contourne l'enclume par la gauche. */
const SPOT_HOME = { x: -0.45, z: 0.26, rot: 0.75 };
const SPOT_WAY = { x: -0.95, z: 1.0 };
const SPOT_FRONT = { x: -0.3, z: 1.6, rot: 0.12 };
const WALK_SPEED = 1.0; // mètres par seconde
const seg1 = Math.hypot(SPOT_WAY.x - SPOT_HOME.x, SPOT_WAY.z - SPOT_HOME.z), seg2 = Math.hypot(SPOT_FRONT.x - SPOT_WAY.x, SPOT_FRONT.z - SPOT_WAY.z);
let walkU = 0, walkPhase = 0, snapWalk = true;
function walkPos(u) { // u : 0 = poste de travail, 1 = devant l'enclume
  const d = u * (seg1 + seg2);
  if (d <= seg1) { const f = d / seg1; return { x: SPOT_HOME.x + (SPOT_WAY.x - SPOT_HOME.x) * f, z: SPOT_HOME.z + (SPOT_WAY.z - SPOT_HOME.z) * f }; }
  const f = (d - seg1) / seg2; return { x: SPOT_WAY.x + (SPOT_FRONT.x - SPOT_WAY.x) * f, z: SPOT_WAY.z + (SPOT_FRONT.z - SPOT_WAY.z) * f };
}
const angleTo = (from, to) => { let a = to - from; while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; };
/* Avance le forgeron vers l'endroit voulu ; renvoie { walking, atFront, atHome } */
function updateWalk(dt) {
  const target = state === 'ready' ? 1 : 0;
  if (snapWalk || state === 'exploration' || state === 'mine' || state === 'unbuilt') { walkU = target; snapWalk = false; }
  const before = walkU, step = dt * WALK_SPEED / (seg1 + seg2);
  walkU = target > walkU ? Math.min(target, walkU + step) : Math.max(target, walkU - step);
  const walking = walkU !== before;
  const p = walkPos(walkU);
  P.dwarf.position.x = p.x; P.dwarf.position.z = p.z;
  let want;
  if (walking) { const q = walkPos(Math.max(0, Math.min(1, walkU + (target > before ? 0.02 : -0.02)))); want = Math.atan2(q.x - p.x, q.z - p.z); }
  else want = walkU >= 1 ? SPOT_FRONT.rot : SPOT_HOME.rot;
  P.dwarf.rotation.y += angleTo(P.dwarf.rotation.y, want) * Math.min(1, dt * (walking ? 10 : 6));
  if (walking) walkPhase += dt * 9;
  return { walking, atFront: walkU >= 1, atHome: walkU <= 0 };
}
function animateRig(t, st, dt, k, reduced, mv) {
  mv = mv || { walking: false, atFront: false, atHome: true };
  const p = window.__forgePose || null; // aperçu de réglage (développement)
  // pose de repos : bras le long du corps
  let rDown = 1.25, lDown = 1.25, rFwd = 0, lFwd = 0, rElb = 0.15, lElb = 0.15, rTw = 0, lTw = 0;
  let headX = 0, headY = 0, spineX = 0, spineY = 0, jump = 0, fast = false;
  if ((state === 'travail' || state === 'demandes') && mv.atHome) {
    const period = state === 'demandes' ? 0.42 : 0.9;
    const ph = (st % period) / period;
    // levée lente (marteau derrière la tête), frappe rapide sur l'enclume
    const lift = ph < 0.7 ? Math.sin(ph / 0.7 * Math.PI / 2) : 1 - (ph - 0.7) / 0.3;
    rDown = 1.35; rFwd = -2.3 - lift * 0.75; rElb = -lift * 1.3; rTw = 0.3 - lift * 0.15; // bras ramené vers l'enclume
    lDown = 1.25; lFwd = -1.35; lElb = -0.5;
    headX = 0.35; spineX = 0.06 + (1 - lift) * 0.16; spineY = -lift * 0.15;
    fast = true;
  } else if (state === 'cafe') {
    const ph = (st % 4) / 4;
    const sip = ph > 0.55 && ph < 0.85 ? Math.sin((ph - 0.55) / 0.3 * Math.PI) : 0;
    lDown = 1.15; lFwd = -0.6 - sip * 0.85; lElb = -(1.5 + sip * 0.45); lTw = -0.25;
    rDown = 1.15; rFwd = -0.15; rElb = -0.6;
    headX = -sip * 0.35; headY = Math.sin(t * 0.7) * 0.25 * (1 - sip);
    rig.cur.sipTilt = sip * 0.9;
  } else if (state === 'ready' && mv.atFront) {
    jump = Math.abs(Math.sin(st * 4)) * 0.16 * k;
    rDown = -1.35; lDown = -1.35; rFwd = -0.25; lFwd = -0.25; rElb = 0; lElb = 0; headX = -0.35;
  } else { // idle / unbuilt : il respire et regarde autour de lui
    const br = Math.sin(t * 1.3);
    rDown = 1.25 + br * 0.04; lDown = 1.25 - br * 0.04;
    headY = Math.sin(t * 0.6 * k) * 0.5; headX = Math.sin(t * 0.9 * k) * 0.06;
    rElb = -0.2; lElb = -0.2;
  }
  // En marche : bras qui balancent (ou qui portent le booster devant lui), pas de saut
  let legL = 0, legR = 0, kneeL = 0, kneeR = 0;
  if (mv.walking || (state === 'ready' && !mv.atFront)) {
    const sw = mv.walking ? Math.sin(walkPhase) : 0;
    legL = sw * 0.55; legR = -sw * 0.55;
    kneeL = Math.max(0, -Math.sin(walkPhase - 0.6)) * 0.7 * (mv.walking ? 1 : 0); kneeR = Math.max(0, Math.sin(walkPhase - 0.6)) * 0.7 * (mv.walking ? 1 : 0);
    jump = Math.abs(Math.cos(walkPhase)) * 0.035;
    headX = 0; headY = 0; spineX = 0.04; spineY = sw * 0.06; fast = false;
    if (state === 'ready') { rDown = 1.3; lDown = 1.3; rFwd = -1.1; lFwd = -1.1; rElb = -0.5; lElb = -0.5; rTw = 0.35; lTw = -0.35; }
    else if (state !== 'travail' && state !== 'demandes') { rDown = 1.3; lDown = 1.3; rFwd = -sw * 0.45; lFwd = sw * 0.45; rElb = -0.25; lElb = -0.25; rTw = 0; lTw = 0; }
    else { rDown = 1.3; rFwd = -sw * 0.35; rElb = -0.3; rTw = 0; lDown = 1.3; lFwd = sw * 0.45; lElb = -0.25; lTw = 0; }
  }
  if (p) ({ rDown = rDown, lDown = lDown, rFwd = rFwd, lFwd = lFwd, rElb = rElb, lElb = lElb, rTw = rTw, lTw = lTw, headX = headX, headY = headY, spineX = spineX, spineY = spineY } = p);
  const sp = fast ? 28 : 8;
  rig.model.updateMatrixWorld(true);
  const breathe = Math.sin(t * 2.2 * k) * 0.02;
  poseBone('spine', ease('spx', spineX, dt) + breathe, ease('spy', spineY, dt), 0);
  poseBone('head', ease('hx', headX, dt), ease('hy', headY, dt, 5), 0);
  poseBone('upperarmr', ease('rf', rFwd, dt, sp), ease('rt', rTw, dt), ease('rd', rDown, dt, sp));
  poseBone('upperarml', ease('lf', lFwd, dt), ease('lt', lTw, dt), -ease('ld', lDown, dt));
  poseBone('lowerarmr', ease('re', rElb, dt, sp), 0, 0);
  poseBone('lowerarml', ease('le', lElb, dt), 0, 0);
  poseBone('upperlegl', -ease('gl', legL, dt, 20), 0, 0);
  poseBone('upperlegr', -ease('gr', legR, dt, 20), 0, 0);
  poseBone('lowerlegl', ease('kl', kneeL, dt, 20), 0, 0);
  poseBone('lowerlegr', ease('kr', kneeR, dt, 20), 0, 0);
  P.dwarf.position.y = jump + Math.sin(t * 2.2 * k) * 0.01;
  // Le booster : porté devant lui en marchant, brandi au-dessus de la tête une fois arrivé devant nous
  if (state === 'ready') {
    if (mv.atFront) { P.pack.position.set(0, 1.88, 0.22); P.pack.rotation.set(0, Math.sin(t * 2) * 0.25, 0); }
    else { P.pack.position.set(0, 0.95, 0.42); P.pack.rotation.set(-0.2, 0, 0); }
  }
  const dw = rig.drink ? applyDrink(dt, mv) : 0;
  // La tasse reste droite quelle que soit la position du bras (penchée pendant la gorgée) ;
  // avec l'animation « boire », elle suit la main
  if (P.mug.visible) {
    P.dwarf.getWorldQuaternion(_q);
    _q.multiply(_q2.setFromEuler(_e.set(rig.cur.sipTilt || 0, 0, 0)));
    P.mug.parent.getWorldQuaternion(_qm);
    P.mug.quaternion.copy(_qm.invert().multiply(_q));
    if (dw > 0) P.mug.quaternion.slerp(rig.drink.mugQ, dw);
  }
}

/* ---------- Le décor ---------- */
function buildSet() {
  const g = new THREE.Group();
  const ground = new THREE.Mesh(new THREE.CylinderGeometry(3.4, 3.6, 0.2, 10), M.ground); ground.position.y = -0.1; g.add(ground);
  // Pavés
  const paves = [];
  for (let i = 0; i < 14; i++) { const a = i / 14 * Math.PI * 2, r = 2.4 + (i % 3) * 0.25; const p = box(0.4, 0.05, 0.3, M.stone); p.position.set(Math.cos(a) * r, 0.02, Math.sin(a) * r); p.rotation.y = a; g.add(p); paves.push(p); }
  // Four en briques avec feu
  const furnace = new THREE.Group(); furnace.position.set(-1.55, 0, -0.7);
  const base = box(1.1, 1.0, 0.9, M.brick); base.position.y = 0.5; furnace.add(base);
  const top = box(0.9, 0.5, 0.75, M.brick); top.position.y = 1.25; furnace.add(top);
  const chimney = box(0.4, 0.9, 0.4, M.brick); chimney.position.y = 1.9; furnace.add(chimney);
  const mouth = box(0.6, 0.42, 0.05, M.hot); mouth.position.set(0, 0.55, 0.46); furnace.add(mouth);
  const fireLight = new THREE.PointLight(0xff7a2a, 2.2, 6, 1.6); fireLight.position.set(0, 0.7, 1.0); furnace.add(fireLight);
  g.add(furnace);
  P.furnaceBricks = [base, top, chimney, mouth];
  // Enclume
  const anvil = new THREE.Group(); anvil.position.set(0.05, 0, 0.68); anvil.rotation.y = 0.75; anvil.scale.setScalar(0.9);
  const stump = cyl(0.32, 0.36, 0.45, 7, M.woodDark); stump.position.y = 0.22; anvil.add(stump);
  const foot = box(0.42, 0.14, 0.3, M.iron); foot.position.y = 0.52; anvil.add(foot);
  const waist = box(0.24, 0.14, 0.2, M.iron); waist.position.y = 0.64; anvil.add(waist);
  const face = box(0.62, 0.14, 0.3, M.iron); face.position.y = 0.78; anvil.add(face);
  const hornA = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.34, 5), M.iron); hornA.rotation.z = Math.PI / 2; hornA.position.set(0.47, 0.78, 0); anvil.add(hornA);
  const ingot = box(0.26, 0.05, 0.1, M.hot); ingot.position.set(-0.05, 0.875, 0); anvil.add(ingot);
  g.add(anvil);
  P.anvilIron = [foot, waist, face, hornA]; P.stump = stump;
  // Tonneau et outils
  const barrel = cyl(0.3, 0.3, 0.6, 8, M.wood); barrel.position.set(1.5, 0.3, -0.9); g.add(barrel);
  const hoops = [0.18, 0.42].map(y => { const hoop = cyl(0.31, 0.31, 0.04, 8, M.iron); hoop.position.set(1.5, y, -0.9); g.add(hoop); return hoop; });
  P.oldDecor = [ground, barrel].concat(hoops, paves);
  const restHammer = new THREE.Group();
  const rh = cyl(0.03, 0.03, 0.55, 5, M.wood); restHammer.add(rh);
  const rhh = box(0.26, 0.14, 0.14, M.iron); rhh.position.y = 0.3; restHammer.add(rhh);
  restHammer.position.set(0.95, 0.42, 1.15); restHammer.rotation.z = -0.5; g.add(restHammer);
  // Pile de commandes (parchemins)
  const scrolls = new THREE.Group(); scrolls.position.set(1.35, 0, 0.35);
  for (let i = 0; i < 7; i++) { const s = cyl(0.07, 0.07, 0.5, 6, M.scroll); s.rotation.z = Math.PI / 2; s.rotation.y = (i * 0.7) % 1.2 - 0.6; s.position.set((i % 3 - 1) * 0.15, 0.07 + Math.floor(i / 3) * 0.13, (i % 2) * 0.12); scrolls.add(s); }
  g.add(scrolls);
  // Matériaux (forge pas encore construite)
  const materials = new THREE.Group(); materials.position.set(-1.3, 0, 0.3);
  for (let i = 0; i < 5; i++) { const l = cyl(0.08, 0.08, 0.9, 6, M.wood); l.rotation.z = Math.PI / 2; l.position.set(0, 0.08 + Math.floor(i / 3) * 0.15, (i % 3 - 1) * 0.17); materials.add(l); }
  for (let i = 0; i < 4; i++) { const s = new THREE.Mesh(new THREE.DodecahedronGeometry(0.16, 0), M.stone); s.position.set(0.7 + (i % 2) * 0.25, 0.14 + Math.floor(i / 2) * 0.2, -0.3 + (i % 2) * 0.1); materials.add(s); }
  g.add(materials);
  // Pancarte « parti en exploration »
  const sign = new THREE.Group(); sign.position.set(0.9, 0, 0.6); sign.rotation.y = -0.35;
  const post = cyl(0.04, 0.05, 1.1, 5, M.woodDark); post.position.y = 0.55; sign.add(post);
  const board = box(1.0, 0.55, 0.05, new THREE.MeshStandardMaterial({ map: textTexture([{ text: 'PARTI EN', size: 34 }, { text: 'EXPLORATION', size: 34 }, { text: '— retour bientôt —', size: 22 }], 256, 140, '#8a5a32', '#fff3d6'), roughness: 0.9 }));
  board.position.set(0, 1.0, 0.05); sign.add(board);
  g.add(sign);
  // Étincelles et vapeur (particules)
  const sparkGeo = new THREE.BufferGeometry(), N = 40;
  sparkGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
  const sparks = new THREE.Points(sparkGeo, new THREE.PointsMaterial({ color: 0xffc04a, size: 0.07, transparent: true, depthWrite: false }));
  g.add(sparks);
  const steamGeo = new THREE.BufferGeometry(), NS = 14;
  steamGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(NS * 3), 3));
  const steam = new THREE.Points(steamGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 0.09, transparent: true, opacity: 0.55, depthWrite: false }));
  g.add(steam);
  Object.assign(P, { set: g, furnace, fireLight, mouth, anvil, ingot, restHammer, scrolls, materials, sign, sparks, sparkVel: new Float32Array(N * 3), sparkLife: new Float32Array(N), steam, steamLife: new Float32Array(NS).map(() => Math.random()) });
  return g;
}

function init() {
  if (renderer) return true;
  try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }); } catch (e) { return false; }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(32, 2, 0.1, 50);
  clock = new THREE.Clock();
  scene.add(new THREE.HemisphereLight(0xd6e2ff, 0x5a4030, 1.25));
  const key = new THREE.DirectionalLight(0xfff1dd, 1.5); key.position.set(3, 5, 5); scene.add(key);
  const fill = new THREE.DirectionalLight(0x9db8ff, 0.6); fill.position.set(-4, 2, 3); scene.add(fill);
  scene.add(buildSet());
  const dwarf = buildDwarf(); dwarf.position.set(-0.6, 0, 0.1); dwarf.rotation.y = 0.75; scene.add(dwarf);
  loadRig();
  loadCup();
  loadAnvil();
  loadFurnace();
  loadBuilding();
  loadSign();
  renderer.domElement.style.width = '100%'; renderer.domElement.style.height = '100%'; renderer.domElement.style.display = 'block';
  return true;
}

function fit() {
  if (!host) return;
  const w = host.clientWidth || 600, h = host.clientHeight || 260;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  // Plus étroit (téléphone) : on recule un peu la caméra
  const dist = w / h < 1.4 ? 7.2 : w / h > 2.6 ? 4.7 : 5.6;
  camera.userData.dist = dist;
  camera.updateProjectionMatrix();
}

function burstSparks() {
  const a = P.sparks.geometry.attributes.position.array, v = P.sparkVel, life = P.sparkLife;
  const origin = new THREE.Vector3(0.0, 0.82, 0.7);
  for (let i = 0; i < life.length; i++) {
    if (life[i] > 0 && Math.random() < 0.5) continue;
    a[i * 3] = origin.x; a[i * 3 + 1] = origin.y; a[i * 3 + 2] = origin.z;
    v[i * 3] = (Math.random() - 0.5) * 2.4; v[i * 3 + 1] = 1.2 + Math.random() * 1.8; v[i * 3 + 2] = (Math.random() - 0.3) * 1.6;
    life[i] = 0.5 + Math.random() * 0.4;
  }
}
function updateParticles(dt) {
  const a = P.sparks.geometry.attributes.position.array, v = P.sparkVel, life = P.sparkLife;
  for (let i = 0; i < life.length; i++) {
    if (life[i] <= 0) { a[i * 3 + 1] = -50; continue; }
    life[i] -= dt; v[i * 3 + 1] -= 6 * dt;
    a[i * 3] += v[i * 3] * dt; a[i * 3 + 1] += v[i * 3 + 1] * dt; a[i * 3 + 2] += v[i * 3 + 2] * dt;
  }
  P.sparks.geometry.attributes.position.needsUpdate = true;
  // Vapeur du café, au-dessus de la tasse
  const s = P.steam.geometry.attributes.position.array, sl = P.steamLife;
  const show = state === 'cafe';
  P.steam.visible = show;
  if (show) {
    const p = new THREE.Vector3(); P.mug.getWorldPosition(p);
    for (let i = 0; i < sl.length; i++) {
      sl[i] += dt * 0.6; if (sl[i] > 1) sl[i] -= 1;
      s[i * 3] = p.x + Math.sin(sl[i] * 6 + i) * 0.05; s[i * 3 + 1] = p.y + (P.mugTop || 0.1) + sl[i] * 0.5; s[i * 3 + 2] = p.z + Math.cos(sl[i] * 5 + i) * 0.04;
    }
    P.steam.geometry.attributes.position.needsUpdate = true;
  }
}

let lastHit = 0, lastSip = -1;
function animate() {
  rafId = requestAnimationFrame(animate);
  if (!host || !host.isConnected) { stop(); return; }
  const dt = Math.min(0.05, clock.getDelta());
  const t = performance.now() / 1000, st = t - stateSince;
  const reduced = document.body.classList.contains('anim-reduced'); // réglage du jeu uniquement
  const k = reduced ? 0.15 : 1;
  // Caméra : léger mouvement de balancier
  const dist = camera.userData.dist || 6, ang = 0.05 + Math.sin(t * 0.2 * k) * 0.1;
  if (P.building) { // dans l'atelier : un peu plus de recul pour voir le bâtiment, sous le toit
    const D = dist * 1.2;
    camera.position.set(-0.6 + Math.sin(ang + 0.1) * D, 2.25, -0.4 + Math.cos(ang + 0.1) * D);
    camera.lookAt(-0.85, 0.95, -0.5);
  } else {
    camera.position.set(Math.sin(ang) * dist, 2.7, Math.cos(ang) * dist);
    camera.lookAt(-0.2, 0.85, 0);
  }
  if (window.__forgeCam) { const c = window.__forgeCam; camera.position.set(c[0], c[1], c[2]); camera.lookAt(c[3], c[4], c[5]); } // aperçu (développement)
  // Feu qui vacille
  P.fireLight.intensity = (state === 'exploration' || state === 'mine' || state === 'unbuilt' ? 0.5 : 2.0) + Math.sin(t * 13) * 0.25 + Math.sin(t * 7.3) * 0.2;
  if (P.hearthGlow) P.hearthGlow.intensity = (state === 'exploration' || state === 'mine' ? 0.6 : 1.6) + Math.sin(t * 11) * 0.3 + Math.sin(t * 5.1) * 0.2;
  P.mouth.material.emissiveIntensity = state === 'exploration' || state === 'mine' || state === 'unbuilt' ? 0.3 : 1.0 + Math.sin(t * 9) * 0.25;
  const d = P.dwarf, R = P.R.pivot, L = P.L.pivot, head = P.head;
  if (rig) {
    const mv = updateWalk(dt);
    // coups de marteau : étincelles et son au moment de la frappe (seulement à son poste)
    if ((state === 'travail' || state === 'demandes') && mv.atHome) {
      const period = state === 'demandes' ? 0.42 : 0.9, hitIndex = Math.floor((st + period * 0.02) / period);
      if (hitIndex !== lastHit) { lastHit = hitIndex; if (!reduced) burstSparks(); sound('hit'); }
    } else if (state === 'cafe' && !rig.drink) {
      const ph = (st % 4) / 4, cycle = Math.floor(st / 4);
      if (ph > 0.66 && lastSip !== cycle) { lastSip = cycle; sound('sip'); }
    }
    animateRig(t, st, dt, k, reduced, mv);
    P.sweat.children.forEach((s2, i) => { s2.position.y = -((t * 0.8 + i * 0.5) % 1) * 0.25; });
    P.ingot.material = state === 'travail' || state === 'demandes' ? M.hot : M.iron;
    updateParticles(dt);
    renderer.render(scene, camera);
    return;
  }
  // Valeurs de repos
  let rArm = -0.15, lArm = -0.15, lArmZ = 0, rArmZ = 0, bodyY = 0, headX = 0, headY = 0, jump = 0;
  if (state === 'travail' || state === 'demandes') {
    const period = state === 'demandes' ? 0.42 : 0.9;
    const ph = (st % period) / period;
    // levée lente, frappe rapide
    const lift = ph < 0.7 ? ph / 0.7 : 1 - (ph - 0.7) / 0.3;
    rArm = -0.2 - lift * 2.3;
    lArm = -0.5; lArmZ = -0.25;
    headX = 0.25; bodyY = -lift * 0.03;
    const hitIndex = Math.floor(st / period);
    if (ph > 0.97 || (hitIndex !== lastHit && ph < 0.1)) { if (hitIndex !== lastHit) { lastHit = hitIndex; if (!reduced) burstSparks(); sound('hit'); } }
  } else if (state === 'cafe') {
    const ph = (st % 4) / 4;
    const sip = ph > 0.55 && ph < 0.85 ? Math.sin((ph - 0.55) / 0.3 * Math.PI) : 0;
    const cycle = Math.floor(st / 4);
    if (ph > 0.66 && lastSip !== cycle) { lastSip = cycle; sound('sip'); }
    lArm = -0.9 - sip * 1.2; lArmZ = -0.2 - sip * 0.35;
    rArm = -0.1; headX = -sip * 0.35; headY = Math.sin(t * 0.7) * 0.15 * (1 - sip);
  } else if (state === 'ready') {
    jump = Math.abs(Math.sin(st * 4)) * 0.18 * k;
    rArm = -2.9; lArm = -2.9; rArmZ = 0.25; lArmZ = -0.25; headX = -0.3;
  } else { // idle / unbuilt
    rArm = -0.15 + Math.sin(t * 1.3) * 0.05; lArm = -0.15 - Math.sin(t * 1.3) * 0.05;
    headY = Math.sin(t * 0.6 * k) * 0.45; headX = Math.sin(t * 0.9 * k) * 0.06;
  }
  R.rotation.x += (rArm - R.rotation.x) * Math.min(1, dt * (state === 'travail' || state === 'demandes' ? 30 : 8));
  L.rotation.x += (lArm - L.rotation.x) * Math.min(1, dt * 8);
  L.rotation.z += (lArmZ - L.rotation.z) * Math.min(1, dt * 8);
  R.rotation.z += (rArmZ - R.rotation.z) * Math.min(1, dt * 8);
  head.rotation.x += (headX - head.rotation.x) * Math.min(1, dt * 8);
  head.rotation.y += (headY - head.rotation.y) * Math.min(1, dt * 5);
  d.position.y = jump + bodyY + Math.sin(t * 2.2 * k) * 0.012;
  P.body.scale.set(1, 1 + Math.sin(t * 2.2 * k) * 0.02, 1);
  P.sweat.children.forEach((s, i) => { s.position.y = 0.22 - i * 0.05 - ((t * 0.8 + i * 0.5) % 1) * 0.25; });
  P.pack.position.set(0, 1.85 + jump * 0.3, 0.15);
  P.pack.rotation.y = Math.sin(t * 2) * 0.3;
  P.ingot.material = state === 'travail' || state === 'demandes' ? M.hot : M.iron;
  updateParticles(dt);
  renderer.render(scene, camera);
}
function stop() { if (rafId) cancelAnimationFrame(rafId); rafId = null; }

function setState(s) {
  if (!renderer) return;
  if (s !== state) { const prev = state; state = s; stateSince = performance.now() / 1000; if (s === 'cafe' && rig && rig.drink) { rig.drink.time = 0; rig.drink.lastSip = -1; } if (s === 'ready' && prev !== 'ready' && host) sound('ready'); }
  const away = state === 'exploration' || state === 'mine', unbuilt = state === 'unbuilt';
  // texte du panneau : parti en Expédition avec toi, ou parti chercher du charbon à la mine
  if (P.signText && P.signTexts && away) { const tx = P.signTexts[state] || P.signTexts.exploration; if (P.signText.material.map !== tx) { P.signText.material.map = tx; P.signText.material.needsUpdate = true; } }
  P.dwarf.visible = !away;
  P.sign.visible = away;
  P.hammer.visible = state === 'travail' || state === 'demandes';
  P.restHammer.visible = !P.hammer.visible && !unbuilt;
  P.mug.visible = state === 'cafe';
  P.pack.visible = state === 'ready';
  P.sweat.visible = state === 'demandes';
  P.scrolls.visible = state === 'demandes';
  P.materials.visible = unbuilt;
  P.anvil.visible = !unbuilt;
  P.furnace.visible = !unbuilt;
}

/* Raccroche le canvas dans l'élément (après un redessin de la page) et règle la scène */
function attach(el, s) {
  if (!el) { stop(); return; }
  if (!init()) { el.innerHTML = '<div class="forge3d-fallback">⚒️</div>'; return; }
  if (!rafId) snapWalk = true; // retour sur la page : il est déjà à sa place, sans marcher
  host = el;
  if (renderer.domElement.parentNode !== el) { el.innerHTML = ''; el.appendChild(renderer.domElement); fit(); }
  setState(s || 'idle');
  if (!rafId) { clock.getDelta(); animate(); }
}
window.addEventListener('resize', () => { if (host && host.isConnected) fit(); });

window.Forge3D = { attach, setState, stop, sound, hasModel: () => !!rig, _debug: () => ({ P, rig, camera, THREE }), states: ['unbuilt', 'idle', 'travail', 'demandes', 'cafe', 'exploration', 'mine', 'ready'] };

/* ============================================================
   Salle des trophées (profil) : une étagère en bois avec les trophées
   des boss d'Expédition vaincus et les reliques trouvées. Les trophées
   pas encore gagnés apparaissent en silhouette sombre.
   Renderer séparé (la Forge et le profil ne sont jamais affichés ensemble).
   ============================================================ */
const TR = { renderer: null, scene: null, camera: null, clock: null, raf: null, host: null, key: '', spin: [] };
const RELIC_COLORS = { coeur: 0xff4d6d, sablier: 0xe8b13d, bourse: 0xffd36a, potion: 0x5ad1a0, oeil: 0x9b7bff, membre: 0x4fa3e3, bouclier: 0x8a5a32, dague: 0x7fe07a, fer: 0x58d16a };
const RELIC_ORDER = ['coeur', 'sablier', 'bourse', 'potion', 'oeil', 'membre', 'bouclier', 'dague', 'fer'];
const shadowMat = new THREE.MeshStandardMaterial({ color: 0x14101e, flatShading: true, roughness: 1 });

function trophyEnt() {
  const g = new THREE.Group();
  const trunk = cyl(0.12, 0.18, 0.55, 6, M.woodDark); trunk.position.y = 0.28; g.add(trunk);
  [[0, 0.75, 0.42], [0, 1.02, 0.32], [0, 1.24, 0.2]].forEach(([x, y, r]) => { const c = new THREE.Mesh(new THREE.ConeGeometry(r, 0.42, 6), mat(0x3f9a4a)); c.position.set(x, y, 0); g.add(c); });
  [-1, 1].forEach(s => { const e = box(0.05, 0.05, 0.02, mat(0xffe08a, { emissive: 0xffc040, emissiveIntensity: 0.8 })); e.position.set(s * 0.06, 0.42, 0.16); g.add(e); });
  return g;
}
function trophyGolem() {
  const g = new THREE.Group();
  const big = new THREE.Mesh(new THREE.OctahedronGeometry(0.38, 0), new THREE.MeshStandardMaterial({ color: 0x9b7bff, emissive: 0x5a2fd0, emissiveIntensity: 0.35, flatShading: true, metalness: 0.3, roughness: 0.2 }));
  big.scale.y = 1.5; big.position.y = 0.62; g.add(big);
  [-0.28, 0.3].forEach((x, i) => { const s = new THREE.Mesh(new THREE.OctahedronGeometry(0.16, 0), new THREE.MeshStandardMaterial({ color: i ? 0x6fd3ff : 0xd08bff, flatShading: true, metalness: 0.3, roughness: 0.2 })); s.scale.y = 1.5; s.position.set(x, 0.25, 0.05); s.rotation.z = x * 0.8; g.add(s); });
  const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(0.22, 0), M.stone); rock.position.y = 0.08; rock.scale.y = 0.5; g.add(rock);
  return g;
}
function trophyDragon() {
  const g = new THREE.Group();
  const red = mat(0xc0392b), dark = mat(0x7a1f16);
  const head = box(0.42, 0.34, 0.5, red); head.position.y = 0.55; g.add(head);
  const snout = box(0.3, 0.2, 0.32, red); snout.position.set(0, 0.48, 0.38); g.add(snout);
  const jaw = box(0.28, 0.08, 0.3, dark); jaw.position.set(0, 0.34, 0.36); g.add(jaw);
  [-1, 1].forEach(s => {
    const horn = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.38, 5), M.horn); horn.position.set(s * 0.15, 0.85, -0.12); horn.rotation.x = -0.6; horn.rotation.z = s * -0.3; g.add(horn);
    const eye = box(0.07, 0.05, 0.03, mat(0xffd36a, { emissive: 0xffa000, emissiveIntensity: 1 })); eye.position.set(s * 0.13, 0.63, 0.26); g.add(eye);
    const n = box(0.04, 0.04, 0.02, M.eye); n.position.set(s * 0.07, 0.52, 0.55); g.add(n);
  });
  const plaque = box(0.62, 0.62, 0.08, M.wood); plaque.position.set(0, 0.55, -0.32); g.add(plaque);
  return g;
}
function silhouette(group) { group.traverse(o => { if (o.isMesh) o.material = shadowMat; }); return group; }

function trInit() {
  if (TR.renderer) return true;
  try { TR.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }); } catch (e) { return false; }
  TR.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  TR.camera = new THREE.PerspectiveCamera(30, 2.4, 0.1, 50);
  TR.clock = new THREE.Clock();
  TR.renderer.domElement.style.width = '100%'; TR.renderer.domElement.style.height = '100%'; TR.renderer.domElement.style.display = 'block';
  return true;
}
function trBuild(kills, relics) {
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xfff2dc, 0x3a2a1a, 1.1));
  const key = new THREE.DirectionalLight(0xfff1dd, 1.3); key.position.set(2, 4, 5); scene.add(key);
  const spot = new THREE.PointLight(0xffc070, 1.4, 8, 1.5); spot.position.set(0, 2.4, 1.5); scene.add(spot);
  // Étagère
  const back = box(5.4, 2.6, 0.1, mat(0x3a2414)); back.position.set(0, 1.1, -0.45); scene.add(back);
  [0, 1.55].forEach(y => { const sh = box(5.6, 0.12, 0.9, M.wood); sh.position.set(0, y - 0.06, 0); scene.add(sh); });
  [-2.75, 2.75].forEach(x => { const side = box(0.12, 2.8, 0.9, M.woodDark); side.position.set(x, 1.1, 0); scene.add(side); });
  TR.spin = [];
  const makers = [['foret', trophyEnt], ['mines', trophyGolem], ['volcan', trophyDragon]];
  makers.forEach(([id, make], i) => {
    const x = -1.7 + i * 1.7, won = (kills[id] || 0) > 0;
    const ped = cyl(0.36, 0.42, 0.18, 8, won ? M.gold : M.stone); ped.position.set(x, 0.09, 0.05); scene.add(ped);
    const t = make(); if (!won) silhouette(t);
    t.position.set(x, 0.18, 0.05); scene.add(t);
    if (won) TR.spin.push(t);
    if ((kills[id] || 0) > 1) { // une petite pile de pièces par victoire en plus
      for (let k = 0; k < Math.min(5, kills[id] - 1); k++) { const c = cyl(0.08, 0.08, 0.03, 8, M.gold); c.position.set(x + 0.45, 0.02 + k * 0.035, 0.25); scene.add(c); }
    }
  });
  // Reliques sur l'étagère du haut
  RELIC_ORDER.forEach((id, i) => {
    const x = -2.3 + i * 0.575, got = relics.includes(id);
    const gem = new THREE.Mesh(new THREE.OctahedronGeometry(0.15, 0), got ? new THREE.MeshStandardMaterial({ color: RELIC_COLORS[id], emissive: RELIC_COLORS[id], emissiveIntensity: 0.25, flatShading: true, metalness: 0.4, roughness: 0.25 }) : shadowMat);
    gem.position.set(x, 1.72, 0.1); scene.add(gem);
    const stand = cyl(0.1, 0.12, 0.06, 6, got ? M.gold : M.stone); stand.position.set(x, 1.53, 0.1); scene.add(stand);
    if (got) TR.spin.push(gem);
  });
  TR.scene = scene;
}
function trFit() {
  if (!TR.host) return;
  const w = TR.host.clientWidth || 600, h = TR.host.clientHeight || 240;
  TR.renderer.setSize(w, h, false);
  TR.camera.aspect = w / h;
  TR.camera.position.set(0, 1.2, w / h < 1.5 ? 10.5 : w / h > 3.2 ? 5.0 : 6.2);
  TR.camera.lookAt(0, 0.95, 0);
  TR.camera.updateProjectionMatrix();
}
function trAnimate() {
  TR.raf = requestAnimationFrame(trAnimate);
  if (!TR.host || !TR.host.isConnected) { cancelAnimationFrame(TR.raf); TR.raf = null; return; }
  const dt = Math.min(0.05, TR.clock.getDelta());
  const reduced = document.body.classList.contains('anim-reduced');
  TR.spin.forEach((o, i) => { o.rotation.y += dt * (reduced ? 0.1 : 0.6) * (i % 2 ? 1 : -1); });
  TR.renderer.render(TR.scene, TR.camera);
}
/* el porte data-kills (JSON) et data-relics (JSON) */
function trAttach(el) {
  if (!el) return;
  if (!trInit()) { el.innerHTML = '<div class="forge3d-fallback">🏆</div>'; return; }
  const kills = JSON.parse(el.dataset.kills || '{}'), relics = JSON.parse(el.dataset.relics || '[]');
  const key = el.dataset.kills + '|' + el.dataset.relics;
  if (key !== TR.key || !TR.scene) { trBuild(kills, relics); TR.key = key; }
  TR.host = el;
  if (TR.renderer.domElement.parentNode !== el) { el.innerHTML = ''; el.appendChild(TR.renderer.domElement); trFit(); }
  if (!TR.raf) { TR.clock.getDelta(); trAnimate(); }
}
window.addEventListener('resize', () => { if (TR.host && TR.host.isConnected) trFit(); });
window.Trophy3D = { attach: trAttach };

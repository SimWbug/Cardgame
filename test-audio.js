/* Teste la couche audio du client hors navigateur, avec un faux AudioContext.
   Objectif : vérifier qu'un même son se rejoue à CHAQUE pose, et pas une seule
   fois par carte comme avec un élément <audio> réutilisé. */
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

let started = 0;            // nombre de lectures réellement déclenchées
let decodeCalls = 0;        // nombre de décodages (doit rester à 1 par URL)
let fetchCalls = 0;
let resumed = 0;

class FakeBufferSource {
  constructor(){ this.buffer=null; }
  connect(n){ return n; }
  start(){ started++; }
}
class FakeGain {
  constructor(){ this.gain={value:1}; }
  connect(n){ return n; }
}
class FakeAudioContext {
  constructor(){ this.state='suspended'; this.destination={}; }
  resume(){ resumed++; this.state='running'; return Promise.resolve(); }
  decodeAudioData(){ decodeCalls++; return Promise.resolve({fake:'buffer'}); }
  createBufferSource(){ return new FakeBufferSource(); }
  createGain(){ return new FakeGain(); }
}

const listeners = {};
const sandbox = {
  window: { AudioContext: FakeAudioContext },
  document: { addEventListener: (ev, fn) => { listeners[ev] = fn; } },
  fetch: async () => { fetchCalls++; return { arrayBuffer: async () => new ArrayBuffer(8) }; },
  Audio: function(){ this.play=()=>Promise.resolve(); },
  console
};
sandbox.window.webkitAudioContext = undefined;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync('public/audio.js','utf8'), sandbox);
const A = sandbox.window.ArcaneAudio;

(async () => {
  // 1) Le contexte démarre suspendu et se réveille à la première interaction
  assert.ok(listeners['click'], 'un écouteur de clic doit être posé pour débloquer l\'audio');
  listeners['click']();
  await new Promise(r => setTimeout(r, 10));
  assert.ok(resumed >= 1, 'le contexte audio doit être réveillé au clic');
  console.log('✅ Contexte audio débloqué à la première interaction.');

  // 2) Première lecture
  await A.playSoundUrl('/uploads/sounds/a.wav');
  assert.strictEqual(started, 1, 'la première lecture doit démarrer');
  console.log('✅ 1re pose de la carte : son joué.');

  // 3) MÊME son rejoué plusieurs fois — le cœur du problème signalé
  await A.playSoundUrl('/uploads/sounds/a.wav');
  await A.playSoundUrl('/uploads/sounds/a.wav');
  await A.playSoundUrl('/uploads/sounds/a.wav');
  assert.strictEqual(started, 4, 'chaque pose doit rejouer le son, or seulement ' + started + ' lecture(s)');
  console.log('✅ 2e, 3e et 4e poses de la MÊME carte : son rejoué à chaque fois.');

  // 4) Le décodage n'a lieu qu'une fois par URL (mise en cache)
  assert.strictEqual(decodeCalls, 1, 'le son ne doit être décodé qu\'une fois, or ' + decodeCalls);
  assert.strictEqual(fetchCalls, 1, 'le fichier ne doit être téléchargé qu\'une fois, or ' + fetchCalls);
  console.log('✅ Son téléchargé et décodé une seule fois, puis réutilisé depuis le cache.');

  // 5) Une autre carte a bien son propre son
  await A.playSoundUrl('/uploads/sounds/b.wav');
  assert.strictEqual(started, 5);
  assert.strictEqual(decodeCalls, 2, 'une URL différente doit être décodée séparément');
  console.log('✅ Une autre carte joue bien son propre son.');

  // 6) Deux sons rapprochés se superposent sans se couper
  await Promise.all([
    A.playSoundUrl('/uploads/sounds/a.wav'),
    A.playSoundUrl('/uploads/sounds/b.wav')
  ]);
  assert.strictEqual(started, 7, 'les sons simultanés doivent tous se déclencher');
  console.log('✅ Deux sons rapprochés se jouent tous les deux.');

  // 7) Préchargement du pool
  const before = fetchCalls;
  A.preloadSounds([{sound:'/uploads/sounds/c.wav'}, {sound:null}, null]);
  await new Promise(r => setTimeout(r, 20));
  assert.strictEqual(fetchCalls, before + 1, 'seules les cartes avec un son sont préchargées');
  console.log('✅ Préchargement : seules les cartes sonores sont téléchargées.');

  // 8) URL absente : aucune lecture, aucune erreur
  await A.playSoundUrl(null);
  assert.strictEqual(started, 7, 'une carte sans son ne doit rien déclencher');
  console.log('✅ Une carte sans son ne déclenche aucune lecture.');

  // 9) Repli si l'API Web Audio est absente : un élément neuf à chaque lecture
  let elementPlays = 0, elementsCreated = 0;
  const sandbox2 = {
    window: {},
    document: { addEventListener: () => {} },
    fetch: async () => ({ arrayBuffer: async () => new ArrayBuffer(8) }),
    Audio: function(){ elementsCreated++; this.play = () => { elementPlays++; return Promise.resolve(); }; },
    console
  };
  vm.createContext(sandbox2);
  vm.runInContext(fs.readFileSync('public/audio.js','utf8'), sandbox2);
  const A2 = sandbox2.window.ArcaneAudio;
  await A2.playSoundUrl('/x.wav');
  await A2.playSoundUrl('/x.wav');
  await A2.playSoundUrl('/x.wav');
  assert.strictEqual(elementPlays, 3, 'le repli doit jouer 3 fois, or ' + elementPlays);
  assert.strictEqual(elementsCreated, 3, 'un élément NEUF par lecture (un élément réutilisé ne rejoue pas)');
  console.log('✅ Repli sans Web Audio : élément neuf à chaque lecture, 3 poses = 3 sons.');

  console.log('\n✅ Couche audio validée : le son se rejoue à chaque pose.');
})().catch(e => { console.error('❌', e.message); process.exit(1); });

/* Vérifie que le module de sons synthétisés (sfx.js) construit correctement
   son graphe audio (oscillateurs, filtres, enveloppes) sans planter, pour
   chaque effet, avec un AudioContext simulé minimal. */
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const src = fs.readFileSync('public/sfx.js', 'utf8');

// AudioContext minimal : trace juste les appels et les paramètres essentiels,
// sans reproduire le vrai traitement du signal (inutile pour ce test).
function fakeParam(initial) {
  return {
    value: initial,
    calls: [],
    setValueAtTime(v, t) { this.value = v; this.calls.push(['set', v, t]); },
    linearRampToValueAtTime(v, t) { this.value = v; this.calls.push(['linear', v, t]); },
    exponentialRampToValueAtTime(v, t) { this.value = v; this.calls.push(['exp', v, t]); }
  };
}
function fakeNode() {
  const node = { connect: () => node, disconnect: () => {} };
  return node;
}
let startedNodes = [];
function fakeCtx() {
  return {
    currentTime: 0, sampleRate: 44100, destination: fakeNode(),
    createOscillator() {
      const n = fakeNode();
      n.type = 'sine'; n.frequency = fakeParam(440);
      n.start = (t) => startedNodes.push({ kind: 'osc', t });
      n.stop = () => {};
      return n;
    },
    createGain() {
      const n = fakeNode();
      n.gain = fakeParam(1);
      return n;
    },
    createBiquadFilter() {
      const n = fakeNode();
      n.type = 'lowpass'; n.frequency = fakeParam(1000);
      return n;
    },
    createBuffer(channels, len, rate) {
      return { length: len, sampleRate: rate, getChannelData: () => new Float32Array(len) };
    },
    createBufferSource() {
      const n = fakeNode();
      n.buffer = null;
      n.start = (t) => startedNodes.push({ kind: 'noise', t });
      n.stop = () => {};
      return n;
    }
  };
}

const sandbox = {
  window: { ArcaneAudio: { getAudioCtx: () => fakeCtx() } },
  Math, console
};
vm.createContext(sandbox);
vm.runInContext(src, sandbox);

assert.ok(sandbox.window.SFX, 'window.SFX doit être exposé');
const expected = ['attackHit', 'packOpen', 'cardReveal', 'turnStart', 'victory', 'defeat', 'cardPlayDefault'];
expected.forEach(name => assert.strictEqual(typeof sandbox.window.SFX[name], 'function', name + ' doit être une fonction'));
console.log('✅ Toutes les fonctions sonores attendues sont exposées : ' + expected.join(', '));

// Chaque effet doit pouvoir s'exécuter sans lever d'exception, avec un contexte simulé
expected.forEach(name => {
  startedNodes = [];
  assert.doesNotThrow(() => {
    if (name === 'cardReveal') {
      ['commun', 'rare', 'epique', 'legendaire'].forEach(r => sandbox.window.SFX.cardReveal(r));
    } else {
      sandbox.window.SFX[name]();
    }
  }, name + ' ne doit jamais lever d\'exception');
});
console.log('✅ Chaque effet sonore s\'exécute sans erreur (y compris les 4 raretés de cardReveal).');

// cardReveal doit produire plus de "notes" pour une légendaire qu'une commune (progression sonore)
startedNodes = [];
sandbox.window.SFX.cardReveal('commun');
const commonCount = startedNodes.length;
startedNodes = [];
sandbox.window.SFX.cardReveal('legendaire');
const legendaryCount = startedNodes.length;
assert.ok(legendaryCount > commonCount, 'une révélation légendaire doit être sonorement plus riche qu\'une commune');
console.log('✅ Une révélation légendaire est sonorement plus riche qu\'une commune (' + legendaryCount + ' > ' + commonCount + ' éléments sonores).');

// Un contexte audio absent (getAudioCtx renvoie null) ne doit jamais planter
const sandboxNoAudio = { window: { ArcaneAudio: { getAudioCtx: () => null } }, Math, console };
vm.createContext(sandboxNoAudio);
vm.runInContext(src, sandboxNoAudio);
expected.forEach(name => {
  assert.doesNotThrow(() => sandboxNoAudio.window.SFX[name](name === 'cardReveal' ? 'rare' : undefined), name + ' doit gérer un contexte audio absent sans planter');
});
console.log('✅ Sans AudioContext disponible (navigateur sans Web Audio), aucune fonction ne plante.');

console.log('\n✅ Module de sons synthétisés validé.');

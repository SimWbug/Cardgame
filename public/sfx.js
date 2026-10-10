/* ---------------- Effets sonores de jeu (synthétisés) ----------------
   Contrairement aux sons de cartes (audio.js, fichiers uploadés par
   l'admin), ces sons d'ambiance (impact d'attaque, ouverture de booster,
   victoire/défaite, tour...) sont entièrement synthétisés avec l'API
   Web Audio — pas de fichier à charger, pas de latence de téléchargement,
   et un rendu cohérent quel que soit l'environnement.
   On réutilise le même AudioContext que audio.js pour ne pas en ouvrir un
   second (les navigateurs limitent leur nombre et le déverrouillage au
   premier clic ne concernerait alors qu'un seul des deux). */

function ctx() {
  return window.ArcaneAudio ? window.ArcaneAudio.getAudioCtx() : null;
}

let noiseBufferCache = null;
function noiseBuffer(c) {
  if (noiseBufferCache) return noiseBufferCache;
  const len = c.sampleRate * 0.5;
  const buf = c.createBuffer(1, len, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  noiseBufferCache = buf;
  return buf;
}

/* Sortie des effets synthétisés, réglée par le volume des effets (Options) */
function sfxOut(c) {
  if (!c.__sfxOut) { c.__sfxOut = c.createGain(); c.__sfxOut.connect(c.destination); }
  const v = Number(window.CGD_SFX_VOLUME);
  c.__sfxOut.gain.value = Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1;
  return c.__sfxOut;
}

/* Une note simple : oscillateur + enveloppe de volume (attaque rapide, chute exponentielle). */
function tone(c, { freq, start, dur, type = 'sine', gain = 0.25, freqEnd = null, attack = 0.008 }) {
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, c.currentTime + start);
  if (freqEnd != null) osc.frequency.exponentialRampToValueAtTime(Math.max(freqEnd, 1), c.currentTime + start + dur);
  g.gain.setValueAtTime(0, c.currentTime + start);
  g.gain.linearRampToValueAtTime(gain, c.currentTime + start + attack);
  g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + start + dur);
  osc.connect(g).connect(sfxOut(c));
  osc.start(c.currentTime + start);
  osc.stop(c.currentTime + start + dur + 0.02);
}

/* Un souffle de bruit filtré (whoosh, impact, sparkle) via le buffer de bruit blanc. */
function noiseHit(c, { start, dur, filterFreq = 1200, filterType = 'lowpass', gain = 0.3, sweepTo = null }) {
  const src = c.createBufferSource();
  src.buffer = noiseBuffer(c);
  const filt = c.createBiquadFilter();
  filt.type = filterType;
  filt.frequency.setValueAtTime(filterFreq, c.currentTime + start);
  if (sweepTo != null) filt.frequency.exponentialRampToValueAtTime(Math.max(sweepTo, 40), c.currentTime + start + dur);
  const g = c.createGain();
  g.gain.setValueAtTime(gain, c.currentTime + start);
  g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + start + dur);
  src.connect(filt).connect(g).connect(sfxOut(c));
  src.start(c.currentTime + start);
  src.stop(c.currentTime + start + dur + 0.02);
}

function attackHit() {
  const c = ctx(); if (!c) return;
  tone(c, { freq: 130, freqEnd: 55, start: 0, dur: 0.16, type: 'sine', gain: 0.35 });
  noiseHit(c, { start: 0, dur: 0.09, filterFreq: 2200, sweepTo: 300, gain: 0.28 });
}

function packOpen() {
  const c = ctx(); if (!c) return;
  tone(c, { freq: 220, freqEnd: 900, start: 0, dur: 0.4, type: 'sawtooth', gain: 0.12 });
  tone(c, { freq: 330, freqEnd: 1300, start: 0.02, dur: 0.35, type: 'triangle', gain: 0.1 });
  noiseHit(c, { start: 0.28, dur: 0.35, filterFreq: 4000, filterType: 'highpass', gain: 0.14 });
}

const RARITY_REVEAL = {
  commun: [{ f: 440, t: 0 }],
  rare: [{ f: 440, t: 0 }, { f: 660, t: 0.07 }],
  epique: [{ f: 440, t: 0 }, { f: 660, t: 0.07 }, { f: 880, t: 0.14 }],
  legendaire: [{ f: 440, t: 0 }, { f: 660, t: 0.08 }, { f: 880, t: 0.16 }, { f: 1320, t: 0.24 }]
};
function cardReveal(rarity) {
  const c = ctx(); if (!c) return;
  const notes = RARITY_REVEAL[rarity] || RARITY_REVEAL.commun;
  notes.forEach(n => tone(c, { freq: n.f, start: n.t, dur: 0.22, type: 'triangle', gain: rarity === 'legendaire' ? 0.16 : 0.12 }));
  if (rarity === 'legendaire') noiseHit(c, { start: 0.2, dur: 0.5, filterFreq: 6000, filterType: 'highpass', gain: 0.08 });
}

function turnStart() {
  const c = ctx(); if (!c) return;
  tone(c, { freq: 523, start: 0, dur: 0.18, type: 'sine', gain: 0.15 });
  tone(c, { freq: 784, start: 0.09, dur: 0.22, type: 'sine', gain: 0.15 });
}

function victory() {
  const c = ctx(); if (!c) return;
  [523, 659, 784, 1046].forEach((f, i) => tone(c, { freq: f, start: i * 0.1, dur: 0.35, type: 'triangle', gain: 0.16 }));
}

function defeat() {
  const c = ctx(); if (!c) return;
  [392, 349, 293].forEach((f, i) => tone(c, { freq: f, start: i * 0.14, dur: 0.4, type: 'sine', gain: 0.16 }));
}

function cardPlayDefault() {
  const c = ctx(); if (!c) return;
  noiseHit(c, { start: 0, dur: 0.12, filterFreq: 1800, sweepTo: 500, gain: 0.14 });
  tone(c, { freq: 300, freqEnd: 180, start: 0, dur: 0.1, type: 'sine', gain: 0.1 });
}

/* Écran de fin de combat : petit « tic » des compteurs, défi réussi, fanfare de niveau */
function coinTick() {
  const c = ctx(); if (!c) return;
  tone(c, { freq: 1320, freqEnd: 1760, start: 0, dur: 0.05, type: 'square', gain: 0.035 });
}
function dailyDone() {
  const c = ctx(); if (!c) return;
  tone(c, { freq: 880, start: 0, dur: 0.16, type: 'triangle', gain: 0.14 });
  tone(c, { freq: 1318, start: 0.08, dur: 0.3, type: 'triangle', gain: 0.14 });
}
function levelUp() {
  const c = ctx(); if (!c) return;
  // Arpège montant puis accord tenu (do majeur) avec une pluie de notes aiguës
  [523, 659, 784, 1046].forEach((f, i) => tone(c, { freq: f, start: i * 0.09, dur: 0.22, type: 'triangle', gain: 0.15 }));
  [523, 659, 784, 1046].forEach(f => tone(c, { freq: f, start: 0.4, dur: 1.1, type: 'sawtooth', gain: 0.035, attack: 0.04 }));
  [523, 784, 1046].forEach(f => tone(c, { freq: f, start: 0.4, dur: 1.2, type: 'triangle', gain: 0.1, attack: 0.02 }));
  [2093, 2637, 3136, 2349, 2794].forEach((f, i) => tone(c, { freq: f, start: 0.45 + i * 0.07, dur: 0.12, type: 'sine', gain: 0.05 }));
}

/* Pioche : petit « fwip » de carte qui glisse */
function cardDraw() {
  const c = ctx(); if (!c) return;
  noiseHit(c, { start: 0, dur: 0.14, filterFreq: 1800, filterType: 'bandpass', gain: 0.16, sweepTo: 4200 });
  tone(c, { freq: 520, freqEnd: 780, start: 0.02, dur: 0.09, type: 'triangle', gain: 0.05 });
}
/* Râle d'agonie : souffle grave et sombre */
function deathrattle() {
  const c = ctx(); if (!c) return;
  tone(c, { freq: 160, freqEnd: 70, start: 0, dur: 0.6, type: 'sawtooth', gain: 0.08 });
  tone(c, { freq: 240, freqEnd: 110, start: 0.04, dur: 0.5, type: 'sine', gain: 0.12 });
  noiseHit(c, { start: 0, dur: 0.5, filterFreq: 900, sweepTo: 200, gain: 0.12 });
}
window.SFX = { cardDraw, deathrattle, attackHit, packOpen, cardReveal, turnStart, victory, defeat, cardPlayDefault, coinTick, dailyDone, levelUp };

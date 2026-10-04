/* ---------------- Audio des cartes ----------------
   On passe par l'API Web Audio plutôt que par des éléments <audio> :
   un même son décodé une fois peut être rejoué autant de fois qu'on veut,
   y compris plusieurs fois dans le même combat et en superposition.
   Un élément <audio> réutilisé reste bloqué sur sa fin de lecture, ce qui
   faisait qu'un son ne se déclenchait qu'une seule fois par partie. */
let audioCtx = null;
const soundBuffers = new Map();   // url -> AudioBuffer décodé
const soundLoading = new Map();   // url -> Promise en cours

function getAudioCtx() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    audioCtx = new Ctx();
  }
  return audioCtx;
}

/* Les navigateurs démarrent le contexte audio « suspendu » tant que
   l'utilisateur n'a pas interagi. On le réveille au premier clic. */
function unlockAudio() {
  const ctx = getAudioCtx();
  if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
}
document.addEventListener('click', unlockAudio, { passive: true });
document.addEventListener('keydown', unlockAudio, { passive: true });

async function loadSound(url) {
  if (soundBuffers.has(url)) return soundBuffers.get(url);
  if (soundLoading.has(url)) return soundLoading.get(url);
  const ctx = getAudioCtx();
  if (!ctx) return null;
  const task = (async () => {
    try {
      const res = await fetch(url);
      const raw = await res.arrayBuffer();
      const buf = await ctx.decodeAudioData(raw);
      soundBuffers.set(url, buf);
      return buf;
    } catch (e) {
      soundBuffers.set(url, null); // on n'essaiera pas en boucle
      return null;
    } finally {
      soundLoading.delete(url);
    }
  })();
  soundLoading.set(url, task);
  return task;
}

/* Précharge une liste de cartes pour éviter la latence au premier jeu. */
function preloadSounds(cards) {
  (cards || []).forEach(c => { if (c && c.sound) loadSound(c.sound); });
}

/* Repli si l'API Web Audio est indisponible : un NOUVEL élément à chaque fois,
   jamais réutilisé, sinon la relecture échoue. */
function playWithAudioElement(url) {
  try {
    const el = new Audio(url);
    el.volume = 0.7 * sfxVolume();
    const attempt = el.play();
    if (attempt && attempt.catch) attempt.catch(() => {});
  } catch (e) {}
}

/* Volume des effets choisi dans les Options (0 à 1) */
function sfxVolume() { const v = Number(window.CGD_SFX_VOLUME); return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1; }

async function playSoundUrl(url) {
  if (!url) return;
  const ctx = getAudioCtx();
  if (!ctx) { playWithAudioElement(url); return; }
  if (ctx.state === 'suspended') { try { await ctx.resume(); } catch (e) {} }
  const buf = await loadSound(url);
  if (!buf) { playWithAudioElement(url); return; }
  try {
    // Une source Web Audio est à usage unique : on en crée une par lecture
    const src = ctx.createBufferSource();
    const gain = ctx.createGain();
    gain.gain.value = 0.7 * sfxVolume();
    src.buffer = buf;
    src.connect(gain).connect(ctx.destination);
    src.start(0);
  } catch (e) {
    playWithAudioElement(url);
  }
}


/* Exposition pour app.js et pour les tests */
window.ArcaneAudio = {
  getAudioCtx, unlockAudio, loadSound, preloadSounds, playSoundUrl,
  _buffers: soundBuffers
};

/* Son de révélation par rareté au pack opening : ordre de priorité
   1) son personnalisé de la rareté, 2) son « toutes raretés », 3) son synthétisé. */
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const src = fs.readFileSync('public/app.js', 'utf8');
const start = src.indexOf('function playRevealSound(card) {');
const end = src.indexOf('function playGameSound(key, fallbackFn) {');
assert.ok(start > 0 && end > start, 'playRevealSound doit exister avant playGameSound');
const fn = src.slice(start, end);

function run(sfx, card, soundOn = true) {
  const played = [];
  const sb = {
    S: { soundOn, content: { sfx } },
    ArcaneAudio: { playSoundUrl: u => played.push('url:' + u) },
    window: { SFX: {} }, SFX: { cardReveal: r => played.push('synth:' + r) }
  };
  sb.window.SFX = sb.SFX;
  vm.createContext(sb); vm.runInContext(fn, sb); sb.playRevealSound(card);
  return played;
}

assert.deepStrictEqual(run({ cardReveal_legendaire: '/l.mp3', cardReveal: '/all.mp3' }, { rarity: 'legendaire' }), ['url:/l.mp3']);
console.log('✅ Une rareté avec son propre son joue ce son.');
assert.deepStrictEqual(run({ cardReveal_legendaire: '/l.mp3', cardReveal: '/all.mp3' }, { rarity: 'rare' }), ['url:/all.mp3']);
console.log('✅ Une rareté sans son propre son retombe sur le son « toutes raretés ».');
assert.deepStrictEqual(run({}, { rarity: 'epique' }), ['synth:epique']);
console.log('✅ Sans aucun son personnalisé, le son synthétisé de la rareté est joué.');
assert.deepStrictEqual(run({ cardReveal_rare: '/r.mp3' }, { rarity: 'rare' }, false), []);
console.log('✅ Son coupé : rien n\'est joué.');

const content = require('./src/content');
['commun', 'rare', 'epique', 'legendaire'].forEach(r => assert.ok(content.SFX_KEYS.includes('cardReveal_' + r), 'clé serveur manquante pour ' + r));
console.log('✅ Les quatre sons de rareté sont acceptés par le panel admin (serveur).');
console.log('\n✅ Sons de révélation par rareté validés.');

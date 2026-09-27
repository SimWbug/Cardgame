/* Vérifie côté client les fonctions t()/icon()/logoUrl()/playGameSound() :
   repli sur le défaut français avant chargement, application des
   remplacements une fois le contenu chargé, et priorité du son
   personnalisé sur la synthèse. */
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const src = fs.readFileSync('public/app.js', 'utf8');
const start = src.indexOf('function t(key, fallback)');
const end = src.indexOf('async function afterLogin()');
const chunk = src.slice(start, end);
assert.ok(chunk.includes('function icon('), 'icon() doit être dans l\'extrait');
assert.ok(chunk.includes('function logoUrl('), 'logoUrl() doit être dans l\'extrait');
assert.ok(chunk.includes('function playGameSound('), 'playGameSound() doit être dans l\'extrait');

const sandbox = { S: { content: null, soundOn: true }, ArcaneAudio: {}, window: {}, console };
sandbox.window.ArcaneAudio = sandbox.ArcaneAudio;
vm.createContext(sandbox);
vm.runInContext(chunk, sandbox);

// 1) Avant chargement du contenu (S.content === null), repli sur le défaut fourni
assert.strictEqual(sandbox.t('nav.collection', 'Collection'), 'Collection');
assert.strictEqual(sandbox.icon('icon.credits', '🪙'), '🪙');
assert.strictEqual(sandbox.logoUrl(), '/branding/logo.png');
console.log('✅ Avant chargement du contenu, repli sur les valeurs par défaut françaises.');

// 2) Une fois le contenu chargé, les remplacements s'appliquent
sandbox.S.content = { strings: { 'nav.collection': 'Cartes' }, icons: { 'icon.credits': '💰' }, media: { logo: '/uploads/branding/x.png' }, sfx: {} };
assert.strictEqual(sandbox.t('nav.collection', 'Collection'), 'Cartes');
assert.strictEqual(sandbox.icon('icon.credits', '🪙'), '💰');
assert.strictEqual(sandbox.logoUrl(), '/uploads/branding/x.png');
console.log('✅ Une fois le contenu chargé, les remplacements personnalisés s\'appliquent.');

// 3) Une clé NON remplacée garde son repli, même contenu chargé
assert.strictEqual(sandbox.t('nav.codex', 'Codex'), 'Codex');
console.log('✅ Une clé non personnalisée garde son repli même une fois le contenu chargé.');

// 4) playGameSound : un son personnalisé prend le pas sur la synthèse
let playedUrl = null, fallbackCalled = false;
sandbox.ArcaneAudio.playSoundUrl = (url) => { playedUrl = url; };
sandbox.S.content.sfx = { attackHit: '/uploads/branding/hit.wav' };
sandbox.playGameSound('attackHit', () => { fallbackCalled = true; });
assert.strictEqual(playedUrl, '/uploads/branding/hit.wav');
assert.strictEqual(fallbackCalled, false, 'la synthèse ne doit PAS être appelée quand un son personnalisé existe');
console.log('✅ Un son personnalisé uploadé prend le pas sur la synthèse.');

// 5) Sans son personnalisé pour cette clé, on retombe sur la synthèse (fallback)
playedUrl = null; fallbackCalled = false;
sandbox.playGameSound('turnStart', () => { fallbackCalled = true; });
assert.strictEqual(playedUrl, null);
assert.strictEqual(fallbackCalled, true, 'la synthèse doit être appelée en l\'absence de son personnalisé');
console.log('✅ Sans son personnalisé, la synthèse par défaut est utilisée.');

// 6) Le son est coupé (S.soundOn = false) : ni le personnalisé ni la synthèse ne jouent
sandbox.S.soundOn = false;
playedUrl = null; fallbackCalled = false;
sandbox.playGameSound('attackHit', () => { fallbackCalled = true; }); // pourtant un son personnalisé existe pour cette clé
assert.strictEqual(playedUrl, null);
assert.strictEqual(fallbackCalled, false);
console.log('✅ Le son coupé (🔇) empêche bien toute lecture, personnalisée ou synthétisée.');

console.log('\n✅ Fonctions client de contenu personnalisable validées.');

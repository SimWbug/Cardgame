/* Le booster gratuit (Édition de base) ne donne que des cartes de base ;
   un booster d'extension ne donne que les cartes de son extension. */
const assert = require('assert');
const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, 'server.js'), 'utf8');
const free = src.slice(src.indexOf("app.post('/api/pack/open'"), src.indexOf("app.post('/api/pack/open'") + 1500);
assert.ok(/\(c\.extensionId \|\| 'base'\) === 'base'/.test(free), 'le booster gratuit filtre sur l\'Édition de base');
const inv = src.slice(src.indexOf("app.post('/api/pack/open-inventory'"), src.indexOf("app.post('/api/pack/open-inventory'") + 1200);
assert.ok(/=== stored\.extensionId/.test(inv) && /drawPack\(pool\)/.test(inv), "le booster d'extension tire dans son extension avec les taux de rareté");
console.log("✅ Booster gratuit = cartes de base uniquement ; booster d'extension = son extension, avec les taux de rareté.");

// 2 exemplaires maximum d'une même carte par booster (vérifié sur 2000 boosters simulés)
const vm = require('vm');
const i = src.indexOf('const PACK_SIZE = 5'), j = src.indexOf('/* Tirage pondéré À L\'INTÉRIEUR');
const k = src.indexOf('function weightedPick(pool) {'), kEnd = src.indexOf('\n}\n', k) + 3;
const sb = { RARITY_WEIGHTS: { commun: 60, rare: 25, epique: 12, legendaire: 3 }, MIN_DROP_WEIGHT: 0.01, MAX_DROP_WEIGHT: 100, DEFAULT_DROP_WEIGHT: 1, Math };
vm.createContext(sb);
vm.runInContext((src.slice(i, j) + src.slice(k, kEnd)).replace(/^const /gm, 'var '), sb);
const tiny = [{ id: 'a', rarity: 'commun' }, { id: 'b', rarity: 'commun' }, { id: 'c', rarity: 'rare' }];
for (let n = 0; n < 2000; n++) {
  const counts = {};
  sb.drawPack(tiny).forEach(c => { counts[c.id] = (counts[c.id] || 0) + 1; });
  assert.ok(Object.values(counts).every(v => v <= 2), 'jamais plus de 2 fois la même carte : ' + JSON.stringify(counts));
}
console.log('✅ Jamais plus de 2 exemplaires d\'une même carte dans un booster (2000 boosters simulés).');

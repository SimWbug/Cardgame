/* Le booster gratuit (Édition de base) ne donne que des cartes de base ;
   un booster d'extension ne donne que les cartes de son extension. */
const assert = require('assert');
const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, 'server.js'), 'utf8');
const free = src.slice(src.indexOf("app.post('/api/pack/open'"), src.indexOf("app.post('/api/pack/open'") + 1500);
assert.ok(/\(c\.extensionId \|\| 'base'\) === 'base'/.test(free), 'le booster gratuit filtre sur l\'Édition de base');
const inv = src.slice(src.indexOf("app.post('/api/pack/open-inventory'"), src.indexOf("app.post('/api/pack/open-inventory'") + 1200);
assert.ok(/=== stored\.extensionId/.test(inv) && /weightedDraw\(pool\)/.test(inv), "le booster d'extension tire dans son extension avec les taux de rareté");
console.log("✅ Booster gratuit = cartes de base uniquement ; booster d'extension = son extension, avec les taux de rareté.");

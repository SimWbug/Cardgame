/* Garde-fou pour un bug réel observé en capture d'écran : la main en éventail
   s'effondrait en une bande verticale d'un pixel de large. Cause : des
   marges horizontales "auto" sur un enfant flex dont tous les descendants
   sont en position:absolute (donc sans largeur de contenu) désactivent
   l'étirement par défaut et ramènent la boîte à ~0px de large. Ce test ne
   vérifie pas le rendu (impossible sans navigateur) mais empêche la
   régression la plus probable : que quelqu'un remette "margin:auto" sur ce
   conteneur précis en "nettoyant" le CSS plus tard. */
const assert = require('assert');
const fs = require('fs');

const css = fs.readFileSync('public/styles.css', 'utf8');
const ruleStart = css.indexOf('.hand-row.hand-fan{');
assert.ok(ruleStart !== -1, 'la règle .hand-row.hand-fan doit exister');
const ruleEnd = css.indexOf('}', ruleStart);
const rule = css.slice(ruleStart, ruleEnd + 1);

assert.ok(!/margin\s*:\s*[^;]*auto/i.test(rule), '.hand-row.hand-fan ne doit jamais utiliser de marge "auto" (voir le commentaire dans le CSS)');
console.log('✅ .hand-row.hand-fan n\'utilise aucune marge "auto" (le piège précis qui causait l\'effondrement en bande verticale).');

assert.ok(/width\s*:\s*100%/.test(rule), '.hand-row.hand-fan doit avoir une largeur explicite (100%) puisque ses enfants sont en position:absolute');
console.log('✅ Une largeur explicite (100%) est bien fixée, indépendante du contenu absolument positionné.');

assert.ok(/position\s*:\s*relative/.test(rule), '.hand-row.hand-fan doit rester le repère de position pour ses cartes en position:absolute');
console.log('✅ position:relative toujours présent (nécessaire comme repère pour les cartes en position:absolute).');

console.log('\n✅ Garde-fou CSS de la main en éventail validé.');

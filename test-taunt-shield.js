/* Vérifie que l'affichage de la Provocation en combat utilise bien
   l'anneau + bouclier plutôt que l'ancien badge texte "PROV", et que ce
   n'est bien affiché QUE pour les serviteurs avec taunt:true. */
const assert = require('assert');
const fs = require('fs');

const src = fs.readFileSync('public/app.js', 'utf8');

assert.ok(!src.includes('>PROV<') && !src.includes("'PROV'"), 'l\'ancien badge texte "PROV" ne doit plus exister');
console.log('✅ L\'ancien badge texte "PROV" a bien été retiré.');

const start = src.indexOf('function minionTile');
const end = src.indexOf('function ', start + 10);
const block = src.slice(start, end);

assert.ok(block.includes('taunt-ring'), 'l\'anneau de provocation doit être présent dans minionTile');
assert.ok(block.includes('taunt-shield'), 'le bouclier de provocation doit être présent dans minionTile');
assert.ok(block.includes('m.taunt ?'), 'l\'affichage doit être conditionné à m.taunt');
console.log('✅ L\'anneau et le bouclier de provocation sont bien présents et conditionnés à m.taunt.');

// Le bouclier doit être placé AVANT .minion-portrait dans le HTML (donc peint
// derrière elle, sauf z-index contraire) et hors de sa boîte à overflow:hidden.
const shieldPos = block.indexOf('taunt-shield');
const portraitPos = block.indexOf('<div class="minion-portrait">');
assert.ok(shieldPos !== -1 && portraitPos !== -1 && shieldPos < portraitPos, 'le bouclier doit apparaître AVANT .minion-portrait dans le HTML, pour être peint derrière elle');
console.log('✅ Le bouclier est placé avant .minion-portrait dans le HTML (derrière elle à l\'écran).');

assert.ok(block.includes('minion-portrait-wrap'), 'le portrait doit être enveloppé dans un conteneur qui ne rogne pas le contenu (contrairement à .minion-portrait)');
console.log('✅ Le portrait est enveloppé dans un conteneur sans découpe, pour que l\'anneau et le bouclier ne soient plus coupés.');

// Vérifie côté CSS que le style existe bien
const css = fs.readFileSync('public/styles.css', 'utf8');
assert.ok(css.includes('.taunt-ring{') && css.includes('.taunt-shield{'), 'le CSS de l\'anneau et du bouclier doit exister');
assert.ok(!css.includes('.kw-badge{'), 'l\'ancien style de badge texte doit avoir été nettoyé (code mort)');
console.log('✅ Le CSS du nouvel affichage existe, l\'ancien badge texte a été nettoyé.');

// Le bouclier doit être nettement plus grand que le portrait (64px) pour
// dépasser visiblement tout autour, pas juste un petit badge caché derrière.
const shieldCssMatch = css.match(/\.taunt-shield\{[^}]*width:(\d+)px/);
assert.ok(shieldCssMatch && Number(shieldCssMatch[1]) > 64, 'le bouclier doit être plus grand que le portrait (64px) pour dépasser tout autour');
console.log('✅ Le bouclier (' + (shieldCssMatch && shieldCssMatch[1]) + 'px) est bien plus grand que le portrait (64px), pour dépasser visiblement derrière.');

// Le bouclier doit être centré (pas juste en bas comme un badge classique)
const shieldRule = css.slice(css.indexOf('.taunt-shield{'), css.indexOf('}', css.indexOf('.taunt-shield{')));
assert.ok(shieldRule.includes('top:50%') && shieldRule.includes('left:50%'), 'le bouclier doit être centré derrière le portrait, pas positionné comme un badge en bas');
console.log('✅ Le bouclier est bien centré derrière le portrait (pas un badge en coin ou en bas).');

console.log('\n✅ Affichage de la Provocation (anneau + bouclier) validé.');

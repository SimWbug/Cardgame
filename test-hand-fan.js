/* Vérifie la disposition de la main en éventail : les cartes centrales sont
   presque verticales, les cartes extérieures sont plus inclinées et
   symétriques, l'ordre d'empilement place le centre au-dessus, et une seule
   carte reste bien centrée sans rotation. */
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const src = fs.readFileSync('public/app.js', 'utf8');
const start = src.indexOf('function handFanStyle');
const end = src.indexOf('function handStatLine');
const chunk = src.slice(start, end);
assert.ok(chunk.includes('--fan-x'), 'la fonction doit être présente dans l\'extrait');

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(chunk, sandbox);

function parseTransform(style) {
  const angle = Number((style.match(/--fan-angle:(-?[\d.]+)deg/) || [])[1]);
  const x = Number((style.match(/--fan-x:(-?[\d.]+)px/) || [])[1]);
  const y = Number((style.match(/--fan-y:(-?[\d.]+)px/) || [])[1]);
  const z = Number((style.match(/z-index:(\d+)/) || [])[1]);
  return { angle, x, y, z };
}

/* 1) Une seule carte : centrée, sans rotation */
const single = parseTransform(sandbox.handFanStyle(0, 1));
assert.strictEqual(single.angle, 0);
assert.strictEqual(single.y, 0);
console.log('✅ Une main d\'une seule carte reste centrée, sans rotation.');

/* 2) Main de 5 cartes : la carte centrale (index 2) est verticale, PV le plus haut */
const mid = parseTransform(sandbox.handFanStyle(2, 5));
assert.strictEqual(mid.angle, 0, 'la carte centrale ne doit avoir aucune rotation');
assert.strictEqual(mid.y, 0, 'la carte centrale ne doit pas descendre');
console.log('✅ La carte centrale d\'une main de 5 est parfaitement verticale et la plus haute.');

/* 3) Symétrie gauche/droite : les cartes équidistantes du centre sont des miroirs */
const left = parseTransform(sandbox.handFanStyle(0, 5));
const right = parseTransform(sandbox.handFanStyle(4, 5));
assert.strictEqual(left.angle, -right.angle, 'les angles doivent être opposés en miroir');
assert.strictEqual(Math.round(left.x * 10), Math.round(-right.x * 10) - Math.round(172 * 10), 'écart symétrique autour du centre (en tenant compte du décalage de largeur de carte)');
assert.strictEqual(left.y, right.y, 'les cartes symétriques doivent descendre de la même hauteur');
console.log('✅ Les cartes extérieures sont symétriques (angles opposés, même hauteur).');

/* 4) Les cartes s'inclinent progressivement du centre vers l'extérieur */
const p0 = parseTransform(sandbox.handFanStyle(0, 5));
const p1 = parseTransform(sandbox.handFanStyle(1, 5));
const p2 = parseTransform(sandbox.handFanStyle(2, 5));
assert.ok(Math.abs(p0.angle) > Math.abs(p1.angle), 'la carte la plus à l\'extérieur doit être plus inclinée que sa voisine');
assert.ok(Math.abs(p1.angle) > Math.abs(p2.angle), 'l\'inclinaison doit croître progressivement vers l\'extérieur');
console.log('✅ L\'inclinaison croît progressivement du centre vers les bords.');

/* 5) Les cartes extérieures descendent plus que les cartes centrales (courbe d'éventail) */
assert.ok(p0.y > p1.y && p1.y > p2.y, 'les cartes doivent descendre de plus en plus en s\'éloignant du centre');
console.log('✅ Les cartes descendent progressivement en s\'éloignant du centre (courbe d\'éventail).');

/* 6) Empilement (z-index) : le centre est au-dessus des bords */
assert.ok(p2.z > p1.z && p1.z > p0.z, 'la carte centrale doit être au-dessus des cartes extérieures');
console.log('✅ La carte centrale passe devant les cartes extérieures (z-index le plus élevé).');

/* 7) L'inclinaison maximale reste raisonnable même avec beaucoup de cartes (ne part pas en vrille) */
const manyCards = parseTransform(sandbox.handFanStyle(0, 10));
assert.ok(Math.abs(manyCards.angle) <= 10, 'l\'inclinaison ne doit jamais devenir extrême, même à 10 cartes en main');
console.log('✅ L\'inclinaison maximale reste raisonnable même avec une main pleine (10 cartes).');

console.log('\n✅ Disposition de la main en éventail validée.');

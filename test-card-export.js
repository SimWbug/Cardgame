/* Export de la liste des cartes (panel admin) : CSV lisible par Excel
   (BOM, « ; », guillemets échappés) et résumé des effets correct. */
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const src = fs.readFileSync('public/app.js', 'utf8');
const grab = (a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); assert.ok(i > 0 && j > i, 'bloc introuvable : ' + a); return src.slice(i, j); };
const code = grab('const RARITIES = {', '\n};') + '\n};\n'
  + grab('function cardTypeLabel(type) {', '\n}\n') + '\n}\n'
  + grab('const EXPORT_EFFECT_LABELS = {', 'function downloadText(')
  + grab('function estimatedDropPercent(', '\n}\n') + '\n}\n';
const sb = { t: (k, d) => d, S: { config: { rarityWeights: { commun: 70, rare: 22, epique: 6.5, legendaire: 1.5 } }, cardPool: [] } }; vm.createContext(sb); vm.runInContext(code.replace(/^const /gm, 'var '), sb);

const pool = [
  { id: 'm1', name: 'Garde "Fer"', type: 'minion', rarity: 'rare', cost: 3, attack: 2, health: 5, taunt: true, desc: 'Solide; très solide', dropWeight: 1 },
  { id: 's1', name: 'Boule de feu', type: 'sort', rarity: 'commun', cost: 4, effectType: 'damage', value: 6, desc: '' },
  { id: 's2', name: 'Cataclysme', type: 'spell', rarity: 'legendaire', cost: 7, effectType: 'board_wipe' },
  { id: 'w1', name: 'Hache', type: 'weapon', rarity: 'epique', cost: 3, attack: 5, durability: 2, usesPerTurn: 2, extensionName: 'Les Ombres' }
];
const rows = sb.cardExportRows(pool);
assert.strictEqual(rows.length, 5, 'une ligne d\'en-tête + une par carte');
const H = rows[0], col = n => H.indexOf(n);
assert.strictEqual(rows[1][col('PV')], 5);
assert.strictEqual(rows[1][col('Provocation')], 'oui');
assert.strictEqual(rows[2][col('Résumé des effets')], 'Inflige 6 dégâts à une cible');
assert.strictEqual(rows[2][col('Valeur')], 6, 'un sort de type « sort » exporte bien sa valeur');
assert.strictEqual(rows[2][col('Effet (sort)')], 'Dégâts (cible)');
assert.strictEqual(rows[3][col('Résumé des effets')], 'Détruit tous les serviteurs des deux camps');
assert.strictEqual(rows[4][col('Durabilité (arme)')], 2);
assert.ok(rows[4][col('Résumé des effets')].includes('2 attaques par tour'));
assert.strictEqual(rows[4][col('Extension')], 'Les Ombres');
assert.strictEqual(rows[2][col('Extension')], 'Base');
assert.strictEqual(rows[3][col('% par booster (estimé)')], '1,50');
sb.S.config = null; assert.strictEqual(sb.cardExportRows(pool)[1][col('% par booster (estimé)')], '', 'sans config de taux, colonne vide au lieu d\'une erreur');
console.log('✅ Chaque carte exporte ses stats, son effet et son extension.');

const csv = sb.toCsv(rows);
assert.ok(csv.startsWith('\ufeff'), 'BOM UTF-8 pour Excel');
const lines = csv.slice(1).split('\r\n');
assert.strictEqual(lines.length, 5);
assert.strictEqual(lines[0].split(';').length, H.length, 'séparateur « ; »');
assert.ok(lines[1].includes('"Garde ""Fer"""'), 'guillemets échappés');
assert.ok(lines[1].includes('"Solide; très solide"'), 'un « ; » dans un texte est protégé par des guillemets');
console.log('✅ Le CSV s\'ouvre proprement dans Excel (BOM, « ; », textes protégés).');
console.log('\n✅ Export de la liste des cartes validé.');

// Texte des cartes en jeu : effet en clair + description, sans doublon
{
  const i = src.indexOf('function cardEffectParts(c) {'), j = src.indexOf('function cardEffectSummary(c) {');
  const sb2 = { t: (k, d) => d, esc: s => String(s), kwWrap: s => s };
  vm.createContext(sb2);
  vm.runInContext((grab('const EXPORT_EFFECT_LABELS = {', 'function cardExportRows(') + src.slice(i, j)).replace(/^const /gm, 'var '), sb2);
  const wipe = sb2.cardTextHTML({ type: 'sort', effectType: 'board_wipe', desc: 'La fin de tout.' }, 'x');
  assert.ok(wipe.includes('Détruit tous les serviteurs des deux camps') && wipe.includes('La fin de tout.'), 'effet + description');
  const dup = sb2.cardTextHTML({ type: 'sort', effectType: 'damage', value: 2, desc: 'Inflige 2 dégâts à une cible.' }, 'x');
  assert.ok(!dup.includes('card-fx'), 'pas de doublon quand la description dit déjà l\'effet');
  const board = sb2.cardEffectParts({ instanceId: 'm1', taunt: true, charge: true, desc: '' });
  assert.strictEqual(JSON.stringify(board), JSON.stringify(['Provocation', 'Charge']), 'serviteur posé sur le plateau = mots-clés de serviteur');
  console.log('✅ Les cartes en jeu affichent leur effet en clair, sans répéter leur description.');
}

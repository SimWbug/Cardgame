/* Stats mensuelles des cartes (Admin → Stats) : enregistrement côté serveur
   et fusion côté client (cartes jamais jouées à 0, cartes supprimées gardées). */
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const db = require('./src/db');

const month = '2099-01';
const card = { id: 'stat-test-card', name: 'Carte de test' };
db.recordCardPlay(card, month, '3', false);
db.recordCardPlay(card, month, '3', true);
db.recordMatchCards(month, [{ cardIds: ['stat-test-card'], won: true }, { cardIds: [], won: false }]);
const b = db.getCardStats().months[month];
assert.deepStrictEqual(b.cards['stat-test-card'], { name: 'Carte de test', plays: 2, botPlays: 1, matches: 1, wins: 1 });
assert.strictEqual(b.days['3'], 2);
assert.strictEqual(b.pvpMatches, 1);
delete db.getCardStats().months[month];
console.log('✅ Poses, poses contre le bot, parties JcJ et victoires sont comptées par carte et par mois.');

const src = fs.readFileSync('public/app.js', 'utf8');
const i = src.indexOf('function buildCardStatRows('), j = src.indexOf('function statBars(');
const sb = {}; vm.createContext(sb); vm.runInContext(src.slice(i, j), sb);
const pool = [{ id: 'a', name: 'A', rarity: 'rare', type: 'minion' }, { id: 'b', name: 'B', rarity: 'commun', type: 'sort', extensionName: 'Ombres' }];
const rows = sb.buildCardStatRows({ cards: [{ id: 'a', plays: 4 }, { id: 'zz', name: 'Ancienne', plays: 2 }] }, pool, {});
assert.strictEqual(rows.length, 3);
assert.strictEqual(rows.find(r => r.id === 'b').plays, 0, 'une carte jamais jouée apparaît avec 0');
assert.ok(rows.find(r => r.id === 'zz').deleted, 'une carte supprimée reste listée avec son nom');
assert.strictEqual(sb.buildCardStatRows({ cards: [] }, pool, { type: 'sort' }).length, 1, 'filtre Sorts');
assert.strictEqual(sb.buildCardStatRows({ cards: [] }, pool, { ext: 'Ombres' }).length, 1, 'filtre extension');
console.log('✅ La page fusionne les stats avec le pool et applique les filtres.');
console.log('\n✅ Stats des cartes validées.');

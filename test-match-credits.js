/* Crédits de fin de combat : gagnant, perdant, abandon et parties trop courtes */
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const src = fs.readFileSync('server.js', 'utf8');
const i = src.indexOf('const MIN_TURNS_FOR_CREDITS'), j = src.indexOf('function settleMatch(');
assert.ok(i > 0 && j > i);
const sb = { db: { getSettings: () => ({}) } };
vm.createContext(sb); vm.runInContext(src.slice(i, j).replace('const MIN_TURNS_FOR_CREDITS', 'var MIN_TURNS_FOR_CREDITS'), sb);
const m = (extra) => Object.assign({ turnNumber: 8, winner: 'a' }, extra);
assert.strictEqual(sb.matchCredits(m(), 'a'), 50, 'gagnant : 50 par défaut');
assert.strictEqual(sb.matchCredits(m(), 'b'), 25, 'perdant : 25 par défaut');
assert.strictEqual(sb.matchCredits(m({ forfeitBy: 'b' }), 'b'), 0, 'abandon : rien pour celui qui abandonne');
assert.strictEqual(sb.matchCredits(m({ forfeitBy: 'b' }), 'a'), 50, 'le gagnant par abandon est payé si la partie a duré');
assert.strictEqual(sb.matchCredits(m({ turnNumber: 2 }), 'a'), 0, 'partie trop courte : rien');
sb.db.getSettings = () => ({ winCredits: 80, lossCredits: 0 });
assert.strictEqual(sb.matchCredits(m(), 'a'), 80, 'montant réglable en admin');
assert.strictEqual(sb.matchCredits(m(), 'b'), 0);
console.log('✅ Crédits de fin de combat : gagnant, perdant, abandon, partie courte et réglage admin.');

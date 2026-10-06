/* « Toujours debout » : +1/+1 tous les 2 tours passés en vie, 3 niveaux max */
const assert = require('assert');
const game = require('./src/game');
const { SEED_CARDS } = require('./src/cards');
const base = SEED_CARDS.find(c => c.type === 'minion' && !c.charge);
const card = Object.assign({}, base, { id: 'stand-test', standing: true, attack: 2, health: 3 });
const pool = SEED_CARDS.concat([card]);
const deck = Array(30).fill(base.id);
const m = game.createMatch('st', { slug: 'a', pseudo: 'A', deck }, { slug: 'b', pseudo: 'B', deck });
if (m.phase === 'mulligan') { game.submitMulligan(m, 0, []); game.submitMulligan(m, 1, []); }
const me = m.players[m.turn];
const mn = game.createMinionFrom(card);
assert.ok(mn.standing && mn.standLevel === 0);
me.board.push(mn);
const owner = m.turn;
const ownTurns = () => { game.endTurn(m); game.endTurn(m); assert.strictEqual(m.turn, owner); };
ownTurns();
assert.strictEqual(mn.standLevel, 0, 'pas encore de niveau après 1 tour');
ownTurns();
assert.strictEqual(mn.standLevel, 1); assert.strictEqual(mn.attack, 3); assert.strictEqual(mn.health, 4); assert.strictEqual(mn.maxHealth, 4);
const ev = m.events.filter(e => e.type === 'levelup');
assert.strictEqual(ev.length, 1); assert.strictEqual(ev[0].level, 1);
console.log('✅ Toujours debout : niveau 1 (+1/+1) après 2 tours en vie, avec un événement.');
for (let i = 0; i < 8; i++) ownTurns();
assert.strictEqual(mn.standLevel, game.STANDING_MAX); assert.strictEqual(mn.attack, 2 + game.STANDING_MAX);
console.log('✅ Toujours debout : plafonné à ' + game.STANDING_MAX + ' niveaux.');
const st = game.redactStateFor(m, pool, owner);
assert.ok(st.you.board.some(x => x.standLevel === game.STANDING_MAX), "le niveau est transmis à l'interface");
console.log('\n✅ Toujours debout validé.');

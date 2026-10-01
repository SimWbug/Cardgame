/* Journal de combat visuel : le moteur produit des événements exacts
   (qui frappe qui, combien, qui meurt) et le bot joue étape par étape. */
const assert = require('assert');
const game = require('./src/game');
const bot = require('./src/bot');
const { SEED_CARDS } = require('./src/cards');

const minion = SEED_CARDS.find(c => c.type === 'minion' && c.attack >= 2 && !c.charge);
const deck = Array(30).fill(minion.id);
const m = game.createMatch('ev', { slug: 'a', pseudo: 'A', deck }, { slug: 'b', pseudo: 'B', deck });
if (m.phase === 'mulligan') { game.submitMulligan(m, 0, []); game.submitMulligan(m, 1, []); }
// Pose directe de deux serviteurs pour un échange contrôlé
const mk = (id, atk, hp) => ({ instanceId: id, cardId: minion.id, name: 'M' + id, attack: atk, health: hp, maxHealth: hp, armor: 0, taunt: false, charge: false, canAttack: true, sickness: false });
const me = m.players[m.turn], opp = m.players[1 - m.turn];
me.board.push(mk('x', 3, 5)); opp.board.push(mk('y', 2, 3));
const r = game.attack(m, m.turn, 'x', 'minion', 'y');
assert.ok(r.ok);
const e = m.events[m.events.length - 1];
assert.strictEqual(e.type, 'attack');
assert.strictEqual(e.attacker.id, 'x'); assert.strictEqual(e.target.id, 'y');
assert.strictEqual(e.dmg, 3); assert.strictEqual(e.back, 2);
assert.strictEqual(e.targetDied, true); assert.strictEqual(e.attackerDied, false);
console.log('✅ Une attaque produit un événement exact (attaquant, cible, dégâts, riposte, mort).');

const plays = m.events.filter(x => x.type === 'turn');
assert.ok(plays.length >= 1, 'un événement « tour » au début de chaque tour');
const st = game.redactStateFor(m, SEED_CARDS, 0);
assert.ok(Array.isArray(st.events) && st.events.length > 0, 'les événements sont envoyés aux joueurs');
console.log('✅ Les événements de tour sont présents et transmis dans l\'état.');

// Bot pas à pas : chaque action est une étape distincte
const m2 = game.createMatch('bot', { slug: 'h', pseudo: 'H', deck }, { slug: 'bot', pseudo: 'Bot', deck });
if (m2.phase === 'mulligan') { game.submitMulligan(m2, 0, []); game.submitMulligan(m2, 1, []); }
for (let i = 0; i < 8 && m2.status === 'active'; i++) {
  if (m2.turn === 0) { game.endTurn(m2); continue; }
  const before = m2.events.length;
  const it = bot.botTurnSteps(m2, SEED_CARDS);
  let steps = 0, r2;
  while (!(r2 = it.next()).done) { steps++; assert.ok(['play', 'attack'].includes(r2.value)); }
  if (steps > 1) { console.log(`✅ Le bot a joué son tour en ${steps} étapes visibles.`); break; }
}
console.log('\n✅ Journal de combat et tour du bot validés.');

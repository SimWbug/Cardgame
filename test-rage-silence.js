/* Rage (+ATQ tant que blessé) et Silence (retire tous les effets) */
const assert = require('assert');
const game = require('./src/game');
const { SEED_CARDS } = require('./src/cards');
const base = SEED_CARDS.find(c => c.type === 'minion' && !c.charge);
const rager = Object.assign({}, base, { id: 'rage-t', name: 'Enragé', attack: 2, health: 5, rage: 2, cost: 1 });
const silence = { id: 'sil-t', name: 'Chut', type: 'sort', cost: 0, rarity: 'commun', effectType: 'silence' };
const pool = SEED_CARDS.concat([rager, silence]);
const deck = Array(30).fill(base.id);
const m = game.createMatch('rs', { slug: 'a', pseudo: 'A', deck }, { slug: 'b', pseudo: 'B', deck });
if (m.phase === 'mulligan') { game.submitMulligan(m, 0, []); game.submitMulligan(m, 1, []); }
const pi = m.turn, me = m.players[pi], opp = m.players[1 - pi];

// Rage
const r = game.createMinionFrom(rager); opp.board.push(r);
const a = game.createMinionFrom(Object.assign({}, base, { attack: 1, health: 9 })); a.canAttack = true; a.sickness = false; me.board.push(a);
assert.ok(game.attack(m, pi, a.instanceId, 'minion', r.instanceId).ok);
assert.strictEqual(r.health, 4); assert.strictEqual(r.attack, 4, 'blessé : +2 ATQ');
r.health = r.maxHealth; game.recomputeAuras(m);
assert.strictEqual(r.attack, 2, 'soigné : le bonus disparaît');
console.log('✅ Rage : +2 ATQ tant que blessé, retiré une fois soigné.');

// Silence sur un serviteur bourré d'effets
r.health = 3; game.recomputeAuras(m); assert.strictEqual(r.attack, 4);
Object.assign(r, { taunt: true, shield: true, windfury: true, standing: true, standLevel: 2, drEffect: 'draw', drValue: 1, auraAttack: 1, asleep: true, asleepTurns: 2 });
r.maxHealth = 7; // bonus de PV reçus
me.hand.push('sil-t'); me.mana = 10;
const res = game.playCard(m, pool, pi, 'sil-t', { targetType: 'minion', targetId: r.instanceId });
assert.ok(res.ok, JSON.stringify(res));
assert.ok(!r.taunt && !r.shield && !r.windfury && !r.standing && !r.drEffect && !r.auraAttack && !r.asleep && !r.rage);
assert.strictEqual(r.attack, 2, 'ATQ de la carte, plus de Rage'); assert.strictEqual(r.maxHealth, 5); assert.strictEqual(r.health, 3, 'les dégâts restent');
assert.ok(r.silenced);
assert.ok(m.events.some(e => e.type === 'silence'));
console.log('✅ Silence : mots-clés, Râle, aura, endormissement et bonus retirés ; dégâts conservés.');

// Un serviteur camouflé ennemi ne peut pas être ciblé
const hidden = game.createMinionFrom(Object.assign({}, base, { stealth: true })); opp.board.push(hidden);
me.hand.push('sil-t');
assert.ok(game.playCard(m, pool, pi, 'sil-t', { targetType: 'minion', targetId: hidden.instanceId }).error);
console.log('✅ Silence : impossible de viser un serviteur camouflé adverse.');

// Silence en cri de guerre (cible choisie) et en Râle d'agonie (cible au hasard)
{
  const bc = Object.assign({}, base, { id: 'bc-sil', name: 'Bâillon', cost: 0, bcEffect: 'silence' });
  const dr = Object.assign({}, base, { id: 'dr-sil', name: 'Muet', cost: 0, attack: 1, health: 1, drEffect: 'silence', drValue: 1 });
  const pool2 = pool.concat([bc, dr]);
  const m2 = game.createMatch('rs2', { slug: 'a', pseudo: 'A', deck }, { slug: 'b', pseudo: 'B', deck });
  if (m2.phase === 'mulligan') { game.submitMulligan(m2, 0, []); game.submitMulligan(m2, 1, []); }
  const p2 = m2.turn, me2 = m2.players[p2], op2 = m2.players[1 - p2];
  const tank = game.createMinionFrom(Object.assign({}, base, { taunt: true, shield: true })); op2.board.push(tank);
  me2.hand.push('bc-sil'); me2.mana = 10;
  assert.ok(game.playCard(m2, pool2, p2, 'bc-sil', { targetType: 'minion', targetId: tank.instanceId }).ok);
  assert.ok(!tank.taunt && !tank.shield, 'cri de guerre Silence appliqué');
  const tank2 = game.createMinionFrom(Object.assign({}, base, { taunt: true, health: 20 })); op2.board.push(tank2);
  const muet = game.createMinionFrom(dr); muet.canAttack = true; muet.sickness = false; me2.board.push(muet);
  const before = m2.events.filter(e => e.type === 'silence').length;
  assert.ok(game.attack(m2, p2, muet.instanceId, 'minion', tank2.instanceId).ok);
  assert.ok(m2.events.filter(e => e.type === 'silence').length > before, "Râle d'agonie Silence déclenché");
  console.log("✅ Silence : en cri de guerre (cible choisie) et en Râle d'agonie (cible au hasard).");
}
console.log('\n✅ Rage et Silence validés.');

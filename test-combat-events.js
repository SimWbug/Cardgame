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

// ---------- Daltonisme : la cible peut changer au hasard ----------
{
  const m3 = game.createMatch('cb', { slug: 'a', pseudo: 'A', deck }, { slug: 'b', pseudo: 'B', deck });
  if (m3.phase === 'mulligan') { game.submitMulligan(m3, 0, []); game.submitMulligan(m3, 1, []); }
  const me3 = m3.players[m3.turn], op3 = m3.players[1 - m3.turn];
  const cb = Object.assign(mk('cb', 4, 6), { colorblind: true, colorblindChance: 100 });
  me3.board.push(cb, mk('ally', 1, 9)); op3.board.push(mk('foe', 1, 9));
  const seq = [0.0, 0.99]; // 1er tirage : déclenche ; 2e : choisit le dernier de la liste (l'allié)
  m3.rng = () => seq.shift();
  const hp0 = me3.heroHealth;
  assert.ok(game.attack(m3, m3.turn, 'cb', 'hero', null).ok);
  const ev = m3.events.filter(x => x.type === 'colorblind').pop();
  assert.ok(ev, 'événement Daltonisme');
  assert.strictEqual(ev.target.id, 'ally', 'la cible tirée au sort est un allié');
  assert.strictEqual(me3.board.find(x => x.instanceId === 'ally').health, 5, "l'allié encaisse les 4 dégâts");
  assert.strictEqual(me3.heroHealth, hp0, 'le héros n\'est pas touché ici');
  console.log('✅ Daltonisme : le serviteur peut frapper un allié tiré au sort.');
  // Chance de 1 % jamais déclenchée avec un tirage haut : attaque normale
  const m4 = game.createMatch('cb2', { slug: 'a', pseudo: 'A', deck }, { slug: 'b', pseudo: 'B', deck });
  if (m4.phase === 'mulligan') { game.submitMulligan(m4, 0, []); game.submitMulligan(m4, 1, []); }
  const me4 = m4.players[m4.turn], op4 = m4.players[1 - m4.turn];
  me4.board.push(Object.assign(mk('cb', 3, 3), { colorblind: true, colorblindChance: 1 }));
  m4.rng = () => 0.5;
  const ohp = op4.heroHealth;
  assert.ok(game.attack(m4, m4.turn, 'cb', 'hero', null).ok);
  assert.strictEqual(op4.heroHealth, ohp - 3, 'sans déclenchement, la cible choisie est frappée');
  console.log('✅ Daltonisme : sans déclenchement, l\'attaque vise bien la cible choisie.');
}

// ---------- Deux effets en un : modifier l'ATQ et les PV ----------
{
  const spell = { id: 'mod', name: 'Mutation', type: 'sort', cost: 1, effectType: 'modify_stats', value: 2, value2: -1, rarity: 'rare' };
  const pool2 = SEED_CARDS.concat([spell]);
  const m5 = game.createMatch('mod', { slug: 'a', pseudo: 'A', deck }, { slug: 'b', pseudo: 'B', deck });
  if (m5.phase === 'mulligan') { game.submitMulligan(m5, 0, []); game.submitMulligan(m5, 1, []); }
  const me5 = m5.players[m5.turn];
  me5.board.push(mk('t', 3, 4)); me5.hand.push('mod'); me5.mana = 5;
  assert.ok(game.playCard(m5, pool2, m5.turn, 'mod', { targetType: 'minion', targetId: 't' }).ok);
  const t = me5.board.find(x => x.instanceId === 't');
  assert.strictEqual(t.attack, 5); assert.strictEqual(t.health, 3);
  const ev = m5.events.filter(x => x.type === 'modify').pop();
  assert.ok(ev && ev.targets[0].atk === 2 && ev.targets[0].hp === -1);
  console.log("✅ Un sort peut retirer des PV et donner de l'ATQ en même temps (+2 ATQ, -1 PV).");
  const spell2 = Object.assign({}, spell, { id: 'mod2', value: -1, value2: 3 });
  me5.hand.push('mod2');
  assert.ok(game.playCard(m5, pool2.concat([spell2]), m5.turn, 'mod2', { targetType: 'minion', targetId: 't' }).ok);
  assert.strictEqual(t.attack, 4); assert.strictEqual(t.health, 6); assert.strictEqual(t.maxHealth, 6);
  console.log("✅ …ou retirer de l'ATQ et donner des PV (-1 ATQ, +3 PV).");
  const kill = Object.assign({}, spell, { id: 'mod3', value: 0, value2: -10 });
  me5.hand.push('mod3');
  assert.ok(game.playCard(m5, pool2.concat([kill]), m5.turn, 'mod3', { targetType: 'minion', targetId: 't' }).ok);
  assert.ok(!me5.board.find(x => x.instanceId === 't'), 'des PV à 0 détruisent le serviteur');
  console.log('✅ Des PV qui tombent à 0 détruisent le serviteur.');
}

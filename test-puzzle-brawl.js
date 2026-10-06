/* Puzzle du jour, Bagarre de la semaine, cartes brillantes (côté moteur et serveur) */
const assert = require('assert');
const game = require('./src/game');
const pz = require('./src/puzzle');
const brawl = require('./src/brawl');
const mm = require('./src/matchmaking');
const { SEED_CARDS, COPY_LIMITS } = require('./src/cards');
const pool = SEED_CARDS.filter(c => !c.unobtainable);

// ---- Puzzle : chaque puzzle fabriqué a une solution, et attaquer la tête ne suffit pas
let made = 0;
for (let d = 1; d <= 12; d++) {
  const key = '2026-11-' + String(d).padStart(2, '0');
  const p = pz.generate(pool, key);
  if (!p) continue;
  made++;
  const again = pz.generate(pool, key);
  assert.deepStrictEqual(again.oppHp, p.oppHp, 'même puzzle toute la journée');
  const m = pz.freshMatch(p, pool, p.oppHp);
  const res = pz.solve(m, pool);
  assert.ok(res.best <= 0, `${key} : le puzzle a une solution`);
  assert.ok(pz.naiveDamage(m, pool) < p.oppHp, `${key} : attaquer la tête ne suffit pas`);
  assert.ok(p.solution.length === p.steps && p.steps >= 3);
}
assert.ok(made >= 8, 'au moins 8 puzzles sur 12 jours (' + made + ')');
console.log(`✅ ${made} puzzles fabriqués sur 12 jours : tous ont une solution, aucun ne se gagne en attaquant simplement la tête.`);

// ---- Puzzle : réussite, série, récompense une seule fois par jour, solution dévoilée = pas de récompense
pz._reset();
const day1 = Date.parse('2026-11-03T10:00:00Z'), day2 = Date.parse('2026-11-04T10:00:00Z');
const u = { slug: 'zoe' };
pz.today(pool, day1);
let r = pz.recordSolve(u, day1);
assert.ok(r.first && r.reward && r.streak === 1 && r.rank === 1);
assert.strictEqual(pz.recordSolve(u, day1).first, false, 'une seule récompense par jour');
pz.today(pool, day2);
pz.reveal(u, day2);
r = pz.recordSolve(u, day2);
assert.ok(r.first && r.reward === null && r.revealed && r.streak === 2, 'solution vue : réussite comptée, sans récompense');
const v = pz.view(u, pool, day2);
assert.strictEqual(v.solvers, 1); assert.ok(v.solution && v.solution.length);
console.log('✅ Puzzle : récompense à la 1re réussite du jour, série de jours, solution dévoilée = pas de récompense.');

// ---- Puzzle en vrai combat : finir son tour = raté ; la solution gagne
const p0 = pz.generate(pool, '2026-11-05');
{
  const sock = { id: 'pz1', connected: true, data: {}, got: [], emit(ev, x) { this.got.push([ev, x]); } };
  const io = { emit() {} };
  const id = mm.startBotMatch(sock, { slug: 'zoe', pseudo: 'Zoé', deck: [] }, { slug: 'bot', pseudo: 'Puzzle', deck: [] }, SEED_CARDS, io, null, { puzzle: { day: 'x' } });
  const e = mm.getEntry(id);
  pz.install(e.match, p0, SEED_CARDS);
  assert.strictEqual(e.match.players[1].heroHealth, p0.oppHp);
  assert.strictEqual(e.match.phase, 'active');
  mm.failPuzzle(e);
  assert.ok(e.match.status === 'finished' && e.match.winner === null && e.match.forfeitBy === 'zoe', 'tour fini sans gagner = raté (défaite)');
  mm.cleanupMatch(id);
}
console.log('✅ Puzzle : finir son tour sans gagner termine le puzzle (raté).');

// ---- Bagarre : la règle change chaque lundi et fait le tour de toutes les règles
const seen = new Set();
for (let w = 0; w < brawl.RULES.length; w++) {
  const key = new Date(Date.parse('2026-10-05T00:00:00Z') + w * 7 * 86400000).toISOString().slice(0, 10);
  seen.add(brawl.ruleFor(key).id);
}
assert.strictEqual(seen.size, brawl.RULES.length, 'toutes les règles passent une fois');
assert.strictEqual(brawl.ruleFor('2026-10-05', 'geants').id, 'geants', 'règle imposée par l\'admin');
const own = Array(30).fill(0).map((_, i) => pool[i % pool.length].id);
const botFn = () => own.slice();
const d15 = brawl.decksFor(brawl.RULES.find(x => x.id === 'mini'), own, pool, COPY_LIMITS, botFn);
assert.ok(d15.player.length === 15 && d15.bot.length === 15, 'mini-decks de 15 cartes');
const dc = brawl.decksFor(brawl.RULES.find(x => x.id === 'sources'), own, pool, COPY_LIMITS, botFn);
assert.ok(dc.player.length === 30 && dc.player.every(id => pool.find(c => c.id === id).rarity === 'commun'), 'que des communes');
const dr = brawl.decksFor(brawl.RULES.find(x => x.id === 'lourd'), own, pool, COPY_LIMITS, botFn);
assert.ok(dr.player.length === 30 && dr.player.every(id => pool.find(c => c.id === id).rarity !== 'commun'), 'que des rares et mieux');
// Récompenses : booster à la 1re victoire de la semaine, puis poussière (plafonnée)
const bu = {};
const now = Date.parse('2026-10-06T10:00:00Z');
assert.strictEqual(brawl.recordResult(bu, false, now).reward, null);
assert.ok(brawl.recordResult(bu, true, now).reward.first);
let dust = 0; for (let i = 0; i < 10; i++) { const x = brawl.recordResult(bu, true, now); if (x.reward) dust += x.reward.dust; }
assert.strictEqual(dust, brawl.DUST_PER_WIN * brawl.DUST_WINS_MAX, 'poussière plafonnée');
assert.ok(brawl.recordResult(bu, true, Date.parse('2026-10-13T10:00:00Z')).reward.first, 'nouvelle semaine : nouveau booster');
console.log('✅ Bagarre : une règle par semaine (toutes y passent), decks selon la règle, booster à la 1re victoire, poussière plafonnée.');

// ---- Moteur : coût -1 (Braderie) et héros à 50 PV (un soin ne les ramène pas à 30)
{
  const minion = pool.find(c => c.type === 'minion' && c.cost >= 2 && !c.bcEffect);
  const m = game.createMatch('t', { slug: 'a', pseudo: 'A', deck: Array(30).fill(minion.id) }, { slug: 'b', pseudo: 'B', deck: Array(30).fill(minion.id) });
  m.costMod = -1;
  game.submitMulligan(m, 0, []); game.submitMulligan(m, 1, []);
  m.players[0].mana = minion.cost - 1;
  assert.ok(game.playCard(m, pool, 0, minion.id, {}).ok, 'la carte coûte 1 de moins');
  assert.strictEqual(m.players[0].mana, 0);
  const red = game.redactStateFor(m, pool, 0);
  assert.ok(red.you.hand.every(c => c.cost === Math.max(0, c.baseCost - 1)), 'la main affiche le coût réduit');
  const heal = pool.find(c => c.type !== 'minion' && c.effectType === 'heal');
  if (heal) {
    const m2 = game.createMatch('t2', { slug: 'a', pseudo: 'A', deck: [heal.id, heal.id, heal.id, heal.id] }, { slug: 'b', pseudo: 'B', deck: [] });
    game.submitMulligan(m2, 0, []); game.submitMulligan(m2, 1, []);
    m2.players[0].heroHealth = 45; m2.players[0].heroMaxHealth = 50; m2.players[0].mana = 10;
    assert.ok(game.playCard(m2, pool, 0, heal.id, { targetType: 'hero' }).ok);
    assert.ok(m2.players[0].heroHealth > 45 && m2.players[0].heroHealth <= 50, 'soin plafonné à 50, sans retomber à 30');
  }
}
console.log('✅ Moteur : cartes à -1 mana et héros à 50 PV (les soins ne font plus baisser les PV au-delà de 30).');

// ---- Un combat enchaîné ne perd pas son lien quand l'ancien combat est nettoyé
{
  const deck = Array(30).fill(pool.find(c => c.type === 'minion').id);
  const s = { id: 'chain', connected: true, data: {}, emit() {} }, io = { emit() {} };
  const a = mm.startBotMatch(s, { slug: 'cc', pseudo: 'C', deck }, { slug: 'bot', pseudo: 'B', deck }, SEED_CARDS, io, null, {});
  const ea = mm.getEntry(a); ea.match.status = 'finished'; ea.match.winner = 'bot';
  const b = mm.startBotMatch(s, { slug: 'cc', pseudo: 'C', deck }, { slug: 'bot', pseudo: 'B', deck }, SEED_CARDS, io, null, {});
  mm.cleanupMatch(a);
  assert.strictEqual((mm.getMatchForSocket(s) || {}).matchId, b, 'le nouveau combat reste jouable');
  mm.cleanupMatch(b);
}
console.log('✅ Enchaîner deux combats (manche suivante, réessayer…) : le nouveau combat reste jouable après le nettoyage de l\'ancien.');
process.exit(0);

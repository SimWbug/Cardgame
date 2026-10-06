/* Mode Draft : choix 1 parmi 3, limites d'exemplaires, entrée gratuite du jour, fin à 3 défaites, récompenses */
const assert = require('assert');
const dr = require('./src/draft');
const { SEED_CARDS, COPY_LIMITS } = require('./src/cards');
let seed = 7; const rng = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const pool = SEED_CARDS.filter(c => !c.unobtainable);
const user = { credits: 1000, stats: {} };
const now = Date.parse('2026-10-06T10:00:00Z');

let r = dr.start(user, pool, COPY_LIMITS, { rng, now });
assert.ok(r.ok && r.free, 'première entrée du jour gratuite');
assert.strictEqual(user.credits, 1000);
assert.ok(dr.start(user, pool, COPY_LIMITS, { rng, now }).error, 'un seul Draft à la fois');
const byId = id => pool.find(c => c.id === id);
for (let i = 0; i < 30; i++) {
  const offer = user.draft.run.offer;
  assert.strictEqual(new Set(offer).size, 3, 'trois cartes différentes');
  if (dr.SPECIAL_PICKS.includes(i + 1)) assert.ok(offer.every(id => byId(id).rarity !== 'commun'), `choix spécial ${i + 1} sans carte commune`);
  assert.ok(dr.pick(user, 'carte-inexistante', pool, COPY_LIMITS, rng).error, 'carte hors choix refusée');
  assert.ok(dr.pick(user, offer[i % 3], pool, COPY_LIMITS, rng).ok);
}
assert.strictEqual(user.draft.run.picks.length, 30);
assert.strictEqual(user.draft.run.offer, null);
const count = {}; user.draft.run.picks.forEach(id => { count[id] = (count[id] || 0) + 1; });
Object.entries(count).forEach(([id, n]) => assert.ok(n <= (COPY_LIMITS[byId(id).rarity] || 2), 'limite d\'exemplaires respectée : ' + id));
assert.ok(dr.pick(user, pool[0].id, pool, COPY_LIMITS, rng).error, 'deck complet');
console.log('✅ 30 choix de 1 carte parmi 3, choix spéciaux rares, limites d\'exemplaires respectées.');

assert.ok(!dr.recordResult(user, true, now).over);
assert.ok(!dr.recordResult(user, false, now).over);
assert.ok(!dr.recordResult(user, true, now).over);
assert.ok(!dr.recordResult(user, false, now).over);
const end = dr.recordResult(user, false, now);
assert.ok(end.over && end.wins === 2 && end.losses === 3, 'fin à 3 défaites');
assert.deepStrictEqual(end.rewards, dr.rewardsFor(2));
assert.strictEqual(user.draft.best, 2); assert.strictEqual(user.draft.run, null);
console.log('✅ Le Draft s\'arrête à 3 défaites, avec les récompenses et le record.');

// Deuxième entrée du jour : payante
r = dr.start(user, pool, COPY_LIMITS, { rng, now });
assert.ok(r.ok && !r.free); assert.strictEqual(user.credits, 1000 - dr.ENTRY_PRICE);
// Abandon avant la fin du deck : entrée rendue
const ab = dr.abandon(user, now);
assert.strictEqual(ab.refunded, dr.ENTRY_PRICE); assert.strictEqual(user.credits, 1000);
const poor = { credits: 10, stats: {}, draft: { freeDay: dr.dayKey(now) } };
assert.ok(dr.start(poor, pool, COPY_LIMITS, { rng, now }).error, 'pas assez de crédits');
assert.ok(dr.start(poor, pool, COPY_LIMITS, { rng, now: now + 86400000 }).ok, 'le lendemain, à nouveau gratuit');
console.log('✅ Une entrée gratuite par jour, puis payante ; abandon avant la fin du deck = entrée rendue.');

// 12 victoires : fin, 3 boosters et le titre
const champ = { credits: 0, stats: {} };
dr.start(champ, pool, COPY_LIMITS, { rng, now });
for (let i = 0; i < 30; i++) dr.pick(champ, champ.draft.run.offer[0], pool, COPY_LIMITS, rng);
let last; for (let i = 0; i < 12; i++) last = dr.recordResult(champ, true, now);
assert.ok(last.over && last.rewards.boosters === 3 && last.rewards.title, '12 victoires : fin et grosses récompenses');
// Abandon en cours de combats : récompenses des victoires obtenues
const mid = { credits: 0, stats: {} };
dr.start(mid, pool, COPY_LIMITS, { rng, now });
for (let i = 0; i < 30; i++) dr.pick(mid, mid.draft.run.offer[1], pool, COPY_LIMITS, rng);
for (let i = 0; i < 4; i++) dr.recordResult(mid, true, now);
const stop = dr.abandon(mid, now);
assert.deepStrictEqual(stop.rewards, dr.rewardsFor(4));
assert.ok(dr.botConfig(9).quality > dr.botConfig(0).quality, 'le bot devient plus fort');
assert.strictEqual(dr.leaderboard([champ, mid, user])[0].best, 12);
console.log('✅ 12 victoires = 3 boosters + titre ; s\'arrêter en route donne les récompenses gagnées ; classement OK.');

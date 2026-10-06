/* Vitrine du jour : tirage stable sur la journée, renouvelé à minuit (heure de Paris) */
const assert = require('assert');
const sc = require('./src/showcase');
const banners = require('./src/banners');
const { SEED_EMOTES } = require('./src/cards');
const ctx = {
  extensions: [{ id: 'base', name: 'Base', boosterCreditPrice: 100 }, { id: 'x2', name: 'Ext 2', boosterDustPrice: 80 }, { id: 'vide', name: 'Vide', boosterCreditPrice: 50 }, { id: 'cachee', name: 'Cachée', hidden: true, boosterCreditPrice: 50 }],
  cardPool: [{ id: 'a', extensionId: 'base' }, { id: 'b', extensionId: 'x2' }, { id: 'c', extensionId: 'cachee' }],
  banners: banners.BANNERS, emotes: SEED_EMOTES || []
};
// Minuit à Paris, en hiver (UTC+1) et en été (UTC+2)
assert.strictEqual(new Date(sc.endsAt(Date.parse('2026-01-15T12:00:00Z'))).toISOString(), '2026-01-15T23:00:00.000Z');
assert.strictEqual(new Date(sc.endsAt(Date.parse('2026-07-15T12:00:00Z'))).toISOString(), '2026-07-15T22:00:00.000Z');
assert.strictEqual(new Date(sc.endsAt(Date.parse('2026-07-15T22:30:00Z'))).toISOString(), '2026-07-16T22:00:00.000Z', 'après minuit Paris : jour suivant');
// Jours de changement d'heure
assert.strictEqual(new Date(sc.endsAt(Date.parse('2026-03-29T10:00:00Z'))).toISOString(), '2026-03-29T22:00:00.000Z');
assert.strictEqual(new Date(sc.endsAt(Date.parse('2026-10-25T10:00:00Z'))).toISOString(), '2026-10-25T23:00:00.000Z');
console.log('✅ La vitrine se renouvelle à minuit, heure de Paris (été comme hiver).');

const a = sc.forDay('2026-10-06', ctx), b = sc.forDay('2026-10-06', ctx);
assert.deepStrictEqual(a, b, 'même vitrine toute la journée');
assert.deepStrictEqual(a.map(s => s.slot), ['booster', 'banner', 'emote']);
const boosterIds = new Set();
for (let i = 1; i <= 60; i++) {
  const day = '2026-11-' + String((i % 28) + 1).padStart(2, '0') + (i > 28 ? 'b' : '');
  const v = sc.forDay(day, ctx);
  boosterIds.add(v[0].id);
  assert.ok(['base', 'x2'].includes(v[0].id), 'pas de booster vide ou caché');
  v.forEach(s => assert.ok(s.price < s.basePrice && s.price > 0, 'prix remisé'));
  assert.strictEqual(banners.byId(v[1].id).source, 'shop', 'uniquement des bannières de boutique');
  assert.ok(v[2].basePrice > 0, 'pas de provocation gratuite');
}
assert.strictEqual(boosterIds.size, 2, 'la vitrine varie selon les jours');
assert.strictEqual(sc.forDay('2026-10-06', ctx)[0].currency === 'credits' ? 'base' : 'x2', sc.forDay('2026-10-06', ctx)[0].id);
assert.deepStrictEqual(sc.forDay('2026-10-06', { extensions: [], cardPool: [], banners: [], emotes: [] }), [], 'vitrine vide sans articles');
console.log('✅ Un booster, une bannière et une provocation, remisés, identiques pour la journée.');

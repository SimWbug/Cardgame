/* Paris des spectateurs : mises, fermeture, partage des gains, remboursements */
const assert = require('assert');
const bets = require('./src/bets');
bets._reset();
const match = { id: 'm1', status: 'active', turnNumber: 1, winner: null, players: [{ slug: 'a', pseudo: 'A' }, { slug: 'b', pseudo: 'B' }] };
const u = (slug, credits) => ({ slug, pseudo: slug.toUpperCase(), credits, stats: {} });
const x = u('x', 1000), y = u('y', 1000), z = u('z', 1000), pa = u('a', 1000);
assert.ok(bets.place(pa, match, 'a', 50).error, 'un joueur ne parie pas sur son propre combat');
assert.ok(bets.place(x, match, 'q', 50).error, 'il faut choisir un des deux joueurs');
assert.ok(bets.place(x, match, 'a', 5).error && bets.place(x, match, 'a', 9999).error, 'mise bornée');
assert.ok(bets.place(x, match, 'a', 100).ok && x.credits === 900, 'la mise est débitée');
assert.ok(bets.place(x, match, 'b', 50).error, 'un seul pari par combat');
assert.ok(bets.place(y, match, 'a', 50).ok && bets.place(z, match, 'b', 60).ok);
assert.deepStrictEqual(bets.poolsOf('m1').pools, { a: 150, b: 60 });
match.turnNumber = 5;
assert.ok(bets.place(u('w', 100), match, 'a', 20).error, 'paris fermés après le tour limite');
match.status = 'finished'; match.winner = 'a';
const pay = bets.settle('m1', match);
const of = s => pay.find(p => p.slug === s);
assert.strictEqual(of('x').payout, 100 + 40, 'gagnant : mise + part des mises perdantes (100/150 de 60)');
assert.strictEqual(of('y').payout, 50 + 20);
assert.strictEqual(of('z').payout, 0);
assert.strictEqual(bets.settle('m1', match).length, 0, 'réglé une seule fois');
// Personne en face : remboursement
const m2 = { id: 'm2', status: 'active', turnNumber: 1, players: match.players };
bets.place(u('q', 500), m2, 'a', 40);
m2.status = 'finished'; m2.winner = 'b';
assert.ok(bets.settle('m2', m2)[0].refund, 'pas de perdants en face : mise rendue');
// Combat qui disparaît sans fin : remboursement
const m3 = { id: 'm3', status: 'active', turnNumber: 1, players: match.players };
bets.place(u('r', 500), m3, 'b', 30);
assert.strictEqual(bets.refundAll('m3')[0].payout, 30);
// Abandon : le vainqueur est l'autre joueur
const m4 = { id: 'm4', status: 'active', turnNumber: 1, players: match.players };
const g = u('g', 500), h = u('h', 500);
bets.place(g, m4, 'a', 100); bets.place(h, m4, 'b', 100);
m4.status = 'finished'; m4.winner = null; m4.forfeitBy = 'b';
assert.strictEqual(bets.settle('m4', m4).find(p => p.slug === 'g').payout, 200, 'abandon de B : les paris sur A gagnent');
console.log('✅ Paris des spectateurs : mises bornées, fermeture au tour 4, partage des mises perdantes, remboursements.');

/* Tournoi : inscriptions, arbre avec exempts, système « prêt », vainqueur */
const assert = require('assert');
const T = require('./src/tournament');

if (T.get().current) T.cancel();
assert.ok(T.create({ name: 'Coupe test', desc: '', rewardOrnamentId: 'orn-x' }).ok);
assert.ok(T.create({ name: 'Doublon' }).error, 'un seul tournoi à la fois');
['a', 'b', 'c'].forEach(s => assert.ok(T.register({ slug: s, pseudo: s.toUpperCase() }).ok));
assert.ok(T.register({ slug: 'a', pseudo: 'A' }).error, 'pas de double inscription');
assert.ok(T.start(true).error, 'minimum 4 joueurs');
['d', 'e'].forEach(s => T.register({ slug: s, pseudo: s.toUpperCase() }));
assert.ok(T.start(true).ok);
let t = T.get().current;
assert.strictEqual(t.rounds.length, 3, '5 joueurs → arbre de 8 : quarts, demies, finale');
assert.strictEqual(t.rounds[0].filter(m => m.bye).length, 3, 'trois exempts qualifiés d\'office');
assert.strictEqual(t.rounds[0].filter(m => m.a && m.b).length, 1, 'un seul vrai match au premier tour');
console.log('✅ Arbre : 5 inscrits → 3 exempts qualifiés d\'office, 1 vrai match.');

// Système « prêt » : le combat ne se lance que quand les deux sont prêts
const first = t.rounds[0].find(m => m.a && m.b);
let r = T.setReady(first.a, true);
assert.ok(r.ok && !r.bothReady);
r = T.setReady(first.b, true);
assert.ok(r.bothReady, 'les deux prêts → lancement');
T.markPlaying(first.id, 'game-1');
assert.ok(T.reportWinner('game-1', first.b).ok, 'le résultat du combat fait avancer le vainqueur');
t = T.get().current;
assert.ok(t.rounds[1].some(m => m.a === first.b || m.b === first.b));
console.log('✅ « Prêt » des deux joueurs puis victoire : le vainqueur passe au tour suivant.');

// On joue tout jusqu'au champion
let guard = 0;
while (t.status === 'running' && guard++ < 10) {
  const m = t.rounds.flat().find(x => !x.winner && x.a && x.b);
  T.reportWinner(m.id, m.a);
  t = T.get().current;
}
assert.strictEqual(t.status, 'finished'); assert.ok(t.champion);
console.log('✅ Le tournoi se termine avec un champion.');
T.archive();
assert.strictEqual(T.get().current, null); assert.strictEqual(T.get().history[0].champion, t.champion);
console.log('\n✅ Tournoi validé.');

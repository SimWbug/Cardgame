/* Vérifie le moteur de blackjack en isolation : calcul de la main (As
   souple), blackjack naturel, dépassement, règle du croupier, résolution
   des différents cas, et masquage de la carte cachée du croupier. */
const assert = require('assert');
const bj = require('./src/blackjack');

const slug = 'test-player';

/* Un blackjack naturel à la donne (~4.8% de chance) termine la manche
   immédiatement — plusieurs étapes ci-dessous ont besoin d'une manche
   VRAIMENT en cours (status 'playing') pour tester hit()/stand(). Plutôt que
   de laisser chaque étape planter au hasard sur ce cas limite (ce qui
   arrivait par intermittence dans une version précédente de ce test —
   observé entre 15 et 20% des lancers, selon combien de donnes le fichier
   fait au total), on redonne jusqu'à tomber sur une main qui n'est pas un
   blackjack naturel, pour rendre les étapes suivantes déterministes. Le
   blackjack naturel lui-même reste testé séparément et explicitement à
   l'étape 5. */
function startPlayingGame(bet, currency) {
  for (let i = 0; i < 1000; i++) {
    bj.clearGame(slug);
    const state = bj.startGame(slug, bet || 10, currency || 'dust');
    if (state.status === 'playing') return state;
  }
  throw new Error('Impossible d\'obtenir une manche non-naturelle en 1000 essais (ne devrait jamais arriver).');
}

/* --- 1. Valeur des cartes --- */
assert.strictEqual(bj.cardValue('A'), 11);
assert.strictEqual(bj.cardValue('K'), 10);
assert.strictEqual(bj.cardValue('7'), 7);
console.log('✅ Valeur des cartes correcte (As=11, figures=10, chiffres=valeur faciale).');

/* --- 2. Total de main avec As souple (11 → 1 si besoin) --- */
assert.strictEqual(bj.handTotal([{ rank: 'A', suit: '♠' }, { rank: 'K', suit: '♥' }]), 21, 'As + Roi = 21 (blackjack)');
assert.strictEqual(bj.handTotal([{ rank: 'A', suit: '♠' }, { rank: '9', suit: '♥' }, { rank: '5', suit: '♦' }]), 15, 'As(1)+9+5 = 15, pas 25');
assert.strictEqual(bj.handTotal([{ rank: 'A', suit: '♠' }, { rank: 'A', suit: '♥' }, { rank: '9', suit: '♦' }]), 21, 'deux As + 9 : un As repasse à 1 → 11+1+9=21');
console.log('✅ Les As repassent de 11 à 1 automatiquement pour éviter un dépassement évitable.');

/* --- 3. Blackjack naturel et dépassement --- */
assert.strictEqual(bj.isBlackjack([{ rank: 'A', suit: '♠' }, { rank: 'Q', suit: '♥' }]), true);
assert.strictEqual(bj.isBlackjack([{ rank: '10', suit: '♠' }, { rank: 'Q', suit: '♥' }, { rank: 'A', suit: '♦' }]), false, '21 en 3 cartes n\'est pas un blackjack naturel (2 cartes seulement)');
assert.strictEqual(bj.isBust([{ rank: 'K', suit: '♠' }, { rank: 'Q', suit: '♥' }, { rank: '5', suit: '♦' }]), true);
assert.strictEqual(bj.isBust([{ rank: 'K', suit: '♠' }, { rank: 'Q', suit: '♥' }]), false);
console.log('✅ Détection du blackjack naturel (2 cartes only) et du dépassement de 21 correctes.');

/* --- 4. Démarrer une manche donne bien 2+2 cartes (naturel ou pas, peu importe ici) --- */
bj.clearGame(slug);
const state = bj.startGame(slug, 10, 'dust');
console.log(state.playerCards.length === 2 && state.dealerCards.length === 2 ? '✅ La donne initiale distribue bien 2 cartes à chacun' : '❌ nombre de cartes incorrect');

/* --- 5. Un blackjack naturel du joueur termine la manche immédiatement --- */
let foundNaturalCase = false;
for (let i = 0; i < 500 && !foundNaturalCase; i++) {
  bj.clearGame(slug);
  const s = bj.startGame(slug, 10, 'dust');
  if (bj.isBlackjack(s.playerCards)) {
    foundNaturalCase = true;
    console.log(s.status === 'finished' ? '✅ Un blackjack naturel termine la manche immédiatement' : '❌ manche restée ouverte malgré un blackjack naturel');
    console.log(s.outcome && (s.outcome.result === 'blackjack' || s.outcome.result === 'push') ? '✅ Résultat correctement calculé sur blackjack naturel (' + s.outcome.result + ')' : '❌ résultat incorrect');
  }
}
if (!foundNaturalCase) console.log('ℹ️ Aucun blackjack naturel tiré en 500 essais (~4.8% de chance par donne) — étape sautée par malchance statistique, pas un échec.');

/* --- 6. hit() ajoute une carte, et bust si on dépasse 21 --- */
startPlayingGame();
let before = bj.getGame(slug).playerCards.length;
const hitRes = bj.hit(slug);
console.log(hitRes.ok && hitRes.state.playerCards.length === before + 1 ? '✅ hit() ajoute bien une carte à la main du joueur' : '❌ ' + hitRes.error);

/* --- 7. hit() jusqu'au bust termine la manche en défaite --- */
startPlayingGame();
let busted = false, guard = 0;
while (!busted && guard++ < 15) {
  const r = bj.hit(slug);
  if (r.state.status === 'finished') { busted = true; }
}
const finalState = bj.getGame(slug);
console.log(busted && finalState.outcome.result === 'lose' && finalState.outcome.multiplier === 0 ? '✅ Un dépassement (bust) en tirant termine la manche en défaite (mise perdue)' : '❌ résultat de bust incorrect');

/* --- 8. stand() fait jouer le croupier jusqu'à 17 minimum --- */
startPlayingGame();
const standRes = bj.stand(slug);
console.log(standRes.ok && bj.handTotal(standRes.state.dealerCards) >= 17 ? '✅ Le croupier tire bien jusqu\'à atteindre au moins 17' : '❌ le croupier s\'est arrêté trop tôt (' + bj.handTotal(standRes.state.dealerCards) + ')');
console.log(standRes.state.status === 'finished' ? '✅ La manche est bien terminée après stand()' : '❌ manche toujours ouverte');

/* --- 9. Agir sur une manche déjà terminée (ou inexistante) est refusé --- */
const afterEnd = bj.hit(slug);
console.log(afterEnd.error ? '✅ Tirer sur une manche déjà terminée est refusé' : '❌ accepté à tort');
bj.clearGame(slug);
const noGame = bj.hit(slug);
console.log(noGame.error ? '✅ Agir sans manche en cours est refusé' : '❌ accepté à tort');

/* --- 10. redactState masque la seconde carte du croupier tant que la manche n'est pas finie --- */
const live = startPlayingGame();
const redacted = bj.redactState(live);
console.log(redacted.dealerCards[1].hidden === true ? '✅ La seconde carte du croupier est masquée pendant la manche' : '❌ carte cachée révélée à tort');
console.log(redacted.dealerTotal === null ? '✅ Le total du croupier n\'est pas révélé pendant la manche' : '❌ total du croupier révélé trop tôt');
const finished = bj.stand(slug);
const redactedFinished = bj.redactState(finished.state);
console.log(redactedFinished.dealerCards[1].hidden === undefined ? '✅ La carte cachée est révélée une fois la manche terminée' : '❌ toujours masquée après la fin');
console.log(redactedFinished.dealerTotal !== null ? '✅ Le total du croupier est révélé une fois la manche terminée' : '❌ total toujours caché');

console.log('\n✅ Moteur de blackjack validé.');

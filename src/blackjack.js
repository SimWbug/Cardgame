/* ----------------------------------------------------------------------
   Blackjack (21) contre le croupier — un vrai jeu de cartes à l'ancienne
   (52 cartes, 4 couleurs), indépendant des cartes du TCG. Les parties en
   cours vivent en mémoire (une par joueur), comme les combats PvP : perdre
   une partie en cours si le serveur redémarre est un compromis acceptable,
   déjà assumé ailleurs dans l'application pour les combats.
   ---------------------------------------------------------------------- */

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

function freshShuffledDeck() {
  const deck = [];
  SUITS.forEach(s => RANKS.forEach(r => deck.push({ rank: r, suit: s })));
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function cardValue(rank) {
  if (rank === 'A') return 11;
  if (rank === 'J' || rank === 'Q' || rank === 'K') return 10;
  return Number(rank);
}

/* Total d'une main, avec les As qui repassent de 11 à 1 autant que
   nécessaire pour éviter un dépassement de 21 quand c'est possible. */
function handTotal(cards) {
  let total = cards.reduce((a, c) => a + cardValue(c.rank), 0);
  let aces = cards.filter(c => c.rank === 'A').length;
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return total;
}

function isBlackjack(cards) { return cards.length === 2 && handTotal(cards) === 21; }
function isBust(cards) { return handTotal(cards) > 21; }

/* Le croupier tire tant qu'il n'a pas au moins 17 (y compris un 17 "doux",
   c'est-à-dire obtenu grâce à un As compté pour 11 — règle courante et
   simple à appliquer : on s'arrête à la première main >= 17, sans
   distinguer 17 doux et 17 dur, pour rester lisible et prévisible). */
function playDealer(state) {
  while (handTotal(state.dealerCards) < 17) {
    state.dealerCards.push(state.deck.pop());
  }
}

/* Compare les deux mains une fois le croupier joué, et détermine à la fois
   le résultat ('win'|'lose'|'push') et le multiplicateur de gain appliqué
   à la mise (0 = mise perdue, 1 = mise rendue à l'identique — égalité,
   2 = mise doublée — victoire normale, 2.5 = blackjack naturel). */
function resolveOutcome(state) {
  const playerBJ = isBlackjack(state.playerCards);
  const playerTotal = handTotal(state.playerCards);
  const dealerTotal = handTotal(state.dealerCards);
  const dealerBJ = isBlackjack(state.dealerCards);

  if (isBust(state.playerCards)) return { result: 'lose', multiplier: 0 };
  if (playerBJ && dealerBJ) return { result: 'push', multiplier: 1 };
  if (playerBJ) return { result: 'blackjack', multiplier: 2.5 };
  if (dealerBJ) return { result: 'lose', multiplier: 0 };
  if (isBust(state.dealerCards)) return { result: 'win', multiplier: 2 };
  if (playerTotal > dealerTotal) return { result: 'win', multiplier: 2 };
  if (playerTotal < dealerTotal) return { result: 'lose', multiplier: 0 };
  return { result: 'push', multiplier: 1 };
}

const activeGames = new Map(); // userSlug -> état de la manche en cours

function startGame(userSlug, bet, currency) {
  const deck = freshShuffledDeck();
  const state = {
    deck, playerCards: [deck.pop(), deck.pop()], dealerCards: [deck.pop(), deck.pop()],
    bet, currency, status: 'playing'
  };
  if (isBlackjack(state.playerCards)) {
    // Blackjack naturel dès la donne : la manche se termine immédiatement,
    // pas besoin d'attendre une action du joueur (il ne peut de toute façon
    // plus tirer avec seulement 2 cartes à 21).
    playDealer(state); // le croupier doit quand même révéler sa main pour vérifier l'égalité
    state.status = 'finished';
    state.outcome = resolveOutcome(state);
  }
  activeGames.set(userSlug, state);
  return state;
}

function getGame(userSlug) { return activeGames.get(userSlug) || null; }

function hit(userSlug) {
  const state = activeGames.get(userSlug);
  if (!state || state.status !== 'playing') return { error: 'Aucune manche en cours.' };
  state.playerCards.push(state.deck.pop());
  if (isBust(state.playerCards)) {
    state.status = 'finished';
    state.outcome = { result: 'lose', multiplier: 0 };
  }
  return { ok: true, state };
}

function stand(userSlug) {
  const state = activeGames.get(userSlug);
  if (!state || state.status !== 'playing') return { error: 'Aucune manche en cours.' };
  playDealer(state);
  state.status = 'finished';
  state.outcome = resolveOutcome(state);
  return { ok: true, state };
}

function clearGame(userSlug) { activeGames.delete(userSlug); }

/* Représentation publique d'une manche : cache la seconde carte du croupier
   tant que la manche n'est pas terminée (comme à une vraie table). */
function redactState(state) {
  if (!state) return null;
  const dealerVisible = state.status === 'finished'
    ? state.dealerCards
    : [state.dealerCards[0], { hidden: true }];
  return {
    playerCards: state.playerCards, dealerCards: dealerVisible,
    playerTotal: handTotal(state.playerCards),
    dealerTotal: state.status === 'finished' ? handTotal(state.dealerCards) : null,
    status: state.status, bet: state.bet, currency: state.currency,
    outcome: state.outcome || null
  };
}

module.exports = {
  freshShuffledDeck, cardValue, handTotal, isBlackjack, isBust,
  startGame, getGame, hit, stand, clearGame, redactState
};

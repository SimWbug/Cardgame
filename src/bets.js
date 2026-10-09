/* ======================================================
   Paris des spectateurs
   Un spectateur mise des crédits sur l'un des deux joueurs pendant les
   premiers tours (BET_MAX_TURN). Pari mutuel : les gagnants récupèrent leur
   mise + une part des mises perdantes, au prorata. Égalité, combat annulé ou
   personne en face : chacun récupère sa mise.
   ====================================================== */
const BET_MIN = 10, BET_MAX = 500, BET_MAX_TURN = 4;
const store = new Map(); // matchId -> { bets: [{ slug, pseudo, side, amount }], sides: [slugA, slugB] }

function poolsOf(matchId) {
  const b = store.get(matchId);
  const pools = {};
  if (b) b.sides.forEach(s => { pools[s] = 0; });
  if (b) b.bets.forEach(x => { pools[x.side] = (pools[x.side] || 0) + x.amount; });
  return { pools, count: b ? b.bets.length : 0 };
}
function betOf(matchId, slug) { const b = store.get(matchId); return b ? b.bets.find(x => x.slug === slug) || null : null; }

/* user : objet joueur (crédits débités ici) ; match : le combat regardé */
function place(user, match, side, amount) {
  if (!match || match.status !== 'active') return { error: "Ce combat n'accepte plus de paris." };
  if (match.players.some(p => p.slug === user.slug)) return { error: 'Tu ne peux pas parier sur ton propre combat.' };
  if ((match.turnNumber || 0) > BET_MAX_TURN) return { error: `Les paris sont fermés après le tour ${BET_MAX_TURN}.` };
  if (!match.players.some(p => p.slug === side)) return { error: 'Choisis un des deux joueurs.' };
  const a = Math.round(Number(amount));
  if (!Number.isFinite(a) || a < BET_MIN || a > BET_MAX) return { error: `Mise entre ${BET_MIN} et ${BET_MAX} crédits.` };
  if ((user.credits || 0) < a) return { error: 'Pas assez de crédits.' };
  let b = store.get(match.id);
  if (!b) { b = { bets: [], sides: match.players.map(p => p.slug) }; store.set(match.id, b); }
  if (b.bets.some(x => x.slug === user.slug)) return { error: 'Tu as déjà parié sur ce combat.' };
  user.credits -= a;
  if (user.stats) user.stats.creditsSpent = (user.stats.creditsSpent || 0) + a;
  b.bets.push({ slug: user.slug, pseudo: user.pseudo, side, amount: a });
  return { ok: true, bet: { side, amount: a } };
}

/* Fin du combat : renvoie la liste des paiements [{ slug, stake, payout, won, refund }] */
function settle(matchId, match) {
  const b = store.get(matchId);
  if (!b) return [];
  store.delete(matchId);
  let winner = match && match.status === 'finished' ? match.winner : null;
  if (!winner && match && match.forfeitBy) winner = (match.players.find(p => p.slug !== match.forfeitBy) || {}).slug || null;
  const winPool = b.bets.filter(x => x.side === winner).reduce((s, x) => s + x.amount, 0);
  const losePool = b.bets.filter(x => winner && x.side !== winner).reduce((s, x) => s + x.amount, 0);
  return b.bets.map(x => {
    if (!winner || !winPool || !losePool) return { slug: x.slug, stake: x.amount, payout: x.amount, refund: true, won: false, side: x.side };
    if (x.side !== winner) return { slug: x.slug, stake: x.amount, payout: 0, won: false, side: x.side };
    return { slug: x.slug, stake: x.amount, payout: x.amount + Math.floor(x.amount / winPool * losePool), won: true, side: x.side };
  });
}
function refundAll(matchId) {
  const b = store.get(matchId);
  if (!b) return [];
  store.delete(matchId);
  return b.bets.map(x => ({ slug: x.slug, stake: x.amount, payout: x.amount, refund: true, won: false, side: x.side }));
}
function _reset() { store.clear(); }

module.exports = { BET_MIN, BET_MAX, BET_MAX_TURN, place, settle, refundAll, poolsOf, betOf, _reset };

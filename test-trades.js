/* Vérifie le système d'échange multi-cartes : les échanges à sens unique (don
   ou demande sans contrepartie) sont autorisés, plusieurs cartes sont
   possibles de chaque côté, et les quantités/possessions sont bien vérifiées. */
const BASE = 'http://localhost:3000';
async function reg(p) { const r = await fetch(BASE + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pseudo: p, password: 'test1234' }) }); const d = await r.json(); return { cookie: r.headers.getSetCookie().find(c => c.startsWith('connect.sid')).split(';')[0], profile: d.profile }; }
function mk(c) { return async (p, m, b) => { const r = await fetch(BASE + p, { method: m || 'GET', headers: Object.assign({ Cookie: c }, b ? { 'Content-Type': 'application/json' } : {}), body: b ? JSON.stringify(b) : undefined }); return { ok: r.ok, d: await r.json().catch(() => ({})) }; }; }
async function grantStarter(user) {
  const r = mk(user.cookie);
  await r('/api/admin/users/' + user.profile.slug + '/grant-starter', 'POST', { code: 'admin123' });
  user.profile = (await r('/api/me')).d.profile;
}

(async () => {
  let fails = 0;
  const sfx = Date.now().toString(36);
  const A = await reg('TradeA_' + sfx), B = await reg('TradeB_' + sfx);
  const rA = mk(A.cookie), rB = mk(B.cookie);
  await grantStarter(A);
  await grantStarter(B);
  const myCards = A.profile.deck.filter((v, i, arr) => arr.indexOf(v) === i); // ids uniques du deck de départ
  const theirCards = B.profile.deck.filter((v, i, arr) => arr.indexOf(v) === i);

  // 1) Offrir sans rien demander (un "cadeau" à sens unique) est autorisé
  const giftOnly = await rA('/api/trade/request', 'POST', { toSlug: B.profile.slug, offerCardIds: [myCards[0]], requestCardIds: [] });
  console.log(giftOnly.ok ? '✅ Offrir sans rien demander en retour est autorisé' : '❌ ' + giftOnly.d.error); if (!giftOnly.ok) fails++;
  if (giftOnly.ok) {
    const meBeforeGift = (await rA('/api/me')).d.profile;
    const themBeforeGift = (await rB('/api/me')).d.profile;
    const acceptGift = await rB('/api/trade/' + giftOnly.d.trade.id + '/accept', 'POST');
    console.log(acceptGift.ok ? '✅ Le receveur peut accepter un cadeau à sens unique' : '❌ ' + acceptGift.d.error);
    const meAfterGift = (await rA('/api/me')).d.profile;
    const themAfterGift = (await rB('/api/me')).d.profile;
    const senderLostIt = (meAfterGift.collection[myCards[0]] || 0) === (meBeforeGift.collection[myCards[0]] || 0) - 1;
    const receiverGotIt = (themAfterGift.collection[myCards[0]] || 0) === (themBeforeGift.collection[myCards[0]] || 0) + 1;
    console.log(senderLostIt && receiverGotIt ? '✅ La carte offerte change bien de main, sans contrepartie' : '❌ transfert du cadeau incorrect');
    if (!senderLostIt || !receiverGotIt) fails++;
  }

  // 2) Demander sans rien offrir (à sens unique dans l'autre sens) est aussi autorisé
  const beggingOnly = await rA('/api/trade/request', 'POST', { toSlug: B.profile.slug, offerCardIds: [], requestCardIds: [theirCards[0]] });
  console.log(beggingOnly.ok ? '✅ Demander sans rien offrir en retour est autorisé' : '❌ ' + beggingOnly.d.error); if (!beggingOnly.ok) fails++;

  // 3) Une proposition totalement vide (rien des deux côtés) reste refusée
  const emptyTrade = await rA('/api/trade/request', 'POST', { toSlug: B.profile.slug, offerCardIds: [], requestCardIds: [] });
  console.log(!emptyTrade.ok ? '✅ Une proposition totalement vide (rien des deux côtés) est refusée' : '❌ acceptée à tort'); if (emptyTrade.ok) fails++;

  // 4) Une proposition avec plusieurs cartes de chaque côté est acceptée
  // (offre et demande utilisent des index distincts : les deux comptes démarrent
  // avec le même deck de départ déterministe, donc myCards[0] === theirCards[0])
  const multi = await rA('/api/trade/request', 'POST', {
    toSlug: B.profile.slug,
    offerCardIds: [myCards[0], myCards[1]],
    requestCardIds: [theirCards[5], theirCards[6], theirCards[7]]
  });
  console.log(multi.ok ? '✅ Proposition multi-cartes créée (2 offertes contre 3 demandées)' : '❌ ' + multi.d.error);
  if (!multi.ok) { console.log('\n❌ Arrêt : impossible de continuer sans une proposition valide.'); process.exit(1); }
  const tradeId = multi.d.trade.id;
  console.log('  offre:', multi.d.trade.offerCards.map(c => c.name).join(', '));
  console.log('  demande:', multi.d.trade.requestCards.map(c => c.name).join(', '));

  // 5) Offrir plus d'exemplaires qu'on en possède est refusé
  const tooMany = await rA('/api/trade/request', 'POST', { toSlug: B.profile.slug, offerCardIds: [myCards[0], myCards[0], myCards[0], myCards[0], myCards[0]], requestCardIds: [theirCards[0]] });
  console.log(!tooMany.ok ? '✅ Offrir plus d\'exemplaires qu\'on en possède est refusé' : '❌ accepté à tort'); if (tooMany.ok) fails++;

  // 6) Échanger avec soi-même est refusé
  const selfTrade = await rA('/api/trade/request', 'POST', { toSlug: A.profile.slug, offerCardIds: [myCards[0]], requestCardIds: [myCards[1]] });
  console.log(!selfTrade.ok ? '✅ Échanger avec soi-même est refusé' : '❌ accepté à tort'); if (selfTrade.ok) fails++;

  // 7) Acceptation : les deux collections doivent se mettre à jour correctement
  const meBefore = (await rA('/api/me')).d.profile;
  const themBefore = (await rB('/api/me')).d.profile;
  const accept = await rB('/api/trade/' + tradeId + '/accept', 'POST');
  console.log(accept.ok ? '✅ Échange multi-cartes accepté' : '❌ ' + accept.d.error); if (!accept.ok) fails++;

  const meAfter = (await rA('/api/me')).d.profile;
  const themAfter = (await rB('/api/me')).d.profile;
  // A doit avoir perdu ses 2 cartes offertes et gagné les 3 demandées
  const aLostOffered = [myCards[0], myCards[1]].every(id => (meAfter.collection[id] || 0) === (meBefore.collection[id] || 0) - 1);
  const aGainedRequested = [theirCards[5], theirCards[6], theirCards[7]].every(id => (meAfter.collection[id] || 0) === (meBefore.collection[id] || 0) + 1);
  console.log(aLostOffered && aGainedRequested ? '✅ Le proposant perd ses cartes offertes et gagne toutes celles demandées' : '❌ collection du proposant incorrecte après échange');
  if (!aLostOffered || !aGainedRequested) fails++;

  const bLostRequested = [theirCards[5], theirCards[6], theirCards[7]].every(id => (themAfter.collection[id] || 0) === (themBefore.collection[id] || 0) - 1);
  const bGainedOffered = [myCards[0], myCards[1]].every(id => (themAfter.collection[id] || 0) === (themBefore.collection[id] || 0) + 1);
  console.log(bLostRequested && bGainedOffered ? '✅ Le receveur perd ce qui a été demandé et gagne ce qui a été offert' : '❌ collection du receveur incorrecte après échange');
  if (!bLostRequested || !bGainedOffered) fails++;

  // 8) Une carte disparue entre-temps invalide l'échange à l'acceptation (pas de duplication ni de perte)
  const req2 = await rA('/api/trade/request', 'POST', { toSlug: B.profile.slug, offerCardIds: [myCards[2]], requestCardIds: [theirCards[3]] });
  // On désenchante la carte offerte AVANT que B accepte, pour simuler sa disparition
  const dup = (await rA('/api/dust/duplicates')).d.duplicates.find(d => d.cardId === myCards[2]);
  if (dup) {
    await rA('/api/dust/disenchant', 'POST', { cardId: myCards[2], amount: dup.excess });
  }
  const stillOwns = ((await rA('/api/me')).d.profile.collection[myCards[2]] || 0) > 0;
  if (stillOwns) {
    console.log('ℹ️ Carte encore possédée après désenchantement des doublons (pas assez d\'exemplaires en trop), étape de validation tardive sautée.');
  } else {
    const accept2 = await rB('/api/trade/' + req2.d.trade.id + '/accept', 'POST');
    console.log(!accept2.ok ? '✅ Une carte disparue entre-temps invalide l\'échange à l\'acceptation' : '❌ accepté à tort malgré la carte manquante');
    if (accept2.ok) fails++;
  }

  console.log(fails === 0 ? '\n✅ Système d\'échange multi-cartes validé.' : '\n❌ ' + fails + ' échec(s)');
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('❌', e.message, e.stack); process.exit(1); });

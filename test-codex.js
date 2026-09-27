/* Vérifie le codex : suivi cumulatif des cartes débloquées, y compris
   après désenchantement ou échange, et non-fuite des cartes non découvertes. */
const BASE = 'http://localhost:3000';
async function reg(p) { const r = await fetch(BASE + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pseudo: p, password: 'test1234' }) }); const d = await r.json(); return { cookie: r.headers.getSetCookie().find(c => c.startsWith('connect.sid')).split(';')[0], profile: d.profile }; }
function mk(c) { return async (p, m, b) => { const r = await fetch(BASE + p, { method: m || 'GET', headers: Object.assign({ Cookie: c }, b ? { 'Content-Type': 'application/json' } : {}), body: b ? JSON.stringify(b) : undefined }); return { ok: r.ok, d: await r.json().catch(() => ({})) }; }; }

(async () => {
  let fails = 0;
  const A = await reg('CodexA_' + Date.now().toString(36));
  const B = await reg('CodexB_' + Date.now().toString(36));
  const rA = mk(A.cookie), rB = mk(B.cookie);

  // 1) Au départ, le codex ne montre que les cartes de départ comme découvertes
  const codex0 = (await rA('/api/codex')).d;
  const base0 = codex0.extensions.find(e => e.id === 'base');
  console.log('Découvertes au départ :', base0.discoveredCount, '/', base0.totalCards, '(' + base0.percent + '%)');
  console.log(base0.discoveredCount === Object.keys(A.profile.collection).length ? '✅ Correspond au deck de départ' : '❌ ne correspond pas');
  if (base0.discoveredCount !== Object.keys(A.profile.collection).length) fails++;

  // 2) Une carte non découverte ne révèle pas son nom/stats
  const undiscovered = base0.cards.find(c => !c.discovered);
  console.log(undiscovered && undiscovered.name === undefined ? '✅ Une carte non découverte ne fuite pas son nom/stats' : '❌ fuite de données sur une carte non découverte');
  if (!undiscovered || undiscovered.name !== undefined) fails++;

  // 3) Ouvrir un booster ajoute au codex si nouvelle carte
  let gained = null;
  for (let i = 0; i < 15 && !gained; i++) {
    const open = await rA('/api/pack/open', 'POST', { useCredits: true });
    if (!open.ok) break;
    gained = open.d.drawn.find(c => !Object.keys(A.profile.collection).includes(c.id));
  }
  const codex1 = (await rA('/api/codex')).d;
  const base1 = codex1.extensions.find(e => e.id === 'base');
  console.log(base1.discoveredCount >= base0.discoveredCount ? '✅ Le codex ne diminue jamais après un booster' : '❌ codex incohérent');
  if (gained) {
    const entry = base1.cards.find(c => c.id === gained.id);
    console.log(entry && entry.discovered ? '✅ Nouvelle carte obtenue = marquée découverte' : '❌ carte obtenue non marquée');
    if (!entry || !entry.discovered) fails++;
  }

  // 4) Désenchanter une carte NE DOIT PAS la retirer du codex
  const dupBefore = (await rA('/api/dust/duplicates')).d.duplicates[0];
  if (dupBefore) {
    await rA('/api/dust/disenchant', 'POST', { cardId: dupBefore.cardId, amount: dupBefore.excess });
    const codex2 = (await rA('/api/codex')).d;
    const entry2 = codex2.extensions.find(e => e.id === 'base').cards.find(c => c.id === dupBefore.cardId);
    console.log(entry2 && entry2.discovered ? '✅ Le codex garde la carte comme découverte après désenchantement' : '❌ retirée du codex à tort');
    if (!entry2 || !entry2.discovered) fails++;
  } else {
    console.log('ℹ️ Aucun doublon à désenchanter pour ce test (tirage), étape sautée.');
  }

  // 5) Échanger une carte : le receveur la voit apparaître dans SON codex, le donneur la garde dans le sien
  // (B n'a encore ouvert aucun booster dans ce test : on lui offre un deck de départ pour avoir de quoi échanger)
  await rB('/api/admin/users/' + B.profile.slug + '/grant-starter', 'POST', { code: 'admin123' });
  const myCards = Object.keys((await rA('/api/me')).d.profile.collection);
  const cardToTrade = myCards[0];
  const bCollection = Object.keys((await rB('/api/me')).d.profile.collection);
  const codexBBefore = (await rB('/api/codex')).d;
  const hadBefore = codexBBefore.extensions.find(e => e.id === 'base').cards.find(c => c.id === cardToTrade).discovered;

  const reqTrade = await rA('/api/trade/request', 'POST', { toSlug: B.profile.slug, offerCardIds: [cardToTrade], requestCardIds: [bCollection[0]] });
  const tradeId = reqTrade.d.trade.id;
  const accept = await rB('/api/trade/' + tradeId + '/accept', 'POST');
  console.log(accept.ok ? '✅ Échange accepté' : '❌ ' + accept.d.error);

  const codexBAfter = (await rB('/api/codex')).d;
  const hasAfter = codexBAfter.extensions.find(e => e.id === 'base').cards.find(c => c.id === cardToTrade).discovered;
  console.log((!hadBefore ? hasAfter : true) ? '✅ Le receveur débloque la carte reçue par échange dans son codex' : '❌ non débloquée pour le receveur');
  if (hadBefore === false && !hasAfter) fails++;

  const codexAAfter = (await rA('/api/codex')).d;
  const stillHasA = codexAAfter.extensions.find(e => e.id === 'base').cards.find(c => c.id === cardToTrade).discovered;
  console.log(stillHasA ? '✅ Le donneur garde la carte échangée dans son propre codex' : '❌ perdue du codex du donneur après échange');
  if (!stillHasA) fails++;

  // 6) Totaux globaux cohérents
  const codexFinal = (await rA('/api/codex')).d;
  console.log(codexFinal.totalCards > 0 && codexFinal.totalDiscovered <= codexFinal.totalCards ? '✅ Totaux globaux cohérents (' + codexFinal.totalDiscovered + '/' + codexFinal.totalCards + ')' : '❌ totaux incohérents');

  console.log(fails === 0 ? '\n✅ Codex validé.' : '\n❌ ' + fails + ' échec(s)');
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('❌', e.message, e.stack); process.exit(1); });

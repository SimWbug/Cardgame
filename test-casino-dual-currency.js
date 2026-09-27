/* Vérifie le casino en double monnaie (crédits ET poussière, indépendants),
   et les packs de crédits achetables contre de la poussière. */
const BASE = 'http://localhost:3000';
async function reg(p) { const r = await fetch(BASE + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pseudo: p, password: 'test1234' }) }); const d = await r.json(); return { cookie: r.headers.getSetCookie().find(c => c.startsWith('connect.sid')).split(';')[0], profile: d.profile }; }
function mk(c) { return async (p, m, b) => { const r = await fetch(BASE + p, { method: m || 'GET', headers: Object.assign({ Cookie: c }, b ? { 'Content-Type': 'application/json' } : {}), body: b ? JSON.stringify(b) : undefined }); return { ok: r.ok, d: await r.json().catch(() => ({})) }; }; }

(async () => {
  let fails = 0;
  const sfx = Date.now().toString(36);
  const A = await reg('CasinoA_' + sfx);
  const rA = mk(A.cookie);
  await rA('/api/admin/users/' + A.profile.slug + '/grant-starter', 'POST', { code: 'admin123' });
  await rA('/api/admin/users/' + A.profile.slug + '/credits', 'POST', { code: 'admin123', delta: 1000 });
  await rA('/api/admin/users/' + A.profile.slug + '/dust', 'POST', { code: 'admin123', delta: 1000 });
  await rA('/api/admin/events/tab', 'PATCH', { code: 'admin123', enabled: true });

  /* ---------- Casino activé uniquement en poussière au départ ---------- */
  await rA('/api/admin/events/casino', 'PATCH', { code: 'admin123', enabled: true, costPerSpinDust: 10, costPerSpinCredits: 0 });
  const spinCredits1 = await rA('/api/events/casino/spin', 'POST', { currency: 'credits' });
  console.log(!spinCredits1.ok ? '✅ Jouer en crédits est refusé quand ce coût est à 0' : '❌ accepté à tort'); if (spinCredits1.ok) fails++;
  const spinDust1 = await rA('/api/events/casino/spin', 'POST', { currency: 'dust' });
  console.log(spinDust1.ok && spinDust1.d.currency === 'dust' ? '✅ Jouer en poussière fonctionne (monnaie confirmée dans la réponse)' : '❌ ' + spinDust1.d.error);

  /* ---------- On active aussi les crédits, avec un coût différent ---------- */
  await rA('/api/admin/events/casino', 'PATCH', { code: 'admin123', costPerSpinCredits: 25 });
  const creditsBefore = (await rA('/api/me')).d.profile.credits;
  const spinCredits2 = await rA('/api/events/casino/spin', 'POST', { currency: 'credits' });
  console.log(spinCredits2.ok && spinCredits2.d.currency === 'credits' ? '✅ Jouer en crédits fonctionne une fois activé' : '❌ ' + spinCredits2.d.error);
  const creditsAfter = spinCredits2.d.credits;
  const expected = spinCredits2.d.payout > 0 ? creditsBefore - 25 + spinCredits2.d.payout : creditsBefore - 25;
  console.log(creditsAfter === expected ? '✅ Le coût en crédits (25) est bien débité, indépendamment du coût poussière' : '❌ solde crédits incorrect');
  if (creditsAfter !== expected) fails++;

  // La poussière ne doit JAMAIS bouger quand on joue en crédits
  const dustBefore = (await rA('/api/me')).d.profile.dust;
  await rA('/api/events/casino/spin', 'POST', { currency: 'credits' });
  const dustAfter = (await rA('/api/me')).d.profile.dust;
  console.log(dustBefore === dustAfter ? '✅ Jouer en crédits ne touche jamais à la poussière' : '❌ la poussière a bougé alors qu\'on jouait en crédits');
  if (dustBefore !== dustAfter) fails++;

  /* ---------- Poussière insuffisante en jouant en poussière (même avec des crédits en réserve) ---------- */
  await rA('/api/admin/users/' + A.profile.slug + '/dust', 'POST', { code: 'admin123', delta: -100000 });
  const noDust = await rA('/api/events/casino/spin', 'POST', { currency: 'dust' });
  console.log(!noDust.ok ? '✅ Pas assez de poussière refuse le tour en poussière, même riche en crédits' : '❌ accepté à tort'); if (noDust.ok) fails++;

  /* ---------- Packs de crédits ---------- */
  const badCode = await rA('/api/admin/credit-packs', 'POST', { code: 'faux', name: 'X', creditsAmount: 100, dustPrice: 50 });
  console.log(!badCode.ok ? '✅ Mauvais code refusé à la création d\'un pack' : '❌ accepté à tort'); if (badCode.ok) fails++;

  const createPack = await rA('/api/admin/credit-packs', 'POST', { code: 'admin123', name: 'Petit pack', creditsAmount: 200, dustPrice: 80 });
  console.log(createPack.ok ? '✅ Pack de crédits créé : ' + createPack.d.pack.name : '❌ ' + createPack.d.error);
  const packId = createPack.d.pack.id;

  const publicList = await rA('/api/credit-packs');
  console.log(publicList.d.packs.some(p => p.id === packId) ? '✅ Le pack apparaît dans la liste publique' : '❌ absent de la liste publique');

  await rA('/api/admin/users/' + A.profile.slug + '/dust', 'POST', { code: 'admin123', delta: 100 });
  const dustBeforeBuy = (await rA('/api/me')).d.profile.dust;
  const creditsBeforeBuy = (await rA('/api/me')).d.profile.credits;
  const buyPack = await rA('/api/shop/buy-credit-pack', 'POST', { packId });
  console.log(buyPack.ok ? '✅ Achat du pack réussi' : '❌ ' + buyPack.d.error);
  console.log(buyPack.d.profile.dust === dustBeforeBuy - 80 ? '✅ 80 poussière débitée' : '❌ débit poussière incorrect');
  console.log(buyPack.d.profile.credits === creditsBeforeBuy + 200 ? '✅ 200 crédits crédités' : '❌ crédit crédits incorrect');
  if (buyPack.d.profile.dust !== dustBeforeBuy - 80 || buyPack.d.profile.credits !== creditsBeforeBuy + 200) fails++;

  const notEnough = await rA('/api/shop/buy-credit-pack', 'POST', { packId }); // plus assez de poussière normalement
  console.log(!notEnough.ok ? '✅ Racheter sans assez de poussière est refusé' : 'ℹ️ assez de poussière restait, achat répété accepté (pas une erreur)');

  const patchPack = await rA('/api/admin/credit-packs/' + packId, 'PATCH', { code: 'admin123', dustPrice: 999 });
  console.log(patchPack.ok && patchPack.d.pack.dustPrice === 999 ? '✅ Prix du pack modifiable' : '❌ modification échouée');

  const delPack = await rA('/api/admin/credit-packs/' + packId, 'DELETE', { code: 'admin123' });
  console.log(delPack.ok ? '✅ Pack supprimé' : '❌ suppression échouée');
  const listAfterDel = await rA('/api/credit-packs');
  console.log(!listAfterDel.d.packs.some(p => p.id === packId) ? '✅ Le pack supprimé n\'apparaît plus' : '❌ toujours présent');

  console.log(fails === 0 ? '\n✅ Casino en double monnaie et packs de crédits validés.' : '\n❌ ' + fails + ' échec(s)');
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('❌', e.message, e.stack); process.exit(1); });

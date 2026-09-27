/* Vérifie l'achat groupé de plusieurs boosters d'un coup : le prix total est
   bien multiplié par la quantité, le bon nombre d'entrées est ajouté à
   l'inventaire, et un achat trop gros pour les fonds disponibles est refusé
   en bloc (aucun achat partiel). */
const BASE = 'http://localhost:3000';
async function reg(p) { const r = await fetch(BASE + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pseudo: p, password: 'test1234' }) }); const d = await r.json(); return { cookie: r.headers.getSetCookie().find(c => c.startsWith('connect.sid')).split(';')[0], profile: d.profile }; }
function mk(c) { return async (p, m, b) => { const r = await fetch(BASE + p, { method: m || 'GET', headers: Object.assign({ Cookie: c }, b ? { 'Content-Type': 'application/json' } : {}), body: b ? JSON.stringify(b) : undefined }); return { ok: r.ok, d: await r.json().catch(() => ({})) }; }; }

(async () => {
  let fails = 0;
  const A = await reg('BuyMulti_' + Date.now().toString(36));
  const rA = mk(A.cookie);
  await rA('/api/admin/users/' + A.profile.slug + '/credits', 'POST', { code: 'admin123', delta: 1000 });
  await fetch(BASE + '/api/admin/extensions/base', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'admin123', boosterCreditPrice: 50 }) });

  /* ---------- Acheter 4 d'un coup ---------- */
  const creditsBefore = (await rA('/api/me')).d.profile.credits;
  const buy = await rA('/api/shop/buy-booster', 'POST', { extensionId: 'base', currency: 'credits', quantity: 4 });
  console.log(buy.ok && buy.d.stored.length === 4 ? '✅ 4 boosters achetés en une requête (4 entrées renvoyées)' : '❌ ' + (buy.d.error || 'nombre incorrect'));
  if (!buy.ok || buy.d.stored.length !== 4) fails++;
  console.log(buy.d.profile.credits === creditsBefore - 200 ? '✅ Le prix total (50×4=200) est bien débité en une fois' : '❌ débit incorrect (' + buy.d.profile.credits + ')');
  if (buy.d.profile.credits !== creditsBefore - 200) fails++;
  console.log(buy.d.profile.boosterInventory.length === 4 ? '✅ Les 4 boosters sont bien dans l\'inventaire' : '❌ inventaire incorrect (' + buy.d.profile.boosterInventory.length + ')');
  const ids = new Set(buy.d.stored.map(s => s.id));
  console.log(ids.size === 4 ? '✅ Chaque booster acheté a un identifiant unique' : '❌ identifiants en double');

  /* ---------- Quantité au-delà de la limite (20) est plafonnée, pas refusée brutalement ---------- */
  await rA('/api/admin/users/' + A.profile.slug + '/credits', 'POST', { code: 'admin123', delta: 5000 });
  const buyTooMany = await rA('/api/shop/buy-booster', 'POST', { extensionId: 'base', currency: 'credits', quantity: 999 });
  console.log(buyTooMany.ok && buyTooMany.d.stored.length === 20 ? '✅ Une quantité excessive (999) est plafonnée à 20, pas refusée' : '❌ plafonnement incorrect (' + (buyTooMany.d.stored && buyTooMany.d.stored.length) + ')');
  if (!buyTooMany.ok || buyTooMany.d.stored.length !== 20) fails++;

  /* ---------- Fonds insuffisants pour la quantité demandée : refus total, aucun achat partiel ---------- */
  const B = await reg('BuyMultiB_' + Date.now().toString(36));
  const rB = mk(B.cookie);
  await rB('/api/admin/users/' + B.profile.slug + '/credits', 'POST', { code: 'admin123', delta: -1000 }); // remise à 0 (un nouveau compte démarre avec 100 crédits)
  await rB('/api/admin/users/' + B.profile.slug + '/credits', 'POST', { code: 'admin123', delta: 60 }); // pile assez pour 1, pas pour 3
  const invBefore = (await rB('/api/me')).d.profile.boosterInventory.length;
  const buyFail = await rB('/api/shop/buy-booster', 'POST', { extensionId: 'base', currency: 'credits', quantity: 3 });
  console.log(!buyFail.ok ? '✅ Fonds insuffisants pour la quantité demandée : achat refusé en bloc' : '❌ accepté à tort'); if (buyFail.ok) fails++;
  const invAfter = (await rB('/api/me')).d.profile.boosterInventory.length;
  console.log(invAfter === invBefore ? '✅ Aucun achat partiel : l\'inventaire n\'a pas bougé du tout' : '❌ achat partiel détecté (' + invBefore + ' → ' + invAfter + ')');
  if (invAfter !== invBefore) fails++;

  /* ---------- Sans quantité précisée, comportement par défaut = 1 (rétrocompatible) ---------- */
  const C = await reg('BuyMultiC_' + Date.now().toString(36));
  const rC = mk(C.cookie);
  await rC('/api/admin/users/' + C.profile.slug + '/credits', 'POST', { code: 'admin123', delta: 500 });
  const buyDefault = await rC('/api/shop/buy-booster', 'POST', { extensionId: 'base', currency: 'credits' });
  console.log(buyDefault.ok && buyDefault.d.stored.length === 1 ? '✅ Sans quantité précisée, un seul booster est acheté (rétrocompatible)' : '❌ comportement par défaut incorrect');

  console.log(fails === 0 ? '\n✅ Achat groupé de boosters validé.' : '\n❌ ' + fails + ' échec(s)');
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('❌', e.message, e.stack); process.exit(1); });

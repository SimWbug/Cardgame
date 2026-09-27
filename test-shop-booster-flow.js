/* Vérifie le flux complet d'achat de booster depuis la boutique (route utilisée
   par App.buyBooster côté client) : /api/shop retourne bien les boosters,
   l'achat déduit la bonne monnaie et RANGE le booster dans l'inventaire
   (il ne s'ouvre plus immédiatement — voir test-booster-inventory.js pour
   le cycle complet achat → ouverture). */
const BASE = 'http://localhost:3000';
async function reg(p) { const r = await fetch(BASE + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pseudo: p, password: 'test1234' }) }); const d = await r.json(); return { cookie: r.headers.getSetCookie().find(c => c.startsWith('connect.sid')).split(';')[0], profile: d.profile }; }
function mk(c) { return async (p, m, b) => { const r = await fetch(BASE + p, { method: m || 'GET', headers: Object.assign({ Cookie: c }, b ? { 'Content-Type': 'application/json' } : {}), body: b ? JSON.stringify(b) : undefined }); return { ok: r.ok, d: await r.json().catch(() => ({})) }; }; }

(async () => {
  let fails = 0;
  const A = await reg('ShopFlow_' + Date.now().toString(36));
  const rA = mk(A.cookie);

  const shop = (await rA('/api/shop')).d;
  console.log('Boosters listés dans /api/shop :', shop.boosters.map(b => b.name + ' (✦' + b.creditPrice + ')').join(', '));
  const base = shop.boosters.find(b => b.id === 'base');
  console.log(base ? '✅ Le booster de l\'extension de base est listé' : '❌ absent'); if (!base) fails++;
  console.log(base.cardCount > 0 ? '✅ cardCount correct (' + base.cardCount + ')' : '❌ cardCount incorrect');

  const meBefore = (await rA('/api/me')).d.profile;
  const buy = await rA('/api/shop/buy-booster', 'POST', { extensionId: 'base', currency: 'credits' });
  console.log(buy.ok && buy.d.stored ? '✅ Achat via /api/shop/buy-booster réussi (rangé dans l\'inventaire)' : '❌ ' + buy.d.error);
  if (!buy.ok) fails++;
  const meAfter = buy.d.profile;
  console.log(meAfter.credits === meBefore.credits - base.creditPrice ? '✅ Le bon montant de crédits a été déduit' : '❌ déduction incorrecte');
  if (meAfter.credits !== meBefore.credits - base.creditPrice) fails++;
  console.log(meAfter.boosterInventory.length === 1 ? '✅ Le booster est bien dans l\'inventaire, pas encore ouvert' : '❌ inventaire incorrect');

  const openInv = await rA('/api/pack/open-inventory', 'POST', { inventoryId: meAfter.boosterInventory[0].id });
  console.log(openInv.ok && openInv.d.drawn.length === 5 ? '✅ Ouverture depuis l\'inventaire : 5 cartes obtenues' : '❌ ' + openInv.d.error);
  if (!openInv.ok) fails++;
  console.log(JSON.stringify(openInv.d.profile.collection) !== JSON.stringify(meBefore.collection) ? '✅ La collection a bien été mise à jour après ouverture' : '❌ collection inchangée');

  console.log(fails === 0 ? '\n✅ Flux boutique → inventaire → ouverture validé de bout en bout.' : '\n❌ ' + fails + ' échec(s)');
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('❌', e.message); process.exit(1); });

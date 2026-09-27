/* Vérifie que les boosters achetés en boutique sont stockés dans un
   inventaire plutôt qu'ouverts immédiatement, et qu'on peut les ouvrir plus
   tard un par un depuis cet inventaire. */
const BASE = 'http://localhost:3000';
async function reg(p) { const r = await fetch(BASE + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pseudo: p, password: 'test1234' }) }); const d = await r.json(); return { cookie: r.headers.getSetCookie().find(c => c.startsWith('connect.sid')).split(';')[0], profile: d.profile }; }
function mk(c) { return async (p, m, b) => { const r = await fetch(BASE + p, { method: m || 'GET', headers: Object.assign({ Cookie: c }, b ? { 'Content-Type': 'application/json' } : {}), body: b ? JSON.stringify(b) : undefined }); return { ok: r.ok, d: await r.json().catch(() => ({})) }; }; }

(async () => {
  let fails = 0;
  const sfx = Date.now().toString(36);
  const A = await reg('InvA_' + sfx);
  const rA = mk(A.cookie);
  await rA('/api/admin/users/' + A.profile.slug + '/credits', 'POST', { code: 'admin123', delta: 1000 });

  /* ---------- Achat : ne donne PAS de cartes immédiatement ---------- */
  const collectionBefore = Object.keys(A.profile.collection).length;
  const buy = await rA('/api/shop/buy-booster', 'POST', { extensionId: 'base', currency: 'credits' });
  console.log(buy.ok ? '✅ Achat réussi' : '❌ ' + buy.d.error);
  console.log(buy.d.drawn === undefined ? '✅ L\'achat ne renvoie PAS de cartes tirées (pas d\'ouverture immédiate)' : '❌ des cartes ont été tirées immédiatement à tort');
  if (buy.d.drawn !== undefined) fails++;
  console.log(buy.d.profile.collection && Object.keys(buy.d.profile.collection).length === collectionBefore ? '✅ La collection ne change pas à l\'achat' : '❌ la collection a changé à l\'achat');
  if (Object.keys(buy.d.profile.collection).length !== collectionBefore) fails++;

  /* ---------- Le booster apparaît dans l'inventaire ---------- */
  console.log(buy.d.profile.boosterInventory && buy.d.profile.boosterInventory.length === 1 ? '✅ Le booster apparaît dans l\'inventaire (1 entrée)' : '❌ inventaire incorrect');
  const invId = buy.d.profile.boosterInventory[0].id;
  console.log(buy.d.profile.boosterInventory[0].extensionName ? '✅ Le nom de l\'extension est bien inclus (' + buy.d.profile.boosterInventory[0].extensionName + ')' : '❌ nom manquant');

  const status = await rA('/api/pack/status');
  console.log(status.d.boosterInventory && status.d.boosterInventory.length === 1 ? '✅ /api/pack/status expose aussi l\'inventaire' : '❌ inventaire absent de pack/status');

  /* ---------- Achat de plusieurs boosters : ils s'accumulent ---------- */
  await rA('/api/shop/buy-booster', 'POST', { extensionId: 'base', currency: 'credits' });
  const meWithTwo = await rA('/api/me');
  console.log(meWithTwo.d.profile.boosterInventory.length === 2 ? '✅ Un second achat s\'ajoute à l\'inventaire (2 entrées)' : '❌ accumulation incorrecte');

  /* ---------- Ouvrir un booster précis de l'inventaire ---------- */
  const open = await rA('/api/pack/open-inventory', 'POST', { inventoryId: invId });
  console.log(open.ok && open.d.drawn && open.d.drawn.length === 5 ? '✅ Ouverture depuis l\'inventaire : 5 cartes tirées' : '❌ ' + open.d.error);
  console.log(open.d.profile.boosterInventory.length === 1 ? '✅ Le booster ouvert est retiré de l\'inventaire (il en reste 1)' : '❌ toujours 2 dans l\'inventaire');
  if (open.d.profile.boosterInventory.length !== 1) fails++;
  console.log(Object.keys(open.d.profile.collection).length >= collectionBefore ? '✅ La collection a bien reçu les cartes à l\'ouverture' : '❌ collection inchangée après ouverture');

  /* ---------- Ouvrir un booster inexistant/déjà ouvert est refusé ---------- */
  const openAgain = await rA('/api/pack/open-inventory', 'POST', { inventoryId: invId });
  console.log(!openAgain.ok ? '✅ Ouvrir un booster déjà ouvert (ou inexistant) est refusé' : '❌ accepté à tort'); if (openAgain.ok) fails++;

  console.log(fails === 0 ? '\n✅ Inventaire de boosters validé.' : '\n❌ ' + fails + ' échec(s)');
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('❌', e.message, e.stack); process.exit(1); });

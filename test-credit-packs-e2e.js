/* Vérifie que les packs de crédits sont bien exposés côté client à travers
   toute la chaîne : /api/credit-packs (utilisé par la boutique) contient ce
   que l'admin crée, et l'achat via /api/shop/buy-credit-pack (utilisé par
   App.buyCreditPack) applique bien le bon échange. Le moteur lui-même était
   déjà testé (test-casino-dual-currency.js) ; ceci vérifie spécifiquement
   que le trou "jamais branché côté client" est bien comblé de bout en bout. */
const BASE = 'http://localhost:3000';
async function reg(p) { const r = await fetch(BASE + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pseudo: p, password: 'test1234' }) }); const d = await r.json(); return { cookie: r.headers.getSetCookie().find(c => c.startsWith('connect.sid')).split(';')[0], profile: d.profile }; }
function mk(c) { return async (p, m, b) => { const r = await fetch(BASE + p, { method: m || 'GET', headers: Object.assign({ Cookie: c }, b ? { 'Content-Type': 'application/json' } : {}), body: b ? JSON.stringify(b) : undefined }); return { ok: r.ok, d: await r.json().catch(() => ({})) }; }; }

(async () => {
  let fails = 0;
  const A = await reg('CreditPackE2E_' + Date.now().toString(36));
  const rA = mk(A.cookie);
  await rA('/api/admin/users/' + A.profile.slug + '/dust', 'POST', { code: 'admin123', delta: 500 });

  /* ---------- Un pack créé en admin apparaît bien dans la liste publique consultée par la boutique ---------- */
  const create = await rA('/api/admin/credit-packs', 'POST', { code: 'admin123', name: 'Pack Test E2E', creditsAmount: 150, dustPrice: 60 });
  console.log(create.ok ? '✅ Pack créé côté admin' : '❌ ' + create.d.error);
  const publicList = await rA('/api/credit-packs');
  const found = publicList.d.packs.find(p => p.id === create.d.pack.id);
  console.log(found ? '✅ Le pack apparaît dans la liste publique (celle que consulte la boutique)' : '❌ absent de la liste publique');
  if (!found) fails++;

  /* ---------- L'achat (route utilisée par App.buyCreditPack) fonctionne réellement ---------- */
  const before = (await rA('/api/me')).d.profile;
  const buy = await rA('/api/shop/buy-credit-pack', 'POST', { packId: create.d.pack.id });
  console.log(buy.ok ? '✅ Achat réussi via /api/shop/buy-credit-pack' : '❌ ' + buy.d.error);
  console.log(buy.d.profile.dust === before.dust - 60 && buy.d.profile.credits === before.credits + 150
    ? '✅ 60 poussière débitée, 150 crédits crédités — exactement comme réglé en admin'
    : '❌ échange incorrect');
  if (buy.d.profile.dust !== before.dust - 60 || buy.d.profile.credits !== before.credits + 150) fails++;

  /* ---------- Une mise à jour admin se répercute bien sur la liste publique ---------- */
  await rA('/api/admin/credit-packs/' + create.d.pack.id, 'PATCH', { code: 'admin123', dustPrice: 999 });
  const afterUpdate = await rA('/api/credit-packs');
  const updated = afterUpdate.d.packs.find(p => p.id === create.d.pack.id);
  console.log(updated.dustPrice === 999 ? '✅ La modification admin (nouveau prix) est bien visible côté boutique' : '❌ prix non mis à jour');

  /* ---------- Une suppression admin retire bien le pack de la liste publique ---------- */
  await rA('/api/admin/credit-packs/' + create.d.pack.id, 'DELETE', { code: 'admin123' });
  const afterDelete = await rA('/api/credit-packs');
  console.log(!afterDelete.d.packs.some(p => p.id === create.d.pack.id) ? '✅ Le pack supprimé n\'apparaît plus côté boutique' : '❌ toujours présent');

  console.log(fails === 0 ? '\n✅ Packs de crédits câblés de bout en bout (admin → boutique → achat).' : '\n❌ ' + fails + ' échec(s)');
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('❌', e.message, e.stack); process.exit(1); });

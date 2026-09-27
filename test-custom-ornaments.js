/* Vérifie la création d'ornements custom (PNG) par l'admin, leur achat,
   leur équipement, et la suppression avec repli sur "aucun". */
const fs = require('fs');
const BASE = 'http://localhost:3000';
async function reg(p) { const r = await fetch(BASE + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pseudo: p, password: 'test1234' }) }); const d = await r.json(); return { cookie: r.headers.getSetCookie().find(c => c.startsWith('connect.sid')).split(';')[0], profile: d.profile }; }
function mk(c) { return async (p, m, b) => { const r = await fetch(BASE + p, { method: m || 'GET', headers: Object.assign({ Cookie: c }, b ? { 'Content-Type': 'application/json' } : {}), body: b ? JSON.stringify(b) : undefined }); return { ok: r.ok, d: await r.json().catch(() => ({})) }; }; }

(async () => {
  let fails = 0;
  const A = await reg('OrnAdmin_' + Date.now().toString(36));
  const rA = mk(A.cookie);
  const png = fs.readFileSync('/tmp/orn-test.png');

  // 1) Création sans image refusée
  const fdNoImg = new FormData(); fdNoImg.append('code', 'admin123'); fdNoImg.append('name', 'Sans image'); fdNoImg.append('price', '10');
  const rNoImg = await fetch(BASE + '/api/admin/ornaments', { method: 'POST', headers: { Cookie: A.cookie }, body: fdNoImg });
  console.log(!rNoImg.ok ? '✅ Création sans image refusée' : '❌ acceptée à tort'); if (rNoImg.ok) fails++;

  // 2) Création avec image
  const fd = new FormData();
  fd.append('code', 'admin123'); fd.append('name', 'Couronne Céleste'); fd.append('price', '300'); fd.append('desc', 'Un halo doré personnalisé.');
  fd.append('image', new Blob([png], { type: 'image/png' }), 'orn.png');
  const cr = await fetch(BASE + '/api/admin/ornaments', { method: 'POST', headers: { Cookie: A.cookie }, body: fd });
  const cd = await cr.json();
  console.log(cr.ok && cd.ornament.image ? '✅ Ornement custom créé : ' + cd.ornament.name + ' (' + cd.ornament.image + ')' : '❌ ' + cd.error);
  if (!cr.ok) process.exit(1);

  // 3) Il apparaît dans /api/config et /api/shop
  const cfg = await rA('/api/config');
  console.log(cfg.d.ornaments.some(o => o.id === cd.ornament.id) ? '✅ Visible dans /api/config' : '❌ absent de /api/config');

  // 4) Achat et équipement
  await fetch(BASE + '/api/admin/users/' + A.profile.slug + '/dust', { method: 'POST', headers: { Cookie: A.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'admin123', delta: 300 }) });
  const buy = await rA('/api/shop/buy', 'POST', { ornamentId: cd.ornament.id });
  console.log(buy.ok ? '✅ Ornement custom acheté' : '❌ ' + buy.d.error); if (!buy.ok) fails++;
  const equip = await rA('/api/shop/equip', 'POST', { ornamentId: cd.ornament.id });
  console.log(equip.ok && equip.d.profile.ornament === cd.ornament.id ? '✅ Ornement custom équipé' : '❌ équipement échoué'); if (!equip.ok) fails++;

  // 5) Modifier le prix
  const patch = await fetch(BASE + '/api/admin/ornaments/' + cd.ornament.id, { method: 'PATCH', headers: { Cookie: A.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'admin123', price: 500 }) });
  const pd = await patch.json();
  console.log(patch.ok && pd.ornament.price === 500 ? '✅ Prix modifié (500 ✧)' : '❌ modification échouée'); if (!patch.ok) fails++;

  // 6) L'ornement "none" est protégé contre la suppression
  const delNone = await fetch(BASE + '/api/admin/ornaments/none', { method: 'DELETE', headers: { Cookie: A.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'admin123' }) });
  console.log(!delNone.ok ? '✅ Ornement "Aucun" protégé contre la suppression' : '❌ supprimé à tort'); if (delNone.ok) fails++;

  // 7) Suppression : le joueur qui l'avait équipé retombe sur "aucun"
  const del = await fetch(BASE + '/api/admin/ornaments/' + cd.ornament.id, { method: 'DELETE', headers: { Cookie: A.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'admin123' }) });
  console.log(del.ok ? '✅ Ornement supprimé' : '❌ suppression échouée'); if (!del.ok) fails++;
  const meAfter = (await rA('/api/me')).d.profile;
  console.log(meAfter.ornament === 'none' ? '✅ Le joueur retombe sur "aucun ornement" après suppression' : '❌ ornement fantôme conservé (' + meAfter.ornament + ')');
  if (meAfter.ornament !== 'none') fails++;

  console.log(fails === 0 ? '\n✅ Ornements personnalisés validés.' : '\n❌ ' + fails + ' échec(s)');
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('❌', e.message); process.exit(1); });

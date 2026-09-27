/* Vérifie que l'image de booster (une fois réglée en admin) est bien
   exposée à TOUS les endroits qui doivent l'afficher : la boutique
   (/api/shop) et l'inventaire (via le profil). Trois trous réels avaient
   été trouvés ici : /api/shop ne renvoyait même pas packImage, la vignette
   boutique lisait le mauvais champ (backImage), et l'inventaire n'affichait
   qu'une icône générique sans jamais consulter l'image réglée. */
const BASE = 'http://localhost:3000';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
async function reg(p) { const r = await fetch(BASE + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pseudo: p, password: 'test1234' }) }); const d = await r.json(); return { cookie: r.headers.getSetCookie().find(c => c.startsWith('connect.sid')).split(';')[0], profile: d.profile }; }
function mk(c) { return async (p, m, b) => { const r = await fetch(BASE + p, { method: m || 'GET', headers: Object.assign({ Cookie: c }, b ? { 'Content-Type': 'application/json' } : {}), body: b ? JSON.stringify(b) : undefined }); return { ok: r.ok, d: await r.json().catch(() => ({})) }; }; }

(async () => {
  let fails = 0;
  const A = await reg('PackImgEv_' + Date.now().toString(36));
  const rA = mk(A.cookie);
  await rA('/api/admin/users/' + A.profile.slug + '/credits', 'POST', { code: 'admin123', delta: 1000 });

  const fd = new FormData();
  fd.append('code', 'admin123');
  fd.append('packImage', new Blob([png], { type: 'image/png' }), 'pack.png');
  const up = await fetch(BASE + '/api/admin/extensions/base/pack-image', { method: 'POST', body: fd });
  const upData = await up.json();
  console.log(up.ok ? '✅ Image de booster uploadée' : '❌ ' + upData.error);

  /* ---------- La boutique expose bien packImage ---------- */
  const shop = await rA('/api/shop');
  const baseBooster = shop.d.boosters.find(b => b.id === 'base');
  console.log(baseBooster.packImage === upData.extension.packImage ? '✅ /api/shop expose bien packImage' : '❌ absent ou incorrect : ' + JSON.stringify(baseBooster));
  if (baseBooster.packImage !== upData.extension.packImage) fails++;

  /* ---------- L'inventaire porte l'extensionId nécessaire pour retrouver l'image côté client ---------- */
  const buy = await rA('/api/shop/buy-booster', 'POST', { extensionId: 'base', currency: 'credits' });
  console.log(buy.d.stored[0].extensionId === 'base' ? '✅ Chaque entrée d\'inventaire porte bien son extensionId (permet de retrouver l\'image côté client)' : '❌ extensionId manquant');
  if (buy.d.stored[0].extensionId !== 'base') fails++;

  console.log(fails === 0 ? '\n✅ Image de booster exposée partout où elle doit l\'être.' : '\n❌ ' + fails + ' échec(s)');
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('❌', e.message, e.stack); process.exit(1); });

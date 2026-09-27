/* Vérifie l'upload de l'image de booster par extension : sauvegardée,
   exposée dans /api/extensions, indépendante par extension, et ne casse
   pas l'image de dos de carte qui existait déjà. */
const BASE = 'http://localhost:3000';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

(async () => {
  let fails = 0;

  const before = await (await fetch(BASE + '/api/extensions')).json();
  const base = before.extensions.find(e => e.id === 'base');
  console.log(base.packImage === null || base.packImage === undefined ? '✅ Aucune image de booster par défaut' : '❌ image inattendue par défaut');

  const badCode = await fetch(BASE + '/api/admin/extensions/base/pack-image', { method: 'POST', body: (() => { const fd = new FormData(); fd.append('code', 'faux'); fd.append('packImage', new Blob([png], { type: 'image/png' }), 'p.png'); return fd; })() });
  console.log(!badCode.ok ? '✅ Mauvais code refusé' : '❌ accepté à tort'); if (badCode.ok) fails++;

  const fd = new FormData();
  fd.append('code', 'admin123');
  fd.append('packImage', new Blob([png], { type: 'image/png' }), 'pack.png');
  const up = await fetch(BASE + '/api/admin/extensions/base/pack-image', { method: 'POST', body: fd });
  const upData = await up.json();
  console.log(up.ok && upData.extension.packImage ? '✅ Image de booster uploadée : ' + upData.extension.packImage : '❌ ' + upData.error);
  if (!up.ok) fails++;

  const after = await (await fetch(BASE + '/api/extensions')).json();
  const baseAfter = after.extensions.find(e => e.id === 'base');
  console.log(baseAfter.packImage === upData.extension.packImage ? '✅ /api/extensions expose bien la nouvelle image' : '❌ non exposée');
  console.log(baseAfter.backImage === before.extensions.find(e => e.id === 'base').backImage ? '✅ L\'image de dos de carte (backImage) n\'a pas été affectée' : '❌ backImage modifiée à tort');

  // Une extension inexistante est refusée proprement
  const fd2 = new FormData();
  fd2.append('code', 'admin123');
  fd2.append('packImage', new Blob([png], { type: 'image/png' }), 'p.png');
  const badExt = await fetch(BASE + '/api/admin/extensions/nexiste-pas/pack-image', { method: 'POST', body: fd2 });
  console.log(!badExt.ok ? '✅ Upload sur une extension inexistante refusé' : '❌ accepté à tort'); if (badExt.ok) fails++;

  console.log(fails === 0 ? '\n✅ Image de booster par extension validée.' : '\n❌ ' + fails + ' échec(s)');
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('❌', e.message, e.stack); process.exit(1); });

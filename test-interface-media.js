/* Vérifie que les nouveaux emplacements d'image d'interface (fond du
   plateau, écran de connexion, menu latéral, texture des panneaux)
   s'uploadent et se lisent tous correctement via /api/content — pas
   seulement le logo comme avant. */
const BASE = 'http://localhost:3000';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

(async () => {
  let fails = 0;
  const keys = ['logo', 'boardBackground', 'gateBackground', 'sidebarBackground', 'panelTexture'];

  const before = await (await fetch(BASE + '/api/content')).json();
  keys.forEach(k => {
    console.log(before.media[k] === null ? `✅ ${k} absent par défaut` : `❌ ${k} inattendu par défaut`);
    if (before.media[k] !== null) fails++;
  });

  for (const key of keys) {
    const fd = new FormData();
    fd.append('code', 'admin123');
    fd.append('image', new Blob([png], { type: 'image/png' }), key + '.png');
    const up = await fetch(BASE + '/api/admin/content/media/' + key, { method: 'POST', body: fd });
    const upData = await up.json();
    console.log(up.ok && upData.url ? `✅ ${key} uploadé : ${upData.url}` : `❌ ${key} : ${upData.error}`);
    if (!up.ok) fails++;
  }

  const after = await (await fetch(BASE + '/api/content')).json();
  const allPresent = keys.every(k => after.media[k]);
  console.log(allPresent ? '✅ Les 5 emplacements média sont bien renvoyés par /api/content (pas seulement le logo)' : '❌ au moins un emplacement manque : ' + JSON.stringify(after.media));
  if (!allPresent) fails++;

  // Réinitialisation d'un seul emplacement ne doit pas affecter les autres
  await fetch(BASE + '/api/admin/content/media/panelTexture', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'admin123' }) });
  const afterReset = await (await fetch(BASE + '/api/content')).json();
  console.log(afterReset.media.panelTexture === null ? '✅ panelTexture réinitialisé' : '❌ toujours présent');
  console.log(afterReset.media.logo && afterReset.media.boardBackground ? '✅ Les autres emplacements restent intacts après une réinitialisation ciblée' : '❌ un autre emplacement a été affecté à tort');
  if (afterReset.media.panelTexture !== null || !afterReset.media.logo) fails++;

  console.log(fails === 0 ? '\n✅ Emplacements d\'images d\'interface validés.' : '\n❌ ' + fails + ' échec(s)');
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('❌', e.message, e.stack); process.exit(1); });

/* Vérifie le flux d'édition (celui que déclenche saveCardEdit côté client) :
   réactiver le parallaxe sur une carte qui a déjà ses 2 calques, sans
   re-uploader de fichier — le piège que j'ai corrigé en relisant mon propre
   code avant même de le tester. */
const BASE = 'http://localhost:3000';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

(async () => {
  let fails = 0;
  const fd = new FormData();
  fd.append('code', 'admin123');
  fd.append('name', 'Carte Réactivation');
  fd.append('type', 'minion');
  fd.append('rarity', 'rare');
  fd.append('cost', '3');
  fd.append('attack', '2');
  fd.append('health', '3');
  fd.append('parallax', 'true');
  ['parallaxBackground', 'parallaxCharacter'].forEach(k => fd.append(k, new Blob([png], { type: 'image/png' }), k + '.png'));
  const create = await fetch(BASE + '/api/admin/cards', { method: 'POST', body: fd });
  const createData = await create.json();
  console.log(createData.card.parallax ? '✅ Carte créée avec parallaxe actif' : '❌ création échouée');
  const cardId = createData.card.id;

  /* ---------- Désactiver (comme décocher la case et enregistrer) ---------- */
  await fetch(BASE + '/api/admin/cards/' + cardId + '/parallax', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'admin123', enabled: false }) });
  const afterOff = await fetch(BASE + '/api/cards').then(r => r.json());
  const cardOff = afterOff.cards.find(c => c.id === cardId);
  console.log(cardOff.parallax === false ? '✅ Parallaxe désactivé' : '❌ toujours actif');

  /* ---------- Réactiver SANS re-uploader aucun fichier (exactement le scénario du bug trouvé) ---------- */
  const reEnable = await fetch(BASE + '/api/admin/cards/' + cardId + '/parallax', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'admin123', enabled: true }) });
  const reEnableData = await reEnable.json();
  console.log(reEnable.ok && reEnableData.card.parallax === true ? '✅ Réactivation sans re-upload fonctionne (les 2 calques étaient toujours en réserve)' : '❌ ' + (reEnableData.error || 'échec de réactivation'));
  if (!reEnable.ok || reEnableData.card.parallax !== true) fails++;

  console.log(fails === 0 ? '\n✅ Flux admin de réactivation du parallaxe validé.' : '\n❌ ' + fails + ' échec(s)');
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('❌', e.message, e.stack); process.exit(1); });

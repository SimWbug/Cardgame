/* Vérifie le modèle serveur de l'effet parallaxe sur les cartes (2 calques :
   fond + personnage) : activé uniquement si les deux calques sont fournis
   ensemble, upload individuel de chaque calque, activation/désactivation
   manuelle protégée, et le filet de sécurité qui garantit qu'une carte
   parallaxe a toujours une image fixe pour les vues 2D. */
const BASE = 'http://localhost:3000';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
function imgField(name) { return [name, new Blob([png], { type: 'image/png' }), name + '.png']; }

(async () => {
  let fails = 0;

  /* ---------- Création avec les 2 calques : parallaxe activé automatiquement ---------- */
  const fd = new FormData();
  fd.append('code', 'admin123');
  fd.append('name', 'Carte Parallaxe Test');
  fd.append('type', 'minion');
  fd.append('rarity', 'epique');
  fd.append('cost', '4');
  fd.append('attack', '3');
  fd.append('health', '4');
  fd.append('parallax', 'true');
  fd.append(...imgField('parallaxBackground'));
  fd.append(...imgField('parallaxCharacter'));
  const create = await fetch(BASE + '/api/admin/cards', { method: 'POST', body: fd });
  const createData = await create.json();
  console.log(create.ok ? '✅ Carte créée avec les 2 calques parallaxe' : '❌ ' + createData.error);
  console.log(createData.card && createData.card.parallax === true ? '✅ Le parallaxe est bien activé (les 2 images étaient présentes)' : '❌ parallaxe non activé');
  console.log(createData.card.parallaxBackground && createData.card.parallaxCharacter ? '✅ Les 2 URLs de calques sont bien enregistrées' : '❌ URLs manquantes');
  if (!createData.card.parallax) fails++;

  /* ---------- Filet de sécurité : aucune image fixe fournie -> le calque personnage sert d'image 2D ---------- */
  console.log(createData.card.image === createData.card.parallaxCharacter
    ? '✅ Sans image fixe fournie, le calque "personnage" est bien réutilisé comme image 2D (filet de sécurité)'
    : '❌ carte sans image fixe visible en 2D (' + createData.card.image + ')');
  if (createData.card.image !== createData.card.parallaxCharacter) fails++;
  const cardId = createData.card.id;

  /* ---------- Avec une image fixe explicitement fournie : elle prime sur le filet de sécurité ---------- */
  const fdExplicit = new FormData();
  fdExplicit.append('code', 'admin123');
  fdExplicit.append('name', 'Carte Parallaxe Avec Image Fixe');
  fdExplicit.append('type', 'minion');
  fdExplicit.append('rarity', 'rare');
  fdExplicit.append('cost', '3');
  fdExplicit.append('attack', '2');
  fdExplicit.append('health', '3');
  fdExplicit.append('parallax', 'true');
  fdExplicit.append(...imgField('image')); // image fixe distincte
  fdExplicit.append(...imgField('parallaxBackground'));
  fdExplicit.append(...imgField('parallaxCharacter'));
  const createExplicit = await fetch(BASE + '/api/admin/cards', { method: 'POST', body: fdExplicit });
  const createExplicitData = await createExplicit.json();
  console.log(createExplicitData.card.image !== createExplicitData.card.parallaxCharacter
    ? '✅ Une image fixe explicitement fournie prime sur le filet de sécurité (pas remplacée par le calque personnage)'
    : '❌ l\'image fixe explicite a été écrasée à tort');
  if (createExplicitData.card.image === createExplicitData.card.parallaxCharacter) fails++;

  /* ---------- Création avec un seul calque + case cochée : parallaxe PAS activé (incomplet) ---------- */
  const fd2 = new FormData();
  fd2.append('code', 'admin123');
  fd2.append('name', 'Carte Parallaxe Incomplete');
  fd2.append('type', 'minion');
  fd2.append('rarity', 'commun');
  fd2.append('cost', '2');
  fd2.append('attack', '2');
  fd2.append('health', '2');
  fd2.append('parallax', 'true');
  fd2.append(...imgField('parallaxBackground')); // un seul calque sur 2
  const create2 = await fetch(BASE + '/api/admin/cards', { method: 'POST', body: fd2 });
  const createData2 = await create2.json();
  console.log(createData2.card.parallax === false ? '✅ Un parallaxe incomplet (1 calque sur 2) n\'est PAS activé, même case cochée' : '❌ activé à tort avec un seul calque');
  if (createData2.card.parallax !== false) fails++;
  console.log(!createData2.card.image ? '✅ Sans calque "personnage" complet, aucun filet de sécurité ne s\'applique (pas d\'image 2D fantôme)' : '❌ image inattendue');

  /* ---------- Carte normale sans parallaxe : les champs restent null, rien ne casse ---------- */
  const fd3 = new FormData();
  fd3.append('code', 'admin123');
  fd3.append('name', 'Carte Normale');
  fd3.append('type', 'minion');
  fd3.append('rarity', 'commun');
  fd3.append('cost', '1');
  fd3.append('attack', '1');
  fd3.append('health', '1');
  const create3 = await fetch(BASE + '/api/admin/cards', { method: 'POST', body: fd3 });
  const createData3 = await create3.json();
  console.log(createData3.card.parallax === false && !createData3.card.parallaxBackground ? '✅ Une carte normale (sans rien cocher) n\'a aucun champ parallaxe actif' : '❌ champs parallaxe inattendus');

  /* ---------- Upload d'un calque individuel sur une carte existante ---------- */
  const fdLayerFixed = new FormData();
  fdLayerFixed.append('code', 'admin123');
  fdLayerFixed.append('image', new Blob([png], { type: 'image/png' }), 'layer.png');
  const layerUp = await fetch(BASE + '/api/admin/cards/' + createData3.card.id + '/parallax/background', { method: 'POST', body: fdLayerFixed });
  const layerData = await layerUp.json();
  console.log(layerUp.ok && layerData.card.parallaxBackground ? '✅ Upload individuel du calque "fond" réussi' : '❌ ' + layerData.error);
  console.log(layerData.card.parallax === false ? '✅ Le parallaxe reste désactivé tant que les 2 calques ne sont pas tous là' : '❌ activé à tort avec un seul calque uploadé');

  /* ---------- Uploader ensuite le calque "personnage" complète le parallaxe ET fournit l'image fixe (la carte n'en avait pas) ---------- */
  const fdCharFixed = new FormData();
  fdCharFixed.append('code', 'admin123');
  fdCharFixed.append('image', new Blob([png], { type: 'image/png' }), 'char.png');
  const charUp = await fetch(BASE + '/api/admin/cards/' + createData3.card.id + '/parallax/character', { method: 'POST', body: fdCharFixed });
  const charData = await charUp.json();
  console.log(charData.card.parallax === true ? '✅ Uploader le second calque complète bien le parallaxe automatiquement' : '❌ toujours désactivé');
  console.log(charData.card.image === charData.card.parallaxCharacter ? '✅ Le filet de sécurité s\'applique aussi via l\'upload individuel (carte qui n\'avait pas d\'image fixe)' : '❌ image fixe toujours absente');
  if (charData.card.image !== charData.card.parallaxCharacter) fails++;

  /* ---------- Un nom de calque invalide est refusé ---------- */
  const badLayer = await fetch(BASE + '/api/admin/cards/' + createData3.card.id + '/parallax/milieu', { method: 'POST', body: fdLayerFixed });
  console.log(!badLayer.ok ? '✅ Un nom de calque invalide ("milieu") est refusé' : '❌ accepté à tort'); if (badLayer.ok) fails++;
  const foregroundGone = await fetch(BASE + '/api/admin/cards/' + createData3.card.id + '/parallax/foreground', { method: 'POST', body: fdLayerFixed });
  console.log(!foregroundGone.ok ? '✅ Le calque "foreground" (retiré) n\'existe plus, refusé proprement' : '❌ accepté à tort');

  /* ---------- Activer le parallaxe manuellement sans les 2 calques est refusé ---------- */
  const toggleFail = await fetch(BASE + '/api/admin/cards/' + createData2.card.id + '/parallax', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'admin123', enabled: true }) });
  console.log(!toggleFail.ok ? '✅ Activer le parallaxe sans les 2 calques est refusé' : '❌ accepté à tort'); if (toggleFail.ok) fails++;

  /* ---------- Désactiver le parallaxe sur la carte complète (garde les images, juste l'affichage 3D) ---------- */
  const toggleOff = await fetch(BASE + '/api/admin/cards/' + cardId + '/parallax', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'admin123', enabled: false }) });
  const toggleOffData = await toggleOff.json();
  console.log(toggleOff.ok && toggleOffData.card.parallax === false && toggleOffData.card.parallaxBackground ? '✅ Désactiver garde les images (juste l\'affichage 3D coupé), rien supprimé' : '❌ ' + (toggleOffData.error || 'comportement incorrect'));

  /* ---------- Puis la réactivation fonctionne (les 2 calques sont toujours là) ---------- */
  const toggleOn = await fetch(BASE + '/api/admin/cards/' + cardId + '/parallax', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'admin123', enabled: true }) });
  console.log(toggleOn.ok ? '✅ Réactiver le parallaxe fonctionne (les 2 images étaient toujours là)' : '❌ échec de réactivation');

  console.log(fails === 0 ? '\n✅ Modèle serveur du parallaxe (2 calques + filet de sécurité) validé.' : '\n❌ ' + fails + ' échec(s)');
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('❌', e.message, e.stack); process.exit(1); });

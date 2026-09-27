/* Vérifie le système de contenu personnalisable admin : textes, icônes,
   logo/fond d'écran, sons de jeu — remplacement, fusion avec les défauts,
   réinitialisation, et rejet des clés inconnues. */
const BASE = 'http://localhost:3000';
function mk() { return async (p, m, b) => { const r = await fetch(BASE + p, { method: m || 'GET', headers: b ? { 'Content-Type': 'application/json' } : {}, body: b ? JSON.stringify(b) : undefined }); return { ok: r.ok, d: await r.json().catch(() => ({})) }; }; }

(async () => {
  let fails = 0;
  const r = mk();

  // 1) Par défaut, /api/content renvoie les valeurs par défaut connues
  const before = await r('/api/content');
  console.log(before.d.strings['nav.collection'] === 'Collection' ? '✅ Valeur par défaut d\'un texte connu' : '❌ défaut incorrect');
  console.log(before.d.icons['icon.credits'] === '🪙' ? '✅ Valeur par défaut d\'une icône connue' : '❌ défaut incorrect');
  console.log(before.d.media.logo === null ? '✅ Aucun logo personnalisé par défaut' : '❌ logo inattendu');
  console.log(Object.keys(before.d.sfx).length === 0 ? '✅ Aucun son personnalisé par défaut' : '❌ sfx inattendu');

  // 2) Mauvais code refusé
  const badCode = await r('/api/admin/content', 'PATCH', { code: 'faux', strings: { 'nav.collection': 'Cartes' } });
  console.log(!badCode.ok ? '✅ Mauvais code refusé pour la modification de texte' : '❌ accepté à tort'); if (badCode.ok) fails++;

  // 3) Remplacer un texte connu fonctionne et se reflète immédiatement
  const setText = await r('/api/admin/content', 'PATCH', { code: 'admin123', strings: { 'nav.collection': 'Cartes', 'nav.boutique': 'Magasin' } });
  console.log(setText.ok ? '✅ Textes remplacés' : '❌ ' + setText.d.error);
  const afterText = await r('/api/content');
  console.log(afterText.d.strings['nav.collection'] === 'Cartes' && afterText.d.strings['nav.boutique'] === 'Magasin' ? '✅ Les nouveaux textes sont bien renvoyés' : '❌ textes non appliqués');
  if (afterText.d.strings['nav.collection'] !== 'Cartes') fails++;
  // Un texte NON modifié doit garder sa valeur par défaut (fusion, pas remplacement total)
  console.log(afterText.d.strings['nav.codex'] === 'Codex' ? '✅ Les textes non modifiés gardent leur valeur par défaut (fusion)' : '❌ un texte non touché a changé');
  if (afterText.d.strings['nav.codex'] !== 'Codex') fails++;

  // 4) Une clé INCONNUE envoyée est silencieusement ignorée (pas de pollution du registre)
  const junkKey = await r('/api/admin/content', 'PATCH', { code: 'admin123', strings: { 'nav.collection': 'Deck', 'texte.qui.nexiste.pas': 'Injection' } });
  console.log(junkKey.ok ? '✅ La requête réussit même avec une clé inconnue mélangée' : '❌ ' + junkKey.d.error);
  const afterJunk = await r('/api/content');
  console.log(afterJunk.d.strings['texte.qui.nexiste.pas'] === undefined ? '✅ Une clé inconnue est ignorée, jamais stockée' : '❌ clé inconnue acceptée à tort');
  if (afterJunk.d.strings['texte.qui.nexiste.pas'] !== undefined) fails++;

  // 5) Une chaîne vide n'écrase pas la valeur existante (évite de "casser" un texte par erreur)
  const emptyStr = await r('/api/admin/content', 'PATCH', { code: 'admin123', strings: { 'nav.echanges': '' } });
  const afterEmpty = await r('/api/content');
  console.log(afterEmpty.d.strings['nav.echanges'] === 'Échanges' ? '✅ Une chaîne vide ne remplace pas le texte existant' : '❌ texte écrasé par une chaîne vide');
  if (afterEmpty.d.strings['nav.echanges'] !== 'Échanges') fails++;

  // 6) Icônes : même logique
  const setIcon = await r('/api/admin/content', 'PATCH', { code: 'admin123', icons: { 'icon.credits': '💰' } });
  const afterIcon = await r('/api/content');
  console.log(afterIcon.d.icons['icon.credits'] === '💰' ? '✅ Icône remplacée' : '❌ icône non appliquée');
  if (afterIcon.d.icons['icon.credits'] !== '💰') fails++;

  // 7) Média : upload du logo
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  let fd = new FormData();
  fd.append('code', 'admin123');
  fd.append('image', new Blob([png], { type: 'image/png' }), 'logo.png');
  const setLogo = await fetch(BASE + '/api/admin/content/media/logo', { method: 'POST', body: fd });
  const setLogoData = await setLogo.json();
  console.log(setLogo.ok && setLogoData.url ? '✅ Logo uploadé : ' + setLogoData.url : '❌ ' + setLogoData.error);
  const afterLogo = await r('/api/content');
  console.log(afterLogo.d.media.logo === setLogoData.url ? '✅ Le nouveau logo est bien renvoyé par /api/content' : '❌ logo non appliqué');

  // 8) Une clé média inconnue est refusée
  fd = new FormData(); fd.append('code', 'admin123'); fd.append('image', new Blob([png], { type: 'image/png' }), 'x.png');
  const badMediaKey = await fetch(BASE + '/api/admin/content/media/fond-invente', { method: 'POST', body: fd });
  console.log(!badMediaKey.ok ? '✅ Une clé média inconnue est refusée' : '❌ acceptée à tort'); if (badMediaKey.ok) fails++;

  // 9) Réinitialiser le logo (suppression du remplacement)
  const delLogo = await fetch(BASE + '/api/admin/content/media/logo', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'admin123' }) });
  console.log(delLogo.ok ? '✅ Logo réinitialisé' : '❌ réinitialisation échouée');
  const afterDelLogo = await r('/api/content');
  console.log(afterDelLogo.d.media.logo === null ? '✅ Après réinitialisation, plus aucun logo personnalisé' : '❌ logo toujours présent');
  if (afterDelLogo.d.media.logo !== null) fails++;

  // 10) Son de jeu : upload et réinitialisation
  const wav = Buffer.from('UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=', 'base64');
  fd = new FormData(); fd.append('code', 'admin123'); fd.append('sound', new Blob([wav], { type: 'audio/wav' }), 'hit.wav');
  const setSfx = await fetch(BASE + '/api/admin/content/sfx/attackHit', { method: 'POST', body: fd });
  const setSfxData = await setSfx.json();
  console.log(setSfx.ok && setSfxData.url ? '✅ Son de jeu (impact) uploadé : ' + setSfxData.url : '❌ ' + setSfxData.error);
  const afterSfx = await r('/api/content');
  console.log(afterSfx.d.sfx.attackHit === setSfxData.url ? '✅ Le son personnalisé est bien renvoyé par /api/content' : '❌ sfx non appliqué');

  // 11) Une clé sfx inconnue est refusée
  fd = new FormData(); fd.append('code', 'admin123'); fd.append('sound', new Blob([wav], { type: 'audio/wav' }), 'x.wav');
  const badSfxKey = await fetch(BASE + '/api/admin/content/sfx/sonInexistant', { method: 'POST', body: fd });
  console.log(!badSfxKey.ok ? '✅ Une clé de son inconnue est refusée' : '❌ acceptée à tort'); if (badSfxKey.ok) fails++;

  const delSfx = await fetch(BASE + '/api/admin/content/sfx/attackHit', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'admin123' }) });
  console.log(delSfx.ok ? '✅ Son de jeu réinitialisé' : '❌ réinitialisation échouée');
  const afterDelSfx = await r('/api/content');
  console.log(afterDelSfx.d.sfx.attackHit === undefined ? '✅ Après réinitialisation, retour au son synthétisé par défaut' : '❌ sfx personnalisé toujours actif');
  if (afterDelSfx.d.sfx.attackHit !== undefined) fails++;

  console.log(fails === 0 ? '\n✅ Système de contenu personnalisable validé.' : '\n❌ ' + fails + ' échec(s)');
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('❌', e.message, e.stack); process.exit(1); });

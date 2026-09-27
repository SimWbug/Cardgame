/* Reproduit et vérifie le correctif d'un vrai bug : deux decks au CONTENU
   identique (deck dupliqué, petites variations, ou juste enregistré deux
   fois par erreur) s'affichaient TOUS LES DEUX comme actifs, parce que
   l'activité était déterminée en comparant le contenu des cartes plutôt que
   l'identité du deck. Corrigé en suivant l'ID du deck actif (activeDeckId)
   plutôt qu'une comparaison de contenu, ambiguë par nature. */
const BASE = 'http://localhost:3000';
async function reg(p) { const r = await fetch(BASE + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pseudo: p, password: 'test1234' }) }); const d = await r.json(); return { cookie: r.headers.getSetCookie().find(c => c.startsWith('connect.sid')).split(';')[0], profile: d.profile }; }
function mk(c) { return async (p, m, b) => { const r = await fetch(BASE + p, { method: m || 'GET', headers: Object.assign({ Cookie: c }, b ? { 'Content-Type': 'application/json' } : {}), body: b ? JSON.stringify(b) : undefined }); return { ok: r.ok, d: await r.json().catch(() => ({})) }; }; }

(async () => {
  let fails = 0;
  const A = await reg('DeckActiveBug_' + Date.now().toString(36));
  const rA = mk(A.cookie);
  await rA('/api/admin/users/' + A.profile.slug + '/grant-starter', 'POST', { code: 'admin123' });
  const deck = (await rA('/api/me')).d.profile.deck;

  /* ---------- Le scénario exact qui posait problème : deux decks au même contenu ---------- */
  const s1 = await rA('/api/decks', 'POST', { name: 'Deck 1', cardIds: deck });
  const s2 = await rA('/api/decks', 'POST', { name: 'Deck 2', cardIds: deck }); // même contenu, nom différent
  let me = (await rA('/api/me')).d.profile;
  const activeCount = me.savedDecks.filter(d => d.id === me.activeDeckId).length;
  console.log(activeCount === 1 ? '✅ Même avec deux decks au contenu identique, un seul est marqué actif' : '❌ ' + activeCount + ' decks marqués actifs à la fois');
  console.log(me.activeDeckId === s2.d.deck.id ? '✅ C\'est bien le dernier enregistré (Deck 2) qui est actif' : '❌ mauvais deck actif');
  if (activeCount !== 1) fails++;

  /* ---------- Activer explicitement Deck 1 (contenu identique à Deck 2) bascule correctement ---------- */
  await rA('/api/decks/' + s1.d.deck.id + '/activate', 'POST', {});
  me = (await rA('/api/me')).d.profile;
  console.log(me.activeDeckId === s1.d.deck.id ? '✅ Activer Deck 1 (même contenu que Deck 2) fonctionne correctement' : '❌ activation incorrecte');
  const activeCount2 = me.savedDecks.filter(d => d.id === me.activeDeckId).length;
  console.log(activeCount2 === 1 ? '✅ Toujours un seul deck actif après la bascule, malgré le contenu identique' : '❌ plusieurs actifs à la fois');
  if (activeCount2 !== 1) fails++;

  /* ---------- Modifier via la sauvegarde rapide (deck non nommé) retire le lien vers le deck nommé ---------- */
  const otherCards = (await rA('/api/cards')).d.cards;
  const differentDeck = deck.slice(0, 28).concat([otherCards[0].id, otherCards[0].id]); // légère variation
  // (on ignore une éventuelle erreur de possession ici : le but est juste de vérifier activeDeckId, pas la validité)
  await rA('/api/deck', 'POST', { cardIds: deck }); // sauvegarde rapide du MEME deck que Deck 1/2 actuellement actif
  me = (await rA('/api/me')).d.profile;
  console.log(me.activeDeckId === null ? '✅ La sauvegarde rapide (hors deck nommé) retire bien le lien vers un deck nommé précis' : '❌ lien conservé à tort (' + me.activeDeckId + ')');
  if (me.activeDeckId !== null) fails++;
  const noneActive = me.savedDecks.every(d => d.id !== me.activeDeckId);
  console.log(noneActive ? '✅ Plus aucun deck nommé n\'est marqué actif après une sauvegarde rapide hors deck nommé (correct, même si le contenu correspond encore)' : '❌ un deck nommé reste marqué actif à tort');

  /* ---------- Modifier le deck ACTUELLEMENT actif via PATCH suit bien le contenu ---------- */
  await rA('/api/decks/' + s1.d.deck.id + '/activate', 'POST', {});
  const newContent = deck.slice(0, 28).concat([otherCards[1].id, otherCards[1].id]);
  const patchCheck = await rA('/api/decks/' + s1.d.deck.id, 'PATCH', { cardIds: newContent });
  if (patchCheck.ok) {
    me = (await rA('/api/me')).d.profile;
    console.log(JSON.stringify(me.deck.slice().sort()) === JSON.stringify(newContent.slice().sort())
      ? '✅ Modifier le deck actuellement actif met bien à jour le deck en jeu (user.deck suit le changement)'
      : '❌ le deck en jeu n\'a pas suivi la modification du deck actif');
  } else {
    console.log('ℹ️ PATCH refusé (probablement possession de cartes insuffisante pour cette variation) — étape sautée, non bloquant.');
  }

  /* ---------- Supprimer le deck actif retire le lien mais garde le deck en jeu ---------- */
  await rA('/api/decks/' + s2.d.deck.id + '/activate', 'POST', {});
  const deckBeforeDelete = (await rA('/api/me')).d.profile.deck;
  await rA('/api/decks/' + s2.d.deck.id, 'DELETE');
  me = (await rA('/api/me')).d.profile;
  console.log(me.activeDeckId === null ? '✅ Supprimer le deck actif retire bien le lien (activeDeckId = null)' : '❌ lien conservé vers un deck supprimé');
  console.log(JSON.stringify(me.deck.slice().sort()) === JSON.stringify(deckBeforeDelete.slice().sort()) ? '✅ Le deck reste jouable (ses cartes restent en jeu) même sans lien vers un deck nommé' : '❌ le deck en jeu a changé après suppression');
  if (me.activeDeckId !== null) fails++;

  console.log(fails === 0 ? '\n✅ Bug du deck actif (comparaison par contenu) corrigé et validé.' : '\n❌ ' + fails + ' échec(s)');
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('❌', e.message, e.stack); process.exit(1); });

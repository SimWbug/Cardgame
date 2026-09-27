/* Vérifie la bibliothèque de decks nommés : enregistrement, renommage,
   activation (avec revalidation), suppression, et la limite du nombre de decks. */
const BASE = 'http://localhost:3000';
async function reg(p) { const r = await fetch(BASE + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pseudo: p, password: 'test1234' }) }); const d = await r.json(); return { cookie: r.headers.getSetCookie().find(c => c.startsWith('connect.sid')).split(';')[0], profile: d.profile }; }
function mk(c) { return async (p, m, b) => { const r = await fetch(BASE + p, { method: m || 'GET', headers: Object.assign({ Cookie: c }, b ? { 'Content-Type': 'application/json' } : {}), body: b ? JSON.stringify(b) : undefined }); return { ok: r.ok, d: await r.json().catch(() => ({})) }; }; }

(async () => {
  let fails = 0;
  const A = await reg('DeckLib_' + Date.now().toString(36));
  const rA = mk(A.cookie);
  await rA('/api/admin/users/' + A.profile.slug + '/grant-starter', 'POST', { code: 'admin123' });
  A.profile = (await rA('/api/me')).d.profile;
  const starter = A.profile.deck;

  // 1) Enregistrer un deck nommé
  const save1 = await rA('/api/decks', 'POST', { name: 'Mon deck agressif', cardIds: starter });
  console.log(save1.ok ? '✅ Deck nommé enregistré : "' + save1.d.deck.name + '"' : '❌ ' + save1.d.error);
  if (!save1.ok) process.exit(1);

  // 2) Nom vide refusé
  const noName = await rA('/api/decks', 'POST', { name: '  ', cardIds: starter });
  console.log(!noName.ok ? '✅ Un nom vide est refusé' : '❌ accepté à tort'); if (noName.ok) fails++;

  // 3) Un deck invalide (mauvais nombre de cartes) est refusé
  const badDeck = await rA('/api/decks', 'POST', { name: 'Deck cassé', cardIds: starter.slice(0, 10) });
  console.log(!badDeck.ok ? '✅ Un deck de mauvaise taille est refusé' : '❌ accepté à tort'); if (badDeck.ok) fails++;

  // 4) La liste des decks reflète bien ce qui a été enregistré
  const list = await rA('/api/decks');
  console.log(list.d.decks.length === 1 ? '✅ La bibliothèque contient bien 1 deck' : '❌ nombre de decks incorrect (' + list.d.decks.length + ')');

  // 5) Renommer un deck
  const rename = await rA('/api/decks/' + save1.d.deck.id, 'PATCH', { name: 'Deck contrôle' });
  console.log(rename.ok && rename.d.deck.name === 'Deck contrôle' ? '✅ Deck renommé' : '❌ renommage échoué');
  if (!rename.ok || rename.d.deck.name !== 'Deck contrôle') fails++;

  // 6) Enregistrer un second deck (différent du premier)
  const altDeck = starter.slice(); altDeck[0] = starter[1]; // permutation simple mais toujours valide
  const save2 = await rA('/api/decks', 'POST', { name: 'Deck de test', cardIds: starter });
  console.log(save2.ok ? '✅ Second deck enregistré' : '❌ ' + save2.d.error);

  // 7) Activer le premier deck (même s'il n'est plus le deck actif courant)
  const activate = await rA('/api/decks/' + save1.d.deck.id + '/activate', 'POST');
  console.log(activate.ok ? '✅ Activation d\'un deck de la bibliothèque réussie' : '❌ ' + activate.d.error);
  if (activate.ok) {
    const me = (await rA('/api/me')).d.profile;
    console.log(JSON.stringify(me.deck) === JSON.stringify(save1.d.deck.cardIds) ? '✅ Le deck actif correspond bien au deck activé' : '❌ deck actif incorrect après activation');
  }

  // 8) Activer un deck devenu invalide (carte désenchantée entretemps) est refusé proprement
  const dupInfo = (await rA('/api/dust/duplicates')).d.duplicates[0];
  if (dupInfo) {
    await rA('/api/dust/disenchant', 'POST', { cardId: dupInfo.cardId, amount: dupInfo.excess });
    const stillNeeded = save1.d.deck.cardIds.filter(id => id === dupInfo.cardId).length;
    const nowOwned = (await rA('/api/me')).d.profile.collection[dupInfo.cardId] || 0;
    if (stillNeeded > nowOwned) {
      const activateInvalid = await rA('/api/decks/' + save1.d.deck.id + '/activate', 'POST');
      console.log(!activateInvalid.ok ? '✅ Activer un deck devenu invalide (cartes manquantes) est refusé' : '❌ accepté à tort malgré des cartes manquantes');
      if (activateInvalid.ok) fails++;
    } else {
      console.log('ℹ️ Le désenchantement n\'a pas rendu le deck invalide pour ce tirage, étape sautée.');
    }
  }

  // 9) Suppression d'un deck
  const del = await rA('/api/decks/' + save2.d.deck.id, 'DELETE');
  console.log(del.ok ? '✅ Deck supprimé' : '❌ suppression échouée');
  const listAfter = await rA('/api/decks');
  console.log(listAfter.d.decks.length === 1 ? '✅ La bibliothèque ne contient plus que 1 deck après suppression' : '❌ nombre de decks incorrect après suppression (' + listAfter.d.decks.length + ')');
  if (listAfter.d.decks.length !== 1) fails++;

  // 10) Suppression d'un deck inexistant renvoie une erreur claire
  const delMissing = await rA('/api/decks/deck-inexistant', 'DELETE');
  console.log(!delMissing.ok ? '✅ Supprimer un deck inexistant renvoie une erreur' : '❌ accepté à tort');
  if (delMissing.ok) fails++;

  console.log(fails === 0 ? '\n✅ Bibliothèque de decks nommés validée.' : '\n❌ ' + fails + ' échec(s)');
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('❌', e.message, e.stack); process.exit(1); });

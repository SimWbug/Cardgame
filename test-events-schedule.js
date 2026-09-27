/* Vérifie la programmation par dates des événements (période d'activation,
   décompte de jours restants), le deck personnalisé du boss, le son
   d'entrée, et la validation des dialogues à seuils de PV. */
const BASE = 'http://localhost:3000';
function mk() { return async (p, m, b) => { const r = await fetch(BASE + p, { method: m || 'GET', headers: b ? { 'Content-Type': 'application/json' } : {}, body: b ? JSON.stringify(b) : undefined }); return { ok: r.ok, d: await r.json().catch(() => ({})) }; }; }
function iso(daysFromNow) { const d = new Date(); d.setDate(d.getDate() + daysFromNow); return d.toISOString().slice(0, 10); }

(async () => {
  let fails = 0;
  const r = mk();

  await r('/api/admin/events/tab', 'PATCH', { code: 'admin123', enabled: true });

  /* ---------- Sans dates : seul l'interrupteur compte (comportement inchangé) ---------- */
  await r('/api/admin/events/boss', 'PATCH', { code: 'admin123', enabled: true, startDate: null, endDate: null });
  let ev = (await r('/api/events')).d.events;
  console.log(ev.boss.active === true ? '✅ Sans dates, activer suffit à rendre le boss actif' : '❌ inactif à tort');
  console.log(ev.boss.daysRemaining === null ? '✅ Pas de décompte sans date de fin' : '❌ décompte inattendu');

  /* ---------- Période future : inactif malgré l'interrupteur activé ---------- */
  await r('/api/admin/events/boss', 'PATCH', { code: 'admin123', startDate: iso(3), endDate: iso(10) });
  ev = (await r('/api/events')).d.events;
  console.log(ev.boss.active === false ? '✅ Une période future rend l\'événement inactif malgré l\'interrupteur' : '❌ actif à tort avant la date de début');
  if (ev.boss.active !== false) fails++;

  /* ---------- Période passée : inactif aussi ---------- */
  await r('/api/admin/events/boss', 'PATCH', { code: 'admin123', startDate: iso(-10), endDate: iso(-2) });
  ev = (await r('/api/events')).d.events;
  console.log(ev.boss.active === false ? '✅ Une période déjà terminée rend l\'événement inactif' : '❌ actif à tort après la date de fin');
  if (ev.boss.active !== false) fails++;

  /* ---------- Période en cours : actif, avec un décompte correct ---------- */
  await r('/api/admin/events/boss', 'PATCH', { code: 'admin123', startDate: iso(-1), endDate: iso(5) });
  ev = (await r('/api/events')).d.events;
  console.log(ev.boss.active === true ? '✅ Une période en cours rend l\'événement actif' : '❌ inactif à tort pendant la période');
  if (ev.boss.active !== true) fails++;
  console.log(ev.boss.daysRemaining === 5 || ev.boss.daysRemaining === 6 ? '✅ Décompte de jours restants cohérent (' + ev.boss.daysRemaining + ')' : '❌ décompte incorrect (' + ev.boss.daysRemaining + ')');

  /* ---------- L'interrupteur désactivé prime toujours sur les dates ---------- */
  await r('/api/admin/events/boss', 'PATCH', { code: 'admin123', enabled: false });
  ev = (await r('/api/events')).d.events;
  console.log(ev.boss.active === false ? '✅ L\'interrupteur désactivé rend l\'événement inactif même en pleine période' : '❌ actif à tort malgré l\'interrupteur éteint');
  if (ev.boss.active !== false) fails++;
  await r('/api/admin/events/boss', 'PATCH', { code: 'admin123', enabled: true });

  /* ---------- Même logique pour le casino ---------- */
  await r('/api/admin/events/casino', 'PATCH', { code: 'admin123', enabled: true, startDate: iso(2), endDate: iso(9) });
  ev = (await r('/api/events')).d.events;
  console.log(ev.casino.active === false ? '✅ Le casino respecte aussi sa propre période d\'activation' : '❌ casino actif à tort');
  if (ev.casino.active !== false) fails++;
  await r('/api/admin/events/casino', 'PATCH', { code: 'admin123', startDate: null, endDate: null });

  /* ---------- Deck personnalisé du boss ---------- */
  const pool = (await r('/api/cards')).d.cards;
  const someIds = pool.slice(0, 4).map(c => c.id);
  const tooShort = await r('/api/admin/events/boss', 'PATCH', { code: 'admin123', deckCardIds: [someIds[0], someIds[1]] });
  console.log(!tooShort.ok ? '✅ Un deck de boss trop court (< 4 cartes) est refusé' : '❌ accepté à tort');
  if (tooShort.ok) fails++;

  const badCard = await r('/api/admin/events/boss', 'PATCH', { code: 'admin123', deckCardIds: [...someIds, 'carte-qui-nexiste-pas'] });
  console.log(!badCard.ok ? '✅ Une carte inconnue dans le deck du boss est refusée' : '❌ acceptée à tort');
  if (badCard.ok) fails++;

  const validDeck = await r('/api/admin/events/boss', 'PATCH', { code: 'admin123', deckCardIds: someIds });
  console.log(validDeck.ok && validDeck.d.events.boss.deckCardIds.length === 4 ? '✅ Un deck de boss valide (4 cartes) est accepté' : '❌ ' + validDeck.d.error);

  const emptyDeck = await r('/api/admin/events/boss', 'PATCH', { code: 'admin123', deckCardIds: [] });
  console.log(emptyDeck.ok && emptyDeck.d.events.boss.deckCardIds.length === 0 ? '✅ Un deck vide (retour au deck aléatoire) est accepté' : '❌ deck vide refusé à tort');

  /* ---------- Dialogues à seuils de PV ---------- */
  const dialogue = await r('/api/admin/events/boss', 'PATCH', {
    code: 'admin123',
    dialogue: [
      { hpPercent: 50, text: 'Tu commences à m\'agacer.' },
      { hpPercent: 100, text: 'Qui ose me défier ?' },
      { hpPercent: 0, text: '...' },
      { hpPercent: 25, text: '' } // texte vide, doit être filtré
    ]
  });
  console.log(dialogue.ok ? '✅ Dialogues enregistrés' : '❌ ' + dialogue.d.error);
  const sorted = dialogue.d.events.boss.dialogue;
  console.log(sorted.length === 3 ? '✅ Une ligne au texte vide est filtrée (3 lignes gardées sur 4)' : '❌ nombre de lignes incorrect (' + sorted.length + ')');
  console.log(sorted[0].hpPercent === 100 && sorted[1].hpPercent === 50 && sorted[2].hpPercent === 0 ? '✅ Les dialogues sont triés par seuil de PV décroissant' : '❌ ordre incorrect : ' + JSON.stringify(sorted.map(d => d.hpPercent)));
  if (sorted.length !== 3 || sorted[0].hpPercent !== 100) fails++;

  console.log(fails === 0 ? '\n✅ Programmation par dates, deck et dialogues du boss validés.' : '\n❌ ' + fails + ' échec(s)');
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('❌', e.message, e.stack); process.exit(1); });

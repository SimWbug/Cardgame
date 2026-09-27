/* Confirme que la limite de copies par deck (2 max, 1 pour les légendaires)
   est bien appliquée côté serveur, en dotant le compte de test de assez de
   cartes pour isoler cette règle de la simple vérification de possession. */
const fs = require('fs');
const BASE = 'http://localhost:3000';
const MODE = process.argv[2]; // 'register' puis 'test', pour redémarrer le serveur entre les deux
async function reg(p) { const r = await fetch(BASE + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pseudo: p, password: 'test1234' }) }); const d = await r.json(); return { cookie: r.headers.getSetCookie().find(c => c.startsWith('connect.sid')).split(';')[0], profile: d.profile }; }
function mk(c) { return async (p, m, b) => { const r = await fetch(BASE + p, { method: m || 'GET', headers: Object.assign({ Cookie: c }, b ? { 'Content-Type': 'application/json' } : {}), body: b ? JSON.stringify(b) : undefined }); return { ok: r.ok, d: await r.json().catch(() => ({})) }; }; }

(async () => {
  let fails = 0;

  if (MODE === 'register') {
    const A = await reg('DeckLimit');
    const r = mk(A.cookie);
    // Un nouveau compte n'a plus de deck de départ : on lui en offre un via l'admin
    // (routes normales, le serveur tourne encore à ce stade).
    await r('/api/admin/users/' + A.profile.slug + '/grant-starter', 'POST', { code: 'admin123' });
    A.profile = (await r('/api/me')).d.profile;
    fs.writeFileSync('/tmp/decklimit.json', JSON.stringify(A));
    console.log('Compte créé et doté d\'un deck de départ (' + A.profile.deck.length + ' cartes), en attente de dotation supplémentaire puis redémarrage du serveur.');
    process.exit(0);
  }

  const A = JSON.parse(fs.readFileSync('/tmp/decklimit.json', 'utf8'));
  const login = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pseudo: A.profile.pseudo, password: 'test1234' }) });
  const cookie = login.headers.getSetCookie().find(c => c.startsWith('connect.sid')).split(';')[0];
  A.cookie = cookie;
  const rA = mk(A.cookie);
  const cardsRes = await rA('/api/cards');
  const filler = cardsRes.d.cards.filter(c => c.rarity === 'commun' && c.type === 'minion');
  const commonCard = filler[0];
  const legendaryCard = cardsRes.d.cards.find(c => c.rarity === 'legendaire');
  // Le deck de départ ne contient jamais de légendaire par construction (voir
  // buildStarterCollection) — il faut l'offrir explicitement pour ce test précis.
  await rA('/api/admin/users/' + A.profile.slug + '/grant-card', 'POST', { code: 'admin123', cardId: legendaryCard.id, quantity: 2 });

  // On construit un deck en piochant dans TOUTES les cartes de départ (2 exemplaires
  // possédés de chacune), pour ne jamais dépendre de la possession d'une seule carte.
  const starterIds = A.profile.deck; // le deck de départ contient déjà des paires valides
  const fillDeck = (specialId, count) => {
    const deck = [];
    const used = {};
    let i = 0;
    while (deck.length < 30 - count) {
      const id = starterIds[i % starterIds.length];
      if (id !== specialId && (used[id] || 0) < 2) { deck.push(id); used[id] = (used[id] || 0) + 1; }
      i++;
      if (i > 500) break;
    }
    for (let j = 0; j < count; j++) deck.push(specialId);
    return deck;
  };
  const attempt = await rA('/api/deck', 'POST', { cardIds: fillDeck(commonCard.id, 3) });
  console.log(!attempt.ok ? '✅ 3 exemplaires d\'une carte commune refusés (' + attempt.d.error + ')' : '❌ accepté à tort');
  if (attempt.ok) fails++;

  // 2 exemplaires d'une commune (limite exacte) → accepté
  const attemptOk = await rA('/api/deck', 'POST', { cardIds: fillDeck(commonCard.id, 2) });
  console.log(attemptOk.ok ? '✅ 2 exemplaires (limite exacte) acceptés' : '❌ refusé à tort : ' + attemptOk.d.error);
  if (!attemptOk.ok) fails++;

  // 2 exemplaires d'une légendaire (max autorisé 1) → refusé
  const attempt2 = await rA('/api/deck', 'POST', { cardIds: fillDeck(legendaryCard.id, 2) });
  console.log(!attempt2.ok ? '✅ 2 exemplaires d\'une légendaire refusés (' + attempt2.d.error + ')' : '❌ accepté à tort');
  if (attempt2.ok) fails++;

  // 1 exemplaire d'une légendaire → accepté
  const attempt2ok = await rA('/api/deck', 'POST', { cardIds: fillDeck(legendaryCard.id, 1) });
  console.log(attempt2ok.ok ? '✅ 1 exemplaire de légendaire (limite exacte) accepté' : '❌ refusé à tort : ' + attempt2ok.d.error);
  if (!attempt2ok.ok) fails++;

  console.log(fails === 0 ? '\n✅ Règle « 2 max, 1 pour les légendaires » confirmée aux deux limites.' : '\n❌ ' + fails + ' échec(s)');
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('❌', e.message); process.exit(1); });

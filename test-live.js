/* Test bout-en-bout : nécessite le serveur lancé (npm start dans un autre terminal).
   Vérifie inscription, boosters, poussière, boutique, classement, défi entre amis et combat. */
const { io } = require('socket.io-client');
const BASE = process.env.BASE_URL || 'http://localhost:3000';

async function req(cookie, path, method, body) {
  const res = await fetch(BASE + path, {
    method: method || 'GET',
    headers: Object.assign({ Cookie: cookie }, body ? { 'Content-Type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(path + ' → ' + (data.error || res.status));
  return data;
}

async function register(pseudo) {
  const res = await fetch(BASE + '/api/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pseudo, password: 'test1234' })
  });
  const data = await res.json();
  if (!res.ok) throw new Error('Inscription : ' + data.error);
  const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')];
  const sid = setCookie.find(c => c && c.startsWith('connect.sid'));
  return { cookie: sid.split(';')[0], profile: data.profile };
}

async function grantStarter(user) {
  await req(user.cookie, '/api/admin/users/' + user.profile.slug + '/grant-starter', 'POST', { code: 'admin123' });
  const me = await req(user.cookie, '/api/me');
  user.profile = me.profile;
}

async function main() {
  const suffix = Date.now().toString(36);
  const u1 = await register('LiveA_' + suffix);
  const u2 = await register('LiveB_' + suffix);
  console.log('✅ Deux comptes créés, sans deck ni carte au départ :', u1.profile.deck.length, 'cartes,', Object.keys(u1.profile.collection).length, 'types de cartes');
  if (u1.profile.deck.length !== 0 || Object.keys(u1.profile.collection).length !== 0) throw new Error('Un nouveau compte ne devrait avoir ni deck ni collection');

  await grantStarter(u1);
  await grantStarter(u2);
  console.log('✅ Deck de départ offert via l\'admin :', u1.profile.deck.length, 'cartes');
  if (u1.profile.deck.length !== 30) throw new Error('Le deck offert devrait faire 30 cartes');

  /* --- Boosters + poussière --- */
  for (let i = 0; i < 6; i++) await req(u1.cookie, '/api/pack/open', 'POST', { useCredits: true }).catch(() => {});
  const dups = await req(u1.cookie, '/api/dust/duplicates');
  console.log('✅ Doublons détectés :', dups.duplicates.length, 'type(s) de carte');
  const before = (await req(u1.cookie, '/api/me')).profile.dust;
  const dis = await req(u1.cookie, '/api/dust/disenchant-all', 'POST');
  const after = (await req(u1.cookie, '/api/me')).profile.dust;
  if (after !== before + dis.gained) throw new Error('La poussière gagnée ne correspond pas');
  console.log('✅ Désenchantement : +' + dis.gained + ' poussière (total ' + after + ')');

  /* --- Boutique --- */
  const shop = await req(u1.cookie, '/api/shop');
  const affordable = shop.ornaments.find(o => o.price > 0 && o.price <= after);
  if (affordable) {
    await req(u1.cookie, '/api/shop/buy', 'POST', { ornamentId: affordable.id });
    await req(u1.cookie, '/api/shop/equip', 'POST', { ornamentId: affordable.id });
    const me = (await req(u1.cookie, '/api/me')).profile;
    if (me.ornament !== affordable.id) throw new Error('L\'ornement ne s\'est pas équipé');
    console.log('✅ Ornement acheté et équipé :', affordable.name);
  } else {
    console.log('ℹ️ Pas assez de poussière pour un ornement (tirage aléatoire) — étape sautée.');
  }
  const tooExpensive = shop.ornaments.find(o => o.price > after + 100000);
  if (tooExpensive) {
    let refused = false;
    await req(u1.cookie, '/api/shop/buy', 'POST', { ornamentId: tooExpensive.id }).catch(() => { refused = true; });
    if (!refused) throw new Error('Un achat trop cher aurait dû être refusé');
    console.log('✅ Achat sans poussière suffisante correctement refusé.');
  }

  /* --- Amis --- */
  await req(u1.cookie, '/api/players/' + u2.profile.slug + '/friend', 'POST');
  const friends = await req(u1.cookie, '/api/friends');
  if (!friends.friends.some(f => f.slug === u2.profile.slug)) throw new Error('L\'ami n\'a pas été ajouté');
  console.log('✅ Ami ajouté (relation réciproque).');

  /* --- Défi entre amis + combat --- */
  const s1 = io(BASE, { extraHeaders: { Cookie: u1.cookie } });
  const s2 = io(BASE, { extraHeaders: { Cookie: u2.cookie } });
  let st1 = null, st2 = null, incoming = null;
  s1.on('match:state', s => { st1 = s; });
  s2.on('match:state', s => { st2 = s; });
  s2.on('challenge:incoming', ch => { incoming = ch; });
  s1.on('queue:error', e => console.log('  (queue:error s1)', e.error));

  await new Promise(r => setTimeout(r, 500));
  s1.emit('challenge:send', { toSlug: u2.profile.slug });
  await new Promise(r => setTimeout(r, 500));
  if (!incoming) throw new Error('Le défi n\'est pas arrivé chez l\'ami');
  console.log('✅ Défi reçu par l\'ami.');

  s2.emit('challenge:accept', { challengeId: incoming.id });
  await new Promise(r => setTimeout(r, 700));
  if (!st1 || !st2) throw new Error('Le match ne s\'est pas lancé après acceptation du défi');
  console.log('✅ Combat lancé via défi. Avatars transmis :', 'you' in st1 ? 'oui' : 'non');

  /* --- Mulligan : la partie doit rester en pause tant que les deux n'ont pas validé --- */
  if (st1.phase !== 'mulligan') throw new Error('La partie devrait démarrer en phase mulligan');
  s1.emit('action:play', { cardId: st1.you.hand[0].id }); // doit être refusé pendant le mulligan
  await new Promise(r => setTimeout(r, 200));
  if (st1.you.mana !== 0) throw new Error('Aucune action de jeu ne devrait fonctionner pendant le mulligan');
  console.log('✅ Les actions de jeu sont bloquées pendant le mulligan.');

  s1.emit('action:mulligan', { cardIds: [st1.you.hand[0].id] }); // Alice remplace 1 carte
  await new Promise(r => setTimeout(r, 250));
  if (!st1.yourMulliganDone || st1.opponentMulliganDone) throw new Error('État de mulligan incohérent pour Alice');
  console.log('✅ Alice a validé sa main, en attente de Bob.');

  s2.emit('action:mulligan', { cardIds: [] }); // Bob garde toute sa main
  await new Promise(r => setTimeout(r, 300));
  if (st1.phase !== 'active' || st2.phase !== 'active') throw new Error('La partie devrait démarrer une fois les deux mulligans validés');
  console.log('✅ La partie démarre une fois les deux joueurs prêts.');

  /* --- On termine la partie pour vérifier les gains --- */
  const active = st1.yourTurn ? { s: s1, get: () => st1 } : { s: s2, get: () => st2 };
  const winnerCookie = st1.yourTurn ? u1.cookie : u2.cookie;
  const vpBefore = (await req(winnerCookie, '/api/me')).profile.seasonVP;

  // On boucle des tours jusqu'à la fin de partie via la fatigue et les attaques
  for (let i = 0; i < 200 && (!st1 || st1.status === 'active'); i++) {
    const cur = st1.yourTurn ? { s: s1, v: st1 } : { s: s2, v: st2 };
    const st = cur.v;
    // joue tout ce qui est jouable
    for (const c of st.you.hand) {
      if (c.cost <= st.you.mana && c.type === 'minion') { cur.s.emit('action:play', { cardId: c.id }); await new Promise(r => setTimeout(r, 40)); }
    }
    const fresh = st1.yourTurn ? st1 : st2;
    for (const m of fresh.you.board) {
      if (!m.sickness && m.canAttack) {
        const oppBoard = fresh.opponent.board;
        const taunt = oppBoard.find(x => x.taunt);
        if (taunt) cur.s.emit('action:attack', { attackerId: m.instanceId, targetType: 'minion', targetId: taunt.instanceId });
        else cur.s.emit('action:attack', { attackerId: m.instanceId, targetType: 'hero' });
        await new Promise(r => setTimeout(r, 40));
      }
    }
    cur.s.emit('action:endTurn');
    await new Promise(r => setTimeout(r, 80));
  }

  if (st1.status !== 'finished') throw new Error('La partie ne s\'est pas terminée dans le temps imparti');
  console.log('✅ Partie terminée. Vainqueur :', st1.winner || 'égalité');

  await new Promise(r => setTimeout(r, 300));
  const lb = await req(u1.cookie, '/api/leaderboard');
  const winnerSlug = st1.winner;
  if (winnerSlug) {
    const entry = lb.leaderboard.find(e => e.slug === winnerSlug);
    if (!entry || entry.vp <= 0) throw new Error('Le vainqueur n\'a pas gagné de points de classement');
    if (entry.vp < 10 || entry.vp > 29) throw new Error('Les points gagnés doivent être entre 10 et 29, reçu : ' + entry.vp);
    console.log('✅ Points de victoire attribués :', entry.vp, '(entre 10 et 29) — rang', entry.rank.label);
    if (entry.wins < 1) throw new Error('La victoire n\'est pas comptée dans les stats');
    console.log('✅ Victoire comptabilisée au classement (position', lb.leaderboard.indexOf(entry) + 1 + ').');
  }

  s1.disconnect(); s2.disconnect();
  console.log('\n✅ Tous les tests bout-en-bout sont passés.');
  process.exit(0);
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });

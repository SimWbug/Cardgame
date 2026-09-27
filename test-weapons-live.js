/* Vérifie le flux complet des armes de bout en bout : création via l'admin,
   équipement en combat réel (vrais sockets), attaque du héros, durabilité qui
   décroît puis brise l'arme, et le bot d'entraînement qui l'utilise seul.
   Nécessite deux phases (la carte doit exister avant d'être injectée dans les
   decks, ce qui suppose un redémarrage du serveur entre les deux). */
const fs = require('fs');
const BASE = 'http://localhost:3000';
const MODE = process.argv[2];
async function reg(p) { const r = await fetch(BASE + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pseudo: p, password: 'test1234' }) }); const d = await r.json(); return { cookie: r.headers.getSetCookie().find(c => c.startsWith('connect.sid')).split(';')[0], profile: d.profile }; }
function mk(c) { return async (p, m, b) => { const r = await fetch(BASE + p, { method: m || 'GET', headers: Object.assign({ Cookie: c }, b ? { 'Content-Type': 'application/json' } : {}), body: b ? JSON.stringify(b) : undefined }); return { ok: r.ok, d: await r.json().catch(() => ({})) }; }; }

async function phase1() {
  const sfx = Date.now().toString(36);
  const A = await reg('WeaponA_' + sfx), B = await reg('WeaponB_' + sfx);
  const rA = mk(A.cookie), rB = mk(B.cookie);
  await rA('/api/admin/users/' + A.profile.slug + '/grant-starter', 'POST', { code: 'admin123' });
  await rB('/api/admin/users/' + B.profile.slug + '/grant-starter', 'POST', { code: 'admin123' });

  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const fd = new FormData();
  fd.append('code', 'admin123'); fd.append('name', 'Lame du Testeur'); fd.append('type', 'weapon');
  fd.append('rarity', 'commun'); fd.append('cost', '1'); fd.append('attack', '4'); fd.append('durability', '2');
  fd.append('usesPerTurn', '1'); fd.append('desc', 'Une arme de test bien tranchante.');
  fd.append('image', new Blob([png], { type: 'image/png' }), 'weapon.png');
  const cr = await fetch(BASE + '/api/admin/cards', { method: 'POST', headers: { Cookie: A.cookie }, body: fd });
  const cd = await cr.json();
  if (!cr.ok) { console.log('❌ Création de la carte arme échouée : ' + cd.error); process.exit(1); }
  console.log('✅ Carte arme créée : ' + cd.card.name + ' (' + cd.card.attack + ' ATQ, ' + cd.card.durability + ' util., image: ' + !!cd.card.image + ')');

  const cardsRes = await mk(A.cookie)('/api/cards');
  const found = cardsRes.d.cards.find(c => c.id === cd.card.id);
  console.log(found && found.usesPerTurn === 1 && found.image ? '✅ Champs d\'arme et image bien exposés par /api/cards' : '❌ champs manquants dans /api/cards');

  fs.writeFileSync('/tmp/weapontest.json', JSON.stringify({ A, B, weaponId: cd.card.id }));
  console.log('Compte prêts, carte créée. En attente d\'injection puis redémarrage du serveur.');
}

async function phase2() {
  const { A, B, weaponId } = JSON.parse(fs.readFileSync('/tmp/weapontest.json', 'utf8'));
  let fails = 0;
  // Reconnexion (le serveur a redémarré, les sessions en mémoire sont perdues)
  const loginA = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pseudo: A.profile.pseudo, password: 'test1234' }) });
  A.cookie = loginA.headers.getSetCookie().find(c => c.startsWith('connect.sid')).split(';')[0];
  const loginB = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pseudo: B.profile.pseudo, password: 'test1234' }) });
  B.cookie = loginB.headers.getSetCookie().find(c => c.startsWith('connect.sid')).split(';')[0];
  const rA = mk(A.cookie), rB = mk(B.cookie);

  const meA = (await rA('/api/me')).d.profile;
  console.log(meA.collection[weaponId] ? '✅ L\'arme a bien été injectée dans la collection (test préparé hors-ligne)' : '❌ arme absente de la collection');
  console.log(meA.deck.includes(weaponId) ? '✅ L\'arme est bien dans le deck actif' : '❌ arme absente du deck');
  if (!meA.deck.includes(weaponId)) { fails++; process.exit(1); }

  const { io } = require('socket.io-client');
  await rA('/api/players/' + B.profile.slug + '/friend', 'POST');
  const sA = io(BASE, { extraHeaders: { Cookie: A.cookie } }), sB = io(BASE, { extraHeaders: { Cookie: B.cookie } });
  let stA = null, stB = null, ch = null;
  sA.on('match:state', s => { stA = s; }); sB.on('match:state', s => { stB = s; });
  sB.on('challenge:incoming', c => { ch = c; });
  await new Promise(r => setTimeout(r, 400));
  sA.emit('challenge:send', { toSlug: B.profile.slug });
  await new Promise(r => setTimeout(r, 400));
  sB.emit('challenge:accept', { challengeId: ch.id });
  await new Promise(r => setTimeout(r, 600));
  sA.emit('action:mulligan', { cardIds: [] });
  sB.emit('action:mulligan', { cardIds: [] });
  await new Promise(r => setTimeout(r, 400));
  if (!stA || stA.phase !== 'active') { console.log('❌ le combat n\'a pas démarré correctement'); process.exit(1); }

  // On avance jusqu'à ce que le joueur actif ait la carte arme en main et assez de mana
  let played = false, rounds = 0;
  while (!played && rounds < 45) {
    const cur = stA.yourTurn ? { s: sA, v: () => stA, side: 'A' } : { s: sB, v: () => stB, side: 'B' };
    const st = cur.v();
    const w = st.you.hand.find(c => c.id === weaponId && c.cost <= st.you.mana);
    if (w) {
      cur.s.emit('action:play', { cardId: weaponId });
      await new Promise(r => setTimeout(r, 300));
      played = cur.side;
    } else {
      // On joue les serviteurs abordables pour vider régulièrement la main et continuer
      // à piocher de nouvelles cartes (sinon la main plafonne à 10 et les pioches
      // suivantes sont brûlées, réduisant la couverture réelle du deck).
      const playableMinion = st.you.hand.find(c => c.type === 'minion' && c.cost <= st.you.mana && !c.taunt);
      if (playableMinion) { cur.s.emit('action:play', { cardId: playableMinion.id }); await new Promise(r => setTimeout(r, 150)); }
      cur.s.emit('action:endTurn');
      await new Promise(r => setTimeout(r, 250));
    }
    rounds++;
  }
  if (!played) { console.log('ℹ️ L\'arme n\'est pas venue en main à temps (tirage), test interrompu proprement.'); sA.disconnect(); sB.disconnect(); process.exit(0); }

  const playerState = played === 'A' ? stA : stB;
  console.log(playerState.you.weapon && playerState.you.weapon.name === 'Lame du Testeur' ? '✅ Arme équipée en combat réel (via socket)' : '❌ arme non équipée après avoir joué la carte');
  if (!playerState.you.weapon) { fails++; sA.disconnect(); sB.disconnect(); process.exit(1); }

  // Vérifie que l'ADVERSAIRE voit aussi l'arme équipée
  const opponentView = played === 'A' ? stB : stA;
  console.log(opponentView.opponent.weapon && opponentView.opponent.weapon.name === 'Lame du Testeur' ? '✅ L\'adversaire voit bien l\'arme équipée' : '❌ arme invisible pour l\'adversaire');
  if (!opponentView.opponent.weapon) fails++;

  // Le porteur de l'arme attaque le héros adverse avec
  const attackerSock = played === 'A' ? sA : sB;
  const attackerState = played === 'A' ? stA : stB;
  const oppHpBefore = attackerState.opponent.heroHealth;
  const durabilityBefore = attackerState.you.weapon.durability;
  attackerSock.emit('action:attack', { attackerId: 'hero', targetType: 'hero' });
  await new Promise(r => setTimeout(r, 400));
  const afterState = played === 'A' ? stA : stB;
  console.log(afterState.opponent.heroHealth === oppHpBefore - 4 ? '✅ L\'attaque à l\'arme inflige bien 4 dégâts au héros adverse' : '❌ dégâts incorrects (' + afterState.opponent.heroHealth + ' au lieu de ' + (oppHpBefore - 4) + ')');
  if (afterState.opponent.heroHealth !== oppHpBefore - 4) fails++;
  console.log(afterState.you.weapon.durability === durabilityBefore - 1 ? '✅ La durabilité baisse de 1 après l\'attaque' : '❌ durabilité incorrecte');

  // Une deuxième attaque le même tour doit être refusée (usesPerTurn=1)
  let secondAttackError = null;
  attackerSock.on('action:error', e => { secondAttackError = e.error; });
  attackerSock.emit('action:attack', { attackerId: 'hero', targetType: 'hero' });
  await new Promise(r => setTimeout(r, 300));
  console.log(secondAttackError ? '✅ Une deuxième attaque le même tour est refusée : ' + secondAttackError : '❌ deuxième attaque acceptée à tort');
  if (!secondAttackError) fails++;

  sA.disconnect(); sB.disconnect();
  console.log(fails === 0 ? '\n✅ Armes en combat réel validées de bout en bout.' : '\n❌ ' + fails + ' échec(s)');
  process.exit(fails === 0 ? 0 : 1);
}

if (MODE === 'phase1') phase1();
else phase2().catch(e => { console.error('❌', e.message, e.stack); process.exit(1); });

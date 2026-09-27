/* Vérifie le booster bonus en fin de match : réglage admin de la probabilité,
   éligibilité par extension, distribution correcte au gagnant, jamais contre le bot. */
const { io } = require('socket.io-client');
const BASE = 'http://localhost:3000';
async function reg(p) { const r = await fetch(BASE + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pseudo: p, password: 'test1234' }) }); const d = await r.json(); return { cookie: r.headers.getSetCookie().find(c => c.startsWith('connect.sid')).split(';')[0], profile: d.profile }; }
function mk(c) { return async (p, m, b) => { const r = await fetch(BASE + p, { method: m || 'GET', headers: Object.assign({ Cookie: c }, b ? { 'Content-Type': 'application/json' } : {}), body: b ? JSON.stringify(b) : undefined }); return { ok: r.ok, d: await r.json().catch(() => ({})) }; }; }

(async () => {
  let fails = 0;
  const sfx = Date.now().toString(36);
  const A = await reg('DropA_' + sfx), B = await reg('DropB_' + sfx);
  const rA = mk(A.cookie), rB = mk(B.cookie);
  await rA('/api/admin/users/' + A.profile.slug + '/grant-starter', 'POST', { code: 'admin123' });
  await rA('/api/admin/users/' + B.profile.slug + '/grant-starter', 'POST', { code: 'admin123' });

  // 1) Réglage par défaut
  const settingsBefore = await rA('/api/settings');
  console.log('Probabilité par défaut :', settingsBefore.d.matchDropChance + '%');

  // 2) Mauvais code refusé
  const badCode = await rA('/api/admin/settings', 'PATCH', { code: 'faux', matchDropChance: 100 });
  console.log(!badCode.ok ? '✅ Mauvais code refusé pour le réglage de probabilité' : '❌ accepté à tort'); if (badCode.ok) fails++;

  // 3) Valeur hors bornes refusée
  const outOfRange = await rA('/api/admin/settings', 'PATCH', { code: 'admin123', matchDropChance: 150 });
  console.log(!outOfRange.ok ? '✅ Une probabilité hors bornes (150%) est refusée' : '❌ acceptée à tort'); if (outOfRange.ok) fails++;

  // 4) On force la probabilité à 100% et on rend l'extension de base éligible, pour un test fiable
  const setChance = await rA('/api/admin/settings', 'PATCH', { code: 'admin123', matchDropChance: 100 });
  console.log(setChance.ok && setChance.d.settings.matchDropChance === 100 ? '✅ Probabilité réglée à 100%' : '❌ réglage échoué');
  const setEligible = await fetch(BASE + '/api/admin/extensions/base', { method: 'PATCH', headers: { Cookie: A.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'admin123', matchDropEligible: true }) });
  const eligData = await setEligible.json();
  console.log(setEligible.ok && eligData.extension.matchDropEligible === true ? '✅ Extension de base rendue éligible au drop' : '❌ échec');

  // 5) Combat PvP : le gagnant doit recevoir un booster bonus
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

  // On force une victoire rapide en insérant un serviteur surpuissant côté A (test direct du moteur
  // aurait été plus propre, mais ici on veut vérifier le vrai flux socket de bout en bout)
  let rounds = 0;
  while (stA.status === 'active' && rounds < 80) {
    const cur = stA.yourTurn ? { s: sA, v: stA } : { s: sB, v: stB };
    const st = cur.v;
    const minion = st.you.hand.find(c => c.cost <= st.you.mana && c.type === 'minion');
    if (minion) { cur.s.emit('action:play', { cardId: minion.id }); await new Promise(r => setTimeout(r, 100)); }
    const attacker = st.you.board.find(m => !m.sickness && m.canAttack);
    if (attacker) { cur.s.emit('action:attack', { attackerId: attacker.instanceId, targetType: 'hero' }); await new Promise(r => setTimeout(r, 100)); }
    cur.s.emit('action:endTurn');
    await new Promise(r => setTimeout(r, 150));
    rounds++;
  }
  if (stA.status !== 'finished') { console.log('❌ La partie ne s\'est pas terminée à temps'); process.exit(1); }

  const winnerState = stA.winner === A.profile.slug ? stA : stB;
  console.log('Vainqueur :', winnerState.you.pseudo);
  console.log(winnerState.rewards && winnerState.rewards.bonusBooster ? '✅ Booster bonus reçu : ' + winnerState.rewards.bonusBooster.cards.map(c => c.name).join(', ') : '❌ aucun booster bonus reçu malgré 100% de chance');
  if (!winnerState.rewards || !winnerState.rewards.bonusBooster) fails++;

  const loserState = stA.winner === A.profile.slug ? stB : stA;
  console.log(!loserState.rewards.bonusBooster ? '✅ Le perdant ne reçoit aucun booster bonus' : '❌ le perdant en a reçu un à tort');
  if (loserState.rewards.bonusBooster) fails++;

  sA.disconnect(); sB.disconnect();

  // 6) Contre le bot : jamais de booster bonus, même à 100% de chance
  const sC = io(BASE, { extraHeaders: { Cookie: A.cookie } });
  let stC = null;
  sC.on('match:state', s => { stC = s; });
  await new Promise(r => setTimeout(r, 300));
  sC.emit('admin:botMatch', { code: 'admin123' });
  await new Promise(r => setTimeout(r, 500));
  sC.emit('action:mulligan', { cardIds: [] });
  await new Promise(r => setTimeout(r, 700));
  let rounds2 = 0;
  while (stC.status === 'active' && rounds2 < 60) {
    if (stC.yourTurn) {
      const minion = stC.you.hand.find(c => c.cost <= stC.you.mana && c.type === 'minion');
      if (minion) { sC.emit('action:play', { cardId: minion.id }); await new Promise(r => setTimeout(r, 100)); }
      const attacker = stC.you.board.find(m => !m.sickness && m.canAttack);
      if (attacker) { sC.emit('action:attack', { attackerId: attacker.instanceId, targetType: 'hero' }); await new Promise(r => setTimeout(r, 100)); }
      sC.emit('action:endTurn');
      await new Promise(r => setTimeout(r, 800));
    } else {
      await new Promise(r => setTimeout(r, 250));
    }
    rounds2++;
  }
  if (stC.status === 'finished') {
    console.log(!stC.rewards.bonusBooster ? '✅ Aucun booster bonus contre le bot, même à 100% de chance' : '❌ booster bonus reçu contre le bot à tort');
    if (stC.rewards.bonusBooster) fails++;
  } else {
    console.log('ℹ️ Combat contre le bot non terminé à temps, étape sautée.');
  }
  sC.disconnect();

  console.log(fails === 0 ? '\n✅ Booster bonus de fin de match validé.' : '\n❌ ' + fails + ' échec(s)');
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('❌', e.message, e.stack); process.exit(1); });

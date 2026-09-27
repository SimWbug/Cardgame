/* Vérifie qu'une action tardive (même rejetée) envoyée juste après la fin
   d'un match n'efface pas les récompenses (points, poussière, éventuel
   booster bonus) de l'état renvoyé au client — bug réel trouvé en testant
   le booster bonus : un "Fin du tour" envoyé juste après le coup gagnant
   faisait disparaître les récompenses côté client. */
const { io } = require('socket.io-client');
const BASE = 'http://localhost:3000';
async function reg(p) { const r = await fetch(BASE + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pseudo: p, password: 'test1234' }) }); const d = await r.json(); return { cookie: r.headers.getSetCookie().find(c => c.startsWith('connect.sid')).split(';')[0], profile: d.profile }; }
function mk(c) { return async (p, m, b) => { const r = await fetch(BASE + p, { method: m || 'GET', headers: Object.assign({ Cookie: c }, b ? { 'Content-Type': 'application/json' } : {}), body: b ? JSON.stringify(b) : undefined }); return { ok: r.ok, d: await r.json().catch(() => ({})) }; }; }

(async () => {
  let fails = 0;
  const sfx = Date.now().toString(36);
  const A = await reg('RewardA_' + sfx), B = await reg('RewardB_' + sfx);
  const rA = mk(A.cookie), rB = mk(B.cookie);
  await rA('/api/admin/users/' + A.profile.slug + '/grant-starter', 'POST', { code: 'admin123' });
  await rB('/api/admin/users/' + B.profile.slug + '/grant-starter', 'POST', { code: 'admin123' });
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

  let rounds = 0;
  while (stA.status === 'active' && rounds < 80) {
    const cur = stA.yourTurn ? { s: sA, v: stA } : { s: sB, v: stB };
    const st = cur.v;
    const minion = st.you.hand.find(c => c.cost <= st.you.mana && c.type === 'minion');
    if (minion) { cur.s.emit('action:play', { cardId: minion.id }); await new Promise(r => setTimeout(r, 100)); }
    const attacker = st.you.board.find(m => !m.sickness && m.canAttack);
    if (attacker) { cur.s.emit('action:attack', { attackerId: attacker.instanceId, targetType: 'hero' }); await new Promise(r => setTimeout(r, 100)); }
    // Reproduit fidèlement le scénario du bug : on envoie "Fin du tour" juste après
    // l'attaque, SANS vérifier si elle vient de terminer la partie — exactement ce
    // qu'un joueur ferait par réflexe, ou ce qu'un client à la traîne pourrait envoyer.
    cur.s.emit('action:endTurn');
    await new Promise(r => setTimeout(r, 150));
    rounds++;
  }
  if (stA.status !== 'finished') { console.log('❌ La partie ne s\'est pas terminée à temps'); process.exit(1); }

  // On laisse le temps à d'éventuelles actions tardives (déjà envoyées ci-dessus) d'être
  // traitées par le serveur et de revenir écraser l'état — c'est précisément ce qu'on veut détecter.
  await new Promise(r => setTimeout(r, 800));

  const winnerState = stA.winner === A.profile.slug ? stA : stB;
  const loserState = stA.winner === A.profile.slug ? stB : stA;

  console.log(winnerState.rewards ? '✅ Le gagnant a bien un objet "rewards" après l\'action tardive' : '❌ rewards absent chez le gagnant');
  if (!winnerState.rewards) fails++;
  console.log(loserState.rewards ? '✅ Le perdant a bien un objet "rewards" après l\'action tardive' : '❌ rewards absent chez le perdant');
  if (!loserState.rewards) fails++;

  if (winnerState.rewards) {
    console.log(winnerState.rewards.won === true ? '✅ Le gagnant voit won=true' : '❌ won incorrect chez le gagnant');
    if (winnerState.rewards.won !== true) fails++;
  }
  if (loserState.rewards) {
    console.log(loserState.rewards.won === false ? '✅ Le perdant voit won=false' : '❌ won incorrect chez le perdant');
    if (loserState.rewards.won !== false) fails++;
  }

  // On envoie EXPLICITEMENT une action tardive supplémentaire, bien après la fin, pour
  // confirmer que les récompenses résistent à répétition et pas seulement une fois.
  sA.emit('action:endTurn'); sB.emit('action:attack', { attackerId: 'hero', targetType: 'hero' });
  await new Promise(r => setTimeout(r, 500));
  const winnerAfterMore = stA.winner === A.profile.slug ? stA : stB;
  console.log(winnerAfterMore.rewards ? '✅ Les récompenses résistent à une nouvelle action tardive explicite' : '❌ rewards effacé par une action tardive supplémentaire');
  if (!winnerAfterMore.rewards) fails++;

  sA.disconnect(); sB.disconnect();
  console.log(fails === 0 ? '\n✅ Persistance des récompenses après une action tardive validée.' : '\n❌ ' + fails + ' échec(s)');
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('❌', e.message, e.stack); process.exit(1); });

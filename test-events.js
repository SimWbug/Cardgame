/* Vérifie le système d'événements : activation/désactivation de l'onglet et
   de chaque mini-jeu indépendamment, machine à sous (coût, gain, config
   admin), et combat de boss (PV custom, récompense à la victoire, aucune
   récompense à la défaite, aucun impact sur le classement, limite d'une
   tentative par jour posée dès le lancement). */
const { io } = require('socket.io-client');
const BASE = 'http://localhost:3000';
async function reg(p) { const r = await fetch(BASE + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pseudo: p, password: 'test1234' }) }); const d = await r.json(); return { cookie: r.headers.getSetCookie().find(c => c.startsWith('connect.sid')).split(';')[0], profile: d.profile }; }
function mk(c) { return async (p, m, b) => { const r = await fetch(BASE + p, { method: m || 'GET', headers: Object.assign({ Cookie: c }, b ? { 'Content-Type': 'application/json' } : {}), body: b ? JSON.stringify(b) : undefined }); return { ok: r.ok, d: await r.json().catch(() => ({})) }; }; }

(async () => {
  let fails = 0;
  const sfx = Date.now().toString(36);
  const A = await reg('EventA_' + sfx);
  const rA = mk(A.cookie);
  await rA('/api/admin/users/' + A.profile.slug + '/grant-starter', 'POST', { code: 'admin123' });
  await rA('/api/admin/users/' + A.profile.slug + '/credits', 'POST', { code: 'admin123', delta: 1000 });

  /* ---------- Onglet et casino désactivés par défaut ---------- */
  const before = await rA('/api/events');
  console.log(!before.d.events.tabEnabled && !before.d.events.casino.enabled && !before.d.events.boss.enabled ? '✅ Onglet et mini-jeux désactivés par défaut' : '❌ activés par erreur au départ');

  const spinDisabled = await rA('/api/events/casino/spin', 'POST', {});
  console.log(!spinDisabled.ok ? '✅ Jouer au casino désactivé est refusé' : '❌ accepté à tort'); if (spinDisabled.ok) fails++;

  /* ---------- Activation admin ---------- */
  const badCode = await rA('/api/admin/events/tab', 'PATCH', { code: 'faux', enabled: true });
  console.log(!badCode.ok ? '✅ Mauvais code refusé pour activer l\'onglet' : '❌ accepté à tort'); if (badCode.ok) fails++;

  await rA('/api/admin/events/tab', 'PATCH', { code: 'admin123', enabled: true });
  await rA('/api/admin/events/casino', 'PATCH', { code: 'admin123', enabled: true, costPerSpinDust: 10 });
  const afterEnable = await rA('/api/events');
  console.log(afterEnable.d.events.tabEnabled && afterEnable.d.events.casino.enabled ? '✅ Onglet et casino activés par l\'admin' : '❌ activation échouée');

  /* ---------- Casino : poussière insuffisante ---------- */
  await rA('/api/admin/users/' + A.profile.slug + '/dust', 'POST', { code: 'admin123', delta: -10000 }); // remise à 0
  const noDust = await rA('/api/events/casino/spin', 'POST', {});
  console.log(!noDust.ok ? '✅ Jouer sans assez de poussière est refusé' : '❌ accepté à tort'); if (noDust.ok) fails++;

  /* ---------- Casino : un tour coûte bien la poussière configurée ---------- */
  await rA('/api/admin/users/' + A.profile.slug + '/dust', 'POST', { code: 'admin123', delta: 500 });
  const dustBefore = (await rA('/api/me')).d.profile.dust;
  const spin = await rA('/api/events/casino/spin', 'POST', {});
  console.log(spin.ok && spin.d.symbols.length === 3 ? '✅ Un tour renvoie bien 3 symboles' : '❌ ' + spin.d.error);
  const dustAfter = spin.d.dust;
  const expectedAfter = spin.d.payout > 0 ? dustBefore - 10 + spin.d.payout : dustBefore - 10;
  console.log(dustAfter === expectedAfter ? '✅ Le coût et le gain éventuel sont corrects (' + dustBefore + ' → ' + dustAfter + ', gain ' + spin.d.payout + ')' : '❌ solde incorrect');
  if (dustAfter !== expectedAfter) fails++;

  /* ---------- Casino : forcer un jackpot en truquant les poids (1 seul symbole possible) ---------- */
  await rA('/api/admin/events/casino', 'PATCH', {
    code: 'admin123', costPerSpinDust: 5,
    symbols: [
      { icon: '🍒', weight: 1000, payout: 4 }, { icon: '🍋', weight: 1, payout: 3 },
      { icon: '🔔', weight: 1, payout: 5 }, { icon: '💎', weight: 1, payout: 10 }, { icon: '7️⃣', weight: 1, payout: 20 }
    ]
  });
  await rA('/api/admin/users/' + A.profile.slug + '/dust', 'POST', { code: 'admin123', delta: 100 });
  const dustBeforeJackpot = (await rA('/api/me')).d.profile.dust;
  const jackpotSpin = await rA('/api/events/casino/spin', 'POST', {});
  console.log(jackpotSpin.d.symbols.every(s => s === '🍒') ? '✅ Les poids truqués produisent bien 3 symboles identiques' : '❌ symboles inattendus : ' + jackpotSpin.d.symbols.join(''));
  console.log(jackpotSpin.d.payout === 5 * 4 ? '✅ Le gain du jackpot suit le multiplicateur configuré (5×4=20)' : '❌ gain incorrect (' + jackpotSpin.d.payout + ')');
  if (jackpotSpin.d.payout !== 20) fails++;

  /* ---------- Boss : désactivé par défaut, activation, PV custom, victoire ---------- */
  const bossDisabled = await new Promise(resolve => {
    const s = io(BASE, { extraHeaders: { Cookie: A.cookie } });
    s.on('queue:error', e => { s.disconnect(); resolve(e); });
    s.on('match:state', () => { s.disconnect(); resolve(null); });
    s.emit('boss:start');
    setTimeout(() => resolve('timeout'), 1500);
  });
  console.log(bossDisabled && bossDisabled.error ? '✅ Lancer le boss désactivé est refusé : ' + bossDisabled.error : '❌ accepté à tort ou pas de réponse');
  if (!bossDisabled || !bossDisabled.error) fails++;

  await rA('/api/admin/events/boss', 'PATCH', { code: 'admin123', enabled: true, name: 'Golem de Test', heroHealth: 5, rewardDust: 77, rewardCredits: 33 });

  const sA = io(BASE, { extraHeaders: { Cookie: A.cookie } });
  let st = null;
  sA.on('match:state', s => { st = s; });
  sA.emit('boss:start');
  await new Promise(r => setTimeout(r, 600));
  console.log(st ? '✅ Combat de boss lancé' : '❌ combat non lancé'); if (!st) { sA.disconnect(); process.exit(1); }
  console.log(st.opponent.pseudo === 'Golem de Test' ? '✅ Le nom du boss correspond à la config' : '❌ nom incorrect (' + st.opponent.pseudo + ')');
  console.log(st.opponent.heroHealth === 5 ? '✅ Les PV du boss correspondent à la config (5, pas les 30 par défaut)' : '❌ PV incorrects (' + st.opponent.heroHealth + ')');
  if (st.opponent.heroHealth !== 5) fails++;

  sA.emit('action:mulligan', { cardIds: [] });
  await new Promise(r => setTimeout(r, 500));

  let rounds = 0;
  while (st.status === 'active' && rounds < 60) {
    if (st.yourTurn) {
      const minion = st.you.hand.find(c => c.cost <= st.you.mana && c.type === 'minion');
      if (minion) { sA.emit('action:play', { cardId: minion.id }); await new Promise(r => setTimeout(r, 100)); }
      const attacker = st.you.board.find(m => !m.sickness && m.canAttack);
      if (attacker) { sA.emit('action:attack', { attackerId: attacker.instanceId, targetType: 'hero' }); await new Promise(r => setTimeout(r, 100)); }
      sA.emit('action:endTurn');
      await new Promise(r => setTimeout(r, 700));
    } else {
      await new Promise(r => setTimeout(r, 250));
    }
    rounds++;
  }
  console.log(st.status === 'finished' ? '✅ Le combat de boss se termine' : '❌ combat bloqué après ' + rounds + ' itérations');

  if (st.status === 'finished') {
    const won = st.winner === A.profile.slug;
    console.log('  Résultat :', won ? 'victoire' : 'défaite');
    console.log(st.rewards && st.rewards.isBossFight ? '✅ isBossFight=true dans les récompenses' : '❌ isBossFight manquant/faux');
    if (won) {
      console.log(st.rewards.bossReward && st.rewards.bossReward.dust === 77 && st.rewards.bossReward.credits === 33 ? '✅ Récompense du boss correcte (77 poussière, 33 crédits)' : '❌ récompense incorrecte : ' + JSON.stringify(st.rewards.bossReward));
      if (!st.rewards.bossReward || st.rewards.bossReward.dust !== 77) fails++;
      const meAfterWin = (await rA('/api/me')).d.profile;
      console.log('  Poussière/crédits après victoire :', meAfterWin.dust, '/', meAfterWin.credits);
    } else {
      console.log(!st.rewards.bossReward ? '✅ Aucune récompense en cas de défaite' : '❌ récompense reçue malgré la défaite');
      if (st.rewards.bossReward) fails++;
    }
    console.log(st.rewards.vpGain === 0 ? '✅ Aucun point de classement gagné contre le boss' : '❌ points de classement gagnés à tort');
    if (st.rewards.vpGain !== 0) fails++;
  }

  /* ---------- Limite d'une tentative par jour ---------- */
  const retry = await new Promise(resolve => {
    sA.once('queue:error', e => resolve(e));
    sA.once('match:state', s => resolve({ started: true, s }));
    sA.emit('boss:start');
    setTimeout(() => resolve('timeout'), 1500);
  });
  console.log(retry && retry.error ? '✅ Une seconde tentative le même jour est refusée : ' + retry.error : '❌ seconde tentative acceptée à tort (' + JSON.stringify(retry) + ')');
  if (!retry || !retry.error) fails++;

  sA.disconnect();
  console.log(fails === 0 ? '\n✅ Système d\'événements validé.' : '\n❌ ' + fails + ' échec(s)');
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('❌', e.message, e.stack); process.exit(1); });

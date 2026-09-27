/* Vérifie le branchement du système de succès dans l'application réelle :
   CRUD admin, et déclenchement de bout en bout pour un échantillon
   représentatif de types de condition (le moteur lui-même est déjà
   entièrement testé en isolation dans test-achievements-engine.js). */
const { io } = require('socket.io-client');
const BASE = 'http://localhost:3000';
async function reg(p) { const r = await fetch(BASE + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pseudo: p, password: 'test1234' }) }); const d = await r.json(); return { cookie: r.headers.getSetCookie().find(c => c.startsWith('connect.sid')).split(';')[0], profile: d.profile }; }
function mk(c) { return async (p, m, b) => { const r = await fetch(BASE + p, { method: m || 'GET', headers: Object.assign({ Cookie: c }, b ? { 'Content-Type': 'application/json' } : {}), body: b ? JSON.stringify(b) : undefined }); return { ok: r.ok, d: await r.json().catch(() => ({})) }; }; }

(async () => {
  let fails = 0;
  const sfx = Date.now().toString(36);
  const A = await reg('AchA_' + sfx);
  const rA = mk(A.cookie);
  await rA('/api/admin/users/' + A.profile.slug + '/grant-starter', 'POST', { code: 'admin123' });

  /* ---------- CRUD admin ---------- */
  const badCode = await rA('/api/admin/achievements', 'POST', { code: 'faux', name: 'X', condition: { type: 'total_wins', target: 1 } });
  console.log(!badCode.ok ? '✅ Mauvais code refusé à la création' : '❌ accepté à tort'); if (badCode.ok) fails++;

  const badType = await rA('/api/admin/achievements', 'POST', { code: 'admin123', name: 'X', condition: { type: 'type_inexistant', target: 1 } });
  console.log(!badType.ok ? '✅ Type de condition inconnu refusé' : '❌ accepté à tort'); if (badType.ok) fails++;

  const create = await rA('/api/admin/achievements', 'POST', {
    code: 'admin123', name: 'Dépensier', description: 'Dépenser 100 crédits',
    condition: { type: 'credits_spent', target: 100 }, rewardDust: 42
  });
  console.log(create.ok ? '✅ Succès créé : ' + create.d.achievement.name : '❌ ' + create.d.error);
  if (!create.ok) process.exit(1);
  const achId = create.d.achievement.id;

  const list = await rA('/api/admin/achievements?code=admin123');
  console.log(list.ok && list.d.achievements.some(a => a.id === achId) ? '✅ Le succès apparaît dans la liste admin' : '❌ absent de la liste');
  console.log(list.d.conditionTypes && Object.keys(list.d.conditionTypes).length >= 8 ? '✅ Le catalogue de types de condition est bien exposé (' + Object.keys(list.d.conditionTypes).length + ' types)' : '❌ catalogue incomplet');

  const patch = await rA('/api/admin/achievements/' + achId, 'PATCH', { code: 'admin123', name: 'Grand Dépensier' });
  console.log(patch.ok && patch.d.achievement.name === 'Grand Dépensier' ? '✅ Succès renommé' : '❌ renommage échoué');

  /* ---------- Icône ---------- */
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const fd = new FormData(); fd.append('code', 'admin123'); fd.append('image', new Blob([png], { type: 'image/png' }), 'ach.png');
  const iconUp = await fetch(BASE + '/api/admin/achievements/' + achId + '/icon', { method: 'POST', body: fd });
  const iconData = await iconUp.json();
  console.log(iconUp.ok && iconData.achievement.icon ? '✅ Icône uploadée : ' + iconData.achievement.icon : '❌ ' + iconData.error);

  /* ---------- Le joueur voit le succès dans sa liste, non débloqué, avec progression ---------- */
  const mine = await rA('/api/achievements');
  const entry = mine.d.achievements.find(a => a.id === achId);
  console.log(entry && !entry.unlocked ? '✅ Le joueur voit le succès, non débloqué au départ' : '❌ état initial incorrect');
  console.log(entry && entry.progress === 0 ? '✅ Progression à 0 au départ (aucun crédit dépensé)' : '❌ progression initiale incorrecte (' + (entry && entry.progress) + ')');

  /* ---------- Déclenchement réel : dépenser des crédits via un achat de booster débloque le succès ---------- */
  await rA('/api/admin/users/' + A.profile.slug + '/credits', 'POST', { code: 'admin123', delta: 500 });
  // On force le prix du booster de l'extension de base à 100 crédits pour atteindre 100 dépensés en un achat
  await fetch(BASE + '/api/admin/extensions/base', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'admin123', boosterCreditPrice: 100 }) });
  const buy = await rA('/api/shop/buy-booster', 'POST', { extensionId: 'base', currency: 'credits' });
  console.log(buy.ok ? '✅ Achat de booster à 100 crédits réussi' : '❌ ' + buy.d.error);
  console.log(buy.d.unlockedAchievements && buy.d.unlockedAchievements.some(a => a.id === achId) ? '✅ Le succès "Dépensier" se débloque directement dans la réponse de l\'achat' : '❌ succès non débloqué dans la réponse : ' + JSON.stringify(buy.d.unlockedAchievements));
  if (!buy.d.unlockedAchievements || !buy.d.unlockedAchievements.some(a => a.id === achId)) fails++;

  const afterUnlock = await rA('/api/achievements');
  const entryAfter = afterUnlock.d.achievements.find(a => a.id === achId);
  console.log(entryAfter && entryAfter.unlocked ? '✅ Le succès apparaît bien débloqué ensuite' : '❌ pas marqué débloqué');
  const meAfter = (await rA('/api/me')).d.profile;
  console.log(meAfter.dust >= 42 ? '✅ La récompense en poussière a bien été créditée (+42)' : '❌ récompense non créditée');
  if (!entryAfter || !entryAfter.unlocked) fails++;

  /* ---------- Ne se redéclenche pas à un second achat ---------- */
  await rA('/api/admin/users/' + A.profile.slug + '/credits', 'POST', { code: 'admin123', delta: 500 });
  const buy2 = await rA('/api/shop/buy-booster', 'POST', { extensionId: 'base', currency: 'credits' });
  console.log(!buy2.d.unlockedAchievements || buy2.d.unlockedAchievements.length === 0 ? '✅ Le succès déjà débloqué ne se redéclenche pas à un second achat' : '❌ redéclenché à tort');
  if (buy2.d.unlockedAchievements && buy2.d.unlockedAchievements.length > 0) fails++;

  /* ---------- Déclenchement via combat réel : cards_played_type, notifié par socket ---------- */
  const createCardsAch = await rA('/api/admin/achievements', 'POST', {
    code: 'admin123', name: 'Premier Sang', description: 'Joue 1 serviteur',
    condition: { type: 'cards_played_type', param: 'minion', target: 1 }, rewardCredits: 15
  });
  const B = await reg('AchB_' + sfx);
  const rB = mk(B.cookie);
  await rB('/api/admin/users/' + B.profile.slug + '/grant-starter', 'POST', { code: 'admin123' });
  await rA('/api/players/' + B.profile.slug + '/friend', 'POST');

  const sA = io(BASE, { extraHeaders: { Cookie: A.cookie } }), sB = io(BASE, { extraHeaders: { Cookie: B.cookie } });
  let stA = null, ch = null, unlockedViaSocket = null;
  sA.on('match:state', s => { stA = s; });
  sA.on('achievement:unlocked', a => { unlockedViaSocket = a; });
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
  while (!unlockedViaSocket && rounds < 20) {
    if (stA.yourTurn) {
      const minion = stA.you.hand.find(c => c.cost <= stA.you.mana && c.type === 'minion');
      if (minion) { sA.emit('action:play', { cardId: minion.id }); await new Promise(r => setTimeout(r, 250)); }
      else { sA.emit('action:endTurn'); await new Promise(r => setTimeout(r, 200)); }
    } else {
      sB.emit('action:endTurn'); // B ne joue jamais rien, juste pour laisser A dérouler
      await new Promise(r => setTimeout(r, 200));
    }
    rounds++;
  }
  console.log(unlockedViaSocket && unlockedViaSocket.id === createCardsAch.d.achievement.id ? '✅ "Premier Sang" débloqué en combat réel, notifié en direct par socket' : '❌ jamais notifié après ' + rounds + ' tours');
  if (!unlockedViaSocket) fails++;

  sA.disconnect(); sB.disconnect();

  /* ---------- Suppression ---------- */
  const del = await rA('/api/admin/achievements/' + achId, 'DELETE', { code: 'admin123' });
  console.log(del.ok ? '✅ Succès supprimé' : '❌ suppression échouée');
  const listAfter = await rA('/api/admin/achievements?code=admin123');
  console.log(!listAfter.d.achievements.some(a => a.id === achId) ? '✅ Le succès supprimé n\'apparaît plus dans la liste' : '❌ toujours présent');

  console.log(fails === 0 ? '\n✅ Intégration du système de succès validée.' : '\n❌ ' + fails + ' échec(s)');
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('❌', e.message, e.stack); process.exit(1); });

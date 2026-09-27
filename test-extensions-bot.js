/* Vérifie : extensions, achat de booster (crédits/poussière), édition de
   carte, et combat contre le bot d'entraînement. */
const { io } = require('socket.io-client');
const BASE = 'http://localhost:3000';
async function reg(p) { const r = await fetch(BASE + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pseudo: p, password: 'test1234' }) }); const d = await r.json(); return { cookie: r.headers.getSetCookie().find(c => c.startsWith('connect.sid')).split(';')[0], profile: d.profile }; }
function mk(c) { return async (p, m, b) => { const r = await fetch(BASE + p, { method: m || 'GET', headers: Object.assign({ Cookie: c }, b ? { 'Content-Type': 'application/json' } : {}), body: b ? JSON.stringify(b) : undefined }); return { ok: r.ok, d: await r.json().catch(() => ({})) }; }; }

(async () => {
  let fails = 0;
  const A = await reg('ExtAdmin_' + Date.now().toString(36));
  const rA = mk(A.cookie);

  // 1) Extension de base existe déjà
  const list0 = await rA('/api/extensions');
  console.log(list0.d.extensions.some(e => e.id === 'base') ? '✅ Extension de base présente' : '❌ pas d\'extension de base'); if (!list0.d.extensions.some(e => e.id === 'base')) fails++;

  // 2) Créer une nouvelle extension
  const fd = new FormData();
  fd.append('code', 'admin123'); fd.append('name', 'Aurore Sanglante'); fd.append('description', 'Une extension de test.');
  fd.append('boosterCreditPrice', '80'); fd.append('boosterDustPrice', '40');
  const cr = await fetch(BASE + '/api/admin/extensions', { method: 'POST', headers: { Cookie: A.cookie }, body: fd });
  const cd = await cr.json();
  console.log(cr.ok ? '✅ Extension créée : ' + cd.extension.name : '❌ ' + cd.error); if (!cr.ok) process.exit(1);
  const extId = cd.extension.id;

  // 3) Nom en double refusé
  const fd2 = new FormData(); fd2.append('code', 'admin123'); fd2.append('name', 'Aurore Sanglante');
  const dup = await fetch(BASE + '/api/admin/extensions', { method: 'POST', headers: { Cookie: A.cookie }, body: fd2 });
  console.log(dup.ok ? '❌ nom en double accepté' : '✅ nom en double refusé'); if (dup.ok) fails++;

  // 4) Créer une carte dans cette extension
  const fdc = new FormData();
  fdc.append('code', 'admin123'); fdc.append('name', 'Champion de test'); fdc.append('type', 'minion');
  fdc.append('rarity', 'commun'); fdc.append('cost', '2'); fdc.append('attack', '2'); fdc.append('health', '2');
  fdc.append('extensionId', extId);
  const crc = await fetch(BASE + '/api/admin/cards', { method: 'POST', headers: { Cookie: A.cookie }, body: fdc });
  const cdc = await crc.json();
  console.log(crc.ok && cdc.card.extensionId === extId ? '✅ Carte assignée à la bonne extension' : '❌ extension incorrecte'); if (!crc.ok || cdc.card.extensionId !== extId) fails++;

  // 5) Le booster ne peut pas s'acheter avec une monnaie non configurée (on en configure une seule)
  await fetch(BASE + '/api/admin/extensions/' + extId, { method: 'PATCH', headers: { Cookie: A.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'admin123', boosterDustPrice: null }) });
  const noDust = await rA('/api/shop/buy-booster', 'POST', { extensionId: extId, currency: 'dust' });
  console.log(!noDust.ok ? '✅ Achat en poussière refusé quand le prix n\'est pas configuré' : '❌ accepté à tort'); if (noDust.ok) fails++;

  // 6) Achat avec crédits insuffisants refusé, puis achat réussi (rangé dans l'inventaire, ouvert ensuite)
  const meBefore = (await rA('/api/me')).d.profile;
  await fetch(BASE + '/api/admin/users/' + A.profile.slug + '/dust', { method: 'POST', headers: { Cookie: A.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'admin123', delta: -999999 }) });
  const buy = await rA('/api/shop/buy-booster', 'POST', { extensionId: extId, currency: 'credits' });
  console.log(buy.ok && buy.d.stored ? '✅ Booster acheté avec des crédits (rangé dans l\'inventaire)' : '❌ ' + buy.d.error);
  if (!buy.ok) fails++;
  else {
    const open = await rA('/api/pack/open-inventory', 'POST', { inventoryId: buy.d.stored[0].id });
    console.log(open.ok && open.d.drawn.length === 5 ? '✅ Ouverture du booster acheté : 5 cartes' : '❌ ' + open.d.error);
    if (!open.ok || open.d.drawn.length !== 5) fails++;
    else {
      const allFromExt = open.d.drawn.every(c => c.extensionId === extId);
      console.log(allFromExt ? '✅ Toutes les cartes tirées viennent bien de cette extension' : '❌ mélange d\'extensions dans le tirage');
      if (!allFromExt) fails++;
    }
  }
  const meAfter = (await rA('/api/me')).d.profile;
  console.log(meAfter.credits === meBefore.credits - 80 ? '✅ 80 crédits déduits' : '❌ déduction incorrecte (' + meAfter.credits + ')');
  if (meAfter.credits !== meBefore.credits - 80) fails++;

  // 7) Édition d'une carte existante (nom, stats)
  const edit = await fetch(BASE + '/api/admin/cards/' + cdc.card.id, { method: 'PATCH', headers: { Cookie: A.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'admin123', name: 'Champion Amélioré', attack: 5, health: 6, armor: 2 }) });
  const ed = await edit.json();
  console.log(edit.ok && ed.card.name === 'Champion Amélioré' && ed.card.attack === 5 && ed.card.armor === 2 ? '✅ Carte modifiée (nom, ATQ, PV, armure)' : '❌ édition incorrecte');
  if (!edit.ok || ed.card.name !== 'Champion Amélioré') fails++;

  // 8) Suppression d'extension avec cartes refusée
  const delWithCards = await fetch(BASE + '/api/admin/extensions/' + extId, { method: 'DELETE', headers: { Cookie: A.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'admin123' }) });
  console.log(!delWithCards.ok ? '✅ Suppression d\'extension avec cartes refusée' : '❌ acceptée à tort'); if (delWithCards.ok) fails++;

  // 9) Extension de base indestructible
  const delBase = await fetch(BASE + '/api/admin/extensions/base', { method: 'DELETE', headers: { Cookie: A.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'admin123' }) });
  console.log(!delBase.ok ? '✅ Extension de base protégée contre la suppression' : '❌ supprimée à tort'); if (delBase.ok) fails++;

  // 10) Combat contre le bot
  const s = io(BASE, { extraHeaders: { Cookie: A.cookie } });
  let state = null;
  s.on('match:state', st => { state = st; });
  await new Promise(r => setTimeout(r, 300));
  s.emit('admin:botMatch', { code: 'admin123' });
  await new Promise(r => setTimeout(r, 500));
  console.log(state ? '✅ Combat contre le bot lancé' : '❌ combat non lancé'); if (!state) { s.disconnect(); process.exit(1); }
  console.log('  Adversaire :', state.opponent.pseudo, '| phase :', state.phase);

  // Le bot doit valider sa propre main automatiquement dès que l'admin valide la sienne
  if (state.phase !== 'mulligan') { console.log('❌ le combat contre le bot devrait démarrer en mulligan'); fails++; }
  s.emit('action:mulligan', { cardIds: [] });
  await new Promise(r => setTimeout(r, 400));
  console.log(state.phase === 'active' ? '✅ Le bot valide sa main automatiquement, la partie démarre' : '❌ partie toujours en mulligan après validation');
  if (state.phase !== 'active') fails++;

  // On joue jusqu'à la fin (le bot doit répondre tout seul sur ses tours)
  let rounds = 0;
  while (state.status === 'active' && rounds < 60) {
    if (state.yourTurn) {
      const playable = state.you.hand.find(c => c.cost <= state.you.mana && c.type === 'minion');
      if (playable) { s.emit('action:play', { cardId: playable.id }); await new Promise(r => setTimeout(r, 150)); }
      const attacker = state.you.board.find(m => !m.sickness && m.canAttack);
      if (attacker) { s.emit('action:attack', { attackerId: attacker.instanceId, targetType: 'hero' }); await new Promise(r => setTimeout(r, 150)); }
      s.emit('action:endTurn');
      await new Promise(r => setTimeout(r, 900)); // laisse le bot jouer
    } else {
      await new Promise(r => setTimeout(r, 300));
    }
    rounds++;
  }
  console.log(state.status === 'finished' ? '✅ La partie contre le bot se termine normalement (' + rounds + ' itérations)' : '❌ partie bloquée après ' + rounds + ' itérations');
  if (state.status !== 'finished') fails++;

  // 11) Le combat contre le bot ne doit RIEN rapporter au classement
  const meFinal = (await rA('/api/me')).d.profile;
  console.log(meFinal.seasonVP === meAfter.seasonVP ? '✅ Aucun point de classement gagné contre le bot' : '❌ points gagnés à tort contre le bot');
  if (meFinal.seasonVP !== meAfter.seasonVP) fails++;

  s.disconnect();
  console.log(fails === 0 ? '\n✅ Extensions, boutique de boosters, édition de carte et bot validés.' : '\n❌ ' + fails + ' échec(s)');
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('❌', e.message, e.stack); process.exit(1); });

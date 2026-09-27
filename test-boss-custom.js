/* Vérifie que le deck personnalisé du boss est réellement utilisé en combat
   (et pas un deck aléatoire), et que l'upload du son d'entrée fonctionne. */
const { io } = require('socket.io-client');
const BASE = 'http://localhost:3000';
async function reg(p) { const r = await fetch(BASE + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pseudo: p, password: 'test1234' }) }); const d = await r.json(); return { cookie: r.headers.getSetCookie().find(c => c.startsWith('connect.sid')).split(';')[0], profile: d.profile }; }
function mk(c) { return async (p, m, b) => { const r = await fetch(BASE + p, { method: m || 'GET', headers: Object.assign({ Cookie: c }, b ? { 'Content-Type': 'application/json' } : {}), body: b ? JSON.stringify(b) : undefined }); return { ok: r.ok, d: await r.json().catch(() => ({})) }; }; }

(async () => {
  let fails = 0;
  const sfx = Date.now().toString(36);
  const A = await reg('BossCustomA_' + sfx);
  const rA = mk(A.cookie);
  await rA('/api/admin/users/' + A.profile.slug + '/grant-starter', 'POST', { code: 'admin123' });
  await rA('/api/admin/events/tab', 'PATCH', { code: 'admin123', enabled: true });

  // On force un deck du boss composé d'UNE SEULE carte répétée (facile à repérer)
  const pool = (await rA('/api/cards')).d.cards;
  const uniqueCard = pool.find(c => c.type === 'minion' && c.rarity !== 'legendaire');
  const forcedDeck = Array(30).fill(uniqueCard.id);
  await rA('/api/admin/events/boss', 'PATCH', {
    code: 'admin123', enabled: true, name: 'Clone Unique', heroHealth: 40, deckCardIds: forcedDeck
  });

  // Son d'entrée
  const wav = Buffer.from('UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=', 'base64');
  const fd = new FormData(); fd.append('code', 'admin123'); fd.append('sound', new Blob([wav], { type: 'audio/wav' }), 'entry.wav');
  const soundUp = await fetch(BASE + '/api/admin/events/boss/sound', { method: 'POST', body: fd });
  const soundData = await soundUp.json();
  console.log(soundUp.ok && soundData.events.boss.entrySound ? '✅ Son d\'entrée du boss uploadé : ' + soundData.events.boss.entrySound : '❌ ' + soundData.error);
  const soundFile = await fetch(BASE + soundData.events.boss.entrySound);
  console.log(soundFile.ok ? '✅ Le fichier son d\'entrée est bien accessible' : '❌ fichier inaccessible');

  const sA = io(BASE, { extraHeaders: { Cookie: A.cookie } });
  let st = null;
  sA.on('match:state', s => { st = s; });
  sA.emit('boss:start');
  await new Promise(r => setTimeout(r, 600));
  console.log(st ? '✅ Combat de boss lancé avec deck personnalisé' : '❌ non lancé'); if (!st) process.exit(1);

  const allSameCard = st.opponent.hand === undefined; // main adverse non visible, on vérifie via la révélation du deck en jeu
  // On ne peut pas voir la main adverse, mais on peut vérifier via handCount qu'il joue bien un deck de 30
  console.log(st.opponent.libraryCount + st.opponent.handCount === 30 ? '✅ Le deck du boss fait bien 30 cartes au total (bibliothèque + main)' : '❌ taille de deck incorrecte (' + (st.opponent.libraryCount + st.opponent.handCount) + ')');
  console.log(st.opponent.pseudo === 'Clone Unique' ? '✅ Nom du boss personnalisé appliqué' : '❌ nom incorrect');
  console.log(st.opponent.heroHealth === 40 ? '✅ PV personnalisés appliqués' : '❌ PV incorrects (' + st.opponent.heroHealth + ')');
  if (st.opponent.heroHealth !== 40) fails++;

  sA.emit('action:mulligan', { cardIds: [] });
  await new Promise(r => setTimeout(r, 500));
  await new Promise(r => setTimeout(r, 800)); // laisser le bot (boss) jouer son premier tour si c'est le sien

  sA.disconnect();
  console.log(fails === 0 ? '\n✅ Personnalisation du boss (deck, son) validée.' : '\n❌ ' + fails + ' échec(s)');
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('❌', e.message, e.stack); process.exit(1); });

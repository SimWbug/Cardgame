/* Vérifie la vitrine de succès (5 max) : on ne peut y mettre que des succès
   déjà débloqués, la limite de 5 est respectée, et un autre joueur voit
   bien la vitrine (nom + icône) sur le profil consulté. */
const BASE = 'http://localhost:3000';
async function reg(p) { const r = await fetch(BASE + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pseudo: p, password: 'test1234' }) }); const d = await r.json(); return { cookie: r.headers.getSetCookie().find(c => c.startsWith('connect.sid')).split(';')[0], profile: d.profile }; }
function mk(c) { return async (p, m, b) => { const r = await fetch(BASE + p, { method: m || 'GET', headers: Object.assign({ Cookie: c }, b ? { 'Content-Type': 'application/json' } : {}), body: b ? JSON.stringify(b) : undefined }); return { ok: r.ok, d: await r.json().catch(() => ({})) }; }; }

(async () => {
  let fails = 0;
  const sfx = Date.now().toString(36);
  const A = await reg('ShowA_' + sfx);
  const rA = mk(A.cookie);

  // On crée 7 succès faciles (dépenser au moins 1 crédit, satisfait par le premier achat de booster) pour tester la limite de 5
  const ids = [];
  for (let i = 0; i < 7; i++) {
    const c = await rA('/api/admin/achievements', 'POST', { code: 'admin123', name: 'Succès ' + i, condition: { type: 'credits_spent', target: 1 } });
    ids.push(c.d.achievement.id);
  }
  // Déclenche une vérification (n'importe quelle action qui appelle awardAchievements) pour les débloquer tous
  await rA('/api/admin/users/' + A.profile.slug + '/credits', 'POST', { code: 'admin123', delta: 500 });
  await rA('/api/admin/extensions/base', 'PATCH', { code: 'admin123', boosterCreditPrice: 10 });
  await rA('/api/shop/buy-booster', 'POST', { extensionId: 'base', currency: 'credits' }); // dépense des crédits -> déclenche awardAchievements

  const mine = await rA('/api/achievements');
  const unlockedCount = mine.d.achievements.filter(a => a.unlocked).length;
  console.log(unlockedCount >= 7 ? '✅ Les 7 succès de test sont bien débloqués (target:0 toujours vrai)' : '❌ pas tous débloqués (' + unlockedCount + '/7)');

  /* ---------- Mettre plus de 5 succès en vitrine est refusé ---------- */
  const tooMany = await rA('/api/me/showcase', 'POST', { achievementIds: ids });
  console.log(!tooMany.ok ? '✅ Plus de 5 succès en vitrine est refusé' : '❌ accepté à tort'); if (tooMany.ok) fails++;

  /* ---------- Un succès non débloqué ne peut pas être mis en vitrine ---------- */
  const fakeAch = await rA('/api/admin/achievements', 'POST', { code: 'admin123', name: 'Jamais débloqué', condition: { type: 'total_wins', target: 9999 } });
  const withLocked = await rA('/api/me/showcase', 'POST', { achievementIds: [ids[0], fakeAch.d.achievement.id] });
  console.log(!withLocked.ok ? '✅ Un succès non débloqué est refusé dans la vitrine' : '❌ accepté à tort'); if (withLocked.ok) fails++;

  /* ---------- Une vitrine valide (5 succès débloqués) est acceptée ---------- */
  const valid = await rA('/api/me/showcase', 'POST', { achievementIds: ids.slice(0, 5) });
  console.log(valid.ok && valid.d.showcase.length === 5 ? '✅ Vitrine de 5 succès débloqués acceptée' : '❌ ' + valid.d.error);
  if (!valid.ok) fails++;

  /* ---------- /api/achievements renvoie bien la vitrine actuelle ---------- */
  const check = await rA('/api/achievements');
  console.log(JSON.stringify(check.d.showcase) === JSON.stringify(ids.slice(0, 5)) ? '✅ La vitrine actuelle est bien renvoyée par /api/achievements' : '❌ vitrine incorrecte');

  /* ---------- Un autre joueur voit la vitrine (nom + icône) sur le profil consulté ---------- */
  const B = await reg('ShowB_' + sfx);
  const rB = mk(B.cookie);
  const viewA = await rB('/api/players/' + A.profile.slug);
  console.log(viewA.d.achievementShowcase && viewA.d.achievementShowcase.length === 5 ? '✅ Un autre joueur voit bien les 5 succès de la vitrine' : '❌ vitrine non visible pour un autre joueur');
  console.log(viewA.d.achievementShowcase && viewA.d.achievementShowcase[0].name ? '✅ Chaque entrée de la vitrine a bien un nom' : '❌ nom manquant');
  if (!viewA.d.achievementShowcase || viewA.d.achievementShowcase.length !== 5) fails++;

  /* ---------- Réduire la vitrine à 0 (vider) est autorisé ---------- */
  const empty = await rA('/api/me/showcase', 'POST', { achievementIds: [] });
  console.log(empty.ok && empty.d.showcase.length === 0 ? '✅ Vider la vitrine est autorisé' : '❌ vidage refusé');

  console.log(fails === 0 ? '\n✅ Vitrine de succès validée.' : '\n❌ ' + fails + ' échec(s)');
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('❌', e.message, e.stack); process.exit(1); });

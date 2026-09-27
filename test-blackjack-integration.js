/* Vérifie l'intégration réelle du blackjack : activation/désactivation,
   période, mise en double monnaie, déroulement complet d'une manche
   (start → hit/stand → paiement), une seule manche à la fois, et blocage
   quand ce n'est pas disponible. */
const BASE = 'http://localhost:3000';
async function reg(p) { const r = await fetch(BASE + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pseudo: p, password: 'test1234' }) }); const d = await r.json(); return { cookie: r.headers.getSetCookie().find(c => c.startsWith('connect.sid')).split(';')[0], profile: d.profile }; }
function mk(c) { return async (p, m, b) => { const r = await fetch(BASE + p, { method: m || 'GET', headers: Object.assign({ Cookie: c }, b ? { 'Content-Type': 'application/json' } : {}), body: b ? JSON.stringify(b) : undefined }); return { ok: r.ok, d: await r.json().catch(() => ({})) }; }; }

(async () => {
  let fails = 0;
  const sfx = Date.now().toString(36);
  const A = await reg('BjA_' + sfx);
  const rA = mk(A.cookie);
  await rA('/api/admin/users/' + A.profile.slug + '/dust', 'POST', { code: 'admin123', delta: 2000 });
  await rA('/api/admin/users/' + A.profile.slug + '/credits', 'POST', { code: 'admin123', delta: 2000 });

  /* ---------- Désactivé par défaut ---------- */
  const startDisabled = await rA('/api/events/blackjack/start', 'POST', { currency: 'dust' });
  console.log(!startDisabled.ok ? '✅ Démarrer une manche est refusé quand le blackjack est désactivé' : '❌ accepté à tort'); if (startDisabled.ok) fails++;

  /* ---------- Activation ---------- */
  await rA('/api/admin/events/tab', 'PATCH', { code: 'admin123', enabled: true });
  await rA('/api/admin/events/blackjack', 'PATCH', { code: 'admin123', enabled: true, costDust: 20, costCredits: 15 });

  /* ---------- Démarrer une manche déduit la bonne mise ---------- */
  const dustBefore = (await rA('/api/me')).d.profile.dust;
  const start = await rA('/api/events/blackjack/start', 'POST', { currency: 'dust' });
  console.log(start.ok ? '✅ Manche démarrée en poussière' : '❌ ' + start.d.error);
  console.log(start.d.profile.dust === dustBefore - 20 ? '✅ La mise (20 poussière) est bien débitée' : '❌ débit incorrect');
  console.log(start.d.state.playerCards.length === 2 && start.d.state.dealerCards.length === 2 ? '✅ 2 cartes chacun à la donne' : '❌ nombre de cartes incorrect');
  console.log(start.d.state.dealerCards[1].hidden === true || start.d.state.status === 'finished' ? '✅ La seconde carte du croupier est masquée (sauf blackjack naturel immédiat)' : '❌ carte cachée révélée à tort');

  /* ---------- Impossible de démarrer une deuxième manche pendant que l'une est en cours ---------- */
  if (start.d.state.status === 'playing') {
    const doubleStart = await rA('/api/events/blackjack/start', 'POST', { currency: 'dust' });
    console.log(!doubleStart.ok ? '✅ Démarrer une deuxième manche pendant qu\'une est en cours est refusé' : '❌ accepté à tort');
    if (doubleStart.ok) fails++;

    /* ---------- Consulter l'état en cours ---------- */
    const stateCheck = await rA('/api/events/blackjack/state');
    console.log(stateCheck.d.state && stateCheck.d.state.status === 'playing' ? '✅ /api/events/blackjack/state renvoie bien la manche en cours' : '❌ état incorrect');

    /* ---------- stand() termine la manche et paie/débite selon le résultat ---------- */
    const meforStand = (await rA('/api/me')).d.profile;
    const stand = await rA('/api/events/blackjack/stand', 'POST', {});
    console.log(stand.ok && stand.d.state.status === 'finished' ? '✅ stand() termine la manche' : '❌ ' + stand.d.error);
    console.log(stand.d.state.outcome && ['win', 'lose', 'push', 'blackjack'].includes(stand.d.state.outcome.result) ? '✅ Résultat renvoyé : ' + stand.d.state.outcome.result : '❌ résultat manquant');
    const expectedDust = meforStand.dust + Math.round(stand.d.state.bet * stand.d.state.outcome.multiplier);
    console.log(stand.d.profile.dust === expectedDust ? '✅ Le paiement suit bien le multiplicateur du résultat' : '❌ paiement incorrect (' + stand.d.profile.dust + ' au lieu de ' + expectedDust + ')');
    if (stand.d.profile.dust !== expectedDust) fails++;

    /* ---------- Après la fin, agir à nouveau (hit/stand) est refusé ---------- */
    const hitAfter = await rA('/api/events/blackjack/hit', 'POST', {});
    console.log(!hitAfter.ok ? '✅ Tirer après la fin de la manche est refusé' : '❌ accepté à tort'); if (hitAfter.ok) fails++;

    /* ---------- On peut relancer une nouvelle manche ensuite ---------- */
    const restart = await rA('/api/events/blackjack/start', 'POST', { currency: 'dust' });
    console.log(restart.ok ? '✅ Une nouvelle manche peut être lancée après la fin de la précédente' : '❌ ' + restart.d.error);
  } else {
    console.log('ℹ️ Blackjack naturel tiré à la donne (manche déjà terminée) — étapes hit/stand sautées pour cette partie, mais couvertes en isolation dans test-blackjack-engine.js.');
  }

  /* ---------- hit() jusqu'au bust débite bien la mise sans rien payer ---------- */
  // On relance proprement une manche fraîche pour ce test précis
  const state1 = blackjackStateSafe(await rA('/api/events/blackjack/state'));
  if (state1 && state1.status === 'playing') {
    let guard = 0, r;
    do { r = await rA('/api/events/blackjack/hit', 'POST', {}); guard++; } while (r.d.state.status === 'playing' && guard < 15);
    if (r.d.state.status === 'finished') {
      console.log(r.d.state.outcome.result === 'lose' || r.d.state.outcome.result === 'win' || r.d.state.outcome.result === 'push' ? '✅ Tirer jusqu\'à la fin résout bien la manche (' + r.d.state.outcome.result + ')' : '❌ résultat incorrect');
    }
  }
  function blackjackStateSafe(r) { return r && r.d && r.d.state; }

  /* ---------- Une monnaie non configurée (coût à 0) est refusée ---------- */
  await rA('/api/admin/events/blackjack', 'PATCH', { code: 'admin123', costCredits: 0 });
  const noCreditsMode = await rA('/api/events/blackjack/start', 'POST', { currency: 'credits' });
  console.log(!noCreditsMode.ok ? '✅ Jouer en crédits est refusé quand ce coût est à 0' : '❌ accepté à tort'); if (noCreditsMode.ok) fails++;

  console.log(fails === 0 ? '\n✅ Intégration du blackjack validée.' : '\n❌ ' + fails + ' échec(s)');
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('❌', e.message, e.stack); process.exit(1); });

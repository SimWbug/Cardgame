/* ============================================================
   CLEAN GANG DECKS — client
   Auth REST + combat temps réel Socket.io
   ============================================================ */

const RARITIES = {
  commun: { label: 'Commun', color: 'var(--commun)' },
  rare: { label: 'Rare', color: 'var(--rare)' },
  epique: { label: 'Épique', color: 'var(--epique)' },
  legendaire: { label: 'Légendaire', color: 'var(--legendaire)' }
};
const COPY_LIMITS = { commun: 2, rare: 2, epique: 2, legendaire: 1 };
const DUST_VALUES = { commun: 1, rare: 2, epique: 10, legendaire: 250 };
const DECK_SIZE = 30;

let S = {
  profile: null, cardPool: [], config: null, tab: 'collection',
  gateMode: 'login', gateError: null,
  packStatus: { ready: false, remainingMs: 0 }, packAnim: null, lastDrawn: null, lastSubTab: {},
  deckDraft: null,
  viewedPlayer: null, playersList: [], friends: [], playerFilter: '',
  trades: { received: [], sent: [] }, tradeBuilder: null,
  duplicates: [], shop: null, leaderboard: null,
  isAdmin: false, adminCodeTry: '', adminCardType: 'minion',
  socket: null,
  queueStatus: 'idle', matchState: null,
  selectedAttacker: null, targetingSpell: null, matchError: null,
  incomingChallenge: null, challengeNotice: null,
  emoteWheelOpen: false, activeEmotes: {}, shopTab: 'ornaments', wheelDraft: null, wheelSlot: 0,
  soundOn: true, nowPlaying: null,
  adminTab: 'cards', adminCardRarity: 'commun', adminCustomDrop: false,
  adminUsers: null, adminUserFilter: '', adminViewedUser: null,
  card3DView: null, card3DError: null,
  extensions: [], adminEditingCardId: null, adminExtCodeTry: '', shopBoosterTab: 'ornaments',
  codex: null, codexExt: 'base', combatAnim: null, mulliganSelected: null, savedDecks: [], settings: null, content: null,
  events: null, bossAvailableToday: null, casinoResult: null, casinoSpinning: false,
  bossDeckDraft: null, bossDialogueDraft: null, bossDialogueShown: new Set(), bossDialogueActive: null,
  adminAchievements: [], adminConditionTypes: {}, adminAchievementType: 'cards_played_type',
  achievements: [], achievementToast: null, casinoReelDisplay: ['❔','❔','❔'], showcaseDraft: null, blackjackState: null,
  packOpeningExtensionId: null, creditPacks: [], adminCreditPacks: [], matchResultOverlay: null, adminCardParallax: false, adminSpellEffect: null
};

async function api(path, method, body) {
  const res = await fetch(path, {
    method: method || 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin'
  });
  let data = {};
  try { data = await res.json(); } catch (e) {}
  if (!res.ok) throw new Error(data.error || 'Erreur inconnue.');
  return data;
}

/* ---------- Images allégées AVANT l'envoi (dans le navigateur) ----------
   Les PNG/JPG sont réduits à une taille utile puis convertis en WebP, plus
   léger. Aucune bibliothèque côté serveur. Si le navigateur ne sait pas
   produire de WebP (ancien Safari) ou si le résultat est plus lourd, on
   envoie l'image d'origine. Les GIF ne sont pas touchés. */
const IMAGE_MAX_SIDE = path => /avatar/i.test(path) ? 512 : /card/i.test(path) ? 1200 : 1600;
async function shrinkImage(file, maxSide) {
  if (!(file instanceof Blob) || !/^image\/(png|jpeg|webp)$/.test(file.type)) return file;
  try {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * k)), h = Math.max(1, Math.round(bmp.height * k));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
    if (bmp.close) bmp.close();
    const blob = await new Promise(r => canvas.toBlob(r, 'image/webp', 0.82));
    if (!blob || blob.type !== 'image/webp' || (blob.size >= file.size && k === 1)) return file;
    const name = String(file.name || 'image').replace(/\.[^.]+$/, '') + '.webp';
    return new File([blob], name, { type: 'image/webp' });
  } catch (e) { return file; }
}
async function upload(path, formData) {
  // Les images du formulaire sont allégées avant l'envoi
  const fd = new FormData();
  for (const [k, v] of formData.entries()) {
    if (v instanceof File && /^image\//.test(v.type)) { const f = await shrinkImage(v, IMAGE_MAX_SIDE(path + ' ' + k)); fd.append(k, f, f.name); }
    else fd.append(k, v);
  }
  formData = fd;
  const res = await fetch(path, { method: 'POST', body: formData, credentials: 'same-origin' });
  let data = {};
  try { data = await res.json(); } catch (e) {}
  if (!res.ok) throw new Error(data.error || 'Envoi échoué.');
  return data;
}

function cardById(id) { return S.cardPool.find(c => c.id === id); }
/* L'admin (code vérifié) voit aussi les extensions cachées et leurs cartes */
function adminQuery() { return S.isAdmin && S.adminCodeTry ? '?code=' + encodeURIComponent(S.adminCodeTry) : ''; }
function cardsUrl() { return '/api/cards' + adminQuery(); }
function extsUrl() { return '/api/extensions' + adminQuery(); }

/* ---------------- Glisser-déposer d'une carte (main → champ de bataille) ----------------
   Un vrai <div draggable> ne permet pas d'appliquer une inclinaison 3D qui suit
   le curseur (l'image de glisser-déposer native est une capture figée). On
   suit donc le pointeur à la main et on déplace un "fantôme" en position fixe. */
let cardDrag = null;
const DRAG_THRESHOLD = 8; // px avant de considérer que c'est un vrai glisser, pas un simple clic

function onCardDragMove(e) {
  if (!cardDrag) return;
  const dx = e.clientX - cardDrag.startX;
  const dy = e.clientY - cardDrag.startY;

  if (!cardDrag.dragging) {
    if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return; // encore un simple clic potentiel
    cardDrag.dragging = true;
    const ghost = cardDrag.originEl.cloneNode(true);
    ghost.className = String(cardDrag.originEl.className || 'hand-card').replace('drag-source-hidden', '').trim() + ' drag-ghost';
    ghost.style.position = 'fixed';
    ghost.style.bottom = 'auto';
    ghost.style.width = cardDrag.w + 'px';
    ghost.style.height = cardDrag.h + 'px';
    ghost.style.transformOrigin = `${cardDrag.offsetX}px ${cardDrag.offsetY}px`; // la carte reste sous le doigt
    document.body.appendChild(ghost);
    cardDrag.ghostEl = ghost;
    cardDrag.originEl.classList.add('drag-source-hidden');
    if (document.body && document.body.classList) document.body.classList.add('card-dragging'); // curseur « main fermée » partout
  }

  const ghost = cardDrag.ghostEl;
  const x = e.clientX - cardDrag.offsetX;
  const y = e.clientY - cardDrag.offsetY;
  ghost.style.left = x + 'px';
  ghost.style.top = y + 'px';

  const tiltY = Math.max(-28, Math.min(28, dx * 0.18));
  const lift = Math.min(1, Math.max(0, -dy) / 220); // plus on lève la carte, plus elle se redresse/grossit
  ghost.style.transform = `perspective(700px) rotateY(${tiltY}deg) rotateX(${-8 - lift * 14}deg) scale(${(1.05 + lift * 0.18) * (cardDrag.fit || 1)}) translateZ(0)`;

  const handRow = document.querySelector('.board-screen.premium .hand-row');
  const handTop = handRow ? handRow.getBoundingClientRect().top : window.innerHeight;
  const overBoard = e.clientY < handTop - 10;
  cardDrag.overBoard = overBoard;
  const boardEl = document.querySelector('.board-row.mine');
  if (boardEl) boardEl.classList.toggle('drop-target-active', overBoard);
  ghost.classList.toggle('drag-ready', overBoard);
}

function onCardDragEnd() {
  window.removeEventListener('pointermove', onCardDragMove);
  window.removeEventListener('pointerup', onCardDragEnd);
  if (!cardDrag) return;
  const { cardId, dragging, ghostEl, originEl, overBoard } = cardDrag;
  if (document.body && document.body.classList) document.body.classList.remove('card-dragging');
  document.querySelectorAll('.board-row.mine').forEach(el => el.classList.remove('drop-target-active'));

  if (!dragging) {
    // Un simple clic (sans glisser) ouvre la visionneuse 3D pour lire la carte,
    // c'est le glisser jusqu'au plateau qui la joue (voir plus bas).
    cardDrag = null;
    App.open3DView(cardId);
    return;
  }

  originEl.classList.remove('drag-source-hidden');
  if (overBoard) {
    ghostEl.remove();
    cardDrag = null;
    App.clickHand(cardId); // logique de jeu (pose immédiate ou entrée en ciblage)
  } else {
    // Relâchée en dehors du plateau : la carte revient à la main
    const rect = originEl.getBoundingClientRect();
    ghostEl.style.transition = 'left .22s ease, top .22s ease, transform .22s ease';
    ghostEl.style.left = rect.left + 'px';
    ghostEl.style.top = rect.top + 'px';
    ghostEl.style.transform = 'none';
    setTimeout(() => ghostEl.remove(), 230);
    cardDrag = null;
  }
}

/* ---------------- Animations de combat (diff entre deux états) ----------------
   Le rendu réinjecte tout le HTML à chaque mise à jour, donc on ne peut pas
   transitionner un élément existant : à la place, on calcule ce qui a changé
   entre l'état précédent et le nouveau, et on applique des classes
   d'animation "à l'entrée" (qui rejouent naturellement puisque l'élément est
   recréé de toute façon), ciblées uniquement sur ce qui a vraiment bougé. */
let animCleanupTimer = null;
function emptyCombatAnim() {
  return {
    youHeroHit: false, youHeroHeal: false, oppHeroHit: false, oppHeroHeal: false,
    youHeroAttacked: false, oppHeroAttacked: false,
    enterIds: new Set(), hitIds: new Set(), healIds: new Set(), attackedIds: new Set(),
    dyingMinions: [], floaters: []
  };
}

/* Détecte si un héros vient d'attaquer avec son arme (durabilité en baisse
   sur la MÊME arme). Une arme remplacée par une autre (cardId différent)
   n'est jamais comptée comme une attaque. Limite connue : l'attaque qui
   brise l'arme (durabilité 0 → l'arme disparaît) n'est pas détectée, faute
   de référence pour comparer — cas rare, sans conséquence fonctionnelle. */
function detectHeroAttack(prevSide, nextSide) {
  if (!prevSide.weapon || !nextSide.weapon) return false;
  if (prevSide.weapon.cardId !== nextSide.weapon.cardId) return false;
  return nextSide.weapon.durability < prevSide.weapon.durability;
}
/* Déclenche la réplique de lore du boss dont le seuil de PV vient d'être franchi
   (une seule fois par seuil et par combat). Le "maximum" de référence pour le
   pourcentage est le PV configuré par l'admin pour ce boss, connu côté client
   depuis /api/events — pas les PV de départ standards du jeu. */
function checkBossDialogue(state) {
  const allLines = S.events && S.events.boss && S.events.boss.dialogue;
  if (!allLines || allLines.length === 0) return;
  const lines = allLines.filter(l => l.enabled !== false); // une réplique désactivée par l'admin est ignorée, comme si elle n'existait pas
  if (lines.length === 0) return;
  const maxHp = (S.events.boss.heroHealth) || state.opponent.heroHealth || 1;
  const pct = Math.max(0, Math.min(100, (state.opponent.heroHealth / maxHp) * 100));
  // On parcourt du seuil le plus BAS au plus haut, pour déclencher le seuil le plus
  // proche des PV actuels (celui qui vient d'être franchi), pas le premier trivialement
  // satisfait — sinon un boss à 45% déclencherait sa réplique à 100% au lieu de 50%.
  const ascending = lines.slice().sort((a, b) => a.hpPercent - b.hpPercent);
  for (const line of ascending) {
    if (pct <= line.hpPercent + 0.001 && !S.bossDialogueShown.has(line.hpPercent)) {
      S.bossDialogueShown.add(line.hpPercent);
      S.bossDialogueActive = line.text;
      clearTimeout(window.__bossDialogueTimer);
      window.__bossDialogueTimer = setTimeout(() => { S.bossDialogueActive = null; render(); }, 5000);
      break;
    }
  }
}

function computeCombatAnimations(prev, next) {
  if (!next) { S.combatAnim = emptyCombatAnim(); return; }
  if (!prev || prev.id !== next.id) { S.combatAnim = emptyCombatAnim(); return; }
  const anim = emptyCombatAnim();
  let floaterKey = 0;

  function diffBoard(prevBoard, nextBoard, side) {
    const prevMap = new Map((prevBoard || []).map(m => [m.instanceId, m]));
    const nextMap = new Map((nextBoard || []).map(m => [m.instanceId, m]));
    nextMap.forEach((m, id) => {
      if (!prevMap.has(id)) { anim.enterIds.add(id); return; }
      const before = prevMap.get(id);
      if (m.health < before.health) {
        anim.hitIds.add(id);
        anim.floaters.push({ key: 'f' + (floaterKey++), target: id, amount: before.health - m.health, kind: 'damage' });
      } else if (m.health > before.health) {
        anim.healIds.add(id);
        anim.floaters.push({ key: 'f' + (floaterKey++), target: id, amount: m.health - before.health, kind: 'heal' });
      }
      if (before.canAttack && !m.canAttack && !before.sickness) anim.attackedIds.add(id);
    });
    prevMap.forEach((m, id) => {
      if (!nextMap.has(id)) anim.dyingMinions.push(Object.assign({}, m, { side }));
    });
  }
  diffBoard(prev.you.board, next.you.board, 'you');
  diffBoard(prev.opponent.board, next.opponent.board, 'opp');

  if (next.you.heroHealth < prev.you.heroHealth) {
    anim.youHeroHit = true;
    anim.floaters.push({ key: 'f' + (floaterKey++), target: 'you-hero', amount: prev.you.heroHealth - next.you.heroHealth, kind: 'damage' });
  } else if (next.you.heroHealth > prev.you.heroHealth) {
    anim.youHeroHeal = true;
    anim.floaters.push({ key: 'f' + (floaterKey++), target: 'you-hero', amount: next.you.heroHealth - prev.you.heroHealth, kind: 'heal' });
  }
  if (next.opponent.heroHealth < prev.opponent.heroHealth) {
    anim.oppHeroHit = true;
    anim.floaters.push({ key: 'f' + (floaterKey++), target: 'opp-hero', amount: prev.opponent.heroHealth - next.opponent.heroHealth, kind: 'damage' });
  } else if (next.opponent.heroHealth > prev.opponent.heroHealth) {
    anim.oppHeroHeal = true;
    anim.floaters.push({ key: 'f' + (floaterKey++), target: 'opp-hero', amount: next.opponent.heroHealth - prev.opponent.heroHealth, kind: 'heal' });
  }

  anim.youHeroAttacked = detectHeroAttack(prev.you, next.you);
  anim.oppHeroAttacked = detectHeroAttack(prev.opponent, next.opponent);

  S.combatAnim = anim;
}
function triggerCombatAnimationCleanup() {
  clearTimeout(animCleanupTimer);
  // Les serviteurs morts restent affichés (fondu) un court instant avant de disparaître pour de bon
  const a = S.combatAnim;
  const hadDying = a && a.dyingMinions.length > 0;
  const hadAction = a && (a.hitIds.size > 0 || a.healIds.size > 0 || a.enterIds.size > 0 || a.youHeroHit || a.oppHeroHit || a.youHeroHeal || a.oppHeroHeal);
  // Durée de la charge (voir playCombatFx) : l'impact et la mort doivent se jouer
  // en entier avant que le re-rendu ne recrée le plateau sans ces classes.
  const chargeTime = (a && a.chargeDuration) || 0;
  animCleanupTimer = setTimeout(() => {
    S.combatAnim = emptyCombatAnim();
    render();
  }, chargeTime + (hadDying ? 700 : hadAction ? 650 : 60));
}

/* ---------------- Effets de combat pilotés en JS ----------------
   Les classes CSS ne connaissent que "cet élément a attaqué" : elles ne
   savent pas OÙ est la cible. Ici, après le rendu, on mesure les vraies
   positions à l'écran et on fait charger l'attaquant jusqu'à sa cible
   (recul, élan, impact, retour), puis on déclenche l'impact au bon moment,
   cible par cible : secousse, étoile de dégâts, PV qui baissent, éclats.

   Fluidité : quand c'est TOI qui attaques, la charge démarre dès le clic
   (sans attendre la réponse du serveur). Quand l'état arrive, le plateau est
   redessiné et la charge reprend exactement là où elle en était, grâce à un
   délai négatif — pas de saut, pas de temps mort. */
let FX_WINDUP = 220, FX_DASH = 130, FX_BACK = 340, FX_STAGGER = 380;
let FX_IMPACT = FX_WINDUP + FX_DASH, FX_TOTAL = FX_WINDUP + FX_DASH + FX_BACK;
/* Option « animations rapides » : toutes les durées de combat divisées par deux */
function setFxSpeed(f) {
  FX_WINDUP = Math.round(220 * f); FX_DASH = Math.round(130 * f); FX_BACK = Math.round(340 * f); FX_STAGGER = Math.round(380 * f);
  FX_IMPACT = FX_WINDUP + FX_DASH; FX_TOTAL = FX_WINDUP + FX_DASH + FX_BACK;
  LEGEND_ENTRY_MS = Math.round(1500 * f);
}
let pendingCharge = null; // { attackerId, targetSel, startedAt } — charge lancée au clic, en attente de l'état serveur

function fxReducedMotion() { return OPTS.anim === 'reduced' || !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }
function fxLayer() {
  let l = document.getElementById('combat-fx-layer');
  if (!l) {
    l = document.createElement('div');
    l.id = 'combat-fx-layer';
    document.body.appendChild(l);
  }
  return l;
}
function fxCenter(el) { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }
function fxBoardScale() {
  const b = document.querySelector('.board-screen.premium');
  if (!b || !b.offsetWidth) return 1;
  return (b.getBoundingClientRect().width / b.offsetWidth) || 1;
}
function fxBurst(x, y, colors, n, spread, size) {
  const layer = fxLayer();
  for (let i = 0; i < n; i++) {
    const p = document.createElement('div');
    const s = size * (0.5 + Math.random() * 0.9);
    const c = colors[i % colors.length];
    p.className = 'fx-particle';
    p.style.cssText = `left:${x}px;top:${y}px;width:${s}px;height:${s}px;background:${c};box-shadow:0 0 ${s}px ${c};`;
    layer.appendChild(p);
    const a = Math.random() * Math.PI * 2, r = spread * (0.3 + Math.random() * 0.7);
    p.animate([
      { transform: 'translate(-50%,-50%) scale(1)', opacity: 1 },
      { transform: `translate(calc(-50% + ${Math.cos(a) * r}px), calc(-50% + ${Math.sin(a) * r}px)) scale(.2)`, opacity: 0 }
    ], { duration: 650 + Math.random() * 400, easing: 'cubic-bezier(.1,.7,.3,1)', fill: 'forwards' }).finished.then(() => p.remove()).catch(() => p.remove());
  }
}
function fxShake(amp) {
  const board = document.querySelector('.board-screen.premium');
  if (!board || !board.animate) return;
  const k = [];
  for (let i = 0; i < 8; i++) { const a = amp * (1 - i / 8); k.push({ translate: `${(Math.random() - .5) * 2 * a}px ${(Math.random() - .5) * 2 * a}px` }); }
  k.push({ translate: '0 0' });
  board.animate(k, { duration: 340 });
}
function fxMinionEl(id) { return document.querySelector(`.minion[data-iid="${CSS.escape(id)}"]`); }
function fxAttackerEl(attackerId) { return attackerId === 'hero' ? document.querySelector('[data-hero="you"]') : fxMinionEl(attackerId); }

/* Associe chaque attaquant à une cible du camp d'en face, à partir du diff
   d'état : serviteur touché, serviteur mort, ou héros touché. Si l'attaque
   vient d'un clic de ta part, on connaît la cible exacte (pendingCharge). */
function findChargePairs(anim) {
  const q = sel => document.querySelector(sel);
  // Cas normal : le serveur dit exactement qui a attaqué qui (événements « attack »)
  const evAttacks = (S.newEvents || []).filter(e => e.type === 'attack');
  if (evAttacks.length && S.matchState) {
    const mySlug = S.matchState.you.slug;
    const elFor = ref => ref.kind === 'hero' ? q(`[data-hero="${ref.owner === mySlug ? 'you' : 'opp'}"]`) : fxMinionEl(ref.id);
    const exact = [];
    evAttacks.forEach(e => {
      const a = elFor(e.attacker), tg = elFor(e.target);
      if (!a || !tg) return;
      const mine = e.by === mySlug;
      exact.push({ attacker: a, target: tg, mine, pending: !!(mine && pendingCharge && fxAttackerEl(pendingCharge.attackerId) === a) });
    });
    if (exact.length) return exact;
  }
  const isMine = el => { const r = el && el.closest('.board-row'); return !!(r && r.classList.contains('mine')); };
  const targetsOn = (sideMine) => {
    const list = [];
    anim.hitIds.forEach(id => { const el = fxMinionEl(id); if (el && isMine(el) === sideMine) list.push(el); });
    document.querySelectorAll('.minion.minion-dying').forEach(el => { if (isMine(el) === sideMine) list.push(el); });
    const hero = q(`[data-hero="${sideMine ? 'you' : 'opp'}"]`);
    if (hero && (sideMine ? anim.youHeroHit : anim.oppHeroHit)) list.push(hero);
    return list;
  };
  const mineAttackers = [], oppAttackers = [];
  anim.attackedIds.forEach(id => { const el = fxMinionEl(id); if (el) (isMine(el) ? mineAttackers : oppAttackers).push(el); });
  if (anim.youHeroAttacked) { const h = q('[data-hero="you"]'); if (h) mineAttackers.push(h); }
  if (anim.oppHeroAttacked) { const h = q('[data-hero="opp"]'); if (h) oppAttackers.push(h); }
  const oppTargets = targetsOn(false), myTargets = targetsOn(true);
  const pairs = [];
  // Ton attaque lancée au clic : attaquant et cible sont connus exactement,
  // même si l'un des deux vient de mourir (il est encore affiché, en train de disparaître).
  let pendingAttacker = null;
  if (pendingCharge) {
    const a = fxAttackerEl(pendingCharge.attackerId), t = q(pendingCharge.targetSel);
    if (a && t) { pendingAttacker = a; pairs.push({ attacker: a, target: t, mine: true, pending: true }); }
  }
  mineAttackers.forEach((a, i) => {
    if (a === pendingAttacker) return;
    pairs.push({ attacker: a, target: oppTargets.length ? oppTargets[i % oppTargets.length] : q('[data-hero="opp"]'), mine: true });
  });
  oppAttackers.forEach((a, i) => pairs.push({ attacker: a, target: myTargets.length ? myTargets[i % myTargets.length] : q('[data-hero="you"]'), mine: false }));
  return pairs.filter(p => p.attacker && p.target);
}

/* Anime une charge. startAt > 0 = reprend une charge déjà commencée (ms déjà
   écoulées), startAt < 0 = démarre plus tard (enchaînement de plusieurs attaques). */
function fxChargeAnim(attacker, target, startAt) {
  const scale = fxBoardScale();
  const a = fxCenter(attacker), t = fxCenter(target);
  const dx = (t.x - a.x) / scale, dy = (t.y - a.y) / scale;
  const len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len;
  const stop = Math.min(len * 0.35, 70); // s'arrête au contact, pas au centre de la cible
  const back = `translate(${(-ux * 34).toFixed(1)}px,${(-uy * 34).toFixed(1)}px) scale(1.1)`;
  const hit = `translate(${(dx - ux * stop).toFixed(1)}px,${(dy - uy * stop).toFixed(1)}px) scale(1.12)`;
  attacker.style.zIndex = 40;
  attacker.animate([
    { transform: 'translate(0,0) scale(1)', offset: 0, easing: 'cubic-bezier(.3,0,.2,1)' },
    { transform: back, offset: FX_WINDUP / FX_TOTAL, easing: 'cubic-bezier(.6,0,1,.6)' },
    { transform: hit, offset: FX_IMPACT / FX_TOTAL, easing: 'cubic-bezier(.2,.8,.2,1)' },
    { transform: 'translate(0,0) scale(1)', offset: 1 }
  ], { duration: FX_TOTAL, delay: -startAt }).finished.then(() => { attacker.style.zIndex = ''; }).catch(() => {});
}

/* Lancée au clic sur une cible : la charge part tout de suite, le serveur
   répond pendant l'élan. Renvoie false si rien n'a pu être animé (le rendu
   classique prend alors le relais). */
function startOptimisticCharge(attackerId, targetSel) {
  if (fxReducedMotion()) return false;
  const attacker = fxAttackerEl(attackerId), target = document.querySelector(targetSel);
  if (!attacker || !target) return false;
  const board = document.querySelector('.board-screen.premium');
  if (board) board.querySelectorAll('.selected,.targetable').forEach(el => el.classList.remove('selected', 'targetable'));
  fxChargeAnim(attacker, target, 0);
  pendingCharge = { attackerId, targetSel, startedAt: performance.now() };
  clearTimeout(window.__pendingChargeTimer);
  window.__pendingChargeTimer = setTimeout(() => { pendingCharge = null; }, 2500);
  return true;
}

/* À l'impact : les PV affichés passent de l'ancienne à la nouvelle valeur,
   la cible encaisse (secousse + étincelles + son). Avant l'impact, on garde
   l'ancienne valeur à l'écran pour ne pas « spoiler » le coup. */
function fxHoldHp(target, anim, impactIn) {
  const isHero = target.matches('[data-hero]');
  const key = isHero ? (target.dataset.hero === 'you' ? 'you-hero' : 'opp-hero') : target.dataset.iid;
  const fl = anim.floaters.find(f => f.target === key);
  const gem = target.querySelector(isHero ? '.hp-gem' : '.hp-gem-minion');
  if (!fl || !gem || impactIn <= 0) return;
  const now = gem.textContent;
  const before = fl.kind === 'damage' ? Number(now) + fl.amount : Number(now) - fl.amount;
  if (!Number.isFinite(before)) return;
  gem.textContent = before;
  setTimeout(() => { if (document.body.contains(gem)) gem.textContent = now; }, impactIn);
}
function fxImpact(target, impactIn) {
  const container = target.matches('[data-hero]') ? (target.closest('.hero-row') || target) : target;
  container.style.setProperty('--impact-delay', Math.max(0, impactIn) + 'ms');
  setTimeout(() => {
    if (!document.body.contains(target)) return;
    const c = fxCenter(target);
    fxBurst(c.x, c.y, ['#ffb347', '#ff5a3a', '#fff1c7'], 14, 90, 8);
    fxShake(target.matches('[data-hero]') ? 9 : 5);
    playGameSound('attackHit', () => window.SFX && SFX.attackHit());
    if (target.classList.contains('minion-dying')) fxBurst(c.x, c.y, ['#c9b58a', '#8a6d3b', '#fff1c7'], 20, 130, 9);
  }, Math.max(0, impactIn));
}

/* Entrée spéciale d'une légendaire : la carte apparaît en grand au centre de
   l'écran dans un halo doré, puis plonge vers sa place sur la table, qui
   tremble sous l'impact. Le serviteur reste caché jusqu'à l'impact. */
let LEGEND_ENTRY_MS = 1500;
function fxLegendaryEntry(el, m) {
  const layer = fxLayer();
  const target = fxCenter(el);
  el.style.opacity = '0';
  const card = cardById(m.cardId) || {};
  const img = m.image || card.image;
  const o = document.createElement('div');
  o.className = 'legend-entry';
  o.innerHTML = `<div class="le-rays"></div><div class="le-card">${img ? `<img src="${esc(img)}" alt="">` : '<span>👑</span>'}<b>${esc(m.name)}</b><small>Légendaire</small></div>`;
  layer.appendChild(o);
  if (window.SFX && S.soundOn && SFX.cardReveal) SFX.cardReveal('legendaire');
  const cardEl = o.querySelector('.le-card');
  const vw = window.innerWidth, vh = window.innerHeight;
  cardEl.animate([
    { transform: 'translate(-50%,-50%) scale(.2) rotate(-8deg)', opacity: 0 },
    { transform: 'translate(-50%,-50%) scale(1.08) rotate(2deg)', opacity: 1, offset: .25 },
    { transform: 'translate(-50%,-50%) scale(1) rotate(0deg)', opacity: 1, offset: .62 },
    { transform: `translate(calc(-50% + ${target.x - vw / 2}px), calc(-50% + ${target.y - vh / 2}px)) scale(.25)`, opacity: .9, offset: 1 }
  ], { duration: LEGEND_ENTRY_MS - 200, easing: 'cubic-bezier(.3,.7,.3,1)', fill: 'forwards' });
  o.querySelector('.le-rays').animate([{ opacity: 0 }, { opacity: 1, offset: .2 }, { opacity: 1, offset: .6 }, { opacity: 0 }], { duration: LEGEND_ENTRY_MS - 200, fill: 'forwards' });
  setTimeout(() => {
    o.remove();
    if (document.body.contains(el)) {
      el.style.opacity = '';
      el.animate([{ transform: 'scale(1.6)', opacity: 0 }, { transform: 'scale(.92)', opacity: 1, offset: .6 }, { transform: 'scale(1)', opacity: 1 }], { duration: 320, easing: 'cubic-bezier(.5,0,.75,.2)' });
    }
    fxBurst(target.x, target.y, ['#f5c542', '#fff3c4', '#ffb000'], 40, 200, 10);
    fxShake(14);
  }, LEGEND_ENTRY_MS - 200);
}

function playCombatFx(anim) {
  if (!anim || typeof document === 'undefined') return;
  const board = document.querySelector('.board-screen.premium');
  if (!board) return;
  const reduce = fxReducedMotion();
  board.style.setProperty('--impact-delay', '0ms');

  // Poussière quand un serviteur arrive sur le plateau ; entrée spéciale pour une légendaire
  let legendaryEntry = 0;
  if (!reduce) anim.enterIds.forEach(id => {
    const el = fxMinionEl(id);
    const st = S.matchState;
    const m = st && st.you.board.concat(st.opponent.board).find(x => x.instanceId === id);
    if (el && m && m.rarity === 'legendaire') { fxLegendaryEntry(el, m); legendaryEntry = LEGEND_ENTRY_MS; return; }
    if (el) setTimeout(() => { const c = fxCenter(el); fxBurst(c.x, c.y + 30, ['#c9b58a', '#8a6d3b'], 12, 70, 6); }, 180);
  });

  const pairs = reduce ? [] : findChargePairs(anim);
  const handled = new Set();
  let longest = 0, queue = 0;
  pairs.forEach(p => {
    // Ta propre attaque déjà lancée au clic : on reprend là où elle en est
    let elapsed = 0;
    if (p.pending && pendingCharge) {
      elapsed = Math.min(FX_TOTAL, performance.now() - pendingCharge.startedAt);
      pendingCharge = null;
    } else {
      elapsed = -queue * FX_STAGGER; // attaques adverses : l'une après l'autre
      queue++;
    }
    if (elapsed < FX_TOTAL) fxChargeAnim(p.attacker, p.target, elapsed);
    const impactIn = FX_IMPACT - elapsed;
    if (!handled.has(p.target)) {
      handled.add(p.target);
      fxHoldHp(p.target, anim, impactIn);
      fxImpact(p.target, impactIn);
    }
    // Riposte encaissée par l'attaquant : elle aussi n'apparaît qu'au contact
    const attackerBox = p.attacker.matches('[data-hero]') ? (p.attacker.closest('.hero-row') || p.attacker) : p.attacker;
    // Un attaquant qui meurt dans l'échange finit sa charge, revient, puis vole en éclats
    const attackerDelay = p.attacker.classList.contains('minion-dying') ? FX_TOTAL - elapsed : impactIn;
    attackerBox.style.setProperty('--impact-delay', Math.max(0, attackerDelay) + 'ms');
    fxHoldHp(p.attacker, anim, impactIn);
    longest = Math.max(longest, FX_TOTAL - elapsed);
  });
  anim.chargeDuration = Math.max(0, longest, legendaryEntry);

  // Coups sans charge (sorts, effets) : impact immédiat
  document.querySelectorAll('.minion.minion-dying').forEach(el => {
    if (handled.has(el)) return;
    const c = fxCenter(el);
    fxBurst(c.x, c.y, ['#c9b58a', '#8a6d3b', '#fff1c7'], 20, 130, 9);
  });
  if (!pairs.length && (anim.youHeroHit || anim.oppHeroHit)) fxShake(8);
}

/* Mode de ciblage pour un effet de sort (sort ou cri de guerre). null = sans cible. */
/* Effets possibles d'un cri de guerre (outil de création) */

/* Champs « cartes spéciales » de l'outil de création :
   - carte spéciale (jamais dans les boosters, n'apparaît que via des effets)
   - liste des cartes que peut donner l'effet « Donner des cartes au hasard »
   - combo : partenaire + carte qui apparaît (serviteurs) */
function renderSpecialFields(editingCard, isMinion) {
  const key = editingCard ? editingCard.id : 'new';
  if (S.randomPoolFor !== key) { S.randomPoolFor = key; S.randomPoolDraft = (editingCard && editingCard.randomPool || []).slice(); }
  const all = (S.cardPool || []).slice().sort((a, b) => String(a.name).localeCompare(String(b.name), 'fr'));
  const minions = all.filter(c => c.type === 'minion');
  const opt = (list, sel, none) => `<option value="">${none}</option>` + list.map(c => `<option value="${esc(c.id)}" ${sel === c.id ? 'selected' : ''}>${esc(c.name)}${c.unobtainable ? ' ★' : ''}</option>`).join('');
  return `<div class="special-fields">
    <label style="display:flex;gap:8px;align-items:center;font-weight:600;margin-bottom:10px;"><input type="checkbox" id="new-card-unobtainable" style="width:auto" ${editingCard && editingCard.unobtainable ? 'checked' : ''}> ★ Carte spéciale : jamais dans les boosters, elle n'apparaît que via des effets (cartes au hasard, combo…)</label>
    <details ${S.randomPoolDraft.length ? 'open' : ''}><summary>Cartes au hasard <span class="tone-tag">pour l'effet « Donner des cartes au hasard » — ${S.randomPoolDraft.length ? S.randomPoolDraft.length + ' carte(s) choisie(s)' : 'aucune : toutes les cartes du jeu'}</span></summary>
      <div class="field-row" style="margin-top:8px;"><div><select id="rp-pick">${opt(all, null, '— Choisir une carte à ajouter —')}</select></div><div style="flex:0;"><button type="button" class="btn small" onclick="App.randomPoolAdd()">Ajouter</button></div></div>
      <div class="sb-chips">${S.randomPoolDraft.map((id, i) => `<span class="sb-chip">${cardChip(id)}<button type="button" class="btn small ghost" onclick="App.randomPoolRemove(${i})">✕</button></span>`).join('')}</div>
      <input type="hidden" id="new-card-random-pool" value="${esc(S.randomPoolDraft.join(','))}">
    </details>
    ${isMinion ? `<div class="field-row" style="margin-top:10px;">
      <div><label>🔗 Combo : quand cette carte ET…</label><select id="new-card-combo-partner">${opt(minions, editingCard && editingCard.comboPartnerId, '— Pas de combo —')}</select></div>
      <div><label>…sont sur le plateau, fait apparaître</label><select id="new-card-combo-spawn">${opt(minions, editingCard && editingCard.comboSpawnId, '— Choisir le serviteur —')}</select></div>
    </div>` : ''}
  </div>`;
}

/* Lit les champs jetons / aura / piège du formulaire (ceux qui existent) */
function readMechanicsForm(tokenPrefix) {
  const out = [];
  const v = id => { const el = document.getElementById(id); return el ? el.value : undefined; };
  [['tokenName', tokenPrefix + 'name'], ['tokenAttack', tokenPrefix + 'attack'], ['tokenHealth', tokenPrefix + 'health'],
   ['auraAttack', 'new-card-aura-attack'], ['auraScope', 'new-card-aura-scope'], ['rage', 'new-card-rage'],
   ['trapTrigger', 'new-card-trap-trigger'], ['trapEffect', 'new-card-trap-effect'], ['trapValue', 'new-card-trap-value'],
   ['randomPool', 'new-card-random-pool'], ['comboPartnerId', 'new-card-combo-partner'], ['comboSpawnId', 'new-card-combo-spawn']]
    .forEach(([k, id]) => { const x = v(id); if (x !== undefined) out.push([k, x]); });
  const un = document.getElementById('new-card-unobtainable');
  if (un) out.push(['unobtainable', un.checked ? 'true' : 'false']);
  return out;
}
const BC_OPTIONS = [['', 'Aucun'], ['random_cards', 'Donner des cartes au hasard (voir « Cartes au hasard »)'], ['summon', 'Invoquer des jetons (voir « Jetons »)'], ['draw', 'Piocher des cartes'], ['armor', "Donner de l'armure à ton héros"], ['sleep', 'Endormir un serviteur (une cible)'], ['destroy', 'Détruire un serviteur au choix'], ['silence', 'Réduire un serviteur au silence (une cible)'],
  ['heal', 'Soigner (une cible amie)'], ['damage', 'Infliger des dégâts (une cible)'], ['buff_attack', "Bonus d'attaque à un allié"], ['modify_stats', "Modifier l'ATQ et les PV d'un serviteur"],
  ['give_shield', 'Donner Bouclier à un allié'], ['give_windfury', 'Donner Furie à un allié'], ['give_stealth', 'Donner Camouflage à un allié'], ['give_taunt', 'Donner Provocation à un allié'],
  ['aoe_damage', 'Dégâts à tous les serviteurs ennemis'], ['aoe_heal', 'Soin de tes serviteurs et de ton héros'], ['buff_all_allies', "Bonus d'attaque à tous tes serviteurs"],
  ['damage_all', 'Dégâts à tous les serviteurs'], ['buff_ally_and_heal', "Bonus d'attaque à un allié + soin du héros"], ['board_wipe', 'Détruire tous les autres serviteurs']];
/* Effets de cri de guerre d'une carte (principal + effets cumulés) */
function bcList(c) {
  return [[c.bcEffect, c.bcValue, c.bcValue2], [c.bc2Effect, c.bc2Value, c.bc2Value2], [c.bc3Effect, c.bc3Value, c.bc3Value2]].filter(x => x[0]);
}
function targetModeFor(effectType) {
  return { damage: 'damage', heal: 'heal', buff_attack: 'buff', buff_ally_and_heal: 'buff', modify_stats: 'modify', sleep: 'sleep', destroy: 'destroy', silence: 'silence',
    give_shield: 'buff', give_windfury: 'buff', give_stealth: 'buff', give_taunt: 'buff', give_deathrattle: 'buff' }[effectType] || null;
}
function hasTargetFor(mode, st) {
  if (mode === 'damage' || mode === 'heal') return true; // il y a toujours au moins un héros à viser
  if (mode === 'buff') return st.you.board.length > 0;
  // un serviteur ennemi camouflé ne peut pas être visé
  if (mode === 'modify' || mode === 'sleep' || mode === 'destroy' || mode === 'silence') return st.you.board.length + st.opponent.board.filter(m => !m.stealth).length > 0;
  return false;
}
/* Un sort à cible n'est jouable que s'il existe une cible valable */
function spellNeedsMissingTarget(c, st) {
  if (!c || c.type === 'minion' || c.type === 'weapon') return null;
  const mode = targetModeFor(c.effectType);
  if (!mode || hasTargetFor(mode, st)) return null;
  return mode === 'buff' ? 'Il te faut un de tes serviteurs sur la table pour jouer ce sort.' : 'Aucune cible possible pour ce sort pour le moment.';
}


/* ======================================================
   OPTIONS DU JOUEUR (enregistrées dans ce navigateur)
   musique, effets, vitesse des animations, taille du texte, notifications
   ====================================================== */
const OPTS_KEY = 'cgd-options';
const OPTS_DEFAULT = { musicVol: 0.5, sfxVol: 0.8, anim: 'normal', textScale: 100, notify: false, focusMode: true, kwTips: true };
const OPTS = (() => {
  try { return Object.assign({}, OPTS_DEFAULT, JSON.parse(localStorage.getItem(OPTS_KEY) || '{}')); } catch (e) { return Object.assign({}, OPTS_DEFAULT); }
})();
function saveOpts() { try { localStorage.setItem(OPTS_KEY, JSON.stringify(OPTS)); } catch (e) {} applyOpts(); }
function applyOpts() {
  window.CGD_SFX_VOLUME = OPTS.sfxVol;
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.style.setProperty('--ui-scale', String((OPTS.textScale || 100) / 100));
  document.body && document.body.classList.toggle('text-scaled', (OPTS.textScale || 100) !== 100);
  document.body && document.body.classList.toggle('anim-reduced', OPTS.anim === 'reduced');
  document.body && document.body.classList.toggle('anim-fast', OPTS.anim === 'fast');
  if (MUSIC.el) MUSIC.el.volume = OPTS.musicVol;
  setFxSpeed(OPTS.anim === 'fast' ? 0.5 : 1);
}
/* Vitesse des animations : « rapides » divise les durées par deux */
function animMs(ms) { return OPTS.anim === 'fast' ? Math.round(ms / 2) : ms; }

/* ---------- Musique de fond (Admin → Contenu → Sons : musicMenu, musicCombat) ---------- */
const MUSIC = { el: null, track: null };
function syncMusic() {
  if (typeof document === 'undefined' || !S.profile) return;
  const inCombat = !!(S.matchState && S.matchState.status === 'active');
  const sfx = (S.content && S.content.sfx) || {};
  const url = (inCombat ? sfx.musicCombat : sfx.musicMenu) || null;
  const want = S.soundOn && OPTS.musicVol > 0 && url ? url : null;
  if (want === MUSIC.track) return;
  if (MUSIC.el) { MUSIC.el.pause(); MUSIC.el = null; }
  MUSIC.track = want;
  if (!want) return;
  const el = new Audio(want); el.loop = true; el.volume = OPTS.musicVol;
  MUSIC.el = el;
  el.play().catch(() => { MUSIC.track = null; MUSIC.el = null; }); // le navigateur attend un premier clic : on réessaiera
}
if (typeof document !== 'undefined') document.addEventListener('pointerdown', () => { if (!MUSIC.el) syncMusic(); });
// Réglages appliqués dès le chargement de la page
if (typeof document !== 'undefined' && document.addEventListener) {
  if (document.body) { try { applyOpts(); } catch (e) {} }
  else document.addEventListener('DOMContentLoaded', () => { try { applyOpts(); } catch (e) {} });
}

/* ---------- Appli installable + notifications push ----------
   Le service worker (/sw.js) affiche les notifications envoyées par le serveur
   même quand le jeu est fermé (appli installée sur l'écran d'accueil). */
const PUSH = { supported: false, active: false, installEvt: null, standalone: false };
if (typeof window !== 'undefined') {
  PUSH.supported = !!(window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && typeof Notification !== 'undefined');
  PUSH.standalone = !!((window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone);
  PUSH.ios = /iphone|ipad|ipod/i.test(navigator.userAgent || '');
  if (window.isSecureContext && 'serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); PUSH.installEvt = e; if (S && S.tab === 'options') render(); });
  window.addEventListener('appinstalled', () => { PUSH.installEvt = null; PUSH.standalone = true; });
}
function b64uToBytes(s) {
  const raw = atob((s + '='.repeat((4 - s.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}
async function pushSubscribe() {
  if (!PUSH.supported) return false;
  const reg = await navigator.serviceWorker.ready;
  const { publicKey } = await api('/api/push/key');
  let sub = await reg.pushManager.getSubscription();
  // Clé du serveur changée : on se réabonne
  if (sub && sub.options && sub.options.applicationServerKey) {
    const cur = new Uint8Array(sub.options.applicationServerKey), want = b64uToBytes(publicKey);
    if (cur.length !== want.length || cur.some((v, i) => v !== want[i])) { await sub.unsubscribe(); sub = null; }
  }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(publicKey) });
  await api('/api/push/subscribe', 'POST', { subscription: sub.toJSON() });
  PUSH.active = true;
  return true;
}
async function pushUnsubscribe() {
  PUSH.active = false;
  if (!PUSH.supported) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) { await api('/api/push/unsubscribe', 'POST', { endpoint: sub.endpoint }); await sub.unsubscribe(); }
  } catch (e) {}
}
/* Après connexion : l'abonnement de cet appareil est rattaché au compte connecté */
function pushResync() {
  if (OPTS.notify && PUSH.supported && Notification.permission === 'granted') pushSubscribe().catch(() => {});
}

/* ---------- Notifications du navigateur ---------- */
const NOTIF = { sent: {} };
function pageInBackground() { return typeof document !== 'undefined' && (document.hidden || !document.hasFocus()); }
function notify(title, body, tag) {
  if (!OPTS.notify || typeof Notification === 'undefined' || Notification.permission !== 'granted' || !pageInBackground()) return;
  // Onglet caché et notifications push actives : c'est le serveur qui prévient (pas de doublon)
  if (PUSH.active && document.hidden) return;
  if (tag && NOTIF.sent[tag]) return;
  if (tag) NOTIF.sent[tag] = true;
  try {
    const n = new Notification(title, { body, tag: tag || undefined, icon: logoUrl() });
    n.onclick = () => { window.focus(); n.close(); };
  } catch (e) {}
  // Le titre de l'onglet clignote aussi tant que la page n'est pas revue
  if (!NOTIF.flash) {
    const base = document.title;
    NOTIF.flash = setInterval(() => { document.title = document.title.startsWith('🔔') ? base : '🔔 ' + title; }, 1200);
    const stop = () => { clearInterval(NOTIF.flash); NOTIF.flash = null; document.title = base; window.removeEventListener('focus', stop); };
    window.addEventListener('focus', stop);
  }
}

/* Données d'une carte de ta main pendant un combat. On les prend dans l'état
   envoyé par le serveur (toujours à jour), et pas dans la liste des cartes
   chargée à l'ouverture de la page : une carte créée ou modifiée dans l'admin
   après ce chargement n'y figurait pas, et le clic/glisser était ignoré sans
   message — d'où le serviteur à 5 mana impossible à poser avec 7 mana. */

/* ======================================================
   COMBAT SUR SMARTPHONE : MODE PAYSAGE
   - En portrait, un écran demande de tourner le téléphone (le combat est
     pensé pour le paysage). Un bouton passe en plein écran et verrouille
     l'orientation en paysage là où le navigateur le permet (Android).
   - En paysage, le plateau est mis à l'échelle pour tenir dans la hauteur
     de l'écran et s'étale sur toute la largeur.
   ====================================================== */
function isPhone() {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) <= 600;
}
function isLandscape() { return typeof window !== 'undefined' && window.innerWidth > window.innerHeight; }
function renderRotateOverlay() {
  if (!isPhone()) return '';
  const canLock = !!(document.documentElement.requestFullscreen && screen.orientation && screen.orientation.lock);
  return `<div class="rotate-overlay" role="dialog" aria-label="Tourne ton téléphone">
    <div class="rotate-phone" aria-hidden="true">📱</div>
    <h2>Tourne ton téléphone</h2>
    <p>Le combat se joue en <b>mode paysage</b>.</p>
    ${canLock ? '<button class="btn" onclick="App.enterLandscape()">⛶ Plein écran en paysage</button>' : '<p class="page-sub">Si rien ne se passe, vérifie que le verrouillage de la rotation est désactivé.</p>'}
  </div>`;
}
async function lockLandscape() {
  try {
    if (!document.fullscreenElement && document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    if (screen.orientation && screen.orientation.lock) await screen.orientation.lock('landscape');
  } catch (e) { /* iPhone et certains navigateurs : pas de verrouillage, on tourne le téléphone à la main */ }
}
function releaseLandscape() {
  try { if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock(); } catch (e) {}
  try { if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen(); } catch (e) {}
}
/* Mise à l'échelle du plateau en paysage sur téléphone */
let FIT = 1;
function fitCombat() {
  if (typeof document === 'undefined') return;
  const wrap = document.querySelector('.fullscreen-combat');
  const board = wrap && wrap.querySelector('.board-screen.premium');
  const on = !!(board && isPhone() && isLandscape());
  document.body.classList.toggle('combat-landscape', on);
  // Téléphone (vertical OU paysage) : disposition compacte lisible
  document.body.classList.toggle('phone-combat', !!(board && isPhone()));
  document.body.classList.toggle('focus-mode', !!(board && isPhone() && OPTS.focusMode !== false));
  if (!board) { FIT = 1; return; }
  if (!on) { board.style.transform = ''; board.style.width = ''; board.style.marginBottom = ''; FIT = 1; return; }
  const vw = window.innerWidth - 8, vh = window.innerHeight - 8;
  board.style.transform = ''; board.style.width = '';
  let s = 1;
  for (let k = 0; k < 3; k++) { // le plateau s'élargit quand il est réduit : on ajuste deux ou trois fois
    s = Math.min(1, vh / board.offsetHeight);
    board.style.width = Math.round(vw / s) + 'px';
  }
  s = Math.min(1, vh / board.offsetHeight, vw / board.offsetWidth);
  board.style.transform = `scale(${s.toFixed(4)})`;
  board.style.marginBottom = `${-(board.offsetHeight * (1 - s))}px`;
  FIT = s;
}
if (typeof window !== 'undefined') {
  const refit = () => { if (S.matchState && S.matchState.status === 'active') { fitCombat(); drawTargetArrow(); } };
  window.addEventListener('resize', refit);
  window.addEventListener('orientationchange', () => setTimeout(refit, 250));
}

/* ---------- Flèche de ciblage ----------
   Pendant qu'un sort, un cri de guerre ou une attaque attend sa cible, une
   flèche part de la carte (ou du serviteur) et suit la souris. */
const ARROW = { x: null, y: null };
function targetArrowSource() {
  if (S.targetingSpell) return document.querySelector('.hand-card.pending-target') || document.querySelector('.minion.selected');
  if (S.selectedAttacker === 'hero') return document.querySelector('.hero-portrait-wrap.selected');
  if (S.selectedAttacker) return document.querySelector(`.minion[data-iid="${CSS.escape(S.selectedAttacker)}"]`);
  return null;
}
function drawTargetArrow() {
  if (typeof document === 'undefined') return;
  let svg = document.getElementById('target-arrow');
  const active = (S.targetingSpell || S.selectedAttacker) && S.matchState && S.matchState.status === 'active' && ARROW.x != null;
  const src = active ? targetArrowSource() : null;
  if (!src) { if (svg) svg.style.display = 'none'; return; }
  if (!svg) {
    svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.id = 'target-arrow';
    svg.innerHTML = `<defs><marker id="ta-head" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#ff5a3c"/></marker></defs>
      <path class="ta-glow"/><path class="ta-line" marker-end="url(#ta-head)"/><circle class="ta-end" r="9"/>`;
    document.body.appendChild(svg);
  }
  svg.style.display = '';
  const r = src.getBoundingClientRect();
  const sx = r.left + r.width / 2, sy = src.classList.contains('hand-card') ? r.top + 10 : r.top + r.height / 2;
  const ex = ARROW.x, ey = ARROW.y;
  const cx = (sx + ex) / 2, cy = Math.min(sy, ey) - Math.max(40, Math.abs(ex - sx) * 0.25);
  const d = `M${sx},${sy} Q${cx},${cy} ${ex},${ey}`;
  svg.querySelector('.ta-line').setAttribute('d', d);
  svg.querySelector('.ta-glow').setAttribute('d', d);
  const end = svg.querySelector('.ta-end'); end.setAttribute('cx', ex); end.setAttribute('cy', ey);
}
if (typeof document !== 'undefined') {
  document.addEventListener('pointermove', e => { ARROW.x = e.clientX; ARROW.y = e.clientY; if (S.targetingSpell || S.selectedAttacker) drawTargetArrow(); }, { passive: true });
}

/* ---------- Minuteur de tour ----------
   Un petit cercle dans le bouton « Fin du tour » : il se vide pendant le tour,
   passe à l'orange dans les 15 dernières secondes, au rouge (et pulse) dans les
   10 dernières. Mis à jour toutes les 200 ms sans redessiner l'écran. */
const TIMER_RING = 2 * Math.PI * 15;
function updateTurnTimer() {
  const el = document.getElementById('turn-timer');
  if (!el) return;
  const total = S.turnTotalMs || 60000;
  const left = S.turnDeadline ? Math.max(0, S.turnDeadline - Date.now()) : null;
  el.classList.toggle('off', left == null);
  if (left == null) return;
  const sec = Math.ceil(left / 1000);
  el.querySelector('.tt-num').textContent = sec;
  el.querySelector('.tt-left').style.strokeDasharray = `${(TIMER_RING * left / total).toFixed(2)} ${TIMER_RING.toFixed(2)}`;
  el.classList.toggle('warn', sec <= 15 && sec > 10);
  el.classList.toggle('danger', sec <= 10);
  // Temps écoulé : le bouton se grise tout de suite (le serveur termine le tour lui-même)
  const btn = el.closest('.end-turn-wheel');
  if (btn && left <= 0 && !btn.disabled) { btn.disabled = true; btn.classList.add('disabled'); }
}
if (typeof window !== 'undefined') setInterval(updateTurnTimer, 200);

/* Armure du héros : points de bouclier affichés à gauche des PV, consommés en premier */
function armorGem(n) {
  return n > 0 ? `<div class="armor-gem" title="Armure : ${n} point${n > 1 ? 's' : ''} de bouclier, perdus avant les PV">${n}</div>` : '';
}
function handCardData(cardId) {
  const st = S.matchState;
  const fromHand = st && st.you && (st.you.hand || []).find(c => c.id === cardId);
  return fromHand || cardById(cardId) || null;
}
function playCardSound(p) {
  // Le son se joue, sans bandeau à l'écran : on l'entend, et l'ancien bandeau
  // décalait l'interface (et forçait deux re-rendus qui coupaient les animations).
  if (!S.soundOn || !p || !p.sound) return;
  ArcaneAudio.playSoundUrl(p.sound);
}

/* Argument JS à placer dans un attribut onclick="…" : JSON.stringify produit des
   guillemets doubles qui fermaient l'attribut HTML et rendaient le bouton muet
   (ex. « Supprimer » un deck). Échappés en &quot;, le navigateur les rend au JS. */
function jsArg(v) { return JSON.stringify(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

async function boot() {
  try { S.cardPool = (await api(cardsUrl())).cards; ArcaneAudio.preloadSounds(S.cardPool); } catch (e) {}
  try { S.config = await api('/api/config'); } catch (e) {}
  try { S.extensions = (await api(extsUrl())).extensions; } catch (e) {}
  try { S.settings = await api('/api/settings'); } catch (e) {}
  try { S.content = await api('/api/content'); } catch (e) {}
  try { const ev = await api('/api/events'); S.events = ev.events; S.bossAvailableToday = ev.bossAvailableToday; } catch (e) {}
  loadTournament();
  loadStory();
  try {
    S.profile = (await api('/api/me')).profile;
    await afterLogin();
  } catch (e) { render(); }

  // Le plateau de combat s'ajuste à la hauteur disponible (voir
  // fitCombatToViewport) — un seul écouteur global suffit, la fonction
  // elle-même ne fait rien si on n'est pas en plein combat.
  let resizeDebounce;
  window.addEventListener('resize', () => {
    clearTimeout(resizeDebounce);
    resizeDebounce = setTimeout(fitCombatToViewport, 120);
  });
}

/* Textes et icônes personnalisables : repli sur le libellé français d'origine
   si le contenu n'a pas encore été chargé (S.content est null au tout premier
   rendu, avant que /api/content ait répondu). */
function t(key, fallback) {
  return (S.content && S.content.strings && S.content.strings[key]) || fallback || key;
}
function icon(key, fallback) {
  return (S.content && S.content.icons && S.content.icons[key]) || fallback || '';
}
function logoUrl() {
  return (S.content && S.content.media && S.content.media.logo) || '/branding/logo.png';
}
function mediaUrl(key) {
  return (S.content && S.content.media && S.content.media[key]) || null;
}
/* Image de booster à afficher pendant la secousse et la déchirure : celle de
   l'extension réglée en admin pour ce booster précis, ou aucune (repli sur
   la boîte générique) si l'extension n'en a pas ou est inconnue. */
function currentPackImage() {
  return extensionPackImage(S.packOpeningExtensionId);
}
/* Image de booster réglée pour une extension donnée — utilisée partout où un
   booster de cette extension est représenté (secousse, déchirure, boutique,
   inventaire), pas seulement pendant l'ouverture elle-même. */
function extensionPackImage(extensionId) {
  const ext = (S.extensions || []).find(e => e.id === extensionId);
  return (ext && ext.packImage) || null;
}
/* Applique les images d'interface personnalisées (fond du plateau, de l'écran
   de connexion, du menu latéral, texture des panneaux) via une seule feuille
   de style injectée dynamiquement — plus simple et plus sûr que d'ajouter un
   style en ligne à chaque endroit où un ".panel" apparaît dans le code (il y
   en a des dizaines). Rappelée à chaque chargement de S.content. */
/* Calcule l'échelle à appliquer au plateau de combat pour qu'il tienne dans
   la hauteur disponible sans avoir besoin de défiler. Fonction pure (aucun
   accès au DOM) pour rester testable : renvoie 1 si tout tient déjà, sinon
   le ratio nécessaire, jamais en dessous de minScale pour rester lisible. */
function computeCombatFitScale(contentHeight, availableHeight, minScale) {
  minScale = minScale === undefined ? 0.6 : minScale;
  if (!contentHeight || !availableHeight || contentHeight <= availableHeight) return 1;
  return Math.max(minScale, availableHeight / contentHeight);
}

/* Applique cette échelle au plateau après chaque rendu, pour que le combat
   tienne toujours dans la fenêtre sans molette — plutôt qu'une taille fixe
   en CSS, qui ne peut pas s'adapter à une main de 10 cartes ou à un petit
   écran. La mise à l'échelle ne change pas la mise en page réelle du bloc
   (transform ne redimensionne pas la boîte pour le calcul de défilement),
   donc on masque le débordement résiduel plutôt que de laisser une bande de
   défilement quasi vide en bas. */
function fitCombatToViewport() {
  const outer = document.querySelector('.fullscreen-combat');
  const inner = document.querySelector('.fullscreen-combat > .board-screen.premium');
  if (!outer || !inner) return;
  if (isPhone() && isLandscape()) return; // téléphone en paysage : géré par fitCombat()
  inner.style.transform = 'none';
  const contentHeight = inner.scrollHeight;
  const availableHeight = window.innerHeight - 36; // marge ~= le padding haut+bas de .fullscreen-combat
  const scale = computeCombatFitScale(contentHeight, availableHeight);
  FIT = scale < 1 ? scale : 1; // la carte glissée garde la même échelle que le plateau
  if (scale < 1) {
    inner.style.transform = `scale(${scale})`;
    inner.style.transformOrigin = 'top center';
    outer.style.overflowY = 'hidden';
  } else {
    outer.style.overflowY = 'auto';
  }
}

function applyDynamicMediaStyles() {
  if (typeof document === 'undefined') return;
  let styleEl = document.getElementById('dynamic-media-styles');
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = 'dynamic-media-styles';
    document.head.appendChild(styleEl);
  }
  const rules = [];
  const board = mediaUrl('boardBackground');
  if (board) rules.push(`.fullscreen-combat{background-image:url('${board}');background-size:cover;background-position:center;background-blend-mode:overlay;}`);
  const gate = mediaUrl('gateBackground');
  if (gate) rules.push(`.gate-screen{background-image:url('${gate}');background-size:cover;background-position:center;}`);
  const sidebar = mediaUrl('sidebarBackground');
  if (sidebar) rules.push(`.sidebar{background-image:url('${sidebar}');background-size:cover;background-position:top center;}`);
  const panel = mediaUrl('panelTexture');
  if (panel) rules.push(`.panel{background-image:url('${panel}');background-size:220px;background-repeat:repeat;}`);
  styleEl.textContent = rules.join('\n');
}
/* Un son de jeu personnalisé (uploadé par l'admin) prend le pas sur le son
   synthétisé par défaut (sfx.js) s'il existe. */
/* Son joué quand une carte est révélée dans un booster : d'abord le son
   personnalisé de SA rareté (panel admin), sinon le son « Révélation de carte »
   commun à toutes les raretés, sinon le son synthétisé propre à la rareté. */
function playRevealSound(card) {
  if (!card || !S.soundOn) return;
  const sfx = (S.content && S.content.sfx) || {};
  const url = sfx['cardReveal_' + card.rarity] || sfx.cardReveal;
  if (url) { ArcaneAudio.playSoundUrl(url); return; }
  if (window.SFX) SFX.cardReveal(card.rarity);
}

function playGameSound(key, fallbackFn) {
  if (!S.soundOn) return;
  const url = S.content && S.content.sfx && S.content.sfx[key];
  if (url) { ArcaneAudio.playSoundUrl(url); return; }
  if (fallbackFn) fallbackFn();
}

/* File d'attente de notifications de succès débloqués : si plusieurs se
   débloquent d'un coup (ex : un même achat), on les affiche l'un après
   l'autre plutôt que de les empiler ou de perdre les suivants. */
let achievementToastQueue = [];
function showAchievementToast(a) {
  if (!a) return;
  achievementToastQueue.push(a);
  if (achievementToastQueue.length === 1) advanceAchievementToastQueue();
}
function advanceAchievementToastQueue() {
  if (achievementToastQueue.length === 0) { S.achievementToast = null; render(); return; }
  S.achievementToast = achievementToastQueue[0];
  render();
  setTimeout(() => {
    achievementToastQueue.shift();
    advanceAchievementToastQueue();
  }, 4000);
}
function handleUnlockedAchievements(list) {
  (list || []).forEach(a => showAchievementToast(a));
}

async function afterLogin() {
  try { S.packStatus = await api('/api/pack/status'); } catch (e) {}
  try { if (!S.extensions || !S.extensions.length) S.extensions = (await api(extsUrl())).extensions; } catch (e) {}
  // Onglets Histoire et Tournoi : chargés APRÈS la connexion. Avant, ils n'étaient
  // chargés qu'au démarrage de la page : après une connexion par le formulaire
  // (sans session déjà ouverte), l'onglet Histoire n'apparaissait pas.
  loadTournament();
  loadStory();
  connectSocket();
  pushResync();
  loadBannerCatalog();
  loadCommunity();
  // Ordinateur : une seule page « Jouer » (accueil + combat) ; téléphone : l'accueil mobile
  if (phoneUI()) { S.tab = 'accueil'; render(); } else App.goTab('combat');
}

function connectSocket() {
  if (S.socket) S.socket.disconnect();
  S.socket = io();
  // Présence : le serveur n'envoie une notification push que si le jeu n'est pas à l'écran
  const sendPresence = () => { if (S.socket) S.socket.emit('presence', { visible: document.visibilityState === 'visible' }); };
  S.socket.on('connect', sendPresence);
  if (!window.__presenceHooked) { window.__presenceHooked = true; document.addEventListener('visibilitychange', () => { if (S.socket) S.socket.emit('presence', { visible: document.visibilityState === 'visible' }); }); }
  S.socket.on('queue:waiting', () => { S.queueStatus = 'waiting'; render(); });
  // Survie mise en pause (bouton ⏸ ou déconnexion) : retour à l'écran de la Survie
  S.socket.on('survival:paused', () => { const wasIn = !!S.matchState; S.matchState = null; S.queueStatus = 'idle'; S.selectedAttacker = null; S.targetingSpell = null; S.survival = null; if (wasIn) pushToast('⏸ Combat de Survie en pause : reprends-le quand tu veux.'); App.goTab('survie'); });
  S.socket.on('secrets:unlocked', list => { (list || []).forEach(d => showAchievementToast({ name: '🕵️ ' + d.name + ' — succès secret' })); if (S.tab === 'achievements') api('/api/secrets').then(x => { S.secrets = x; render(); }).catch(() => {}); });
  S.socket.on('community:update', () => { loadCommunity(); });
  S.socket.on('community:reward', r => { pushToast(`🤝 Objectif communautaire atteint ! +${(r && r.credits) || 0} 🪙${r && r.booster ? ` et un booster « ${r.booster} »` : ''} dans ta réserve.`); api('/api/me').then(x => { S.profile = x.profile; render(); }).catch(() => {}); });
  // Tournoi : toute inscription, préparation ou résultat rafraîchit l'onglet chez tout le monde
  S.socket.on('tournament:update', () => { loadTournament(); });
  // Chat général
  S.socket.on('chat:history', list => { CHAT.msgs = Array.isArray(list) ? list : []; chatRenderAll(); syncChat(); });
  S.socket.on('chat:msg', m => chatOnMessage(m));
  S.socket.on('chat:online', n => { CHAT.online = n; syncChat(); });
  S.socket.on('chat:deleted', ({ id }) => { CHAT.msgs = CHAT.msgs.filter(m => m.id !== id); const el = document.querySelector(`.chat-msg[data-id="${CSS.escape(id)}"]`); if (el) el.remove(); });
  S.socket.on('chat:error', e => { const i = document.getElementById('chat-input'); if (i) { i.classList.add('shake'); setTimeout(() => i.classList.remove('shake'), 500); i.placeholder = e.error; } });
  // Une extension vient d'être publiée : nouvelles cartes et nouveau booster visibles tout de suite
  S.socket.on('extensions:update', async () => { try { S.extensions = (await api(extsUrl())).extensions; S.cardPool = (await api(cardsUrl())).cards; render(); } catch (e) {} });
  // Onglet Événements ouvert ou fermé (par l'admin ou par la programmation)
  S.socket.on('events:update', () => { api('/api/events').then(ev => { S.events = ev.events; S.bossAvailableToday = ev.bossAvailableToday; render(); }).catch(() => {}); });
  // L'admin ouvre ou ferme le mode Histoire : le menu se met à jour chez tout le monde
  S.socket.on('story:update', () => { loadStory().then(() => { if (S.tab === 'histoire' && !(S.story && S.story.tabEnabled)) App.goTab('combat'); }); });
  S.socket.on('tournament:won', (p) => {
    loadTournament();
    api('/api/me').then(r => { S.profile = r.profile; render(); }).catch(() => {});
    alert(`🏆 Tu as gagné le tournoi « ${p.name} » ! Ton nouveau contour d'avatar « ${(p.ornament || {}).name || ''} » t'attend dans la boutique (Équiper).`);
  });
  S.socket.on('queue:error', (p) => { alert(p.error); S.queueStatus = 'idle'; render(); });
  S.socket.on('spectate:state', (d) => { if (!S.spectate || S.spectate.matchId !== d.matchId) return; S.spectate.data = d; render(); });
  S.socket.on('spectate:end', (p) => { if (S.spectate && S.spectate.matchId === p.matchId) { S.spectate.ended = true; render(); } });
  S.socket.on('spectate:error', (p) => { S.spectate = null; pushToast('👁 ' + p.error); App.loadLive(); });
  S.socket.on('match:state', async (state) => {
    const wasActive = S.matchState && S.matchState.status === 'active';
    const wasYourTurn = S.matchState && S.matchState.yourTurn;
    const isNewMatch = !S.matchState || S.matchState.id !== state.id;
    // Un défi accepté (ou un match trouvé) ouvre directement le plateau chez les deux joueurs
    if (isNewMatch) { S.matchResultOverlay = null; clearTimeout(window.__matchResultTimer); S.tab = 'combat'; S.viewedPlayer = null; S.duelPicker = null; if (S.spectate) { S.socket.emit('spectate:leave'); S.spectate = null; } }
    // Notification : c'est à toi de jouer (seulement si la page est en arrière-plan)
    if (state.status === 'active' && state.phase !== 'mulligan' && state.yourTurn && (isNewMatch || !wasYourTurn)) {
      notify("C'est ton tour !", `Ton adversaire ${state.opponent ? state.opponent.pseudo : ''} a fini de jouer.`, 'turn-' + state.id + '-' + state.turnNumber);
    }
    // Plus ton tour (fin du temps ou fin de tour) : ciblage et sélection en attente annulés
    if (!state.yourTurn) { S.targetingSpell = null; S.selectedAttacker = null; }
    // Mèche du tour : on convertit le temps restant envoyé par le serveur en échéance locale
    S.turnDeadline = state.turnRemainingMs != null ? Date.now() + state.turnRemainingMs : null;
    S.turnTotalMs = state.turnTotalMs || 60000;
    const evs = state.events || [];
    S.newEvents = isNewMatch ? [] : evs.filter(e => e.seq > (S.lastEventSeq || 0));
    S.newEventsAt = Date.now();
    S.lastEventSeq = evs.length ? evs[evs.length - 1].seq : 0;
    if (S.feedOpen === false || (S.feedOpen === undefined && window.innerWidth < 1500)) S.feedUnread = (S.feedUnread || 0) + S.newEvents.filter(e => e.type !== 'turn').length;
    const oppPlay = S.newEvents.filter(e => e.type === 'play' && e.by !== state.you.slug).pop();
    if (oppPlay) {
      S.oppPlayReveal = oppPlay.card;
      S.oppPlayRevealAt = Date.now();
      clearTimeout(window.__oppRevealTimer);
      window.__oppRevealTimer = setTimeout(() => {
        S.oppPlayReveal = null;
        const el = document.querySelector('.opp-reveal');
        if (el) { el.classList.add('leaving'); setTimeout(() => el.remove(), 300); }
      }, 2200);
    }
    computeCombatAnimations(S.matchState, state);
    if (S.soundOn) {
      const anim = S.combatAnim;
      const hasCharge = anim && (anim.attackedIds.size > 0 || anim.youHeroAttacked || anim.oppHeroAttacked);
      if (anim && !hasCharge && (anim.hitIds.size > 0 || anim.youHeroHit || anim.oppHeroHit)) playGameSound('attackHit', () => window.SFX && SFX.attackHit());
      if (!isNewMatch && !wasYourTurn && state.yourTurn && state.phase === 'active') playGameSound('turnStart', () => window.SFX && SFX.turnStart());
    }
    if (isNewMatch && state.opponent && state.opponent.slug === 'boss') {
      S.bossDialogueShown = new Set();
      S.bossDialogueActive = null;
      const entrySound = S.events && S.events.boss && S.events.boss.entrySound;
      if (S.soundOn && entrySound) ArcaneAudio.playSoundUrl(entrySound);
    }
    if (state.opponent && state.opponent.slug === 'boss' && state.status === 'active') {
      checkBossDialogue(state);
    }
    S.matchState = state;
    S.queueStatus = 'in-match';
    S.selectedAttacker = null;
    S.targetingSpell = null;
    S.incomingChallenge = null;
    if (isNewMatch) S.mulliganSelected = new Set();
    if (state.status === 'finished') { S.emoteWheelOpen = false; }
    if (state.status === 'finished' && wasActive) {
      if (S.soundOn && state.winner !== null) {
        if (state.winner === state.you.slug) playGameSound('victory', () => window.SFX && SFX.victory()); else playGameSound('defeat', () => window.SFX && SFX.defeat());
      }
      // Grand écran de victoire/défaite qui s'affiche par-dessus le plateau,
      // en plus de la petite bannière déjà présente dans le corps de la page.
      const result = state.winner === null ? 'draw' : (state.winner === state.you.slug ? 'win' : 'lose');
      // Abandon contre le bot : pas de « vainqueur » côté serveur, mais c'est une défaite, pas une égalité
      const shownResult = state.winner === null && state.forfeitBy ? (state.forfeitBy === state.you.slug ? 'lose' : 'win') : result;
      const rankBefore = S.profile ? S.profile.rank : null;
      const progressBefore = resultSnapshot(S.profile); // pour l'écran de récompenses animé
      if (state.rewards && state.rewards.achievementsUnlocked) handleUnlockedAchievements(state.rewards.achievementsUnlocked);
      try { S.profile = (await api('/api/me')).profile; } catch (e) {}
      const resultAnim = buildResultAnim(progressBefore, resultSnapshot(S.profile));
      // Niveau et défis s'affichent dans l'écran de fin : pas de bulle en double
      if (resultAnim && S.profile && Array.isArray(S.profile.notices)) {
        const rest = S.profile.notices.filter(n => n.kind !== 'level' && n.kind !== 'daily');
        if (rest.length !== S.profile.notices.length) { S.profile.notices = rest; if (!rest.length) api('/api/me/notices/ack', 'POST', {}).catch(() => {}); }
      }
      S.matchResultOverlay = {
        result: shownResult,
        rewards: state.rewards || null,
        rankBefore,
        rankAfter: S.profile ? S.profile.rank : null,
        anim: resultAnim,
        shownAt: Date.now()
      };
      if (resultAnim) startResultAnim();
      clearTimeout(window.__matchResultTimer);
      // Après 5 s, retour automatique au menu (avant : l'écran de résultat se fermait
      // mais on restait bloqué sur le plateau terminé, sans rien à faire).
      const keepOpen = (state.rewards && state.rewards.survival && state.rewards.survival.won) || (state.rewards && state.rewards.draft && !state.rewards.draft.over) || (state.rewards && state.rewards.puzzle && !state.rewards.puzzle.won);
      // (on laisse le temps à l'animation des récompenses de se terminer)
      if (!keepOpen) window.__matchResultTimer = setTimeout(() => App.returnToMenuAfterMatch(), Math.max(5000, resultAnim ? resultAnim.total + 5000 : 0));
    }
    render();
    playCombatFx(S.combatAnim);
    triggerCombatAnimationCleanup();
  });
  S.socket.on('action:error', (p) => {
    pendingCharge = null;
    S.matchError = p.error; render();
    setTimeout(() => { S.matchError = null; render(); }, 2600);
  });
  S.socket.on('emote:shown', (p) => {
    // Affiche la bulle côté émetteur ET côté adversaire, puis la retire
    S.activeEmotes[p.fromSlug] = p;
    render();
    setTimeout(() => {
      if (S.activeEmotes[p.fromSlug] && S.activeEmotes[p.fromSlug].at === p.at) {
        delete S.activeEmotes[p.fromSlug];
        render();
      }
    }, 3500);
  });
  S.socket.on('card:sound', (p) => {
    playCardSound(p);
  });
  S.socket.on('card:play-default', () => {
    playGameSound('cardPlayDefault', () => window.SFX && SFX.cardPlayDefault());
  });
  S.socket.on('achievement:unlocked', (a) => { showAchievementToast(a); });
  S.socket.on('challenge:incoming', (ch) => { S.incomingChallenge = ch; render(); notify('Défi reçu !', `${(ch && (ch.fromPseudo || (ch.from && ch.from.pseudo))) || 'Un ami'} te défie en combat.`, 'challenge-' + (ch && ch.id)); });
  S.socket.on('challenge:sent', () => { S.duelPicker = null; S.challengeNotice = 'Défi envoyé — en attente de réponse.'; pushToast('⚔️ Défi envoyé : ton ami a 60 secondes pour accepter.'); setTimeout(() => { S.challengeNotice = null; render(); }, 4000); });
  S.socket.on('challenge:declined', () => { S.challengeNotice = 'Ton défi a été refusé.'; render(); setTimeout(() => { S.challengeNotice = null; render(); }, 4000); });
  S.socket.on('trade:incoming', () => { S.challengeNotice = 'Nouvelle demande d\'échange reçue.'; render(); setTimeout(() => { S.challengeNotice = null; render(); }, 4000); });
}

/* ---------------- Actions ---------------- */
const App = {
  setGateMode(m) { S.gateMode = m; S.gateError = null; render(); },

  async doRegister() {
    const pseudo = document.getElementById('reg-pseudo').value.trim();
    const pw = document.getElementById('reg-pw').value;
    const pw2 = document.getElementById('reg-pw2').value;
    if (pw !== pw2) { S.gateError = 'Les deux mots de passe ne correspondent pas.'; render(); return; }
    try {
      S.profile = (await api('/api/register', 'POST', { pseudo, password: pw })).profile;
      S.gateError = null; await afterLogin();
    } catch (e) { S.gateError = e.message; render(); }
  },

  async doLogin() {
    const pseudo = document.getElementById('login-pseudo').value.trim();
    const pw = document.getElementById('login-pw').value;
    try {
      S.profile = (await api('/api/login', 'POST', { pseudo, password: pw })).profile;
      S.gateError = null; await afterLogin();
    } catch (e) { S.gateError = e.message; render(); }
  },

  async logout() {
    if (PUSH.active) await pushUnsubscribe(); // cet appareil ne reçoit plus les notifications de ce compte
    try { await api('/api/logout', 'POST'); } catch (e) {}
    if (S.socket) S.socket.disconnect();
    const pool = S.cardPool, cfg = S.config;
    S = { profile: null, cardPool: pool, config: cfg, tab: 'collection', gateMode: 'login', gateError: null,
      packStatus: { ready: false, remainingMs: 0 }, packAnim: null, lastDrawn: null, lastSubTab: {}, deckDraft: null,
      viewedPlayer: null, playersList: [], friends: [], playerFilter: '', trades: { received: [], sent: [] },
      tradeBuilder: null, duplicates: [], shop: null, leaderboard: null, isAdmin: false,
      adminCodeTry: '', adminCardType: 'minion', socket: null, queueStatus: 'idle', matchState: null,
      selectedAttacker: null, targetingSpell: null, matchError: null, incomingChallenge: null, challengeNotice: null,
      emoteWheelOpen: false, activeEmotes: {}, shopTab: 'ornaments', wheelDraft: null, wheelSlot: 0,
      soundOn: S.soundOn, nowPlaying: null,
      adminTab: 'cards', adminCardRarity: 'commun', adminCustomDrop: false,
      adminUsers: null, adminUserFilter: '', adminViewedUser: null,
      card3DView: null, card3DError: null,
      extensions: S.extensions, adminEditingCardId: null, adminExtCodeTry: '', shopBoosterTab: 'ornaments',
      codex: null, codexExt: 'base', combatAnim: null, mulliganSelected: null, savedDecks: [], settings: null, content: null,
      events: null, bossAvailableToday: null, casinoResult: null, casinoSpinning: false,
      bossDeckDraft: null, bossDialogueDraft: null, bossDialogueShown: new Set(), bossDialogueActive: null,
      adminAchievements: [], adminConditionTypes: {}, adminAchievementType: 'cards_played_type',
      achievements: [], achievementToast: null, casinoReelDisplay: ['❔','❔','❔'], showcaseDraft: null, blackjackState: null,
      packOpeningExtensionId: null, creditPacks: [], adminCreditPacks: [], matchResultOverlay: null, adminCardParallax: false, adminSpellEffect: null };
    render();
  },

  async goTab(t) {
    if (t === 'accueil' && !phoneUI()) t = 'combat'; // sur ordinateur, Accueil et Combat ne font qu'une page
    S.tab = t; S.viewedPlayer = null;
    if (S.spectate) { if (S.socket) S.socket.emit('spectate:leave'); S.spectate = null; }
    try {
      if (t === 'joueurs') S.playersList = (await api('/api/players')).players;
      if (t === 'echanges') S.trades = await api('/api/trade');
      if (t === 'histoire') { S.story = (await api('/api/story')); }
      if (t === 'deckstats') {
        if (!S.deckDraft) S.deckDraft = (S.profile.deck || []).slice();
        S.deckDraft = S.deckDraft.filter(id => cardById(id));
        S.deckStats = null;
        api('/api/deck/analysis', 'POST', { cardIds: S.deckDraft }).then(r => { S.deckStats = r; render(); }).catch(e => { S.deckStats = { error: e.message }; render(); });
      }
      if (t === 'deck') {
        if (!S.deckDraft) S.deckDraft = (S.profile.deck || []).slice();
        // Les cartes supprimées dans le panel admin sortent du brouillon de deck
        S.deckDraft = S.deckDraft.filter(id => cardById(id));
        S.savedDecks = (await api('/api/decks')).decks;
      }
      if (t === 'boosters') S.packStatus = await api('/api/pack/status');
      if (t === 'codex') S.codex = await api('/api/codex');
      if (t === 'poussiere') S.duplicates = (await api('/api/dust/duplicates')).duplicates;
      if (t === 'boutique') { S.shop = await api('/api/shop'); S.creditPacks = (await api('/api/credit-packs')).packs; loadDaily(); }
      if (t === 'classement') S.leaderboard = await api('/api/leaderboard');
      if (t === 'survie') loadSurvival();
      if (t === 'draft') loadDraft();
      if (t === 'puzzle') loadPuzzle();
      if (t === 'bagarre') loadBrawl();
      if (t === 'combat' || t === 'accueil') loadCommunity();
      if (t === 'accueil' || t === 'combat') { api('/api/pack/status').then(r => { S.packStatus = r; render(); }).catch(() => {}); }
      if (t === 'collection' || t === 'boutique') loadBannerCatalog();
      if (t === 'combat') {
        S.friends = (await api('/api/friends')).friends;
        api('/api/replays').then(r => { S.replayList = r.replays; render(); }).catch(() => {});
        App.loadLive();
      }
      if (t === 'evenements') {
        const ev = await api('/api/events'); S.events = ev.events; S.bossAvailableToday = ev.bossAvailableToday; S.casinoResult = null;
        try { S.blackjackState = (await api('/api/events/blackjack/state')).state; } catch (e) { S.blackjackState = null; }
      }
      if (t === 'achievements') { const r = await api('/api/achievements'); S.achievements = r.achievements; S.showcaseDraft = r.showcase.slice(); loadBannerCatalog(); api('/api/secrets').then(x => { S.secrets = x; render(); }).catch(() => {}); }
    } catch (e) {}
    render();
  },

  /* ---- Avatar ---- */
  pickShowcaseSlot(i) { S.showcasePick = i; S.showcaseSearch = ''; render(); },
  closeShowcasePicker() { S.showcasePick = null; render(); },
  showcaseSearch(el) {
    S.showcaseSearch = el.value;
    const q = el.value.trim().toLowerCase();
    document.querySelectorAll('.showcase-picker .grid > [data-name]').forEach(n => { n.style.display = !q || n.dataset.name.includes(q) ? '' : 'none'; });
  },
  async setShowcaseCard(slot, cardId) {
    const ids = (S.profile.cardShowcase || [null, null, null]).slice(0, 3);
    while (ids.length < 3) ids.push(null);
    const other = cardId ? ids.indexOf(cardId) : -1;
    if (other >= 0 && other !== slot) ids[other] = ids[slot]; // déjà exposée ailleurs : on échange les places
    ids[slot] = cardId;
    try {
      const r = await api('/api/me/card-showcase', 'POST', { cardIds: ids });
      S.profile.cardShowcase = r.cardShowcase;
      S.showcasePick = null;
    } catch (e) { alert(e.message); }
    render();
  },
  /* Trailer du jeu dans une fenêtre : lecture, pause et barre de progression
     natives. Fermer la fenêtre (✕, clic à côté ou Échap) arrête la vidéo.
     La fenêtre vit en dehors de l'interface redessinée, pour que la vidéo ne
     redémarre pas quand l'écran se met à jour derrière. */
  openTrailer(trigger) {
    if (document.getElementById('trailer-modal')) return;
    const modal = document.createElement('div');
    modal.id = 'trailer-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', 'Trailer de Clean Gang Decks');
    modal.innerHTML = `<div class="trailer-box">
        <button type="button" class="trailer-close" aria-label="Fermer le trailer">✕</button>
        <video class="trailer-video" controls autoplay playsinline preload="auto">
          <source src="/media/trailer.mp4" type="video/mp4">
          <source src="/media/trailer.webm" type="video/webm">
        </video>
      </div>`;
    document.body.appendChild(modal);
    const video = modal.querySelector('video');
    const close = () => {
      try { video.pause(); video.querySelectorAll('source').forEach(s => s.remove()); video.removeAttribute('src'); video.load(); } catch (e) {}
      document.removeEventListener('keydown', onKey);
      modal.remove();
      if (trigger && trigger.focus) trigger.focus();
    };
    const onKey = e => { if (e.key === 'Escape') close(); };
    modal.addEventListener('click', e => { if (e.target === modal) close(); });
    modal.querySelector('.trailer-close').addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    // Avec plusieurs <source>, l'erreur arrive sur la dernière quand aucune n'est lisible
    const lastSource = video.querySelector('source:last-of-type');
    (lastSource || video).addEventListener('error', () => {
      const box = modal.querySelector('.trailer-box');
      if (box && !box.querySelector('.trailer-error')) box.insertAdjacentHTML('beforeend', '<p class="trailer-error">La vidéo est introuvable (public/media/trailer.mp4 ou trailer.webm).</p>');
    });
    const p = video.play(); if (p && p.catch) p.catch(() => {}); // lecture auto refusée : les contrôles restent disponibles
    modal.querySelector('.trailer-close').focus();
  },
  editBio() { S.bioEditing = true; S.bioDraft = S.profile.bio || ''; render(); setTimeout(() => { const el = document.getElementById('bio-input'); if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } }, 0); },
  bioInput(el) {
    S.bioDraft = Array.from(el.value).slice(0, BIO_MAX).join('');
    if (el.value !== S.bioDraft) el.value = S.bioDraft;
    const c = document.getElementById('bio-count');
    if (c) { c.textContent = `${Array.from(S.bioDraft).length}/${BIO_MAX}`; }
  },
  cancelBio() { S.bioEditing = false; S.bioDraft = ''; render(); },
  async saveBio() {
    try {
      const r = await api('/api/me/bio', 'POST', { bio: S.bioDraft || '' });
      S.profile.bio = r.bio;
      S.bioEditing = false;
    } catch (e) { alert(e.message); }
    render();
  },
  /* Avatar : on choisit une image, on la recadre dans un cercle, puis on envoie un carré de 512 px */
  pickAvatar(input) {
    const f = input.files && input.files[0];
    input.value = '';
    if (!f) return;
    if (!/^image\/(png|jpeg|webp|gif)$/.test(f.type)) { alert('Format non supporté (PNG, JPG, WEBP ou GIF uniquement).'); return; }
    if (f.size > 15 * 1024 * 1024) { alert('Image trop lourde (15 Mo maximum).'); return; }
    const url = URL.createObjectURL(f);
    const img = new Image();
    img.onload = () => { S.avatarCrop = { url, img, iw: img.naturalWidth, ih: img.naturalHeight, zoom: 1, x: 0, y: 0 }; render(); };
    img.onerror = () => { URL.revokeObjectURL(url); alert("Impossible de lire cette image."); };
    img.src = url;
  },
  cropZoom(v) { const c = S.avatarCrop; if (!c) return; c.zoom = Math.max(1, Math.min(4, Number(v) || 1)); cropClamp(c); cropApply(); },
  cropCancel() { if (S.avatarCrop) URL.revokeObjectURL(S.avatarCrop.url); S.avatarCrop = null; render(); },
  async cropSave() {
    const c = S.avatarCrop; if (!c || c.saving) return;
    c.saving = true; render();
    try {
      const OUT = 512, V = CROP_VIEW, sc = cropScale(c);
      const cv = document.createElement('canvas'); cv.width = OUT; cv.height = OUT;
      const ctx = cv.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      const sw = V / sc, sx = c.iw / 2 - (V / 2 + c.x) / sc, sy = c.ih / 2 - (V / 2 + c.y) / sc;
      ctx.drawImage(c.img, sx, sy, sw, sw, 0, 0, OUT, OUT);
      const blob = await new Promise(res => cv.toBlob(res, 'image/png'));
      if (!blob) throw new Error("Impossible de préparer l'image.");
      const fd = new FormData();
      fd.append('image', blob, 'avatar.png');
      await upload('/api/me/avatar', fd);
      S.profile = (await api('/api/me')).profile;
      URL.revokeObjectURL(c.url);
      S.avatarCrop = null;
      pushToast('Avatar mis à jour !');
    } catch (e) { c.saving = false; alert(e.message); }
    render();
  },
  async uploadAvatar(input) {
    if (!input.files || !input.files[0]) return;
    const fd = new FormData();
    fd.append('image', input.files[0]);
    try {
      await upload('/api/me/avatar', fd);
      S.profile = (await api('/api/me')).profile;
    } catch (e) { alert(e.message); }
    render();
  },

  /* ---- Boosters ---- */
  async openPack(useCredits) {
    await App._runPackOpenSequence(() => api('/api/pack/open', 'POST', { useCredits: !!useCredits }), 'base');
  },
  async buyBooster(extensionId, currency) {
    const qtyEl = document.getElementById('booster-qty-' + extensionId);
    const quantity = qtyEl ? Math.max(1, Math.min(20, Number(qtyEl.value) || 1)) : 1;
    try {
      const r = await api('/api/shop/buy-booster', 'POST', { extensionId, currency, quantity });
      S.profile = r.profile;
      S.packStatus = await api('/api/pack/status');
      handleUnlockedAchievements(r.unlockedAchievements);
      const name = r.stored[0].extensionName;
      alert((r.stored.length > 1 ? `${r.stored.length} boosters « ${name} » ajoutés` : `Booster « ${name} » ajouté`) + " à ton inventaire — ouvre-les depuis l'onglet Boosters !");
    } catch (e) { alert(e.message); }
    render();
  },
  async openInventoryBooster(inventoryId) {
    const stored = (S.profile.boosterInventory || []).find(b => b.id === inventoryId);
    await App._runPackOpenSequence(() => api('/api/pack/open-inventory', 'POST', { inventoryId }), stored ? stored.extensionId : 'base');
  },
  /* Séquence commune d'ouverture : secousse → déchirure du haut → révélation
     carte par carte. Les deux points d'entrée (booster gratuit et booster
     d'inventaire) partagent exactement la même mise en scène. L'image du
     booster affichée pendant la secousse et la déchirure suit celle de
     l'extension d'origine (réglée en admin), avec un repli visuel générique
     si l'extension n'en a pas. */
  async _runPackOpenSequence(fetchFn, extensionId) {
    S.packOpeningExtensionId = extensionId || 'base';
    S.packAnim = 'shaking'; render();
    await new Promise(r => setTimeout(r, 900));
    S.packAnim = 'opening'; render();
    await new Promise(r => setTimeout(r, 750));
    try {
      const r = await fetchFn();
      S.lastDrawn = r.drawn;
      S.profile = r.profile;
      S.packStatus = await api('/api/pack/status');
      // Nouvelle phase : les cartes apparaissent face cachée, une pile à révéler
      // carte par carte au clic — voir renderPackRevealStage().
      S.packAnim = { phase: 'presenting', index: 0, flipped: false, collected: [] };
      playGameSound('packOpen', () => window.SFX && SFX.packOpen());
      handleUnlockedAchievements(r.unlockedAchievements);
      render();
    } catch (e) { S.packAnim = null; alert(e.message); render(); }
  },
  /* Un clic sur la carte du dessus : la révèle si elle est encore face cachée,
     ou l'envoie rejoindre les cartes déjà obtenues et avance à la suivante si
     elle est déjà révélée — exactement le cycle décrit dans la spécification
     (clic pour révéler, la carte rejoint ensuite la zone des cartes obtenues). */
  flipTopPackCard() {
    const anim = S.packAnim;
    if (!anim || anim.phase !== 'presenting') return;
    if (!anim.flipped) {
      anim.flipped = true;
      anim.fxAt = Date.now(); // l'effet de rareté ne se joue qu'au moment de la révélation
      const card = S.lastDrawn[anim.index];
      if (card) playRevealSound(card);
      render();
      return;
    }
    // La carte était déjà révélée : elle rejoint la zone des cartes obtenues
    anim.collected.push(S.lastDrawn[anim.index]);
    if (anim.index + 1 >= S.lastDrawn.length) {
      S.packAnim = { phase: 'results' };
    } else {
      anim.index += 1;
      // Seule la toute première carte se présente face cachée avec un clic
      // dédié pour la retourner — à partir de la deuxième, la carte suivante
      // arrive déjà face visible (un seul clic suffit pour passer à la
      // suivante), pour un rythme plus direct sur le reste du paquet.
      anim.flipped = true;
      anim.fxAt = Date.now();
      const nextCard = S.lastDrawn[anim.index];
      if (nextCard) playRevealSound(nextCard);
    }
    render();
  },
  dismissMatchResult() {
    clearTimeout(window.__matchResultTimer);
    S.matchResultOverlay = null;
    App.returnToMenuAfterMatch();
  },
  /* Sortie de fin de match : on quitte le plateau et on revient à l'écran d'où
     l'on vient — l'onglet Événements après un boss, le menu Combat sinon — avec
     des données fraîches (liste d'amis, disponibilité du boss). */
  returnToMenuAfterMatch() {
    if (isPhone()) releaseLandscape();
    const st = S.matchState;
    const wasBoss = !!(st && st.opponent && st.opponent.slug === 'boss');
    const wasPractice = !!S.practiceDeck;
    const wasTournament = !!(st && st.tournament);
    const wasStory = !!(st && st.opponent && st.opponent.slug === 'story-boss');
    const storyRes = S.matchResultOverlay && S.matchResultOverlay.rewards && S.matchResultOverlay.rewards.story;
    const report = S.matchResultOverlay && S.matchResultOverlay.rewards && S.matchResultOverlay.rewards.deckReportId;
    App.leaveMatch();
    // Après un entraînement, on revient sur le bilan du deck plutôt que sur le menu Combat
    if (wasPractice) { S.deckDraft = S.practiceDeck.slice(); S.practiceDeck = null; S.openReport = report || null; App.goTab('deckstats'); return; }
    if (wasTournament) { loadTournament(); App.goTab('tournoi'); return; }
    if (st && st.sandbox) { App.goTab('admin'); S.adminTab = 'sandbox'; render(); return; }
    if (wasStory) { S.storyLast = storyRes || null; App.goTab('histoire'); return; }
    if (st && (st.survival || (st.rewards && st.rewards.survival))) { S.survival = null; App.goTab('survie'); return; }
    if (st && (st.draft || (st.rewards && st.rewards.draft))) { S.draft = null; App.goTab('draft'); return; }
    if (st && st.puzzle) { S.puzzle = null; App.goTab('puzzle'); return; }
    if (st && st.brawl) { S.brawl = null; App.goTab('bagarre'); return; }
    App.goTab(wasBoss && S.events && S.events.tabEnabled ? 'evenements' : 'combat');
  },
  openReportAfterMatch(id) {
    clearTimeout(window.__matchResultTimer);
    S.matchResultOverlay = null;
    if (S.practiceDeck) { S.deckDraft = S.practiceDeck.slice(); S.practiceDeck = null; }
    App.leaveMatch();
    S.openReport = id;
    App.goTab('deckstats');
  },
  closePackReveal() {
    S.packAnim = null;
    if (window.Card3D) window.Card3D.unmount();
    render();
  },

  /* ---- Poussière ---- */
  async disenchant(cardId, amount) {
    try {
      const r = await api('/api/dust/disenchant', 'POST', { cardId, amount });
      S.profile = r.profile;
      S.duplicates = (await api('/api/dust/duplicates')).duplicates;
    } catch (e) { alert(e.message); }
    render();
  },
  async disenchantAll() {
    try {
      const r = await api('/api/dust/disenchant-all', 'POST');
      S.profile = r.profile;
      S.duplicates = (await api('/api/dust/duplicates')).duplicates;
      if (r.gained > 0) alert(`+${r.gained} poussière récupérée.`);
    } catch (e) { alert(e.message); }
    render();
  },

  /* ---- Boutique ---- */
  async buyCreditPack(packId) {
    try {
      const r = await api('/api/shop/buy-credit-pack', 'POST', { packId });
      S.profile = r.profile;
      S.shop = await api('/api/shop');
      handleUnlockedAchievements(r.unlockedAchievements);
    } catch (e) { alert(e.message); }
    render();
  },
  async buyOrnament(id) {
    try {
      const r = await api('/api/shop/buy', 'POST', { ornamentId: id });
      S.profile = r.profile; S.shop = await api('/api/shop');
      handleUnlockedAchievements(r.unlockedAchievements);
    } catch (e) { alert(e.message); }
    render();
  },
  async equipOrnament(id) {
    try {
      const r = await api('/api/shop/equip', 'POST', { ornamentId: id });
      S.profile = r.profile; S.shop = await api('/api/shop');
    } catch (e) { alert(e.message); }
    render();
  },

  /* ---- Deck ---- */
  addToDeck(cardId) {
    const owned = S.profile.collection[cardId] || 0;
    const inDeck = S.deckDraft.filter(id => id === cardId).length;
    const card = cardById(cardId);
    const limit = COPY_LIMITS[card.rarity] || 2;
    if (inDeck >= owned || inDeck >= limit || S.deckDraft.length >= DECK_SIZE) return;
    S.deckDraft.push(cardId); render();
  },
  removeFromDeck(cardId) {
    const idx = S.deckDraft.indexOf(cardId);
    if (idx >= 0) S.deckDraft.splice(idx, 1);
    render();
  },
  async tournamentRegister() { try { S.tournament = await api('/api/tournament/register', 'POST', {}); } catch (e) { alert(e.message); } render(); },
  async tournamentUnregister() { try { S.tournament = await api('/api/tournament/unregister', 'POST', {}); } catch (e) { alert(e.message); } render(); },
  async tournamentReady(ready) { try { S.tournament = await api('/api/tournament/ready', 'POST', { ready }); } catch (e) { alert(e.message); } render(); },
  async adminTournamentTab(enabled) { try { await api('/api/admin/tournament/tab', 'POST', { code: S.adminCodeTry, enabled }); await loadTournament(); } catch (e) { alert(e.message); } },
  async adminTournamentStart() { try { await api('/api/admin/tournament/start', 'POST', { code: S.adminCodeTry }); await loadTournament(); } catch (e) { alert(e.message); } },
  async adminTournamentCancel() { if (!confirm('Annuler le tournoi en cours ?')) return; try { await api('/api/admin/tournament/cancel', 'POST', { code: S.adminCodeTry }); await loadTournament(); } catch (e) { alert(e.message); } },
  async adminTournamentArchive() { try { await api('/api/admin/tournament/archive', 'POST', { code: S.adminCodeTry }); await loadTournament(); } catch (e) { alert(e.message); } },
  async adminTournamentWinner(matchRef, winner) {
    const p = S.tournament && S.tournament.current ? tPlayer(S.tournament.current, winner) : { pseudo: winner };
    if (!confirm(`Déclarer ${p.pseudo} vainqueur de ce match ?`)) return;
    try { await api('/api/admin/tournament/winner', 'POST', { code: S.adminCodeTry, matchRef, winner }); await loadTournament(); } catch (e) { alert(e.message); }
  },
  async adminTournamentCreate() {
    const fd = new FormData();
    fd.append('code', S.adminCodeTry);
    fd.append('name', document.getElementById('tour-name').value.trim());
    fd.append('desc', document.getElementById('tour-desc').value.trim());
    fd.append('rewardName', document.getElementById('tour-orn-name').value.trim());
    fd.append('titleName', (document.getElementById('tour-title') || {}).value || '');
    const img = document.getElementById('tour-orn-image');
    if (img && img.files && img.files[0]) fd.append('image', img.files[0]);
    const ex = document.getElementById('tour-orn-existing');
    if (ex && ex.value) fd.append('rewardOrnamentId', ex.value);
    const tb = document.getElementById('tour-banner');
    if (tb && tb.value) fd.append('rewardBannerId', tb.value);
    try {
      await upload('/api/admin/tournament', fd);
      try { S.config = await api('/api/config'); } catch (e) {}
      await loadTournament();
    } catch (e) { alert(e.message); }
  },
  async openReplay(id) {
    S.replay = { id, idx: 0, playing: false, speed: 1, data: null };
    render();
    try { const r = await api('/api/replays/' + id); S.replay.data = r.replay; S.replay.viewer = r.viewer; }
    catch (e) { alert(e.message); S.replay = null; }
    render(); window.scrollTo(0, 0);
  },
  closeReplay() { clearInterval(window.__replayTimer); S.replay = null; render(); },
  replayGo(i) { if (!S.replay || !S.replay.data) return; S.replay.idx = Math.max(0, Math.min(S.replay.data.frames.length - 1, i)); render(); },
  replayStep(d) { if (S.replay) App.replayGo(S.replay.idx + d); },
  replaySpeed() { if (!S.replay) return; S.replay.speed = S.replay.speed >= 4 ? 1 : S.replay.speed * 2; if (S.replay.playing) { App.replayToggle(); App.replayToggle(); } else render(); },
  replayToggle() {
    const R = S.replay; if (!R || !R.data) return;
    clearInterval(window.__replayTimer);
    R.playing = !R.playing;
    if (R.playing) {
      if (R.idx >= R.data.frames.length - 1) R.idx = 0;
      window.__replayTimer = setInterval(() => {
        if (!S.replay || S.tab !== 'combat') { clearInterval(window.__replayTimer); return; }
        if (S.replay.idx >= S.replay.data.frames.length - 1) { S.replay.playing = false; clearInterval(window.__replayTimer); render(); return; }
        S.replay.idx++; render();
      }, 1300 / R.speed);
    }
    render();
  },
  async saveRanking() {
    const v = id => Number(document.getElementById(id).value);
    const ranking = {
      rankThresholds: [0, 1, 2, 3].map(i => v('rk-th-' + i)), vpWin: v('rk-win'), vpLoss: v('rk-loss'), minLossTurns: v('rk-minturns'),
      firstWinMultiplier: v('rk-first'), streakFrom: v('rk-streak-from'), streakBonus: v('rk-streak'),
      softReset: document.getElementById('rk-soft').checked,
      rankRewards: { bronze: 0, argent: v('rk-rw-argent'), or: v('rk-rw-or'), diamant: v('rk-rw-diamant'), maitre: v('rk-rw-maitre') }
    };
    try {
      await api('/api/admin/settings', 'PATCH', { code: S.adminCodeTry, ranking });
      S.config = await api('/api/config');
      try { S.profile = (await api('/api/me')).profile; } catch (e) {}
      alert('Classement enregistré.');
    } catch (e) { alert(e.message); }
    render();
  },
  storySelect(id) { S.storySelected = id; render(); },
  async adminStoryTab(enabled) {
    try { const r = await api('/api/admin/story/tab', 'POST', { code: S.adminCodeTry, enabled }); S.adminStoryEnabled = r.tabEnabled; await loadStory(); }
    catch (e) { alert(e.message); }
    render();
  },
  storyDismiss() { S.storyLast = null; render(); },
  storyStart(id, fightIndex) { S.storyLast = null; S.socket.emit('story:start', { chapterId: id, fightIndex }); },
  async adminStorySave() {
    try { const r = await api('/api/admin/story', 'POST', { code: S.adminCodeTry, chapters: readAdminStory() }); S.adminStory = r.chapters; alert('Chapitres enregistrés.'); }
    catch (e) { alert(e.message); }
    render();
  },
  adminStoryAdd() {
    S.adminStory = readAdminStory();
    const last = S.adminStory[S.adminStory.length - 1] || {};
    const m = (S.cardPool || []).find(c => c.type === 'minion') || {};
    S.adminStory.push({ id: 'ch-' + Date.now().toString(36), title: 'Nouveau chapitre', intro: '', victory: '', bossCardId: last.bossCardId || m.id, bossName: last.bossName || m.name,
      hp: (Number(last.hp) || 25) + 5, armor: Number(last.armor) || 0, quality: Math.min(1, (Number(last.quality) || 0) + 0.1), reward: { dust: 50, credits: 0 },
      enabled: false, minions: (last.minions || []).map(x => Object.assign({}, x)) });
    render();
  },
  adminStoryRemove(i) { S.adminStory = readAdminStory(); S.adminStory.splice(i, 1); render(); },
  async adminStoryRegenerate() {
    if (!confirm('Recréer tous les chapitres à partir des cartes actuelles ? Tes textes modifiés seront remplacés.')) return;
    try { const r = await api('/api/admin/story', 'POST', { code: S.adminCodeTry, regenerate: true, count: 8 }); S.adminStory = r.chapters; } catch (e) { alert(e.message); }
    render();
  },
  setOpt(key, value, el) {
    OPTS[key] = value; saveOpts();
    if (el && el.nextElementSibling) el.nextElementSibling.textContent = Math.round(value * 100) + ' %'; // curseur : pas de rerendu pendant le glisser
    else render();
    if (key === 'musicVol') { MUSIC.track = null; syncMusic(); }
  },
  testSfx() { if (window.SFX && SFX.cardReveal) SFX.cardReveal('rare'); },
  async toggleNotifications(on) {
    if (on && typeof Notification !== 'undefined' && Notification.permission !== 'granted') {
      const r = await Notification.requestPermission();
      if (r !== 'granted') { OPTS.notify = false; saveOpts(); render(); return; }
    }
    OPTS.notify = !!on; saveOpts();
    if (on) { try { await pushSubscribe(); } catch (e) { S.pushError = "Notifications push indisponibles sur cet appareil : seules les notifications avec l'onglet ouvert marcheront."; } }
    else { S.pushError = null; await pushUnsubscribe(); }
    render();
  },
  async testPush() {
    S.pushTest = 'Envoi…'; render();
    try { const r = await api('/api/push/test', 'POST', {}); S.pushTest = r.ok ? `Envoyée à ${r.devices} appareil${r.devices > 1 ? 's' : ''} : elle s'affiche si le jeu n'est pas à l'écran (ferme ou réduis-le quelques secondes).` : "Le service de notification a refusé l'envoi."; }
    catch (e) { S.pushTest = e.message; }
    render();
  },
  async installApp() {
    if (!PUSH.installEvt) return;
    PUSH.installEvt.prompt();
    try { await PUSH.installEvt.userChoice; } catch (e) {}
    PUSH.installEvt = null; render();
  },
  async setTitle(id) {
    try { await api('/api/me/title', 'POST', { titleId: id }); S.profile = (await api('/api/me')).profile; } catch (e) { alert(e.message); }
    render();
  },
  enterLandscape() { lockLandscape().then(() => setTimeout(() => { fitCombat(); render(); }, 300)); },
  openBugReport() { S.bugModal = { sent: false }; render(); setTimeout(() => { const t = document.getElementById('bug-text'); if (t) t.focus(); }, 0); },
  closeBugReport() { S.bugModal = null; render(); },
  async sendBugReport() {
    const text = (document.getElementById('bug-text') || {}).value || '';
    try {
      await api('/api/bug-report', 'POST', { text, client: navigator.userAgent, screen: `${window.innerWidth}×${window.innerHeight}`,
        clientState: { tab: S.tab, targeting: S.targetingSpell || null, selectedAttacker: S.selectedAttacker || null, matchError: S.matchError || null, options: OPTS } });
      S.bugModal = { sent: true };
    } catch (e) { S.bugModal = { sent: false, error: e.message }; }
    render();
  },
  async loadBugReports() { try { S.adminBugs = (await api('/api/admin/bug-reports?code=' + encodeURIComponent(S.adminCodeTry || ''))).reports; } catch (e) { alert(e.message); } render(); },
  async setBugStatus(id, status, del) {
    try { await api('/api/admin/bug-reports/' + id, 'POST', { code: S.adminCodeTry, status, delete: !!del }); } catch (e) { alert(e.message); }
    App.loadBugReports();
  },
  async openAdminReplay(id, viewer) {
    S.replay = { id, idx: 0, playing: false, speed: 1, data: null };
    App.goTab('combat');
    try { const r = await api(`/api/admin/replays/${id}?code=${encodeURIComponent(S.adminCodeTry || '')}&viewer=${encodeURIComponent(viewer || '')}`); S.replay.data = r.replay; S.replay.viewer = r.viewer; }
    catch (e) { alert(e.message); S.replay = null; }
    render();
  },
  sandboxSearch(v) { S.sandbox.q = v; render(); },
  sandboxAdd(key, id) {
    const max = key === 'hand' ? 10 : 7;
    if (S.sandbox[key].length >= max) { alert(`Maximum ${max} cartes ici.`); return; }
    S.sandbox[key].push(id); render();
  },
  sandboxRemove(key, i) { S.sandbox[key].splice(i, 1); render(); },
  sandboxSet(key, v) { S.sandbox[key] = Number(v); },
  sandboxReset() { S.sandbox = null; render(); },
  startSandbox() {
    const sb = S.sandbox;
    S.socket.emit('admin:sandbox', { code: S.adminCodeTry, hand: sb.hand, myBoard: sb.mine, oppBoard: sb.theirs, mana: sb.mana, oppHp: sb.oppHp });
  },
  eqSet(key, v) {
    S.eq[key] = v;
    if (key === 'cardId' && S.eq.job && S.eq.job.result && S.eq.job.result.cardId !== v) { /* garde l'historique, affiche la carte choisie */ }
    render();
    if (key === 'q') { const el = document.getElementById('eq-search'); if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } }
  },
  async eqRun() {
    const eq = S.eq;
    try {
      const r = await api('/api/admin/equilibrium', 'POST', { code: S.adminCodeTry, cardId: eq.cardId, games: eq.games });
      eq.job = { id: r.jobId, done: 0, games: r.games, finished: false };
      render();
      const poll = async () => {
        try {
          const st = await api(`/api/admin/equilibrium/${r.jobId}?code=${encodeURIComponent(S.adminCodeTry || '')}`);
          eq.job = Object.assign(eq.job, st);
          if (st.finished && st.result) { eq.history = [st.result].concat(eq.history.filter(h => h.cardId !== st.result.cardId)).slice(0, 12); }
          if (S.tab === 'admin' && S.adminTab === 'equilibrium') render();
          if (!st.finished) setTimeout(poll, 400);
        } catch (e) { alert(e.message); }
      };
      setTimeout(poll, 300);
    } catch (e) { alert(e.message); }
  },
  async loadSchedule() {
    try {
      const r = await api('/api/admin/schedule?code=' + encodeURIComponent(S.adminCodeTry || ''));
      const st = await api('/api/admin/story?code=' + encodeURIComponent(S.adminCodeTry || '')).catch(() => ({ chapters: [] }));
      S.schedule = Object.assign(r, { chapters: st.chapters || [] });
    } catch (e) { alert(e.message); }
    render();
  },
  schedSet(k, v) { S.schedForm[k] = v; render(); },
  async addSchedule() {
    const f = S.schedForm, at = document.getElementById('sched-at').value;
    if (!at) { alert("Choisis la date et l'heure."); return; }
    const params = {};
    if (f.action === 'story_chapter_open') { params.chapterId = document.getElementById('sched-chapter').value; params.alsoTab = document.getElementById('sched-also-tab').checked; }
    if (/_tab$/.test(f.action)) params.enabled = document.getElementById('sched-enabled').value === '1';
    if (f.action === 'extension_publish') params.extensionId = document.getElementById('sched-ext').value;
    try { await api('/api/admin/schedule', 'POST', { code: S.adminCodeTry, action: f.action, params, at: new Date(at).getTime() }); App.loadSchedule(); }
    catch (e) { alert(e.message); }
  },
  async deleteSchedule(id) { try { await api('/api/admin/schedule', 'POST', { code: S.adminCodeTry, deleteId: id }); App.loadSchedule(); } catch (e) { alert(e.message); } },
  async optimizeImages() {
    if (!confirm('Convertir toutes les images déjà envoyées en WebP ? Garde cette page ouverte pendant la conversion.')) return;
    try {
      const { urls } = await api('/api/admin/images/list?code=' + encodeURIComponent(S.adminCodeTry || ''));
      let done = 0, before = 0, after = 0;
      for (const url of urls) {
        S.imgProgress = `${done} / ${urls.length}`; render();
        try {
          const blob = await (await fetch(url)).blob();
          const out = await shrinkImage(new File([blob], url.split('/').pop(), { type: blob.type }), IMAGE_MAX_SIDE(url));
          if (out.type === 'image/webp' && out.size < blob.size) {
            const fd = new FormData();
            fd.append('code', S.adminCodeTry); fd.append('url', url); fd.append('image', out, out.name);
            const r = await fetch('/api/admin/images/replace', { method: 'POST', body: fd, credentials: 'same-origin' });
            if (r.ok) { done++; before += blob.size; after += out.size; }
          }
        } catch (e) { /* image suivante */ }
      }
      S.imgProgress = null;
      const mo = n => (n / 1024 / 1024).toFixed(1) + ' Mo';
      alert(done ? `${done} image(s) converties : ${mo(before)} → ${mo(after)}.` : 'Aucune image à convertir (ou ton navigateur ne sait pas produire de WebP : essaie avec Chrome, Edge ou Firefox).');
      S.cardPool = (await api(cardsUrl())).cards; render();
    } catch (e) { S.imgProgress = null; alert(e.message); render(); }
  },
  chatToggle() {
    CHAT.open = !CHAT.open; if (CHAT.open) CHAT.unread = 0;
    try { localStorage.setItem('cgd-chat-open', CHAT.open ? '1' : '0'); } catch (e) {}
    syncChat();
    if (CHAT.open) { const l = document.getElementById('chat-list'); if (l) l.scrollTop = l.scrollHeight; }
  },
  chatSend() {
    const i = document.getElementById('chat-input'); if (!i) return;
    const text = i.value.trim(); if (!text || !S.socket) return;
    S.socket.emit('chat:send', { text });
    i.value = ''; i.placeholder = 'Ton message…'; CHAT.emojiOpen = false; syncChat(); i.focus();
  },
  chatEmojiToggle() { CHAT.emojiOpen = !CHAT.emojiOpen; syncChat(); },
  chatEmoji(e) { const i = document.getElementById('chat-input'); if (i) { i.value = (i.value + (i.value && !i.value.endsWith(' ') ? ' ' : '') + e + ' ').slice(0, 200); i.focus(); } },
  chatMention(pseudo) { const i = document.getElementById('chat-input'); if (i) { i.value = `@${pseudo} ` + i.value; i.focus(); } },
  chatDelete(id) { if (confirm('Supprimer ce message ?')) S.socket.emit('chat:delete', { code: S.adminCodeTry, id }); },
  chatRules() { alert("Règles du chat :\n• Reste respectueux avec tout le monde.\n• Pas de spam ni de publicité.\n• Pas d'informations personnelles.\nL'admin peut supprimer les messages qui ne respectent pas ces règles."); },
  addSuggested(cardId) {
    if ((S.deckDraft || []).length >= DECK_SIZE) {
      if (confirm('Ton deck a déjà 30 cartes. Ouvrir l\'onglet Deck pour retirer une carte et faire de la place ?')) App.goTab('deck');
      return;
    }
    App.addToDeck(cardId);
    App.goTab('deckstats'); // nouvelle analyse avec la carte ajoutée
  },
  practiceActiveDeck() {
    if (!S.profile.deck || S.profile.deck.length !== DECK_SIZE) { alert(`Configure un deck de ${DECK_SIZE} cartes dans l'onglet Deck avant de t'entraîner.`); return; }
    S.deckDraft = S.profile.deck.slice(); App.startPractice();
  },
  startPractice() {
    if ((S.deckDraft || []).length !== DECK_SIZE) { alert(`Il faut un deck de ${DECK_SIZE} cartes pour s'entraîner.`); return; }
    S.practiceDeck = S.deckDraft.slice();
    S.socket.emit('match:practice', { cardIds: S.deckDraft });
  },
  openDeckReport(id) { S.openReport = S.openReport === id ? null : id; render(); },
  setDeckSearch(value) { S.deckSearch = value; render(); },
  setDeckFilter(key, value) { S.deckFilter = Object.assign({ rarity: '', type: '', sort: 'cost', ext: '' }, S.deckFilter, { [key]: value }); render(); },
  clearDeckDraft() {
    if (!(S.deckDraft || []).length) return;
    if (!confirm('Retirer toutes les cartes du deck en cours pour en construire un autre ? Tes decks enregistrés ne sont pas touchés.')) return;
    S.deckDraft = []; render();
  },
  loadSavedDeckIntoDraft(id) {
    const d = (S.savedDecks || []).find(x => x.id === id);
    if (!d) return;
    S.deckDraft = (d.cardIds || []).filter(cid => cardById(cid));
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  },
  autoFillDeck() {
    const draft = [];
    const ids = Object.keys(S.profile.collection);
    let i = 0;
    while (draft.length < DECK_SIZE && ids.length > 0) {
      const id = ids[i % ids.length];
      const card = cardById(id);
      const owned = S.profile.collection[id] || 0;
      const inDraft = draft.filter(x => x === id).length;
      const limit = card ? (COPY_LIMITS[card.rarity] || 2) : 2;
      if (card && inDraft < owned && inDraft < limit) draft.push(id);
      i++;
      if (i > 5000) break;
    }
    S.deckDraft = draft; render();
  },
  async saveDeck() {
    try {
      await api('/api/deck', 'POST', { cardIds: S.deckDraft });
      S.profile = (await api('/api/me')).profile;
      alert('Deck enregistré !');
    } catch (e) { alert(e.message); }
    render();
  },
  async saveDeckAs() {
    if (S.deckDraft.length !== DECK_SIZE) { alert(`Ton deck doit contenir exactement ${DECK_SIZE} cartes avant de l'enregistrer.`); return; }
    const name = prompt('Nom de ce deck :');
    if (!name || !name.trim()) return;
    try {
      await api('/api/decks', 'POST', { name: name.trim(), cardIds: S.deckDraft });
      S.savedDecks = (await api('/api/decks')).decks;
      S.profile = (await api('/api/me')).profile;
      alert('Deck "' + name.trim() + '" enregistré !');
    } catch (e) { alert(e.message); }
    render();
  },
  async activateSavedDeck(id) {
    try {
      await api('/api/decks/' + id + '/activate', 'POST');
      S.profile = (await api('/api/me')).profile;
      S.deckDraft = S.profile.deck.slice();
      alert('Deck activé !');
    } catch (e) { alert(e.message); }
    render();
  },
  async renameSavedDeck(id, currentName) {
    const name = prompt('Nouveau nom :', currentName);
    if (!name || !name.trim() || name.trim() === currentName) return;
    try {
      await api('/api/decks/' + id, 'PATCH', { name: name.trim() });
      S.savedDecks = (await api('/api/decks')).decks;
    } catch (e) { alert(e.message); }
    render();
  },
  async deleteSavedDeck(id, name) {
    if (!confirm('Supprimer le deck "' + name + '" ?')) return;
    try {
      await api('/api/decks/' + id, 'DELETE');
      S.savedDecks = (await api('/api/decks')).decks;
    } catch (e) { alert(e.message); }
    render();
  },

  /* ---- Joueurs / amis / échanges ---- */
  setPlayerFilter(v) { S.playerFilter = v; render(); },
  async viewPlayer(slug) {
    try { S.viewedPlayer = await api('/api/players/' + slug); } catch (e) {}
    render();
  },
  backToDirectory() { S.viewedPlayer = null; S.tradeBuilder = null; render(); },
  async toggleFriend(slug) {
    try {
      await api('/api/players/' + slug + '/friend', 'POST');
      S.profile = (await api('/api/me')).profile;
      if (S.viewedPlayer) S.viewedPlayer = await api('/api/players/' + slug);
    } catch (e) {}
    render();
  },
  startTradeBuilder(theirSlug) {
    S.tradeBuilder = { slug: theirSlug, requestIds: new Set(), offerIds: new Set() };
    render();
  },
  cancelTradeBuilder() { S.tradeBuilder = null; render(); },
  toggleTradeCard(side, cardId) {
    if (!S.tradeBuilder) return;
    const set = side === 'request' ? S.tradeBuilder.requestIds : S.tradeBuilder.offerIds;
    if (set.has(cardId)) set.delete(cardId); else set.add(cardId);
    render();
  },
  async confirmTradeBuilder() {
    if (!S.tradeBuilder) return;
    const { slug, requestIds, offerIds } = S.tradeBuilder;
    try {
      await api('/api/trade/request', 'POST', {
        toSlug: slug, offerCardIds: Array.from(offerIds), requestCardIds: Array.from(requestIds)
      });
      S.tradeBuilder = null;
      alert('Proposition envoyée !');
    } catch (e) { alert(e.message); }
    render();
  },
  async acceptTrade(id) {
    try {
      const r = await api('/api/trade/' + id + '/accept', 'POST');
      S.profile = (await api('/api/me')).profile;
      handleUnlockedAchievements(r.unlockedAchievements);
    } catch (e) { alert(e.message); }
    S.trades = await api('/api/trade'); render();
  },
  async declineTrade(id) {
    try { await api('/api/trade/' + id + '/decline', 'POST'); } catch (e) {}
    S.trades = await api('/api/trade'); render();
  },
  async cancelTrade(id) {
    try { await api('/api/trade/' + id + '/cancel', 'POST'); } catch (e) {}
    S.trades = await api('/api/trade'); render();
  },

  /* ---- Admin ---- */
  setAdminTab(t) {
    S.adminTab = t; S.adminViewedUser = null;
    if (t === 'users') App.refreshAdminUsers();
    if (t === 'stats') App.loadCardStats();
    if (t === 'tournament') loadTournament();
    if (t === 'bugs') App.loadBugReports();
    if (t === 'schedule') App.loadSchedule();
    if (t === 'story') api('/api/admin/story?code=' + encodeURIComponent(S.adminCodeTry || '')).then(r => { S.adminStory = r.chapters; S.adminStoryEnabled = r.tabEnabled; render(); }).catch(e => alert(e.message));
    if (t === 'events') api('/api/events').then(ev => { S.events = ev.events; S.bossDeckDraft = null; S.bossDialogueDraft = null; render(); }).catch(() => {});
    if (t === 'achievements') {
      fetch('/api/admin/achievements?code=' + encodeURIComponent(S.adminCodeTry || ''))
        .then(r => r.json()).then(d => { S.adminAchievements = d.achievements || []; S.adminConditionTypes = d.conditionTypes || {}; render(); }).catch(() => {});
      if (!S.playersList) api('/api/players').then(d => { S.playersList = d.players; render(); }).catch(() => {});
    }
    if (t === 'extensions') api('/api/credit-packs').then(d => { S.adminCreditPacks = d.packs || []; render(); }).catch(() => {});
    render();
  },
  setAdminCardRarity(r) { S.adminCardRarity = r; renderKeepingCardForm(); },
  toggleAdminCustomDrop() { S.adminCustomDrop = !S.adminCustomDrop; renderKeepingCardForm(); },
  toggleAdminCardParallax(checked) { S.adminCardParallax = checked; renderKeepingCardForm(); },
  setAdminSpellEffect(value) {
    // Pas de render() ici : un ré-affichage complet recrée le formulaire et
    // effacerait les champs déjà remplis. On mémorise juste le choix (pour
    // qu'il survive à un ré-affichage ultérieur, ex. case parallaxe cochée)
    // et on affiche/masque directement le champ du soin combiné.
    S.adminSpellEffect = value;
    const row = document.getElementById('new-card-value2-row');
    if (row) row.style.display = value === 'buff_ally_and_heal' || value === 'modify_stats' ? '' : 'none';
    const drRow = document.getElementById('new-card-spell-dr-row');
    if (drRow) drRow.style.display = value === 'give_deathrattle' ? '' : 'none';
    const trapRow = document.getElementById('new-card-trap-row');
    if (trapRow) trapRow.style.display = value === 'trap' ? '' : 'none';
    const tokRow = document.getElementById('new-card-spell-token-row');
    if (tokRow) tokRow.style.display = value === 'summon' || value === 'trap' ? '' : 'none';
    const l1 = document.getElementById('new-card-value-label'), l2 = document.getElementById('new-card-value2-label');
    if (l1) l1.textContent = value === 'modify_stats' ? "Changement d'ATQ (ex : 2 ou -1)" : value === 'draw' ? 'Nombre de cartes à piocher' : value === 'sleep' ? 'Nombre de tours de sommeil' : 'Valeur principale';
    if (l2) l2.textContent = value === 'modify_stats' ? 'Changement de PV (ex : 3 ou -1)' : "Soin du héros (pour l'effet combiné uniquement)";
  },

  previewDropWeight(value) {
    const el = document.getElementById('drop-estimate-preview');
    if (!el) return;
    const pct = estimatedDropPercent(S.adminCardRarity, value);
    el.textContent = `≈ ${(pct || 0).toFixed(2)}% de chance dans un booster`;
  },
  async updateCardDropWeight(cardId) {
    const input = document.getElementById('card-dropweight-' + cardId);
    if (!input) return;
    try {
      await fetch('/api/admin/cards/' + cardId + '/drop-weight', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify({ code: S.adminCodeTry, dropWeight: input.value })
      }).then(async r => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || 'Échec.'); });
      S.cardPool = (await api(cardsUrl())).cards;
    } catch (e) { alert(e.message); }
    render();
  },

  async refreshAdminUsers() {
    try {
      const r = await fetch('/api/admin/users', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify({ code: S.adminCodeTry })
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      S.adminUsers = d.users;
    } catch (e) { S.adminUsers = []; alert(e.message); }
    render();
  },
  setAdminUserFilter(v) { S.adminUserFilter = v; render(); },
  async viewAdminUser(slug) {
    try {
      const r = await fetch('/api/admin/users/' + slug + '/collection', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify({ code: S.adminCodeTry })
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      S.adminViewedUser = d;
    } catch (e) { alert(e.message); }
    render();
  },
  backToAdminUsers() { S.adminViewedUser = null; S.adminGrantSearch = ''; render(); },
  adminGrantSearch(v) {
    S.adminGrantSearch = v;
    const box = document.querySelector('.admin-grant-results');
    if (box && S.adminViewedUser) box.innerHTML = renderAdminGrantResults(S.adminViewedUser);
  },
  async adminGrantCard(slug, cardId, qty) {
    const input = document.getElementById('admin-grant-qty');
    const quantity = qty || Math.max(1, Math.round(Number(input && input.value) || 1));
    try {
      await api('/api/admin/users/' + slug + '/grant-card', 'POST', { code: S.adminCodeTry, cardId, quantity });
      await App.viewAdminUser(slug);
    } catch (e) { alert(e.message); }
  },
  async adminRemoveCard(slug, cardId, qty, name) {
    if (qty === 'all' && !confirm(`Retirer toutes les copies de « ${name || cardId} » de cette collection ? Elles seront aussi retirées de ses decks.`)) return;
    try {
      await api('/api/admin/users/' + slug + '/remove-card', 'POST', qty === 'all' ? { code: S.adminCodeTry, cardId, all: true } : { code: S.adminCodeTry, cardId, quantity: qty });
      await App.viewAdminUser(slug);
    } catch (e) { alert(e.message); }
  },
  async adjustUserDust(slug, delta) {
    try {
      const r = await fetch('/api/admin/users/' + slug + '/dust', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify({ code: S.adminCodeTry, delta })
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      await App.refreshAdminUsers();
    } catch (e) { alert(e.message); }
  },
  async adjustUserDustCustom(slug) {
    const input = document.getElementById('dust-delta-' + slug);
    const delta = Number(input.value);
    if (!delta) { alert('Entre une valeur (positive pour ajouter, négative pour retirer).'); return; }
    await App.adjustUserDust(slug, delta);
    input.value = '';
  },
  async adjustUserCredits(slug, delta) {
    try {
      const r = await fetch('/api/admin/users/' + slug + '/credits', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify({ code: S.adminCodeTry, delta })
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      await App.refreshAdminUsers();
    } catch (e) { alert(e.message); }
  },
  async adjustUserCreditsCustom(slug) {
    const input = document.getElementById('credits-delta-' + slug);
    const delta = Number(input.value);
    if (!delta) { alert('Entre une valeur (positive pour ajouter, négative pour retirer).'); return; }
    await App.adjustUserCredits(slug, delta);
    input.value = '';
  },
  async resetUserPassword(slug, pseudo) {
    const pw = prompt('Nouveau mot de passe pour ' + pseudo + ' (4 caractères minimum) :');
    if (!pw) return;
    try {
      const r = await fetch('/api/admin/users/' + slug + '/reset-password', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify({ code: S.adminCodeTry, newPassword: pw })
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      alert('Mot de passe réinitialisé pour ' + pseudo + '.');
    } catch (e) { alert(e.message); }
  },
  async grantStarterDeck(slug, pseudo) {
    if (!confirm('Offrir un deck de départ (30 cartes) à ' + pseudo + ' ? Les cartes s\'ajoutent à sa collection sans rien lui retirer.')) return;
    try {
      const r = await fetch('/api/admin/users/' + slug + '/grant-starter', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify({ code: S.adminCodeTry })
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      alert('Deck de départ offert à ' + pseudo + ' !');
      await App.refreshAdminUsers();
    } catch (e) { alert(e.message); }
  },
  async deleteUserAccount(slug, pseudo) {
    const confirmText = prompt('Pour confirmer la suppression DÉFINITIVE du compte "' + pseudo + '", retape exactement son pseudo :');
    if (confirmText !== pseudo) { if (confirmText !== null) alert('Le pseudo ne correspond pas — suppression annulée.'); return; }
    try {
      const r = await fetch('/api/admin/users/' + slug + '/delete', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify({ code: S.adminCodeTry, confirmPseudo: pseudo })
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      S.adminViewedUser = null;
      await App.refreshAdminUsers();
    } catch (e) { alert(e.message); }
  },

  /* ---- Édition d'une carte existante ---- */
  startEditCard(cardId) {
    const card = cardById(cardId);
    if (!card) return;
    S.adminEditingCardId = cardId;
    S.adminCardType = card.type;
    S.adminCardRarity = card.rarity;
    S.adminCustomDrop = false;
    S.adminCardParallax = !!card.parallax;
    S.adminSpellEffect = card.effectType || null;
    render();
    setTimeout(() => { const p = document.getElementById('card-form-panel'); if (p) p.scrollIntoView({ behavior: 'smooth' }); }, 30);
  },
  cancelEditCard() { S.adminEditingCardId = null; S.adminCardParallax = false; S.adminSpellEffect = null; render(); },
  async saveCardEdit() {
    const id = S.adminEditingCardId;
    if (!id) return;
    const payload = {
      code: S.adminCodeTry,
      name: document.getElementById('new-card-name').value.trim(),
      desc: document.getElementById('new-card-desc').value.trim(),
      rarity: S.adminCardRarity,
      cost: document.getElementById('new-card-cost').value,
      extensionId: document.getElementById('new-card-extension').value
    };
    if (S.adminCardType === 'minion') {
      payload.attack = document.getElementById('new-card-attack').value;
      payload.health = document.getElementById('new-card-health').value;
      payload.armor = document.getElementById('new-card-armor').value;
      payload.battlecryHeal = document.getElementById('new-card-bcheal').value;
      payload.taunt = document.getElementById('new-card-taunt').checked;
      payload.charge = document.getElementById('new-card-charge').checked;
      payload.colorblind = document.getElementById('new-card-colorblind').checked;
      payload.colorblindChance = document.getElementById('new-card-colorblind-chance').value || '50';
      ['shield', 'windfury', 'stealth', 'standing'].forEach(k => { payload[k] = document.getElementById('new-card-' + k).checked; });
      readMechanicsForm('new-card-token-').forEach(([k, v]) => { payload[k] = v; });
      payload.drEffect = document.getElementById('new-card-dr-effect').value;
      payload.drValue = document.getElementById('new-card-dr-value').value || '1';
      payload.drValue2 = document.getElementById('new-card-dr-value2').value || '';
      [2, 3].forEach(k => {
        payload[`bc${k}Effect`] = document.getElementById(`new-card-bc${k}-effect`).value;
        payload[`bc${k}Value`] = document.getElementById(`new-card-bc${k}-value`).value || '1';
        payload[`bc${k}Value2`] = document.getElementById(`new-card-bc${k}-value2`).value || '';
      });
      payload.bcEffect = document.getElementById('new-card-bc-effect').value;
      payload.bcValue = document.getElementById('new-card-bc-value').value || '1';
      payload.bcValue2 = document.getElementById('new-card-bc-value2').value || '';
    } else if (S.adminCardType === 'weapon') {
      payload.attack = document.getElementById('new-card-attack').value;
      payload.durability = document.getElementById('new-card-durability').value;
      payload.usesPerTurn = document.getElementById('new-card-usesperturn').value;
      payload.battlecryHeal = document.getElementById('new-card-bcheal').value;
    } else {
      payload.effectType = document.getElementById('new-card-effect').value;
      payload.value = document.getElementById('new-card-value').value;
      readMechanicsForm('new-card-stoken-').forEach(([k, v]) => { payload[k] = v; });
      if (payload.effectType === 'give_deathrattle') {
        payload.drEffect = document.getElementById('new-card-spell-dr-effect').value;
        payload.drValue = document.getElementById('new-card-spell-dr-value').value || '1';
        payload.drValue2 = document.getElementById('new-card-spell-dr-value2').value || '';
      }
      payload.value2 = document.getElementById('new-card-value2') ? document.getElementById('new-card-value2').value : '';
    }
    try {
      await fetch('/api/admin/cards/' + id, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify(payload)
      }).then(async r => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || 'Échec.'); });
      // Nouvelle illustration / nouveau son choisis dans le formulaire de modification
      // (avant, ces deux champs étaient ignorés : l'image ne changeait jamais).
      const imgInput = document.getElementById('new-card-image');
      if (imgInput && imgInput.files && imgInput.files[0]) {
        const ifd = new FormData();
        ifd.append('code', S.adminCodeTry);
        ifd.append('image', imgInput.files[0]);
        await upload('/api/admin/cards/' + id + '/image', ifd);
      }
      const sndInput = document.getElementById('new-card-sound');
      if (sndInput && sndInput.files && sndInput.files[0]) {
        const sfd = new FormData();
        sfd.append('code', S.adminCodeTry);
        sfd.append('sound', sndInput.files[0]);
        await upload('/api/admin/cards/' + id + '/sound', sfd);
      }
      if (S.adminCardParallax) {
        const layers = [['background', 'new-card-parallax-bg'], ['character', 'new-card-parallax-char']];
        let anyLayerUploaded = false;
        for (const [layer, inputId] of layers) {
          const input = document.getElementById(inputId);
          if (input && input.files && input.files[0]) {
            anyLayerUploaded = true;
            const lfd = new FormData();
            lfd.append('code', S.adminCodeTry);
            lfd.append('image', input.files[0]);
            await upload('/api/admin/cards/' + id + '/parallax/' + layer, lfd);
          }
        }
        if (!anyLayerUploaded) {
          // Case cochée mais aucun nouveau fichier choisi : soit les 3 calques étaient
          // déjà là (on réactive juste l'affichage), soit ils ne le sont pas (le
          // serveur refusera proprement et on prévient l'admin).
          try {
            await fetch('/api/admin/cards/' + id + '/parallax', {
              method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
              body: JSON.stringify({ code: S.adminCodeTry, enabled: true })
            }).then(async r => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error); });
          } catch (e) { alert('Carte enregistrée, mais le parallaxe n\'a pas pu s\'activer : ' + e.message); }
        }
      } else {
        // La case a été décochée : on désactive juste l'affichage 3D, les images restent en réserve
        await fetch('/api/admin/cards/' + id + '/parallax', {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
          body: JSON.stringify({ code: S.adminCodeTry, enabled: false })
        }).catch(() => {});
      }
      S.cardPool = (await api(cardsUrl())).cards;
      S.adminEditingCardId = null;
      S.adminCardParallax = false;
      S.adminSpellEffect = null;
      alert('Carte mise à jour !');
    } catch (e) { alert(e.message); }
    render();
  },

  /* ---- Extensions ---- */
  /* ---- Événements (admin) ---- */
  /* ---- Succès (admin) ---- */
  toggleShowcase(id) {
    const draft = S.showcaseDraft || [];
    if (draft.includes(id)) { S.showcaseDraft = draft.filter(x => x !== id); render(); return; }
    if (draft.length >= 5) { alert('Maximum 5 succès dans la vitrine — décoche-en un d\'abord.'); return; }
    S.showcaseDraft = draft.concat(id);
    render();
  },
  async saveShowcase() {
    try {
      const r = await api('/api/me/showcase', 'POST', { achievementIds: S.showcaseDraft || [] });
      S.showcaseDraft = r.showcase.slice();
      alert('Vitrine enregistrée !');
    } catch (e) { alert(e.message); }
    render();
  },

  setAdminAchievementType(type) { S.adminAchievementType = type; render(); },
  async createAchievement() {
    const paramEl = document.getElementById('ach-param');
    const body = {
      code: S.adminCodeTry,
      name: document.getElementById('ach-name').value.trim(),
      description: document.getElementById('ach-desc').value.trim(),
      rewardCredits: document.getElementById('ach-reward-credits').value,
      rewardDust: document.getElementById('ach-reward-dust').value,
      rewardTitle: (document.getElementById('ach-reward-title') || {}).value || '',
      condition: { type: S.adminAchievementType, param: paramEl ? paramEl.value : null, target: document.getElementById('ach-target').value }
    };
    try {
      const r = await fetch('/api/admin/achievements', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      document.getElementById('ach-name').value = ''; document.getElementById('ach-desc').value = '';
      App.setAdminTab('achievements');
      alert('Succès créé !');
    } catch (e) { alert(e.message); }
  },
  async updateAchievementReward(id) {
    const rewardCredits = document.getElementById('ach-edit-credits-' + id).value;
    const rewardDust = document.getElementById('ach-edit-dust-' + id).value;
    try {
      const r = await fetch('/api/admin/achievements/' + id, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify({ code: S.adminCodeTry, rewardCredits, rewardDust })
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      App.setAdminTab('achievements');
      alert('Récompense mise à jour !');
    } catch (e) { alert(e.message); }
  },
  async uploadAchievementIcon(id, input) {
    if (!input.files || !input.files[0]) return;
    const fd = new FormData();
    fd.append('code', S.adminCodeTry);
    fd.append('image', input.files[0]);
    try {
      await upload('/api/admin/achievements/' + id + '/icon', fd);
      App.setAdminTab('achievements');
    } catch (e) { alert(e.message); }
  },
  async deleteAchievement(id, name) {
    if (!confirm('Supprimer le succès "' + name + '" ? Les joueurs qui l\'avaient débloqué garderont leur récompense déjà reçue.')) return;
    try {
      const r = await fetch('/api/admin/achievements/' + id, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ code: S.adminCodeTry }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      App.setAdminTab('achievements');
    } catch (e) { alert(e.message); }
  },

  async saveEventsTab() {
    const enabled = document.getElementById('events-tab-enabled').checked;
    try {
      await fetch('/api/admin/events/tab', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify({ code: S.adminCodeTry, enabled })
      }).then(async r => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || 'Échec.'); });
      S.events = (await api('/api/events')).events;
      alert('Onglet Événements ' + (enabled ? 'activé' : 'désactivé') + ' !');
    } catch (e) { alert(e.message); }
    render();
  },
  async saveEventsCasino() {
    const enabled = document.getElementById('casino-enabled').checked;
    const costPerSpinDust = document.getElementById('casino-cost-dust').value;
    const costPerSpinCredits = document.getElementById('casino-cost-credits').value;
    const symbols = (S.events.casino.symbols || []).map((s, i) => ({
      icon: s.icon,
      weight: document.getElementById('casino-weight-' + i).value,
      payout: document.getElementById('casino-payout-' + i).value
    }));
    const startDate = document.getElementById('casino-start').value || null;
    const endDate = document.getElementById('casino-end').value || null;
    try {
      await fetch('/api/admin/events/casino', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify({ code: S.adminCodeTry, enabled, costPerSpinDust, costPerSpinCredits, symbols, startDate, endDate })
      }).then(async r => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || 'Échec.'); });
      S.events = (await api('/api/events')).events;
      alert('Casino enregistré !');
    } catch (e) { alert(e.message); }
    render();
  },
  async saveEventsBlackjack() {
    const body = {
      code: S.adminCodeTry,
      enabled: document.getElementById('blackjack-enabled').checked,
      costDust: document.getElementById('bj-cost-dust').value,
      costCredits: document.getElementById('bj-cost-credits').value,
      startDate: document.getElementById('bj-start').value || null,
      endDate: document.getElementById('bj-end').value || null
    };
    try {
      const r = await fetch('/api/admin/events/blackjack', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      S.events = (await api('/api/events')).events;
      alert('Blackjack enregistré !');
    } catch (e) { alert(e.message); }
    render();
  },
  async saveEventsBoss() {
    const body = {
      code: S.adminCodeTry,
      enabled: document.getElementById('boss-enabled').checked,
      name: document.getElementById('boss-name').value.trim(),
      heroHealth: document.getElementById('boss-hp').value,
      rewardDust: document.getElementById('boss-reward-dust').value,
      rewardCredits: document.getElementById('boss-reward-credits').value,
      startDate: document.getElementById('boss-start').value || null,
      endDate: document.getElementById('boss-end').value || null
    };
    if (S.bossDeckDraft !== null && S.bossDeckDraft !== undefined) body.deckCardIds = S.bossDeckDraft;
    if (S.bossDialogueDraft !== null && S.bossDialogueDraft !== undefined) {
      body.dialogue = S.bossDialogueDraft.filter(d => d.text && d.text.trim());
    }
    try {
      await fetch('/api/admin/events/boss', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify(body)
      }).then(async r => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || 'Échec.'); });
      S.events = (await api('/api/events')).events;
      S.bossDeckDraft = null; S.bossDialogueDraft = null;
      alert('Boss enregistré !');
    } catch (e) { alert(e.message); }
    render();
  },
  async uploadBossImage(input) {
    if (!input.files || !input.files[0]) return;
    const fd = new FormData();
    fd.append('code', S.adminCodeTry);
    fd.append('image', input.files[0]);
    try {
      await upload('/api/admin/events/boss/image', fd);
      S.events = (await api('/api/events')).events;
    } catch (e) { alert(e.message); }
    render();
  },
  async uploadBossSound(input) {
    if (!input.files || !input.files[0]) return;
    const fd = new FormData();
    fd.append('code', S.adminCodeTry);
    fd.append('sound', input.files[0]);
    try {
      await upload('/api/admin/events/boss/sound', fd);
      S.events = (await api('/api/events')).events;
    } catch (e) { alert(e.message); }
    render();
  },
  addToBossDeck(cardId) {
    const draft = (S.bossDeckDraft || (S.events.boss.deckCardIds || []).slice());
    draft.push(cardId);
    S.bossDeckDraft = draft;
    render();
  },
  removeFromBossDeck(cardId) {
    const draft = (S.bossDeckDraft || (S.events.boss.deckCardIds || []).slice());
    const idx = draft.indexOf(cardId);
    if (idx !== -1) draft.splice(idx, 1);
    S.bossDeckDraft = draft;
    render();
  },
  clearBossDeck() {
    if (!confirm("Vider le deck du boss ? Il redeviendra aléatoire.")) return;
    S.bossDeckDraft = [];
    render();
  },
  addBossDialogueLine() {
    const draft = (S.bossDialogueDraft || (S.events.boss.dialogue || []).map(d => Object.assign({}, d)));
    draft.push({ hpPercent: 50, text: '', enabled: true });
    S.bossDialogueDraft = draft;
    render();
  },
  toggleBossDialogueEnabled(i) {
    const draft = (S.bossDialogueDraft || (S.events.boss.dialogue || []).map(d => Object.assign({}, d)));
    draft[i] = Object.assign({}, draft[i], { enabled: draft[i].enabled === false });
    S.bossDialogueDraft = draft;
    render();
  },
  removeBossDialogueLine(i) {
    const draft = (S.bossDialogueDraft || (S.events.boss.dialogue || []).map(d => Object.assign({}, d)));
    draft.splice(i, 1);
    S.bossDialogueDraft = draft;
    render();
  },
  updateBossDialogueField(i, field, value) {
    const draft = (S.bossDialogueDraft || (S.events.boss.dialogue || []).map(d => Object.assign({}, d)));
    draft[i] = Object.assign({}, draft[i], { [field]: field === 'hpPercent' ? Number(value) : value });
    S.bossDialogueDraft = draft;
    // pas de render() ici : on est sur un onchange, un re-rendu perdrait le focus pour rien
  },

  /* ---- Contenu personnalisable (textes, icônes, médias, sons de jeu) ---- */
  async saveContentStrings(keys) {
    const strings = {};
    keys.forEach(k => { strings[k] = document.getElementById('content-str-' + k).value; });
    try {
      await fetch('/api/admin/content', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify({ code: S.adminCodeTry, strings })
      }).then(async r => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || 'Échec.'); });
      S.content = await api('/api/content');
      alert('Textes enregistrés !');
    } catch (e) { alert(e.message); }
    render();
  },
  async saveContentIcons() {
    const icons = {};
    CONTENT_ICON_KEYS.forEach(([k]) => { icons[k] = document.getElementById('content-icon-' + k).value; });
    try {
      await fetch('/api/admin/content', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify({ code: S.adminCodeTry, icons })
      }).then(async r => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || 'Échec.'); });
      S.content = await api('/api/content');
      alert('Icônes enregistrées !');
    } catch (e) { alert(e.message); }
    render();
  },
  async uploadContentMedia(key, input) {
    if (!input.files || !input.files[0]) return;
    const fd = new FormData();
    fd.append('code', S.adminCodeTry);
    fd.append('image', input.files[0]);
    try {
      await upload('/api/admin/content/media/' + key, fd);
      S.content = await api('/api/content');
    } catch (e) { alert(e.message); }
    render();
  },
  async resetContentMedia(key) {
    try {
      await fetch('/api/admin/content/media/' + key, {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify({ code: S.adminCodeTry })
      }).then(async r => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || 'Échec.'); });
      S.content = await api('/api/content');
    } catch (e) { alert(e.message); }
    render();
  },
  async uploadContentSfx(key, input) {
    if (!input.files || !input.files[0]) return;
    const fd = new FormData();
    fd.append('code', S.adminCodeTry);
    fd.append('sound', input.files[0]);
    try {
      await upload('/api/admin/content/sfx/' + key, fd);
      S.content = await api('/api/content');
    } catch (e) { alert(e.message); }
    render();
  },
  async resetContentSfx(key) {
    try {
      await fetch('/api/admin/content/sfx/' + key, {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify({ code: S.adminCodeTry })
      }).then(async r => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || 'Échec.'); });
      S.content = await api('/api/content');
    } catch (e) { alert(e.message); }
    render();
  },

  /* ---- Événements (casino, boss) ---- */
  async spinCasino(currency) {
    if (S.casinoSpinning) return;
    S.casinoSpinning = true; S.casinoResult = null; render();
    // Effet de rouleaux qui tournent : on affiche des symboles aléatoires pendant
    // que la requête est en vol, puis on se cale sur le vrai résultat au retour.
    const allIcons = (S.events.casino.symbols || []).map(s => s.icon);
    S.casinoReelDisplay = ['❔', '❔', '❔'];
    const spinTimer = setInterval(() => {
      S.casinoReelDisplay = [0, 1, 2].map(() => allIcons[Math.floor(Math.random() * allIcons.length)]);
      render();
    }, 80);
    const minSpinTime = new Promise(r => setTimeout(r, 900)); // laisse le temps de voir l'effet même si le serveur répond vite
    try {
      const [r] = await Promise.all([api('/api/events/casino/spin', 'POST', { currency }), minSpinTime]);
      clearInterval(spinTimer);
      S.casinoResult = r;
      S.casinoReelDisplay = r.symbols;
      S.profile.dust = r.dust;
      S.profile.credits = r.credits;
      handleUnlockedAchievements(r.unlockedAchievements);
    } catch (e) {
      clearInterval(spinTimer);
      S.casinoReelDisplay = ['❔', '❔', '❔'];
      alert(e.message);
    }
    S.casinoSpinning = false;
    render();
  },
  async startBlackjack(currency) {
    try {
      const r = await api('/api/events/blackjack/start', 'POST', { currency });
      S.blackjackState = r.state;
      S.profile.dust = r.profile.dust; S.profile.credits = r.profile.credits;
      handleUnlockedAchievements(r.unlockedAchievements);
    } catch (e) { alert(e.message); }
    render();
  },
  async blackjackHit() {
    try {
      const r = await api('/api/events/blackjack/hit', 'POST', {});
      S.blackjackState = r.state;
      S.profile.dust = r.profile.dust; S.profile.credits = r.profile.credits;
      handleUnlockedAchievements(r.unlockedAchievements);
    } catch (e) { alert(e.message); }
    render();
  },
  async blackjackStand() {
    try {
      const r = await api('/api/events/blackjack/stand', 'POST', {});
      S.blackjackState = r.state;
      S.profile.dust = r.profile.dust; S.profile.credits = r.profile.credits;
      handleUnlockedAchievements(r.unlockedAchievements);
    } catch (e) { alert(e.message); }
    render();
  },
  startBossFight() {
    if (!S.bossAvailableToday) return;
    S.tab = 'combat';
    S.socket.emit('boss:start');
    render();
  },

  async saveMatchCredits() {
    const winCredits = Number(document.getElementById('win-credits').value);
    const lossCredits = Number(document.getElementById('loss-credits').value);
    try {
      const r = await api('/api/admin/settings', 'PATCH', { code: S.adminCodeTry, winCredits, lossCredits });
      S.settings = Object.assign({}, S.settings, r.settings);
      alert('Crédits de fin de combat enregistrés.');
    } catch (e) { alert(e.message); }
  },
  async craftShiny(id) {
    const c = cardById(id); if (!c) return;
    const price = SHINY_CRAFT_COST[c.rarity] || 100;
    if (!confirm(`Fabriquer la version brillante de « ${c.name} » pour ${price} poussière ? Elle brillera partout : collection, deck et combat.`)) return;
    try { const r = await api('/api/foil/craft', 'POST', { cardId: id }); S.profile = r.profile; } catch (e) { alert(e.message); }
    render();
    // L'aperçu 3D est redessiné : on remonte la carte dans le nouveau cadre
    requestAnimationFrame(() => {
      const el = document.getElementById('card3d-modal-canvas');
      if (el && !el.firstChild && window.Card3D && S.card3DView) window.Card3D.showSingle(S.card3DView, el).catch(() => {});
    });
  },
  skipResultAnim() {
    const mr = S.matchResultOverlay;
    if (!mr || !mr.anim || resultElapsed(mr.anim) >= mr.anim.total) return;
    mr.anim.t0 = Date.now() - mr.anim.total - 1;
    Object.keys(mr.anim.events).forEach(i => { mr.anim.played[i] = true; });
    const host = document.querySelector('.mr-panel-wrap');
    if (host) host.innerHTML = renderResultPanel(mr.anim);
  },
  async saveShinyMultiplier() {
    try {
      await api('/api/admin/settings', 'PATCH', { code: S.adminCodeTry, shinyMultiplier: document.getElementById('shiny-mult').value });
      S.settings = await api('/api/settings');
      alert('Réglage des cartes brillantes enregistré.');
    } catch (e) { alert(e.message); }
    render();
  },
  async updateMatchDropChance() {
    const val = document.getElementById('match-drop-chance').value;
    try {
      await fetch('/api/admin/settings', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify({ code: S.adminCodeTry, matchDropChance: val })
      }).then(async r => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || 'Échec.'); });
      S.settings = (await api('/api/settings'));
      alert('Probabilité mise à jour !');
    } catch (e) { alert(e.message); }
    render();
  },
  async createExtension() {
    const fd = new FormData();
    fd.append('code', S.adminCodeTry);
    fd.append('name', document.getElementById('new-ext-name').value.trim());
    fd.append('description', document.getElementById('new-ext-desc').value.trim());
    fd.append('boosterCreditPrice', document.getElementById('new-ext-credit').value);
    fd.append('boosterDustPrice', document.getElementById('new-ext-dust').value);
    fd.append('matchDropEligible', document.getElementById('new-ext-drop').checked ? 'true' : 'false');
    fd.append('hidden', document.getElementById('new-ext-hidden').checked ? 'true' : 'false');
    const img = document.getElementById('new-ext-back');
    if (img.files && img.files[0]) fd.append('backImage', img.files[0]);
    try {
      await upload('/api/admin/extensions', fd);
      S.extensions = (await api(extsUrl())).extensions;
      document.getElementById('new-ext-name').value = '';
      document.getElementById('new-ext-desc').value = '';
      img.value = '';
      alert('Extension créée !');
    } catch (e) { alert(e.message); }
    render();
  },
  async publishExtension(extId) {
    const e = (S.extensions || []).find(x => x.id === extId);
    if (!confirm(`Publier « ${e ? e.name : extId} » ? Les joueurs verront ses cartes, et son booster sera en vente s'il a un prix.`)) return;
    try {
      await fetch('/api/admin/extensions/' + extId, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ code: S.adminCodeTry, hidden: false }) })
        .then(async r => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || 'Échec.'); });
      S.extensions = (await api(extsUrl())).extensions;
    } catch (err) { alert(err.message); }
    render();
  },
  async updateExtensionPrices(extId) {
    const credit = document.getElementById('ext-credit-' + extId).value;
    const dust = document.getElementById('ext-dust-' + extId).value;
    const dropEligible = document.getElementById('ext-drop-' + extId).checked;
    const hiddenEl = document.getElementById('ext-hidden-' + extId);
    const body = { code: S.adminCodeTry, boosterCreditPrice: credit === '' ? null : credit, boosterDustPrice: dust === '' ? null : dust, matchDropEligible: dropEligible,
      name: document.getElementById('ext-name-' + extId).value, description: document.getElementById('ext-desc-' + extId).value };
    if (hiddenEl) body.hidden = hiddenEl.checked;
    try {
      await fetch('/api/admin/extensions/' + extId, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify(body)
      }).then(async r => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || 'Échec.'); });
      S.extensions = (await api(extsUrl())).extensions;
    } catch (e) { alert(e.message); }
    render();
  },
  async replaceExtensionBack(extId, input) {
    if (!input.files || !input.files[0]) return;
    const fd = new FormData();
    fd.append('code', S.adminCodeTry);
    fd.append('backImage', input.files[0]);
    try {
      await upload('/api/admin/extensions/' + extId + '/back-image', fd);
      S.extensions = (await api(extsUrl())).extensions;
      S.cardPool = (await api(cardsUrl())).cards;
    } catch (e) { alert(e.message); }
    render();
  },
  async replaceExtensionPackImage(extId, input) {
    if (!input.files || !input.files[0]) return;
    const fd = new FormData();
    fd.append('code', S.adminCodeTry);
    fd.append('packImage', input.files[0]);
    try {
      await upload('/api/admin/extensions/' + extId + '/pack-image', fd);
      S.extensions = (await api(extsUrl())).extensions;
    } catch (e) { alert(e.message); }
    render();
  },
  async createCreditPack() {
    const body = {
      code: S.adminCodeTry,
      name: document.getElementById('pack-name').value.trim(),
      creditsAmount: document.getElementById('pack-credits').value,
      dustPrice: document.getElementById('pack-dust').value
    };
    try {
      const r = await fetch('/api/admin/credit-packs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      S.adminCreditPacks = (await api('/api/credit-packs')).packs;
      document.getElementById('pack-name').value = '';
      alert('Pack créé !');
    } catch (e) { alert(e.message); }
    render();
  },
  async updateCreditPack(id) {
    const body = {
      code: S.adminCodeTry,
      name: document.getElementById('pack-edit-name-' + id).value.trim(),
      creditsAmount: document.getElementById('pack-edit-credits-' + id).value,
      dustPrice: document.getElementById('pack-edit-dust-' + id).value
    };
    try {
      const r = await fetch('/api/admin/credit-packs/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      S.adminCreditPacks = (await api('/api/credit-packs')).packs;
      alert('Pack mis à jour !');
    } catch (e) { alert(e.message); }
    render();
  },
  async deleteCreditPack(id, name) {
    if (!confirm('Supprimer le pack "' + name + '" ?')) return;
    try {
      const r = await fetch('/api/admin/credit-packs/' + id, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ code: S.adminCodeTry }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      S.adminCreditPacks = (await api('/api/credit-packs')).packs;
    } catch (e) { alert(e.message); }
    render();
  },
  async deleteExtension(extId) {
    if (!confirm('Supprimer cette extension ?')) return;
    try {
      await fetch('/api/admin/extensions/' + extId, {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify({ code: S.adminCodeTry })
      }).then(async r => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || 'Échec.'); });
      S.extensions = (await api(extsUrl())).extensions;
    } catch (e) { alert(e.message); }
    render();
  },

  /* ---- Combat de test contre le bot ---- */
  startBotMatch() {
    if (!S.socket) return;
    S.socket.emit('admin:botMatch', { code: S.adminCodeTry });
    S.tab = 'combat';
    S.queueStatus = 'waiting'; // en attente de l'état renvoyé par le serveur
    render();
  },

  async tryAdminLogin() {
    const code = (document.getElementById('admin-code') || {}).value || '';
    S.adminGateError = '';
    try {
      await api('/api/admin/verify', 'POST', { code });
      S.adminCodeTry = code; S.isAdmin = true;
      try { S.cardPool = (await api(cardsUrl())).cards; S.extensions = (await api(extsUrl())).extensions; } catch (e) {}
    } catch (e) { S.isAdmin = false; S.adminCodeTry = ''; S.adminGateError = e.message || 'Code admin incorrect.'; }
    render();
  },
  setAdminCardType(v) { S.adminCardType = v; renderKeepingCardForm(); },
  async createCard() {
    const fd = new FormData();
    fd.append('code', S.adminCodeTry);
    fd.append('name', document.getElementById('new-card-name').value.trim());
    fd.append('type', S.adminCardType);
    fd.append('rarity', S.adminCardRarity);
    fd.append('cost', document.getElementById('new-card-cost').value || '1');
    fd.append('desc', document.getElementById('new-card-desc').value.trim());
    fd.append('extensionId', document.getElementById('new-card-extension').value);
    if (S.adminCardType === 'minion') {
      fd.append('attack', document.getElementById('new-card-attack').value || '1');
      fd.append('health', document.getElementById('new-card-health').value || '1');
      fd.append('armor', document.getElementById('new-card-armor').value || '0');
      fd.append('taunt', document.getElementById('new-card-taunt').checked ? 'true' : 'false');
      fd.append('charge', document.getElementById('new-card-charge').checked ? 'true' : 'false');
      fd.append('battlecryHeal', document.getElementById('new-card-bcheal').value || '0');
      fd.append('colorblind', document.getElementById('new-card-colorblind').checked ? 'true' : 'false');
      fd.append('colorblindChance', document.getElementById('new-card-colorblind-chance').value || '50');
      ['shield', 'windfury', 'stealth', 'standing'].forEach(k => fd.append(k, document.getElementById('new-card-' + k).checked ? 'true' : 'false'));
      readMechanicsForm('new-card-token-').forEach(([k, v]) => fd.append(k, v));
      fd.append('drEffect', document.getElementById('new-card-dr-effect').value);
      fd.append('drValue', document.getElementById('new-card-dr-value').value || '1');
      fd.append('drValue2', document.getElementById('new-card-dr-value2').value || '');
      [2, 3].forEach(k => {
        fd.append(`bc${k}Effect`, document.getElementById(`new-card-bc${k}-effect`).value);
        fd.append(`bc${k}Value`, document.getElementById(`new-card-bc${k}-value`).value || '1');
        fd.append(`bc${k}Value2`, document.getElementById(`new-card-bc${k}-value2`).value || '');
      });
      fd.append('bcEffect', document.getElementById('new-card-bc-effect').value);
      fd.append('bcValue', document.getElementById('new-card-bc-value').value || '1');
      fd.append('bcValue2', document.getElementById('new-card-bc-value2').value || '');
    } else if (S.adminCardType === 'weapon') {
      fd.append('attack', document.getElementById('new-card-attack').value || '1');
      fd.append('durability', document.getElementById('new-card-durability').value || '1');
      fd.append('usesPerTurn', document.getElementById('new-card-usesperturn').value || '1');
      fd.append('battlecryHeal', document.getElementById('new-card-bcheal').value || '0');
    } else {
      const effectType = document.getElementById('new-card-effect').value;
      fd.append('effectType', effectType);
      fd.append('value', document.getElementById('new-card-value').value || (effectType === 'modify_stats' ? '0' : '1'));
      readMechanicsForm('new-card-stoken-').forEach(([k, v]) => fd.append(k, v));
      if (effectType === 'give_deathrattle') {
        fd.append('drEffect', document.getElementById('new-card-spell-dr-effect').value);
        fd.append('drValue', document.getElementById('new-card-spell-dr-value').value || '1');
        fd.append('drValue2', document.getElementById('new-card-spell-dr-value2').value || '');
      }
      if (effectType === 'buff_ally_and_heal' || effectType === 'modify_stats') {
        fd.append('value2', document.getElementById('new-card-value2').value || '0');
      }
    }
    if (S.adminCustomDrop) {
      const w = document.getElementById('new-card-dropweight').value;
      if (w) fd.append('dropWeight', w);
    }
    const fileInput = document.getElementById('new-card-image');
    if (fileInput.files && fileInput.files[0]) fd.append('image', fileInput.files[0]);
    const soundInput = document.getElementById('new-card-sound');
    if (soundInput.files && soundInput.files[0]) fd.append('sound', soundInput.files[0]);
    if (S.adminCardParallax) {
      fd.append('parallax', 'true');
      const bg = document.getElementById('new-card-parallax-bg');
      const ch = document.getElementById('new-card-parallax-char');
      if (bg.files && bg.files[0]) fd.append('parallaxBackground', bg.files[0]);
      if (ch.files && ch.files[0]) fd.append('parallaxCharacter', ch.files[0]);
    }
    try {
      const created = await upload('/api/admin/cards', fd);
      S.cardPool = (await api(cardsUrl())).cards;
      ArcaneAudio.preloadSounds(S.cardPool);
      document.getElementById('new-card-name').value = '';
      document.getElementById('new-card-desc').value = '';
      fileInput.value = '';
      soundInput.value = '';
      S.adminCustomDrop = false;
      if (S.adminCardParallax && created.card && !created.card.parallax) {
        alert('Carte ajoutée, mais le parallaxe n\'a pas pu s\'activer — il faut les trois images (fond, personnage, premier plan) ensemble.');
      } else {
        alert('Carte ajoutée au pool !');
      }
      S.adminCardParallax = false;
      S.adminSpellEffect = null;
    } catch (e) { alert(e.message); }
    render();
  },
  async replaceCardImage(cardId, input) {
    if (!input.files || !input.files[0]) return;
    const fd = new FormData();
    fd.append('code', S.adminCodeTry);
    fd.append('image', input.files[0]);
    try {
      await upload('/api/admin/cards/' + cardId + '/image', fd);
      S.cardPool = (await api(cardsUrl())).cards;
    } catch (e) { alert(e.message); }
    render();
  },
  async createEmote() {
    const text = document.getElementById('new-emote-text').value.trim();
    const price = document.getElementById('new-emote-price').value;
    const tone = document.getElementById('new-emote-tone').value;
    if (!text) { alert('Entre le texte de la provocation.'); return; }
    try {
      await api('/api/admin/emotes', 'POST', { code: S.adminCodeTry, text, price, tone });
      S.config = await api('/api/config');
      if (S.shop) S.shop = await api('/api/shop');
      S.profile = (await api('/api/me')).profile;
      document.getElementById('new-emote-text').value = '';
      document.getElementById('new-emote-price').value = '';
      alert('Provocation ajoutée à la boutique !');
    } catch (e) { alert(e.message); }
    render();
  },
  async updateEmotePrice(id) {
    const input = document.getElementById('emote-price-' + id);
    if (!input) return;
    const price = input.value;
    if (price === '') { alert('Entre un prix.'); return; }
    try {
      await fetch('/api/admin/emotes/' + id, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin', body: JSON.stringify({ code: S.adminCodeTry, price })
      }).then(async r => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || 'Échec.'); });
      S.config = await api('/api/config');
      S.profile = (await api('/api/me')).profile;
      if (S.shop) S.shop = await api('/api/shop');
    } catch (e) { alert(e.message); }
    render();
  },
  async deleteEmote(id) {
    if (!confirm('Supprimer cette provocation de la boutique ? Elle sera retirée des roues des joueurs.')) return;
    try {
      await fetch('/api/admin/emotes/' + id, {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin', body: JSON.stringify({ code: S.adminCodeTry })
      });
      S.config = await api('/api/config');
      S.profile = (await api('/api/me')).profile;
      if (S.shop) S.shop = await api('/api/shop');
    } catch (e) { alert(e.message); }
    render();
  },
  async replaceCardSound(cardId, input) {
    if (!input.files || !input.files[0]) return;
    const fd = new FormData();
    fd.append('code', S.adminCodeTry);
    fd.append('sound', input.files[0]);
    try {
      await upload('/api/admin/cards/' + cardId + '/sound', fd);
      S.cardPool = (await api(cardsUrl())).cards;
      ArcaneAudio.preloadSounds(S.cardPool);
    } catch (e) { alert(e.message); }
    render();
  },
  async removeCardSound(cardId) {
    try {
      await fetch('/api/admin/cards/' + cardId + '/sound', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin', body: JSON.stringify({ code: S.adminCodeTry })
      }).then(async r => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || 'Échec.'); });
      S.cardPool = (await api(cardsUrl())).cards;
    } catch (e) { alert(e.message); }
    render();
  },
  previewSound(url) {
    try {
      const a = new Audio(url); a.volume = 0.7 * (Number(window.CGD_SFX_VOLUME) >= 0 ? Number(window.CGD_SFX_VOLUME) : 1);
      const p = a.play(); if (p && p.catch) p.catch(() => alert('Le navigateur a bloqué la lecture.'));
    } catch (e) {}
  },
  async loadCardStats(month) {
    try {
      const q = 'code=' + encodeURIComponent(S.adminCodeTry || '') + (month ? '&month=' + encodeURIComponent(month) : '');
      const r = await (await fetch('/api/admin/card-stats?' + q, { credentials: 'same-origin' })).json();
      if (r.error) { alert(r.error); return; }
      S.adminCardStats = r;
    } catch (e) { S.adminCardStats = { months: [], month: '', pvpMatches: 0, days: {}, cards: [] }; }
    render();
  },
  setStatsFilter(key, value) { S.statsFilter = Object.assign({}, S.statsFilter, { [key]: value || '' }); render(); },
  toggleStatsSort() { S.statsSort = S.statsSort === 'asc' ? 'desc' : 'asc'; render(); },
  exportCardStats() {
    const st = S.adminCardStats; if (!st) return;
    const rows = buildCardStatRows(st, S.cardPool || [], S.statsFilter).sort((a, b) => b.plays - a.plays);
    const total = rows.reduce((a, r) => a + r.plays, 0);
    const data = [['Carte', 'ID', 'Extension', 'Rareté', 'Type', 'Fois jouée', 'Part (%)', 'dont contre le bot', 'Parties JcJ', 'Victoires', 'Taux de victoire (%)']]
      .concat(rows.map(r => [r.name + (r.deleted ? ' (supprimée)' : ''), r.id, r.ext, (RARITIES[r.rarity] || {}).label || '', r.deleted ? '' : cardTypeLabel(r.type), r.plays,
        total ? (r.plays / total * 100).toFixed(1).replace('.', ',') : '', r.botPlays, r.matches, r.wins, r.matches ? Math.round(r.wins / r.matches * 100) : '']));
    downloadText(`stats-cartes-${st.month}.csv`, toCsv(data), 'text/csv;charset=utf-8');
  },
  /* Zoom sur une carte du journal. Si la carte n'est pas dans la liste chargée
     (créée depuis l'ouverture de la page), on l'affiche avec les infos du journal. */
  zoomFeedCard(cardId, ref) {
    // En combat : fiche détaillée de la carte (ce qu'elle fait), plus de vue 3D
    if (inCombatNow()) { App.showCardInfo(cardId, ref); return; }
    const card = cardById(cardId) || handCardData(cardId) || (ref && Object.assign({
      id: cardId, name: ref.name, image: ref.image, rarity: ref.rarity || 'commun',
      type: ref.type || (ref.kind === 'minion' ? 'minion' : 'sort'), cost: ref.cost, desc: ref.desc || '',
      attack: ref.attack, health: ref.health, effectType: ref.effectType, value: ref.value, value2: ref.value2
    }));
    if (!card) return;
    S.card3DView = card; S.card3DError = null; render();
    if (card.sound && S.soundOn) ArcaneAudio.playSoundUrl(card.sound);
  },
  toggleFocusMenu(open) { S.focusMenuOpen = open === undefined ? !S.focusMenuOpen : !!open; render(); },
  toggleCombatFeed() {
    const open = S.feedOpen !== undefined ? S.feedOpen : window.innerWidth >= 1500;
    S.feedOpen = !open;
    if (S.feedOpen) S.feedUnread = 0;
    render();
  },
  exportCards(format) {
    const pool = (S.cardPool || []).slice().sort((a, b) =>
      String(a.extensionName || '').localeCompare(String(b.extensionName || '')) || (a.cost - b.cost) || String(a.name).localeCompare(String(b.name)));
    if (!pool.length) { alert('Aucune carte à exporter.'); return; }
    const date = new Date().toISOString().slice(0, 10);
    if (format === 'json') downloadText(`cartes-clean-gang-decks-${date}.json`, JSON.stringify(pool, null, 2), 'application/json');
    else downloadText(`cartes-clean-gang-decks-${date}.csv`, toCsv(cardExportRows(pool)), 'text/csv;charset=utf-8');
  },
  async cleanupOrphanCards() {
    try {
      const r = await (await fetch('/api/admin/cards/orphans?code=' + encodeURIComponent(S.adminCodeTry || ''), { credentials: 'same-origin' })).json();
      if (r.error) { alert(r.error); return; }
      if (!r.orphanIds.length) { alert('Aucune carte supprimée ne traîne chez les joueurs. Rien à nettoyer.'); return; }
      if (!confirm(`${r.orphanIds.length} carte(s) qui n'existent plus dans le pool sont encore chez ${r.players} joueur(s) :\n\n${r.orphanIds.join('\n')}\n\nLes retirer de leurs collections et de leurs decks ?`)) return;
      const c = await (await fetch('/api/admin/cards/orphans/cleanup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ code: S.adminCodeTry }) })).json();
      alert(c.error ? c.error : `Nettoyage terminé : ${c.removed} carte(s) retirée(s) chez ${c.players} joueur(s).`);
    } catch (e) { alert('Le nettoyage a échoué.'); }
  },
  async deleteCard(cardId) {
    if (!confirm('Supprimer cette carte du pool ? Elle sera aussi retirée des collections et des decks de tous les joueurs.')) return;
    try {
      await fetch('/api/admin/cards/' + cardId, {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin', body: JSON.stringify({ code: S.adminCodeTry })
      });
      S.cardPool = (await api(cardsUrl())).cards;
    } catch (e) {}
    render();
  },

  /* ---- Combat ---- */
  joinQueue(blitz) {
    if (!S.profile.deck || S.profile.deck.length !== DECK_SIZE) {
      alert(`Configure un deck de ${DECK_SIZE} cartes dans l'onglet Deck avant de combattre.`);
      return;
    }
    S.queueBlitz = !!blitz;
    S.queueStatus = 'waiting'; S.socket.emit('queue:join', blitz ? { blitz: true } : undefined);
    // L'écran « Recherche d'un adversaire… » est sur la page Combat : on y va
    // (depuis l'Accueil, le bouton JOUER mettait en file d'attente sans rien afficher).
    if (S.tab !== 'combat') App.goTab('combat'); else render();
  },
  blitzBot() {
    if (!S.profile.deck || S.profile.deck.length !== DECK_SIZE) { alert(`Configure un deck de ${DECK_SIZE} cartes dans l'onglet Deck avant de combattre.`); return; }
    S.socket.emit('blitz:bot');
  },
  async survivalStart() {
    try { S.survival = await api('/api/survival/start', 'POST', {}); } catch (e) { alert(e.message); }
    render();
  },
  survivalFight() { S.socket.emit('survival:fight'); },
  async survivalAbandon() {
    if (!confirm('Abandonner ta partie de Survie ? Ta série s\'arrête ici (ton record reste enregistré).')) return;
    try { S.survival = await api('/api/survival/abandon', 'POST', {}); } catch (e) { alert(e.message); }
    render();
  },
  survivalPause() { S.focusMenuOpen = false; S.socket.emit('survival:pause'); },
  async loadLive(manual) {
    try { S.liveMatches = (await api('/api/spectate/live')).matches; } catch (e) { S.liveMatches = []; }
    if (manual || S.tab === 'combat') render();
  },
  spectate(matchId) {
    if (S.matchState && S.matchState.status === 'active') { alert('Termine ton combat avant de regarder celui des autres.'); return; }
    S.spectate = { matchId, data: null };
    S.socket.emit('spectate:join', { matchId });
    render(); window.scrollTo(0, 0);
  },
  async spectateFriend(slug) {
    await App.loadLive();
    const m = (S.liveMatches || []).find(x => x.players.some(p => p.slug === slug));
    if (!m) { pushToast("Ce combat n'est pas visible (terminé, ou spectateurs désactivés)."); return; }
    App.spectate(m.matchId);
  },
  stopSpectate() { if (S.socket) S.socket.emit('spectate:leave'); S.spectate = null; App.goTab('combat'); },
  async setAllowSpectate(allow) {
    try { S.profile = (await api('/api/me/allow-spectate', 'POST', { allow })).profile; } catch (e) { alert(e.message); }
    render();
  },
  puzzleStart() { S.socket.emit('puzzle:start'); },
  puzzleRetry() { clearTimeout(window.__matchResultTimer); S.matchResultOverlay = null; S.socket.emit('puzzle:start'); },
  async puzzleReveal() {
    if (!confirm("Voir la solution ? Tu pourras encore réussir le puzzle, mais sans récompense aujourd'hui.")) return;
    try { S.puzzle = await api('/api/puzzle/reveal', 'POST', {}); } catch (e) { alert(e.message); }
    render();
  },
  async adminPuzzleRegen() {
    if (!confirm("Fabriquer un nouveau puzzle pour aujourd'hui ? (les joueurs qui l'ont déjà réussi gardent leur récompense)")) return;
    try { await api('/api/admin/puzzle/regenerate', 'POST', { code: S.adminCodeTry }); await loadPuzzle(); } catch (e) { alert(e.message); }
  },
  brawlFight() { S.socket.emit('brawl:fight'); },
  async adminBrawlRule(rule) {
    try { await api('/api/admin/brawl/rule', 'POST', { code: S.adminCodeTry, rule: rule || null }); await loadBrawl(); S.profile = (await api('/api/me')).profile; } catch (e) { alert(e.message); }
    render();
  },
  async draftStart() {
    const d = S.draft;
    if (d && !d.free && !confirm(`Lancer un Draft pour ${d.price} crédits ?`)) return;
    try { const r = await api('/api/draft/start', 'POST', {}); S.profile = r.profile; S.draft = r; } catch (e) { alert(e.message); }
    render();
  },
  async draftPick(id) {
    if (S.draftPicking) return; // évite le double clic
    S.draftPicking = true;
    try { S.draft = await api('/api/draft/pick', 'POST', { cardId: id }); } catch (e) { alert(e.message); }
    S.draftPicking = false; render();
  },
  draftFight() { S.socket.emit('draft:fight'); },
  async draftAbandon() {
    const run = S.draft && S.draft.run;
    if (!run) return;
    const done = run.picks.length >= 30 || run.wins || run.losses;
    if (!confirm(done ? `Arrêter ton Draft maintenant ? Tu reçois les récompenses de tes ${run.wins} victoire${run.wins > 1 ? 's' : ''}.`
      : "Abandonner ce Draft ? Ton deck n'est pas terminé : l'entrée t'est rendue.")) return;
    try { const r = await api('/api/draft/abandon', 'POST', {}); S.profile = r.profile; S.draft = r; S.draftEnded = r.ended; } catch (e) { alert(e.message); }
    render();
  },
  draftNext() { clearTimeout(window.__matchResultTimer); S.matchResultOverlay = null; App.leaveMatch(); S.socket.emit('draft:fight'); },
  survivalNext() { clearTimeout(window.__matchResultTimer); S.matchResultOverlay = null; App.leaveMatch(); S.socket.emit('survival:fight'); },
  async toggleFavorite(id) {
    const fav = new Set(S.profile.favoriteCards || []);
    const on = !fav.has(id);
    if (on) fav.add(id); else fav.delete(id);
    S.profile.favoriteCards = [...fav]; render();
    try { const r = await api('/api/me/favorite', 'POST', { cardId: id, on }); S.profile.favoriteCards = r.favoriteCards; } catch (e) { alert(e.message); }
    render();
  },
  toggleCodexFav() { S.codexFavOnly = !S.codexFavOnly; render(); },
  async shareDeckImage() {
    const ids = (S.deckDraft || []).slice();
    if (!ids.length) { alert('Ajoute des cartes au deck avant de créer son image.'); return; }
    const active = (S.savedDecks || []).find(d => d.id === S.profile.activeDeckId && JSON.stringify((d.cardIds || []).slice().sort()) === JSON.stringify(ids.slice().sort()));
    const title = active ? active.name : 'Mon deck';
    S.deckImage = { url: null }; render();
    try {
      const cv = await buildDeckImage(ids, title);
      S.deckImage = { url: cv.toDataURL('image/png'), file: (title.replace(/[^a-z0-9\-_ ]/gi, '').trim() || 'deck') + '.png', canvas: cv };
    } catch (e) { S.deckImage = { url: null, msg: "Impossible de créer l'image : " + e.message }; }
    render();
  },
  closeDeckImage() { S.deckImage = null; render(); },
  async copyDeckImage() {
    const di = S.deckImage; if (!di || !di.canvas) return;
    try {
      const blob = await new Promise(r => di.canvas.toBlob(r, 'image/png'));
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      di.msg = 'Image copiée : colle-la dans Discord avec Ctrl+V.';
    } catch (e) { di.msg = 'Copie impossible ici : utilise « Télécharger ».'; }
    render();
  },
  async setBanner(id) {
    try { const r = await api('/api/me/banner', 'POST', { bannerId: id }); S.profile = r.profile; } catch (e) { alert(e.message); }
    render();
  },
  async buyBanner(id) {
    const b = bannerById(id);
    if (!b || !confirm(`Acheter la bannière « ${b.name} » pour ${b.price} crédits ?`)) return;
    try { const r = await api('/api/shop/buy-banner', 'POST', { bannerId: id }); S.profile = r.profile; if (S.shop) S.shop.credits = r.profile.credits; } catch (e) { alert(e.message); }
    render();
  },
  leaveQueue() { S.socket.emit('queue:leave'); S.queueStatus = 'idle'; render(); },
  leaveMatch() { S.matchState = null; S.queueStatus = 'idle'; S.matchResultOverlay = null; clearTimeout(window.__matchResultTimer); S.emoteWheelOpen = false; S.selectedAttacker = null; S.targetingSpell = null; pendingCharge = null; render(); },
  toggleMulliganCard(index) {
    if (!S.mulliganSelected) S.mulliganSelected = new Set();
    if (S.mulliganSelected.has(index)) S.mulliganSelected.delete(index);
    else S.mulliganSelected.add(index);
    render();
  },
  confirmMulligan() {
    const hand = S.matchState && S.matchState.you.hand;
    if (!hand) return;
    const ids = Array.from(S.mulliganSelected || []).map(i => hand[i] && hand[i].id).filter(Boolean);
    S.socket.emit('action:mulligan', { cardIds: ids });
    S.mulliganSelected = new Set();
  },
  forfeitMatch() {
    const sv = S.matchState && S.matchState.survival;
    const dr = S.matchState && S.matchState.draft;
    if (!confirm(sv ? 'Abandonner ce combat termine ta partie de Survie (ton record est gardé). Pour t\'arrêter sans perdre, utilise plutôt ⏸ Pause. Abandonner quand même ?'
      : dr ? 'Abandonner ce combat compte comme une défaite dans ton Draft. Abandonner quand même ?'
      : 'Abandonner ce combat ? Ton adversaire remportera la partie.')) return;
    S.socket.emit('action:forfeit');
  },
  challengeFriend(slug, mode) { S.socket.emit('challenge:send', { toSlug: slug, mode: mode || S.duelMode || 'normal' }); },
  /* Choisir un ami à défier dans un mode donné (combat, Blitz, Bagarre, Draft) */
  async openDuel(mode) {
    S.duelPicker = { mode: mode || 'normal' };
    render();
    try { S.friends = (await api('/api/friends')).friends; } catch (e) {}
    render();
  },
  closeDuel() { S.duelPicker = null; render(); },
  setDuelMode(m) { S.duelMode = m; render(); },
  acceptChallenge() {
    if (!S.incomingChallenge) return;
    S.socket.emit('challenge:accept', { challengeId: S.incomingChallenge.id });
    S.incomingChallenge = null; render();
  },
  declineChallenge() {
    if (!S.incomingChallenge) return;
    S.socket.emit('challenge:decline', { challengeId: S.incomingChallenge.id });
    S.incomingChallenge = null; render();
  },

  /* ---- Provocations (emotes) ---- */
  openEmoteWheel() { S.emoteWheelOpen = true; render(); },
  closeEmoteWheel() { S.emoteWheelOpen = false; render(); },
  sendEmote(emoteId) {
    S.socket.emit('emote:send', { emoteId });
    S.emoteWheelOpen = false;
    render();
  },
  setShopTab(t) { S.shopTab = t; render(); },
  setProfileTab(t) { S.profileTab = t; render(); },
  async adminLevelsLoad(max) {
    try { S.adminLevels = await api('/api/admin/level-rewards/list', 'POST', { code: S.adminCodeTry, maxLevel: max || (S.adminLevels ? S.adminLevels.levels.length + 1 : 60) }); }
    catch (e) { alert(e.message); }
    S.__lvlLoading = false; render();
  },
  adminLevelPick(level) {
    const l = S.adminLevels.levels.find(x => x.level === level); if (!l) return;
    S.adminLevelEdit = Object.assign({ level }, l.reward); render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  },
  adminLevelKind(kind) { S.adminLevelEdit = Object.assign({}, S.adminLevelEdit || {}, { kind, level: Number((document.getElementById('lvl-level') || {}).value) || 2 }); render(); },
  async adminLevelSave() {
    const v = id => (document.getElementById(id) || {}).value;
    const kind = v('lvl-kind'), level = Number(v('lvl-level'));
    const reward = { kind };
    if (kind === 'credits' || kind === 'dust') reward.amount = Number(v('lvl-amount'));
    if (kind === 'title') reward.title = v('lvl-title');
    if (kind === 'ornament') reward.ornamentId = v('lvl-orn');
    if (kind === 'banner') reward.bannerId = v('lvl-banner');
    if (kind === 'booster' && v('lvl-ext')) reward.extensionId = v('lvl-ext');
    try { S.adminLevels = await api('/api/admin/level-rewards/set', 'POST', { code: S.adminCodeTry, level, reward, maxLevel: S.adminLevels.levels.length + 1 }); S.adminLevelEdit = Object.assign({ level }, reward); }
    catch (e) { alert(e.message); }
    render();
  },
  async adminLevelReset() {
    const level = Number((document.getElementById('lvl-level') || {}).value);
    try { S.adminLevels = await api('/api/admin/level-rewards/set', 'POST', { code: S.adminCodeTry, level, reward: null, maxLevel: S.adminLevels.levels.length + 1 }); }
    catch (e) { alert(e.message); }
    render();
  },
  selectWheelSlot(i) { S.wheelSlot = i; render(); },
  assignEmoteToSlot(emoteId) {
    if (!S.wheelDraft) S.wheelDraft = (S.profile.emoteWheel || []).slice();
    const existing = S.wheelDraft.indexOf(emoteId);
    if (existing >= 0 && existing !== S.wheelSlot) {
      // Échange les deux emplacements pour éviter les doublons dans la roue
      S.wheelDraft[existing] = S.wheelDraft[S.wheelSlot];
    }
    S.wheelDraft[S.wheelSlot] = emoteId;
    S.wheelSlot = (S.wheelSlot + 1) % S.wheelDraft.length;
    render();
  },
  resetWheelDraft() { S.wheelDraft = (S.profile.emoteWheel || []).slice(); S.wheelSlot = 0; render(); },
  async saveWheel() {
    try {
      const r = await api('/api/me/emote-wheel', 'POST', { wheel: S.wheelDraft });
      S.profile = r.profile;
      S.wheelDraft = null;
      alert('Roue de provocations enregistrée !');
    } catch (e) { alert(e.message); }
    render();
  },
  async buyDaily(slot, id) {
    try {
      const r = await api('/api/shop/daily/buy', 'POST', { slot, id });
      S.profile = r.profile; S.daily = r.daily;
      if (S.shop) { S.shop.credits = r.profile.credits; S.shop.dust = r.profile.dust; S.shop.ownedEmotes = r.profile.ownedEmotes || S.shop.ownedEmotes; }
      handleUnlockedAchievements(r.unlockedAchievements);
      pushToast(slot === 'booster' ? 'Booster ajouté à ton inventaire (onglet Boosters) !' : slot === 'banner' ? 'Bannière ajoutée à ta collection !' : 'Provocation débloquée !');
    } catch (e) { alert(e.message); loadDaily(); }
    render();
  },
  async buyEmote(id) {
    try {
      const r = await api('/api/shop/buy-emote', 'POST', { emoteId: id });
      S.profile = r.profile;
      S.shop = await api('/api/shop');
      handleUnlockedAchievements(r.unlockedAchievements);
    } catch (e) { alert(e.message); }
    render();
  },

  clickHand(cardId) {
    const st = S.matchState;
    const card = handCardData(cardId);
    if (!card || !st || !st.yourTurn || Number(card.cost) > st.you.mana) return;
    // Jouer une nouvelle carte annule un ciblage ou une attaque restés en attente
    S.targetingSpell = null; S.selectedAttacker = null;
    if (card.type === 'minion' && bcList(card).length) {
      // Cri de guerre à cible : on choisit la cible (pour le premier effet à cible) avant de poser le serviteur
      const primary = bcList(card).find(x => targetModeFor(x[0]));
      const mode = primary ? targetModeFor(primary[0]) : null;
      if (mode && hasTargetFor(mode, st)) { S.targetingSpell = { cardId, mode, battlecry: card.name }; render(); return; }
      S.socket.emit('action:play', { cardId }); return;
    }
    if (card.type === 'minion' || card.type === 'weapon') { S.socket.emit('action:play', { cardId }); return; }
    // Sort : s'il demande une cible, on passe en ciblage ; SINON il se joue tout
    // de suite. Avant, un effet absent d'une liste fixe (ex. un nouvel effet comme
    // l'armure avec une version en cache du jeu) ne faisait rien du tout au clic.
    const mode = targetModeFor(card.effectType);
    const missing = spellNeedsMissingTarget(card, st);
    if (missing) { S.matchError = missing; render(); return; }
    if (mode) { S.targetingSpell = { cardId, mode }; render(); return; }
    if (card.effectType === 'board_wipe' && !confirm('Détruire tous les serviteurs en jeu, y compris les tiens ?')) return;
    S.socket.emit('action:play', { cardId });
  },

  /* ---- Glisser-déposer une carte de la main vers le champ de bataille ----
     Un simple clic (sans déplacement notable) rejoue l'ancien comportement
     (clickHand direct) — le glisser n'est qu'un geste supplémentaire, plus
     proche de Hearthstone, pas un remplacement obligatoire. */
  startCardDrag(e, cardId) {
    const st = S.matchState;
    const card = handCardData(cardId);
    if (!card || !st || !st.yourTurn || Number(card.cost) > st.you.mana || e.button === 2) return;
    const originEl = e.currentTarget;
    const rect = originEl.getBoundingClientRect();
    const f = FIT || 1; // plateau réduit (paysage sur téléphone) : on retrouve la taille réelle de la carte
    cardDrag = {
      cardId, originEl, ghostEl: null,
      startX: e.clientX, startY: e.clientY,
      offsetX: (e.clientX - rect.left) / f, offsetY: (e.clientY - rect.top) / f,
      w: rect.width / f, h: rect.height / f, fit: f, dragging: false
    };
    window.addEventListener('pointermove', onCardDragMove);
    window.addEventListener('pointerup', onCardDragEnd);
  },

  clickMyMinion(instanceId) {
    const ts = S.targetingSpell;
    if (ts && (ts.mode === 'buff' || ts.mode === 'heal' || ts.mode === 'damage' || ts.mode === 'modify' || ts.mode === 'sleep' || ts.mode === 'destroy' || ts.mode === 'silence')) {
      S.socket.emit('action:play', { cardId: ts.cardId, targetType: 'minion', targetId: instanceId });
      S.targetingSpell = null; render(); return;
    }
    const m = S.matchState.you.board.find(x => x.instanceId === instanceId);
    // Serviteur sans attaque : on l'explique au lieu de ne rien faire
    if (S.matchState.yourTurn && m && m.attack <= 0 && m.canAttack && !m.sickness) { S.matchError = `${m.name} a 0 ATQ : il ne peut pas attaquer.`; render(); return; }
    // Hors de ton tour (ou serviteur qui ne peut pas attaquer) : on affiche la carte
    if (!S.matchState.yourTurn || !m || m.sickness || !m.canAttack) { if (m) App.showMinionInfo(m.instanceId); return; }
    S.selectedAttacker = (S.selectedAttacker === instanceId) ? null : instanceId;
    render();
  },

  clickMyHero() {
    const ts = S.targetingSpell;
    if (ts && ts.mode === 'heal') {
      S.socket.emit('action:play', { cardId: ts.cardId, targetType: 'hero' });
      S.targetingSpell = null; render(); return;
    }
    if (ts) { S.matchError = "Ton héros n'est pas une cible valable : choisis une cible en surbrillance, ou annule."; render(); return; }
    const st = S.matchState;
    const w = st && st.status === 'active' && st.you.weapon;
    if (w && st.yourTurn && w.durability > 0 && w.usesThisTurn < w.usesPerTurn) {
      S.selectedAttacker = (S.selectedAttacker === 'hero') ? null : 'hero';
      render(); return;
    }
    // Sans arme utilisable, cliquer son propre avatar ouvre la roue de provocations
    if (st && st.status === 'active') App.openEmoteWheel();
  },

  clickEnemyMinion(instanceId) {
    const ts = S.targetingSpell;
    const target = S.matchState && S.matchState.opponent.board.find(x => x.instanceId === instanceId);
    if (target && target.stealth && (ts || S.selectedAttacker)) { S.matchError = 'Ce serviteur est camouflé : il ne peut pas être ciblé.'; render(); return; }
    if (ts && !['damage', 'modify', 'sleep', 'destroy', 'silence'].includes(ts.mode)) { S.matchError = "Ce serviteur ennemi n'est pas une cible valable : choisis une cible en surbrillance, ou annule."; render(); return; }
    if (ts && (ts.mode === 'damage' || ts.mode === 'modify' || ts.mode === 'sleep' || ts.mode === 'destroy' || ts.mode === 'silence')) {
      S.socket.emit('action:play', { cardId: ts.cardId, targetType: 'minion', targetId: instanceId });
      S.targetingSpell = null; render(); return;
    }
    if (S.selectedAttacker) {
      const attackerId = S.selectedAttacker;
      S.socket.emit('action:attack', { attackerId, targetType: 'minion', targetId: instanceId });
      S.selectedAttacker = null;
      if (!startOptimisticCharge(attackerId, `.minion[data-iid="${CSS.escape(instanceId)}"]`)) render();
      return;
    }
    // Sans attaque en cours : clic = lire la carte adverse
    const om = S.matchState && S.matchState.opponent.board.find(x => x.instanceId === instanceId);
    if (om && om.cardId) App.open3DView(om.cardId);
  },

  clickEnemyHero() {
    const ts = S.targetingSpell;
    if (ts && ts.mode === 'damage') {
      S.socket.emit('action:play', { cardId: ts.cardId, targetType: 'hero' });
      S.targetingSpell = null; render(); return;
    }
    if (ts) { S.matchError = "Le héros adverse n'est pas une cible valable : choisis une cible en surbrillance, ou annule."; render(); return; }
    if (S.selectedAttacker) {
      const attackerId = S.selectedAttacker;
      S.socket.emit('action:attack', { attackerId, targetType: 'hero' });
      S.selectedAttacker = null;
      if (!startOptimisticCharge(attackerId, '[data-hero="opp"]')) render();
    }
  },

  toggleSound() {
    S.soundOn = !S.soundOn;
    if (S.soundOn) { ArcaneAudio.unlockAudio(); ArcaneAudio.preloadSounds(S.cardPool); }
    render();
  },
  open3DView(cardId) {
    if (inCombatNow()) { App.showCardInfo(cardId); return; } // en combat : fiche 2D lisible au lieu de la 3D
    const card = cardById(cardId) || handCardData(cardId);
    if (!card) return;
    S.card3DView = card;
    S.card3DError = null;
    render();
    // Le son lié à la carte (panel admin) se joue à l'ouverture de l'aperçu
    if (card.sound && S.soundOn) ArcaneAudio.playSoundUrl(card.sound);
    requestAnimationFrame(async () => {
      const el = document.getElementById('card3d-modal-canvas');
      if (!el || !window.Card3D) { S.card3DError = 'La 3D n\'a pas pu se charger.'; render(); return; }
      try { await window.Card3D.showSingle(card, el); }
      catch (e) { S.card3DError = e.message || 'Impossible d\'afficher cette carte en 3D.'; render(); }
    });
  },
  play3DCardSound() {
    const card = S.card3DView;
    if (card && card.sound) { ArcaneAudio.unlockAudio(); ArcaneAudio.playSoundUrl(card.sound); }
  },
  close3DView() {
    S.card3DView = null;
    if (window.Card3D) window.Card3D.unmount();
    render();
  },
  /* ---- Ornements (admin) ---- */
  async createOrnament() {
    const fd = new FormData();
    fd.append('code', S.adminCodeTry);
    fd.append('name', document.getElementById('new-orn-name').value.trim());
    fd.append('price', document.getElementById('new-orn-price').value || '0');
    fd.append('desc', document.getElementById('new-orn-desc').value.trim());
    const img = document.getElementById('new-orn-image');
    if (img.files && img.files[0]) fd.append('image', img.files[0]);
    else { alert('Choisis une image PNG pour cet ornement.'); return; }
    try {
      await upload('/api/admin/ornaments', fd);
      S.config = await api('/api/config');
      document.getElementById('new-orn-name').value = '';
      document.getElementById('new-orn-desc').value = '';
      img.value = '';
      alert('Ornement ajouté à la boutique !');
    } catch (e) { alert(e.message); }
    render();
  },
  async updateOrnamentPrice(id) {
    const price = document.getElementById('orn-price-' + id).value;
    try {
      await fetch('/api/admin/ornaments/' + id, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify({ code: S.adminCodeTry, price })
      }).then(async r => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || 'Échec.'); });
      S.config = await api('/api/config');
    } catch (e) { alert(e.message); }
    render();
  },
  async deleteOrnament(id) {
    if (!confirm('Supprimer cet ornement de la boutique ?')) return;
    try {
      await fetch('/api/admin/ornaments/' + id, {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify({ code: S.adminCodeTry })
      }).then(async r => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || 'Échec.'); });
      S.config = await api('/api/config');
    } catch (e) { alert(e.message); }
    render();
  },

  setCodexExt(id) { S.codexExt = id; render(); },

  setAdminCardExt(id) { S.adminCardExt = id; render(); },
  showCardInfo(cardId, ref) {
    const st = S.matchState;
    const board = st ? st.you.board.concat(st.opponent.board) : [];
    const minion = (ref && ref.instanceId && board.find(m => m.instanceId === ref.instanceId)) || null;
    const card = cardById(cardId) || handCardData(cardId) || (ref && { id: cardId, name: ref.name, image: ref.image, rarity: ref.rarity || 'commun',
      type: ref.type || (ref.kind === 'minion' ? 'minion' : 'sort'), cost: ref.cost, attack: ref.attack, health: ref.health, effectType: ref.effectType, value: ref.value, value2: ref.value2 });
    if (!card) return;
    S.cardInfo = { card, minion };
    render();
  },
  showMinionInfo(instanceId) {
    const st = S.matchState; if (!st) return;
    const m = st.you.board.concat(st.opponent.board).find(x => x.instanceId === instanceId);
    if (m) App.showCardInfo(m.cardId, m);
  },
  closeCardInfo() { S.cardInfo = null; render(); },
  randomPoolAdd() { const id = (document.getElementById('rp-pick') || {}).value; if (id && !S.randomPoolDraft.includes(id)) S.randomPoolDraft.push(id); render(); },
  randomPoolRemove(i) { S.randomPoolDraft.splice(i, 1); render(); },
  async loadDeathrattles() {
    try { S.adminDeathrattles = (await api('/api/admin/cards/deathrattles?code=' + encodeURIComponent(S.adminCodeTry || ''))).cards; } catch (e) { alert(e.message); }
    render();
  },
  async clearDeathrattles(scope, label) {
    if (label && !confirm(`Retirer le Râle d'agonie ${label} ?`)) return;
    try {
      const r = await api('/api/admin/cards/deathrattles/clear', 'POST', Object.assign({ code: S.adminCodeTry }, scope));
      S.cardPool = await api(cardsUrl()).then(x => x.cards || x).catch(() => S.cardPool);
      await App.loadDeathrattles();
      alert(`Râle d'agonie retiré de ${r.cleared} carte${r.cleared > 1 ? 's' : ''}.`);
    } catch (e) { alert(e.message); }
  },
  cancelTargeting() { S.targetingSpell = null; S.selectedAttacker = null; S.matchError = null; render(); },
  // Cri de guerre à cible : poser quand même le serviteur, sans déclencher l'effet à cible
  playWithoutBattlecry() {
    const ts = S.targetingSpell;
    if (!ts) return;
    S.socket.emit('action:play', { cardId: ts.cardId });
    S.targetingSpell = null; render();
  },
  endTurn() {
    if (S.matchState && S.matchState.puzzle && S.matchState.status === 'active' && !confirm('Finir ton tour sans avoir gagné = puzzle raté. Finir quand même ?')) return;
    S.socket.emit('action:endTurn');
  }
};
window.App = App;

/* ---------------- Composants de rendu ---------------- */
function fmtCountdown(ms) {
  if (ms <= 0) return '00:00';
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60), sec = s % 60;
  return String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
}

function ornamentHtml(ornamentId) {
  const list = (S.config && S.config.ornaments) || [];
  const orn = list.find(o => o.id === ornamentId);
  if (orn && orn.image) return `<img class="orn-img" src="${esc(orn.image)}" alt="">`;
  // Les contours de niveau ont un identifiant (« lvl-10 ») différent de leur classe CSS (« orn-lvl10 »)
  if (orn && orn.css) return `<div class="orn ${esc(orn.css)}"></div>`;
  return `<div class="orn orn-${esc(ornamentId || 'none')}"></div>`;
}

function avatarHtml(pseudo, avatar, ornament, size, extraClass) {
  const cls = 'avatar-wrap' + (size ? ' ' + size : '') + (extraClass ? ' ' + extraClass : '');
  const inner = avatar
    ? `<img class="avatar-img" src="${esc(avatar)}" alt="">`
    : `<div class="avatar-fallback">${esc((pseudo || '?').slice(0, 2).toUpperCase())}</div>`;
  return `<div class="${cls}">${inner}${ornamentHtml(ornament)}</div>`;
}

function rankPill(rank) {
  if (!rank) return '';
  return `<span class="rank-pill" style="color:${rank.color}">${esc(rank.label)}</span>`;
}

function cardArt(card, cls) {
  if (card.image) return `<div class="${cls || 'card-art'}"><img src="${esc(card.image)}" alt=""></div>`;
  const icon = card.type === 'minion' ? '⚔' : '✦';
  return `<div class="${cls || 'card-art'}"><span class="no-art">${icon}</span></div>`;
}

function cardTypeLabel(type) {
  if (type === 'minion') return t('cardtype.minion', 'Serviteur');
  if (type === 'weapon') return t('cardtype.weapon', 'Arme');
  return t('cardtype.spell', 'Sort');
}

/* Calcule la position, l'inclinaison et l'ordre d'empilement d'une carte
   dans la main en éventail : les cartes centrales sont presque verticales,
   les cartes extérieures sont plus inclinées et descendent légèrement,
   comme un vrai éventail de cartes tenu en main. */
function handFanStyle(index, count) {
  // Sur téléphone (écran étroit), cartes plus petites et éventail plus serré
  const phone = typeof window !== 'undefined' && ((window.innerWidth <= 760 && window.innerHeight > window.innerWidth) || (document.body && document.body.classList.contains('phone-combat')));
  const cardWidth = phone ? 92 : 172;
  if (count <= 1) return `position:absolute;left:50%;bottom:0;transform-origin:50% 120%;--fan-x:${(-cardWidth / 2).toFixed(1)}px;--fan-y:0px;--fan-angle:0deg;transform:translateX(var(--fan-x)) translateY(var(--fan-y)) rotate(var(--fan-angle));z-index:100;`;
  const mid = (count - 1) / 2;
  const offset = index - mid; // négatif = à gauche du centre, positif = à droite
  const spacing = Math.min(cardWidth * 0.6, (phone ? Math.min(300, window.innerWidth - 110) : 460) / (count - 1));
  const maxAngle = Math.min(8, 30 / count);
  const angle = (offset / mid) * maxAngle;
  const x = offset * spacing - cardWidth / 2;
  const y = Math.pow(Math.abs(offset), 1.6) * 3.2; // légère courbe : les bords descendent un peu
  const z = 100 - Math.round(Math.abs(offset) * 10);
  return `position:absolute;left:50%;bottom:0;transform-origin:50% 120%;--fan-x:${x.toFixed(1)}px;--fan-y:${y.toFixed(1)}px;--fan-angle:${angle.toFixed(1)}deg;transform:translateX(var(--fan-x)) translateY(var(--fan-y)) rotate(var(--fan-angle));z-index:${z};`;
}

function handStatLine(c, fontSize) {
  const fs = fontSize || 15;
  if (c.type === 'minion') return `<div class="minion-stats"><span class="atk">${c.attack}</span><span class="hp">${c.health}</span></div>`;
  if (c.type === 'weapon') return `<div class="minion-stats"><span class="atk">${c.attack}</span><span class="hp weapon-durability">${c.durability}</span></div>`;
  return `<div class="card-power" style="font-size:${fs}px;">${c.effectType === 'modify_stats' ? '⇅' : c.value == null || c.effectType === 'board_wipe' || c.effectType === 'destroy' ? '☠' : c.effectType === 'silence' ? '🔇' : c.value}</div>`;
}

/* Illustration d'une carte en main : l'image de la carte, ou à défaut un
   fond coloré selon le type avec une icône, pour que la carte garde sa
   forme (cadre + illustration + bandeau de nom) même sans image. */
function handCardArt(c) {
  if (c.image) return `<div class="hand-card-art"><img src="${esc(c.image)}" alt=""></div>`;
  const glyph = c.type === 'minion' ? '⚔' : c.type === 'weapon' ? '🪓' : '✦';
  return `<div class="hand-card-art no-img"><span>${glyph}</span></div>`;
}

/* ---------- Cartes brillantes ---------- */
const SHINY_CRAFT_COST = { commun: 100, rare: 200, epique: 400, legendaire: 800 };
function isShinyMine(id) { return !!(S.profile && S.profile.foils && S.profile.foils[id] > 0); }
function shinyCount() { return S.profile && S.profile.foils ? Object.keys(S.profile.foils).filter(id => S.profile.foils[id] > 0 && cardById(id)).length : 0; }
/* Particules qui s'échappent de la carte (purement décoratif) */
function shinyFx() { return '<span class="shiny-fx" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></span>'; }

function renderCardTile(card, opts) {
  if (!card) return ''; // carte supprimée par un admin : on ne l'affiche pas plutôt que de planter
  opts = opts || {};
  const r = RARITIES[card.rarity] || RARITIES.commun;
  const clickAttr = opts.onClick ? `onclick="${opts.onClick}"` : '';
  const kws = [];
  if (card.taunt) kws.push('Provocation');
  if (card.charge) kws.push('Charge');
  if (card.colorblind) kws.push('Daltonisme');
  if (card.bcEffect) kws.push('Cri de guerre');
  if (card.auraAttack) kws.push('Aura');
  if (card.comboPartnerId) kws.push('Combo');
  if (card.shield) kws.push('Bouclier');
  if (card.windfury) kws.push('Furie');
  if (card.stealth) kws.push('Camouflage');
  if (card.standing) kws.push('Toujours debout');
  if (card.rage && card.type === 'minion') kws.push('Rage');
  if (card.drEffect && card.type === 'minion') kws.push("Râle d'agonie");
  if (card.armor) kws.push(card.armor + ' armure');
  if (card.type === 'weapon' && card.usesPerTurn > 1) kws.push(card.usesPerTurn + '×/tour');
  if (card.battlecryHeal) kws.push((card.type === 'weapon' ? 'Équip. ' : 'Cri : ') + '+' + card.battlecryHeal + ' PV');
  const effectLabels = {
    damage: 'DÉGÂTS', heal: 'SOIN', buff_attack: 'BONUS ATQ',
    aoe_damage: 'DÉGÂTS ZONE (ennemis)', aoe_heal: 'SOIN ZONE (alliés)',
    damage_all: 'DÉGÂTS À TOUS', buff_all_allies: 'BONUS ATQ (équipe)',
    board_wipe: 'DESTRUCTION TOTALE', buff_ally_and_heal: 'BONUS ATQ + SOIN', modify_stats: 'ATQ / PV', draw: 'PIOCHE', armor: 'ARMURE', sleep: 'ENDORMISSEMENT', destroy: 'DÉTRUIRE', silence: 'SILENCE',
    give_shield: 'BOUCLIER', give_windfury: 'FURIE', give_stealth: 'CAMOUFLAGE', give_taunt: 'PROVOCATION', give_deathrattle: "RÂLE D'AGONIE", summon: 'INVOCATION', trap: 'PIÈGE', random_cards: 'AU HASARD'
  };
  const statLine = card.type === 'minion'
    ? `<div class="minion-stats" style="margin-top:2px;"><span class="atk">${card.attack} ATQ</span><span class="hp">${card.health} PV</span></div>`
    : card.type === 'weapon'
      ? `<div class="minion-stats" style="margin-top:2px;"><span class="atk">${card.attack} ATQ</span><span class="hp weapon-durability">🛡 ${card.durability}</span></div>`
      : card.effectType === 'board_wipe'
        ? `<div class="card-power" style="font-size:13px;">☠ <small>${effectLabels.board_wipe}</small></div>`
        : card.effectType === 'modify_stats'
          ? `<div class="card-power">${signed(card.value)} / ${signed(card.value2)} <small>${effectLabels.modify_stats}</small></div>`
          : `<div class="card-power">${card.value}${card.value2 ? ' / +' + card.value2 : ''} <small>${effectLabels[card.effectType] || 'EFFET'}</small></div>`;
  const shiny = opts.shinyExact ? !!card.shiny : !opts.noShiny && (card.shiny || isShinyMine(card.id));
  return `
  <div class="card rar-${esc(card.rarity)} ${shiny ? 'shiny' : ''} ${opts.selected ? 'selected' : ''} ${evoClass(card.id)} ${opts.synergy && opts.synergy.length ? (opts.synergy.some(x => x.combo) ? 'syn-combo' : 'syn-on') : ''}" style="--rarity:${r.color}" ${clickAttr}>${evoBadge(card.id)}${opts.synergy && opts.synergy.length ? `<span class="syn-badge" title="${esc(opts.synergy.map(x => x.text).join(' · '))}">${opts.synergy.some(x => x.combo) ? '🔗 Combo' : '✨ Synergie'}</span>` : ''}${card.unobtainable && S.isAdmin ? '<span class="special-badge" title="Carte spéciale : jamais dans les boosters, n\'apparaît que via des effets">★ spéciale</span>' : ''}
    ${shiny ? `${shinyFx()}<span class="shiny-badge" title="Version brillante">✨</span>` : ''}
    <button class="btn3d-badge" onclick="event.stopPropagation();App.open3DView('${card.id}')" title="Voir en 3D">${icon('icon.view3d', '🧊')}</button>
    ${opts.fav ? (() => { const on = (S.profile.favoriteCards || []).includes(card.id); return `<button class="fav-badge ${on ? 'on' : ''}" onclick="event.stopPropagation();App.toggleFavorite('${card.id}')" title="${on ? 'Retirer des favoris' : 'Ajouter aux favoris'}" aria-pressed="${on}">${on ? '★' : '☆'}</button>`; })() : ''}
    <div class="card-cost">${card.cost}</div>
    ${cardArt(card)}
    <div class="card-type">${cardTypeLabel(card.type)}${kws.length ? ' · ' + kwWrap(esc(kws.join(', '))) : ''}</div>
    <div class="card-name">${esc(card.name)}</div>
    ${statLine}
    <div class="card-rarity">${r.label}</div>
    ${opts.showDesc !== false ? cardTextHTML(card, 'card-desc') : ''}
    ${card.sound ? '<div class="sound-badge" title="Cette carte a un son">🔊</div>' : ''}
    ${opts.count !== undefined ? `<div class="card-count">×${opts.count}</div>` : ''}
    ${opts.footer ? `<div class="card-foot">${opts.footer}</div>` : ''}
  </div>`;
}

function renderCard3DModal() {
  if (!S.card3DView) return '';
  const card = S.card3DView;
  const r = RARITIES[card.rarity] || RARITIES.commun;
  return `<div class="emote-wheel-overlay" onclick="App.close3DView()">
    <div class="card3d-modal" onclick="event.stopPropagation()">
      <div id="card3d-modal-canvas" class="card3d-canvas"></div>
      ${S.card3DError ? `<div class="card3d-error">⚠️ ${esc(S.card3DError)}<br><span style="font-size:11.5px;">La carte reste jouable normalement — seul l'aperçu 3D est indisponible.</span></div>` :
        `<div class="card3d-hint">Glisse pour faire pivoter · Molette pour zoomer · Double-clic pour recadrer · <span style="color:${r.color}">${r.label}</span></div>`}
      <div class="card3d-title">${esc(card.name)}</div>
      <div class="btn-row" style="justify-content:center;margin-top:0;">
        ${card.sound ? `<button class="btn small" onclick="App.play3DCardSound()">🔊 Écouter le son</button>` : ''}
        ${(() => {
          if (S.matchState && S.matchState.status === 'active') return '';
          if (isShinyMine(card.id)) return '<span class="shiny-owned">✨ Tu as la version brillante</span>';
          if (!(S.profile && S.profile.collection && S.profile.collection[card.id] > 0)) return '';
          const price = SHINY_CRAFT_COST[card.rarity] || 100;
          return `<button class="btn small shiny-craft" ${(S.profile.dust || 0) < price ? 'disabled title="Pas assez de poussière"' : ''} onclick="App.craftShiny('${esc(card.id)}')">✨ Version brillante · ${price} ✧</button>`;
        })()}
        <button class="btn ghost small" onclick="App.close3DView()">Fermer</button>
      </div>
    </div>
  </div>`;
}

function ownedCardsList(collection) {
  return Object.keys(collection).map(id => ({ card: cardById(id), count: collection[id] })).filter(x => x.card);
}

/* ---------- Catégories du menu ----------
   Chaque groupe s'affiche comme une seule entrée du menu, avec ses pages en
   onglets en haut de l'écran. On revient sur le dernier onglet ouvert. */
const NAV_GROUPS = {
  collection: { title: () => t('nav.collectionGroup', 'Cartes & Decks'), tabs: [
    ['deck', () => t('nav.deck', 'Deck')], ['deckstats', () => t('nav.deckstats', 'Stats du deck')], ['codex', () => t('nav.codex', 'Codex')],
    ['poussiere', () => t('nav.poussiere', 'Désenchantement')], ['achievements', () => t('nav.achievements', 'Succès')]] },
  combat: { title: () => t('nav.play', 'Jouer'), tabs: [
    ['combat', () => t('nav.playHub', 'Jouer')], ['survie', () => 'Survie'], ['draft', () => 'Draft'], ['puzzle', () => 'Puzzle'], ['bagarre', () => 'Bagarre']] },
  social: { title: () => t('nav.social', 'Social'), tabs: [
    ['joueurs', () => t('nav.joueurs', 'Joueurs')], ['echanges', () => t('nav.echanges', 'Échanges')]] }
};
function navGroupOf(tab) {
  for (const key of Object.keys(NAV_GROUPS)) if (NAV_GROUPS[key].tabs.some(tb => tb[0] === tab)) return Object.assign({ key }, NAV_GROUPS[key]);
  return null;
}
function renderSubTabs(grp) {
  const pending = (S.trades.received || []).filter(x => x.status === 'pending').length;
  return `<div class="subtabs" role="tablist" aria-label="${esc(grp.title())}">
    ${grp.tabs.map(([id, label]) => `<button class="subtab ${S.tab === id ? 'active' : ''}" role="tab" aria-selected="${S.tab === id}" onclick="App.goTab('${id}')">${esc(label())}${id === 'echanges' && pending > 0 ? ` <span class="badge">${pending}</span>` : ''}</button>`).join('')}
  </div>`;
}

const BIO_MAX = 150;
function renderBioEditor(p) {
  if (S.bioEditing) {
    const v = S.bioDraft || '';
    return `<div class="bio-edit">
      <textarea id="bio-input" maxlength="${BIO_MAX}" rows="2" placeholder="Présente-toi en quelques mots…" oninput="App.bioInput(this)">${esc(v)}</textarea>
      <div class="bio-actions"><span id="bio-count" class="bio-count">${Array.from(v).length}/${BIO_MAX}</span>
        <button class="btn small" onclick="App.saveBio()">Enregistrer</button>
        <button class="btn small ghost" onclick="App.cancelBio()">Annuler</button></div>
    </div>`;
  }
  return `<div class="bio-view">${p.bio ? `<p class="profile-bio">${esc(p.bio)}</p>` : '<p class="profile-bio empty">Aucune description pour l\'instant.</p>'}
    <button class="btn small ghost" onclick="App.editBio()">${p.bio ? 'Modifier' : 'Ajouter une description'}</button></div>`;
}

/* ---------- Vitrine de cartes du profil (3 cartes au choix) ---------- */
function renderCardShowcaseView(ids) {
  const cards = (ids || []).map(id => id && cardById(id)).filter(Boolean);
  if (!cards.length) return '';
  return `<div class="panel card-showcase"><h3 style="margin-top:0;">Vitrine</h3>
    <div class="showcase-slots">${cards.map(c => `<div class="showcase-slot filled">${renderCardTile(c, {})}</div>`).join('')}</div></div>`;
}
function renderCardShowcaseEditor(owned) {
  const ids = (S.profile.cardShowcase || [null, null, null]).slice(0, 3);
  while (ids.length < 3) ids.push(null);
  const pick = S.showcasePick;
  const slots = ids.map((id, i) => {
    const c = id && cardById(id);
    return `<div class="showcase-slot ${c ? 'filled' : 'empty'} ${pick === i ? 'picking' : ''}">
      ${c ? renderCardTile(c, {}) : `<button class="showcase-add" onclick="App.pickShowcaseSlot(${i})"><span>+</span>Choisir une carte</button>`}
      ${c ? `<div class="showcase-slot-actions">
        <button class="btn small ghost" onclick="App.pickShowcaseSlot(${i})">Changer</button>
        <button class="btn small ghost" onclick="App.setShowcaseCard(${i}, null)" title="Retirer de la vitrine">Retirer</button></div>` : ''}
    </div>`;
  }).join('');
  let picker = '';
  if (pick !== null && pick !== undefined) {
    picker = owned.length === 0
      ? `<div class="panel showcase-picker"><div class="empty">${t('empty.collection', "Ta collection est vide — direction l'onglet Boosters !")}</div>
          <div class="btn-row"><button class="btn ghost" onclick="App.closeShowcasePicker()">Fermer</button></div></div>`
      : `<div class="panel showcase-picker">
          <div style="display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap;margin-bottom:12px;">
            <h3 style="margin:0;">Choisis une carte pour l'emplacement ${pick + 1}</h3>
            <div style="display:flex;gap:8px;"><input type="search" placeholder="Rechercher une carte…" value="${esc(S.showcaseSearch || '')}" oninput="App.showcaseSearch(this)" style="min-width:200px;">
            <button class="btn ghost" onclick="App.closeShowcasePicker()">Annuler</button></div>
          </div>
          <div class="grid">${owned.map(x => `<div data-name="${esc(String(x.card.name).toLowerCase())}">${renderCardTile(x.card, { onClick: `App.setShowcaseCard(${pick}, '${x.card.id}')`, selected: ids[pick] === x.card.id })}</div>`).join('')}</div>
        </div>`;
  }
  return `<div class="panel card-showcase">
      <h3 style="margin-top:0;">Ma vitrine</h3>
      <p class="page-sub" style="margin:0 0 14px;">Choisis jusqu'à 3 cartes de ta collection à montrer sur ton profil. Les autres joueurs les voient sur ta fiche.</p>
      <div class="showcase-slots">${slots}</div>
    </div>${picker}`;
}


/* ======================================================
   INTERFACE TÉLÉPHONE
   Sur un écran étroit : plus de menu latéral, une barre de navigation en
   bas (Accueil, Collection, ⚔️ Combat, Classement, Social) et un écran
   d'Accueil qui regroupe le profil, les monnaies, les modes de jeu
   (Histoire, Tournoi, Événements, Entraînement) et les boosters.
   ====================================================== */
function phoneUI() { return typeof window !== 'undefined' && window.innerWidth <= 760; }
function renderMobileNav() {
  const g = navGroupOf(S.tab);
  const on = id => (id === 'collection' ? (g && g.key === 'collection') : id === 'social' ? (g && g.key === 'social') : S.tab === id) ? 'on' : '';
  const pending = (S.trades && S.trades.received || []).filter(x => x.status === 'pending').length;
  return `<nav class="m-nav" aria-label="Navigation">
    <button class="${on('accueil')}" onclick="App.goTab('accueil')"><i>🏠</i>Accueil</button>
    <button class="${on('collection')}" onclick="App.goTab('deck')"><i>📚</i>Collection</button>
    <button class="m-fight ${S.tab === 'combat' ? 'on' : ''}" onclick="App.goTab('combat')" aria-label="Combat">⚔️</button>
    <button class="${on('classement')}" onclick="App.goTab('classement')"><i>🏆</i>Classement</button>
    <button class="${on('social')}" onclick="App.goTab('joueurs')"><i>👥</i>Social${pending ? `<span class="m-badge">${pending}</span>` : ''}</button>
  </nav>`;
}
function renderMobileHome() {
  const p = S.profile, pr = p.progress || {};
  const pct = pr.xpNext ? Math.round(pr.xp / pr.xpNext * 100) : 100;
  const show = (p.cardShowcase || []).map(id => cardById(id)).filter(Boolean);
  const sideCard = (c, cls, fallback) => `<div class="mh-card ${cls}" style="${c && c.image ? `background-image:url('${esc(c.image)}')` : ''}">${c && !c.image ? `<span>${esc(c.name.slice(0, 1))}</span>` : fallback}</div>`;
  const modes = [
    ...(S.story && S.story.tabEnabled ? [['histoire', '🗺️', 'Histoire', (() => { const ch = (S.story.chapters || []); const done = ch.filter(c => c.cleared).length; return ch.length ? `${done} / ${ch.length} chapitres` : 'Affronte les boss'; })()]] : []),
    ...(S.tournament && S.tournament.tabEnabled ? [['tournoi', '🎖️', 'Tournoi', S.tournament.current ? ({ registration: 'Inscriptions ouvertes', running: 'En cours', finished: 'Terminé' }[S.tournament.current.status] || '') : 'Bientôt']] : []),
    ...(S.events && S.events.tabEnabled ? [['evenements', '🎉', 'Événements', 'Boss du jour']] : []),
    ['puzzle', '🧩', 'Puzzle du jour', p.puzzle && p.puzzle.solvedToday ? 'Réussi ✔' : 'Gagne en un tour'],
    ['bagarre', '🥊', 'Bagarre', p.brawl && p.brawl.rule ? p.brawl.rule.name : 'Règle de la semaine'],
    ['draft', '🃏', 'Draft', p.draft && p.draft.run ? (p.draft.run.picks < 30 ? `Choix ${p.draft.run.picks + 1}/30` : `${p.draft.run.wins} V · ${p.draft.run.losses} D`) : (p.draft && p.draft.free ? 'Entrée gratuite' : `Record : ${(p.draft && p.draft.best) || 0}`)],
    ['survie', '🏔️', 'Survie', p.survival && p.survival.run ? `Manche ${p.survival.run.round}` : `Record : ${(p.survival && p.survival.best) || 0}`],
    ['combat', '⚡', 'Blitz', 'Tours de 20 s'],
    ['combat', '🤖', 'Entraînement', 'Contre le bot']
  ];
  const daily = pr.daily || [];
  const exts = (S.extensions || []).filter(e => e.boosterCreditPrice || e.boosterDustPrice);
  const ps = S.packStatus || {};
  const inv = (p.boosterInventory || []).length;
  return `<div class="mh">
    <div class="mh-top">
      <button class="mh-tile" onclick="App.goTab('boutique')"><i>💎</i>Boutique</button>
      <button class="mh-name" onclick="App.goTab('collection')">${avatarHtml(p.pseudo, p.avatar, p.ornament, 'xs')}<b>${esc(String(p.pseudo).toUpperCase())}</b></button>
      <button class="mh-tile" onclick="App.goTab('options')"><i>⚙️</i>Options</button>
    </div>
    <div class="mh-hero" onclick="App.goTab('collection')">
      <div class="mh-rays"></div>
      <img class="mh-logo" src="${esc(logoUrl())}" alt="Clean Gang Decks">
      ${sideCard(show[0], 'l', '')}${sideCard(show[1], 'r', '')}
      <div class="mh-ttl"><div class="mh-title">${esc((p.titleName || (p.rank && p.rank.label) || 'Recrue').toUpperCase())}</div>
        <span class="mh-rank">★ RANG ${esc(((p.rank && p.rank.label) || 'Bronze').toUpperCase())} ★</span></div>
      <div class="mh-xp"><i style="width:${pct}%"></i></div>
      <div class="mh-meta"><span>${pr.xp || 0}/${pr.xpNext || 0} XP</span><span>NIVEAU ${pr.level || 1}</span></div>
    </div>
    <div class="mh-money">
      <div class="mh-coin"><b class="c-or">🪙</b><span data-count="credits" data-val="${Number(p.credits || 0)}">${Number(p.credits || 0).toLocaleString('fr-FR')}</span></div>
      <div class="mh-coin"><b class="c-du">✧</b><span data-count="dust" data-val="${Number(p.dust || 0)}">${Number(p.dust || 0).toLocaleString('fr-FR')}</span></div>
      <div class="mh-coin"><b class="c-pt">🏆</b>${Number(p.seasonVP || 0).toLocaleString('fr-FR')}</div>
    </div>
    <section class="mh-sec">
      <div class="mh-sec-h"><div class="mh-ico">🎮</div>Modes de jeu</div>
      <div class="mh-modes">${modes.map(([tab, ic, name, sub]) => `<button class="mh-mode" onclick="App.goTab('${tab}')"><i>${ic}</i><b>${esc(name)}</b><small>${esc(sub)}</small></button>`).join('')}</div>
    </section>
    ${S.community ? `<section class="mh-sec mh-community">${renderCommunityPanel(true)}</section>` : ''}
    ${daily.length ? `<section class="mh-sec">
      <div class="mh-sec-h"><div class="mh-ico">🎯</div>Défis du jour<span>${daily.filter(d => d.done).length} / ${daily.length}</span></div>
      ${daily.map(d => `<div class="mh-daily ${d.done ? 'done' : ''}"><span>${d.done ? '✅' : '🎯'} ${esc(d.text)}</span><div class="xp-bar"><i style="width:${Math.round(d.progress / d.target * 100)}%"></i></div></div>`).join('')}
    </section>` : ''}
    <section class="mh-sec">
      <div class="mh-sec-h"><div class="mh-ico">🎁</div>Boosters<span>${inv} en réserve</span></div>
      <div class="mh-row">
        <button class="mh-item" onclick="App.goTab('boosters')">Base<small><b class="c-or">🪙</b>${ps.ready ? 'Gratuit' : 'Bientôt'}</small><div class="mh-pack p1 ${ps.ready ? 'ready' : ''}"></div></button>
        ${exts.slice(0, 2).map((e, i) => `<button class="mh-item" onclick="App.goTab('boutique')"><span class="mh-iname">${esc(e.name)}</span><small>${e.boosterCreditPrice ? `<b class="c-or">🪙</b>${e.boosterCreditPrice}` : `<b class="c-du">✧</b>${e.boosterDustPrice}`}</small><div class="mh-pack ${i ? 'p3' : 'p2'}" ${e.packImage ? `style="background-image:url('${esc(e.packImage)}');background-size:cover"` : ''}></div></button>`).join('')}
      </div>
    </section>
    <div class="mh-more">
      <button onclick="App.goTab('wiki')">📘 Wiki</button>
      <button onclick="App.goTab('collection')">👤 Mon profil</button>
      <button onclick="App.goTab('admin')">🛠️ Admin</button>
      <button onclick="App.logout()">🚪 Quitter</button>
    </div>
  </div>`;
}

function renderSidebar() {
  // Menu rangé par usage : Jouer, puis Collection, Boutique, Social ; Options,
  // Wiki et Admin en petit tout en bas. « Mon profil » s'ouvre en cliquant sur
  // son avatar (et reste dans les liens du bas).
  const pending = (S.trades.received || []).filter(t => t.status === 'pending').length;
  const p = S.profile;
  const groupTarget = key => { const g = NAV_GROUPS[key]; const last = (S.lastSubTab || {})[key]; return g.tabs.some(tb => tb[0] === last) ? last : g.tabs[0][0]; };
  const isActive = id => id.startsWith('group:') ? NAV_GROUPS[id.slice(6)].tabs.some(tb => tb[0] === S.tab) : S.tab === id;
  const item = (id, ic, label, badge) => `<button class="nav-btn ${isActive(id) ? 'active' : ''}" onclick="App.goTab('${id.startsWith('group:') ? groupTarget(id.slice(6)) : id}')"><span>${ic}</span> ${label}${badge ? `<span class="badge">${badge}</span>` : ''}</button>`;
  const sections = [
    ['Jouer', [
      ...(S.story && S.story.tabEnabled ? [['histoire', icon('icon.histoire', '🗺️'), t('nav.histoire', 'Histoire')]] : []),
      ...(S.tournament && S.tournament.tabEnabled ? [['tournoi', icon('icon.tournoi', '🎖️'), t('nav.tournoi', 'Tournoi')]] : []),
      ...(S.events && S.events.tabEnabled ? [['evenements', icon('icon.evenements', '🎉'), t('nav.evenements', 'Événements')]] : [])
    ]],
    ['Collection', [
      ['group:collection', icon('icon.collectionGroup', '📚'), t('nav.collectionGroup', 'Cartes & Decks')],
      ['boosters', icon('icon.boosters', '🎁'), t('nav.boosters', 'Boosters')]
    ]],
    ['Boutique', [['boutique', icon('icon.boutique', '🛍️'), t('nav.boutique', 'Boutique')]]],
    ['Social', [
      ['group:social', icon('icon.social', '👥'), t('nav.social', 'Social'), pending || 0],
      ['classement', icon('icon.classement', '🏆'), t('nav.classement', 'Classement')]
    ]]
  ];
  return `
  <div class="sidebar">
    <button type="button" class="brand brand-trailer" onclick="App.openTrailer(this)" title="Voir le trailer" aria-label="Voir le trailer de Clean Gang Decks">
      <img src="${esc(logoUrl())}" alt="Clean Gang Decks" class="brand-logo"><span class="trailer-hint" aria-hidden="true">▶</span>
    </button>
    <!-- Profil et porte-monnaie en haut du menu : un clic ouvre Mon profil -->
    <div class="side-profile ${S.tab === 'collection' ? 'active' : ''}" onclick="App.goTab('collection')" title="Mon profil">
      ${avatarHtml(p.pseudo, p.avatar, p.ornament, 'sm')}
      <div class="side-profile-id"><b>${esc(p.pseudo)}</b>${titleLine(p.titleName)}${rankPill(p.rank)}</div>
      ${p.progress ? `<div class="side-level" title="${p.progress.xpNext ? `${p.progress.xp} / ${p.progress.xpNext} XP` : 'Niveau maximum'}"><b>Niv. ${p.progress.level}</b><span class="xp-bar"><i style="width:${p.progress.xpNext ? Math.round(p.progress.xp / p.progress.xpNext * 100) : 100}%"></i></span></div>` : ''}
      <div class="side-wallet">
        <span class="credits-pill" title="${t('currency.credits', 'crédits')}">${icon('icon.credits', '🪙')} <span data-count="credits" data-val="${p.credits}">${p.credits}</span></span>
        <span class="dust-pill" title="${t('currency.dust', 'poussière')}">${icon('icon.dust', '✧')} <span data-count="dust" data-val="${p.dust}">${p.dust}</span></span>
      </div>
    </div>
    <button class="side-play ${NAV_GROUPS.combat.tabs.some(tb => tb[0] === S.tab) ? 'on' : ''}" onclick="App.goTab('combat')">⚔️ ${t('nav.play', 'JOUER')}</button>
    ${S.queueStatus === 'waiting' && S.tab !== 'combat' ? `<div class="side-queue"><span class="live-dot"></span><span onclick="App.goTab('combat')">Recherche d'un adversaire…</span><button title="Annuler la recherche" onclick="App.leaveQueue()">✕</button></div>` : ''}
    ${sections.map(([title, list]) => list.length ? `<div class="nav-section">${esc(title)}</div>${list.map(([id, ic, label, badge]) => item(id, ic, label, badge)).join('')}` : '').join('')}
    <div class="side-foot">
      <button class="${S.tab === 'collection' ? 'on' : ''}" onclick="App.goTab('collection')">👤 Mon profil</button>
      <button class="${S.tab === 'options' ? 'on' : ''}" onclick="App.goTab('options')">⚙️ Options</button>
      <button class="${S.tab === 'wiki' ? 'on' : ''}" onclick="App.goTab('wiki')">📘 Wiki</button>
      <button class="${S.tab === 'admin' ? 'on' : ''}" onclick="App.goTab('admin')">🛠️ Admin</button>
      <button onclick="App.logout()">🚪 ${t('btn.logout', 'Se déconnecter')}</button>
    </div>
  </div>`;
}

function renderGate() {
  const mode = S.gateMode || 'login';
  return `
  <div class="gate-screen" style="width:100%;display:flex;align-items:center;justify-content:center;min-height:100vh;">
    <div class="gate">
      <button type="button" class="brand-trailer gate-trailer" onclick="App.openTrailer(this)" title="Voir le trailer" aria-label="Voir le trailer de Clean Gang Decks"><img src="${esc(logoUrl())}" alt="Clean Gang Decks" class="gate-logo"><span class="trailer-hint" aria-hidden="true">▶</span></button>
      <h1 style="margin-bottom:6px;">Clean Gang <span style="color:var(--accent)">Decks</span></h1>
      <p class="page-sub" style="margin:0 auto 20px;">${t('gate.tagline', "TCG multijoueur façon Hearthstone : deck de 30 cartes, mana, provocation, classement mensuel et boutique.")}</p>
      <div class="gate-tabs">
        <div class="gate-tab ${mode === 'login' ? 'active' : ''}" onclick="App.setGateMode('login')">Connexion</div>
        <div class="gate-tab ${mode === 'register' ? 'active' : ''}" onclick="App.setGateMode('register')">Créer un compte</div>
      </div>
      ${S.gateError ? `<div class="error-msg">${esc(S.gateError)}</div>` : ''}
      ${mode === 'login' ? `
        <input type="text" id="login-pseudo" placeholder="Pseudo" />
        <input type="password" id="login-pw" placeholder="Mot de passe" />
        <button class="btn" style="width:100%" onclick="App.doLogin()">Se connecter</button>
      ` : `
        <input type="text" id="reg-pseudo" placeholder="Choisis un pseudo" />
        <input type="password" id="reg-pw" placeholder="Mot de passe" />
        <input type="password" id="reg-pw2" placeholder="Confirme le mot de passe" />
        <button class="btn" style="width:100%" onclick="App.doRegister()">Créer mon compte</button>
      `}
      <div class="warn-box">⚠️ Mots de passe hachés avec bcrypt côté serveur, mais ce n'est pas une plateforme professionnelle : n'utilise pas un mot de passe important.</div>
    </div>
  </div>`;
}

function renderCodex() {
  if (!S.codex) return skeletonPage('Codex', 'grid');
  const { extensions, totalCards, totalDiscovered, totalPercent } = S.codex;
  const activeExt = extensions.find(e => e.id === S.codexExt) || extensions[0];
  return `
    <h1 class="page-title">${t('title.codex', 'Codex')}</h1>
    <p class="page-sub">${t('sub.codex', "Toutes les cartes que tu as un jour obtenues restent dans ton codex, même si tu les as échangées ou désenchantées depuis.")}</p>
    <div class="panel">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
        <b>Progression totale</b><span style="color:var(--accent);font-weight:700;">${totalDiscovered} / ${totalCards} (${totalPercent}%)</span>
      </div>
      <div class="rank-bar"><div class="rank-bar-fill" style="width:${totalPercent}%"></div></div>
    </div>
    <div class="gate-tabs" style="max-width:100%;flex-wrap:wrap;height:auto;">
      ${extensions.map(e => `<div class="gate-tab" style="flex:none;padding:9px 16px;${S.codexExt === e.id && !S.codexFavOnly ? 'background:var(--accent);color:#fff;' : ''}" onclick="App.setCodexExt('${e.id}')">${esc(e.name)} (${e.discoveredCount}/${e.totalCards})</div>`).join('')}
      <div class="gate-tab fav-tab" style="flex:none;padding:9px 16px;${S.codexFavOnly ? 'background:#c99a1e;color:#fff;' : ''}" onclick="App.toggleCodexFav()">★ Favoris (${(S.profile.favoriteCards || []).length})</div>
    </div>
    ${S.codexFavOnly ? (() => {
      const favs = new Set(S.profile.favoriteCards || []);
      const list = [].concat(...extensions.map(e => e.cards)).filter(c => c.discovered && favs.has(c.id));
      return list.length ? `<div class="grid" style="margin-top:16px;">${list.map(c => renderCardTile(c, { count: c.owned, showDesc: false, fav: true })).join('')}</div>`
        : '<div class="empty" style="margin-top:16px;">Aucune carte favorite : clique sur l\'étoile ☆ d\'une carte pour l\'ajouter.</div>';
    })() : activeExt ? `
    <div class="panel" style="margin-top:16px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
        <b>${esc(activeExt.name)}</b><span style="color:var(--accent);font-weight:700;">${activeExt.percent}%</span>
      </div>
      <div class="rank-bar"><div class="rank-bar-fill" style="width:${activeExt.percent}%"></div></div>
    </div>
    <div class="grid">
      ${activeExt.cards.map(c => c.discovered
        ? renderCardTile(c, { count: c.owned, showDesc: false, fav: true, footer: c.owned === 0 ? '<div class="tone-tag" style="text-align:center;">Obtenue puis quittée</div>' : '' })
        : `<div class="card codex-locked rar-${esc(c.rarity)}">
             <div class="codex-lock">🔒</div>
             <div class="card-type">${cardTypeLabel(c.type)}</div>
             <div class="card-name">???</div>
             <div class="card-rarity">${(RARITIES[c.rarity] || {}).label || ''}</div>
           </div>`
      ).join('')}
    </div>` : ''}
  `;
}

function renderCollection() {
  const owned = ownedCardsList(S.profile.collection);
  const p = S.profile;
  const allEmotes = (S.config && S.config.emotes) || [];
  const ownedEmotes = p.ownedEmotes || [];
  const draftWheel = S.wheelDraft || (p.emoteWheel || []);
  const wheelChanged = JSON.stringify(draftWheel) !== JSON.stringify(p.emoteWheel || []);
  const lockedEmotes = allEmotes.filter(e => !ownedEmotes.includes(e.id));
  const next = p.nextRank;
  const progress = next ? Math.min(100, Math.round((p.seasonVP - p.rank.min) / (next.min - p.rank.min) * 100)) : 100;
  const ptab = S.profileTab || 'profil';
  const tabsBar = `<div class="subtabs profile-tabs" role="tablist">${[['profil', '👤 Profil'], ['perso', '🎨 Personnalisation'], ['stats', '📊 Statistiques']].map(([id, l]) => `<button class="subtab ${ptab === id ? 'active' : ''}" role="tab" aria-selected="${ptab === id}" onclick="App.setProfileTab('${id}')">${l}</button>`).join('')}</div>`;
  return `
    <h1 class="page-title">${t('title.profil', 'Mon profil')}</h1>
    ${tabsBar}
    ${ptab === 'profil' ? `<div class="panel ${p.banner && bannerById(p.banner) ? 'has-banner' : ''}" style="${bannerStyle(p.banner)}">
      <div style="display:flex;align-items:center;gap:18px;flex-wrap:wrap;">
        ${avatarHtml(p.pseudo, p.avatar, p.ornament)}
        <div style="flex:1;min-width:220px;">
          <div style="font-weight:700;font-size:17px;">${esc(p.pseudo)} ${rankPill(p.rank)}</div>${titleLine(p.titleName)}
          <div style="color:var(--muted);font-size:13px;margin-top:4px;">
            ${p.seasonVP} points · ${p.seasonWins} victoires · ${p.seasonLosses} défaites cette saison
          </div>
          ${renderBioEditor(p)}
          ${renderRankTimeline(p.seasonVP || 0)}
        </div>
        <div class="avatar-change">
          <label class="btn ghost small avatar-btn">📷 Changer d'avatar<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onchange="App.pickAvatar(this)"></label>
          <small>Tu pourras le recadrer avant de l'enregistrer.</small>
        </div>
      </div>
    </div>
    ${renderProgressPanel(p)}
    ${renderCardShowcaseEditor(owned)}` : ''}
    ${ptab === 'perso' ? `
    ${renderBannerPicker(p)}
    ${renderTitlePicker(p)}
    <div class="panel">
      <h3 style="margin-top:0;">Ma roue de provocations</h3>
      <p style="color:var(--muted);font-size:13px;margin:0 0 14px;">
        Ces 6 provocations seront disponibles en combat : clique sur ton avatar pendant la partie pour ouvrir la roue.
        Choisis un emplacement, puis une provocation ci-dessous.
      </p>
      <div class="wheel-editor">
        ${draftWheel.map((id, i) => {
          const e = allEmotes.find(x => x.id === id);
          return `<div class="wheel-slot ${S.wheelSlot === i ? 'active' : ''}" onclick="App.selectWheelSlot(${i})">
            <span class="slot-num">${i + 1}</span>${e ? esc(e.text) : '—'}
          </div>`;
        }).join('')}
      </div>
      <div style="margin-top:14px;">
        <label>Provocations débloquées (clique pour placer dans l'emplacement ${S.wheelSlot + 1})</label>
        ${allEmotes.filter(e => ownedEmotes.includes(e.id)).map(e => `
          <span class="emote-choice ${draftWheel.includes(e.id) ? 'in-wheel' : ''}" onclick="App.assignEmoteToSlot('${e.id}')">
            ${esc(e.text)}
          </span>`).join('')}
      </div>
      ${lockedEmotes.length ? `<div style="margin-top:12px;">
        <label>Verrouillées (achetables en boutique)</label>
        ${lockedEmotes.map(e => `<span class="emote-choice locked">${esc(e.text)} · ✧${e.price}</span>`).join('')}
      </div>` : ''}
      <div class="btn-row">
        <button class="btn" ${wheelChanged ? '' : 'disabled'} onclick="App.saveWheel()">Enregistrer la roue</button>
        ${wheelChanged ? '<button class="btn ghost" onclick="App.resetWheelDraft()">Annuler les changements</button>' : ''}
      </div>
    </div>
    ` : ''}
    ${ptab === 'stats' ? `
    ${renderCareer(p.careerStats)}
    <div class="panel"><h3 style="margin-top:0;">Succès</h3>
      <p class="page-sub" style="margin-top:0;">🕵️ ${p.secretCount || 0} / 100 succès secrets débloqués · 🏔️ record de Survie : ${(p.survival && p.survival.best) || 0} manche${((p.survival && p.survival.best) || 0) > 1 ? 's' : ''} · ✨ ${shinyCount()} carte${shinyCount() > 1 ? 's' : ''} brillante${shinyCount() > 1 ? 's' : ''}</p>
      <button class="btn small ghost" onclick="App.goTab('achievements')">Voir tous mes succès</button></div>` : ''}
  `;
}

/* Intensité de l'effet de révélation selon la rareté — reprend l'échelle de
   la spécification (commun discret, légendaire spectaculaire). */
const PACK_RARITY_EFFECT = { commun: 'fx-common', rare: 'fx-uncommon', epique: 'fx-rare', legendaire: 'fx-special' };


function renderPackPresentingStage() {
  const anim = S.packAnim;
  const card = S.lastDrawn[anim.index];
  const total = S.lastDrawn.length;
  const isLast = anim.index === total - 1;
  // Les effets de révélation (pop, éclat) ne se jouent qu'UNE fois, juste après
  // le clic. Avant, n'importe quel rafraîchissement de l'écran (ami qui se
  // connecte, notification...) recréait la carte et relançait l'éclat doré au
  // hasard. Passé ce court délai, la carte reste affichée sans animation.
  const fresh = !!(anim.fxAt && Date.now() - anim.fxAt < 800);
  const fxClass = anim.flipped ? (PACK_RARITY_EFFECT[card.rarity] || 'fx-common') + (fresh ? ' fx-play' : '') : '';
  return `<div class="pack-theater ${packTheaterEnterClass()}">
    <div class="pack-reveal-panel">
      <p class="pack-theater-hint top">Carte ${anim.index + 1} / ${total}${isLast && !anim.flipped ? ' — la dernière…' : ''}</p>
      <div class="pack-reveal-stage">
        <div class="pack-flip-card ${anim.flipped ? 'flipped' : ''} ${fxClass} ${isLast ? 'is-final' : ''}" onclick="App.flipTopPackCard()">
          <div class="pack-flip-inner">
            <div class="pack-flip-back">${logoUrl() ? `<img src="${esc(logoUrl())}" alt="">` : '✦'}</div>
            <div class="pack-flip-front rar-${esc(card.rarity)} ${card.shiny && anim.flipped ? 'shiny' : ''}">
              ${card.shiny && anim.flipped ? `${shinyFx()}<span class="shiny-label">✨ Brillante !</span>` : ''}
              ${cardArt(card)}
              <div class="pack-type-tag">${esc(cardTypeLabel(card.type))}</div>
              <div class="card-name">${esc(card.name)}</div>
              ${handStatLine(card, 14)}
              ${cardTextHTML(card, 'pack-card-desc')}
            </div>
          </div>
          ${fresh && anim.flipped && (card.rarity === 'epique' || card.rarity === 'legendaire') ? `<div class="pack-fx-burst ${esc(card.rarity)}"></div>` : ''}
        </div>
        ${anim.collected.length > 0 ? `<div class="pack-collected-row">
          ${anim.collected.map(c => `<div class="pack-collected-mini rar-${esc(c.rarity)}">${cardArt(c)}</div>`).join('')}
        </div>` : ''}
      </div>
      <p class="pack-theater-hint">${!anim.flipped ? 'Clique sur la carte pour la révéler.' : (anim.index + 1 >= total ? 'Clique pour voir le résumé.' : 'Clique pour passer à la carte suivante.')}</p>
    </div>
  </div>`;
}

/* Le fond sombre de l'ouverture n'apparaît en fondu qu'UNE fois, au début.
   Avant, chaque clic redessinait l'écran et rejouait ce fondu depuis
   l'opacité 0 : on voyait le menu réapparaître entre deux cartes. */
function packTheaterEnterClass() {
  if (!S.packTheaterAt) S.packTheaterAt = Date.now();
  return Date.now() - S.packTheaterAt < 250 ? 'enter' : '';
}

/* Pile de boosters de la page Boosters : le booster gratuit devant, et les
   boosters achetés (inventaire) rangés DERRIÈRE lui, décalés vers la droite,
   de plus en plus sombres. Chaque booster de la pile s'ouvre d'un clic ; au
   survol il sort légèrement de la pile et affiche le nom de son extension. */
const PACK_STACK_MAX = 4;
function packVisual(extensionId, label) {
  const img = extensionPackImage(extensionId);
  return img
    ? `<div class="pack-stack-visual img" style="background-image:url('${esc(img)}')"></div>`
    : `<div class="pack-stack-visual box"><span>CLEAN GANG DECKS</span>${label ? `<small>${esc(label)}</small>` : ''}</div>`;
}
function renderPackStack(ready) {
  const inv = S.profile.boosterInventory || [];
  const behind = inv.slice(0, PACK_STACK_MAX);
  const extra = inv.length - behind.length;
  const backs = behind.map((b, i) => `
    <button type="button" class="pack-stack-item back" style="--i:${i + 1}" onclick="App.openInventoryBooster('${esc(b.id)}')"
      title="${esc(b.extensionName || 'Booster')} — clique pour l'ouvrir" aria-label="Ouvrir le booster ${esc(b.extensionName || '')} de ta réserve">
      ${packVisual(b.extensionId, b.extensionName)}
      <span class="pack-stack-label">${esc(b.extensionName || 'Booster')}<b>Ouvrir</b></span>
    </button>`).reverse().join('');
  return `<div class="pack-stack-wrap">
    <div class="pack-stack" style="--n:${behind.length}">
      ${backs}
      <button type="button" class="pack-stack-item front ${ready ? 'ready' : 'locked'}" ${ready ? 'onclick="App.openPack(false)"' : 'disabled'}
        aria-label="${ready ? 'Ouvrir le booster gratuit' : 'Booster gratuit pas encore disponible'}">
        ${packVisual('base')}
      </button>
      ${extra > 0 ? `<span class="pack-stack-more" title="${extra} autre(s) booster(s) en réserve">+${extra}</span>` : ''}
    </div>
    ${inv.length ? `<div class="pack-stack-hint">${inv.length} booster${inv.length > 1 ? 's' : ''} en réserve derrière — clique dessus pour l'ouvrir</div>` : ''}
  </div>`;
}

function renderBoosters() {
  // Hors des phases plein écran, on réarme le fondu pour la prochaine ouverture
  if (!(S.packAnim === 'shaking' || S.packAnim === 'opening' || S.packAnim === 'presenting' || (S.packAnim && S.packAnim.phase === 'presenting'))) S.packTheaterAt = 0;
  const remaining = S.packStatus.remainingMs || 0;
  const ready = S.packStatus.ready;

  // Ouverture : le booster puis les cartes s'affichent en grand, au centre de
  // l'écran, sur un fond sombre qui recouvre toute l'interface.
  if (S.packAnim === 'shaking' || S.packAnim === 'opening') {
    const img = currentPackImage();
    const cls = S.packAnim === 'shaking' ? 'shaking' : 'pack-zoom-fade';
    return `<div class="pack-theater ${packTheaterEnterClass()}">
      <div class="pack-stage">${img
        ? `<div class="pack-box-img ${cls}" style="background-image:url('${esc(img)}')"></div>`
        : `<div class="pack-box ${cls}">CLEAN GANG DECKS</div>`}</div>
      <p class="pack-theater-hint">Le booster s'ouvre…</p>
    </div>`;
  }
  if (S.packAnim && S.packAnim.phase === 'presenting') {
    return renderPackPresentingStage();
  }
  if (S.packAnim && S.packAnim.phase === 'results') {
    const remaining = (S.profile.boosterInventory || []).length;
    return `<h1 class="page-title">${t('title.boosters', 'Boosters')}</h1>
    <div class="panel pack-results">
      <h3 style="text-align:center;margin-top:0;">Cartes obtenues</h3>
      <div class="pack-results-row">${S.lastDrawn.map(c => renderCardTile(c, { showDesc: false, shinyExact: true })).join('')}</div>
      ${remaining > 0 ? `<p class="page-sub" style="text-align:center;margin:14px 0 0;">Il te reste ${remaining} booster(s) en réserve.</p>` : ''}
      <div class="btn-row" style="justify-content:center;">
        ${remaining > 0 ? `<button class="btn" onclick="App.openInventoryBooster('${S.profile.boosterInventory[0].id}')">Ouvrir le suivant</button>` : ''}
        <button class="btn ghost" onclick="App.closePackReveal()">Fermer</button>
      </div>
    </div>`;
  }

  return `<h1 class="page-title">${t('title.boosters', 'Boosters')}</h1>
    <p class="page-sub">Un booster de 5 cartes toutes les 10 minutes. Taux de drop : commun 60%, rare 25%, épique 12%, légendaire 3%.</p>
    <div class="panel" style="text-align:center;">
      ${ready ? `<div style="font-size:15px;color:var(--good);font-weight:700;margin-bottom:10px;">Booster prêt !</div>` :
        `<div style="font-size:13px;color:var(--muted);margin-bottom:6px;">Prochain booster dans</div><div class="countdown" id="countdown">${fmtCountdown(remaining)}</div>`}
      ${renderPackStack(ready)}
      <div class="btn-row" style="justify-content:center;">
        <button class="btn" ${!ready ? 'disabled' : ''} onclick="App.openPack(false)">Ouvrir le booster (gratuit)</button>
        ${!ready ? `<button class="btn ghost" ${S.profile.credits < 50 ? 'disabled' : ''} onclick="App.openPack(true)">Débloquer maintenant — 50 🪙</button>` : ''}
      </div>
    </div>
    <h3 style="margin-top:26px;">Ton inventaire (${(S.profile.boosterInventory || []).length})</h3>
    <p class="page-sub">Les boosters achetés en boutique arrivent ici — ouvre-les quand tu veux.</p>
    ${(S.profile.boosterInventory || []).length === 0 ? '<div class="empty">Aucun booster en réserve — la boutique en propose plusieurs.</div>' :
      `<div class="booster-inventory-grid">${(S.profile.boosterInventory || []).map(b => `
        <div class="booster-inv-card">
          <div class="booster-inv-icon">${extensionPackImage(b.extensionId) ? `<img src="${esc(extensionPackImage(b.extensionId))}" alt="">` : '🎁'}</div>
          <div class="booster-inv-name">${esc(b.extensionName)}</div>
          <button class="btn small" onclick="App.openInventoryBooster('${b.id}')">Ouvrir</button>
        </div>`).join('')}</div>`}`;
}

function renderPoussiere() {
  const dups = S.duplicates || [];
  const total = dups.reduce((a, d) => a + d.excess * d.dustEach, 0);
  return `
    <h1 class="page-title">${t('title.poussiere', 'Désenchantement')}</h1>
    <p class="page-sub">${t('sub.poussiere', "Les exemplaires en trop (au-delà de la limite jouable) peuvent être transformés en poussière : commun 1, rare 2, épique 10, légendaire 250. La poussière sert à acheter des ornements dans la boutique.")}</p>
    <div class="panel">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;">
        <div><span class="dust-pill" style="font-size:15px;">✧ ${S.profile.dust} poussière</span></div>
        ${total > 0 ? `<button class="btn" onclick="App.disenchantAll()">Tout désenchanter (+${total} ✧)</button>` : ''}
      </div>
    </div>
    ${dups.length === 0 ? '<div class="empty">Aucun exemplaire en trop pour le moment.</div>' :
      dups.map(d => `
      <div class="row-card">
        <div class="info">
          <b>${esc(d.name)}</b> <span class="tag" style="color:${(RARITIES[d.rarity] || {}).color}">${(RARITIES[d.rarity] || {}).label}</span>
          <div style="color:var(--muted);font-size:12.5px;margin-top:4px;">${d.excess} exemplaire(s) en trop · ${d.dustEach} ✧ chacun</div>
        </div>
        <button class="btn small ghost" onclick="App.disenchant('${d.cardId}',1)">Désenchanter 1</button>
        <button class="btn small" onclick="App.disenchant('${d.cardId}',${d.excess})">Tout (+${d.excess * d.dustEach} ✧)</button>
      </div>`).join('')}
  `;
}

/* ---------- Chargements animés et fondu entre les pages ---------- */
/* Squelette gris animé à la place d'un « Chargement… » */
function skeletonRows(n) {
  return `<div class="skel-rows" aria-busy="true" aria-label="Chargement">${Array.from({ length: n || 3 }, (_, i) => `<div class="skel skel-line" style="width:${[92, 76, 84, 64, 88][i % 5]}%"></div>`).join('')}</div>`;
}
function skeletonPage(title, kind) {
  const grid = `<div class="skel-grid">${Array.from({ length: 8 }, () => '<div class="skel skel-card"></div>').join('')}</div>`;
  return `${title ? `<h1 class="page-title">${esc(title)}</h1>` : ''}
    <div class="panel skel-panel" aria-busy="true" aria-label="Chargement"><div class="skel skel-title"></div>${skeletonRows(3)}</div>
    ${kind === 'grid' ? grid : `<div class="panel skel-panel">${skeletonRows(4)}</div>`}`;
}
/* Fondu à l'arrivée sur une nouvelle page. La page est redessinée plusieurs fois
   pendant le chargement : on reprend l'animation là où elle en était (délai
   négatif) pour qu'elle ne reparte pas de zéro à chaque fois. */
const PAGE_FADE_MS = 220;
function pageFadeAttr() {
  const key = S.tab + '|' + (S.adminTab || '') + '|' + (S.profileTab || '');
  if (key !== S.__fadeKey) { S.__fadeKey = key; S.__fadeAt = Date.now(); }
  const el = Date.now() - (S.__fadeAt || 0);
  return el < PAGE_FADE_MS ? ` class="page-fade" style="animation-delay:-${el}ms"` : '';
}

/* ---------- Vitrine du jour ---------- */
function loadDaily() {
  api('/api/shop/daily').then(r => { S.daily = r; if (S.tab === 'boutique') render(); }).catch(() => {});
}
function fmtLongCountdown(ms) {
  if (ms <= 0) return '0 s';
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60;
  if (h >= 48) return `${Math.floor(h / 24)} j ${h % 24} h`;
  return h ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min ${String(sec).padStart(2, '0')} s`;
}
function renderDailyShowcase() {
  const d = S.daily;
  if (!d) return `<div class="daily-show loading">${skeletonRows(2)}</div>`;
  if (!d.slots.length) return '';
  const wallet = { credits: (S.shop && S.shop.credits) || 0, dust: (S.shop && S.shop.dust) || 0 };
  const boosters = (S.shop && S.shop.boosters) || [];
  const item = s => {
    let visual = '';
    if (s.slot === 'booster') {
      const b = boosters.find(x => x.id === s.id) || {};
      const img = b.packImage || b.backImage;
      visual = `<div class="ds-pack">${img ? `<img src="${esc(img)}" alt="">` : '<span>✦</span>'}</div>`;
    } else if (s.slot === 'banner') visual = `<div class="ds-banner" style="--banner:${esc(s.bg)}"></div>`;
    else visual = `<div class="ds-emote">« ${esc(s.name)} »</div>`;
    const kind = { booster: 'Booster', banner: 'Bannière', emote: 'Provocation' }[s.slot];
    const sym = s.currency === 'credits' ? '🪙' : '✧';
    const done = s.bought || s.owned;
    const btn = done ? `<span class="ds-done">${s.bought ? '✔ Acheté' : '✔ Déjà possédé'}</span>`
      : `<button class="btn small" ${wallet[s.currency] < s.price ? 'disabled' : ''} onclick="App.buyDaily('${s.slot}','${esc(s.id)}')">${sym} ${s.price}</button>`;
    return `<div class="ds-item ${done ? 'done' : ''}">
      <span class="ds-kind">${kind}</span>${visual}
      ${s.slot === 'emote' ? '' : `<div class="ds-name">${esc(s.name)}</div>`}
      <div class="ds-price"><s>${sym} ${s.basePrice}</s> <b>-${Math.round(d.discount * 100)} %</b></div>
      ${btn}</div>`;
  };
  return `<div class="daily-show">
    <div class="ds-head"><h3>✨ Vitrine du jour</h3>
      <span class="ds-timer">Renouvellement dans <b class="js-countdown" data-ends="${d.endsAt}">${fmtLongCountdown(d.endsAt - Date.now())}</b></span></div>
    <div class="ds-row">${d.slots.map(item).join('')}</div></div>`;
}
/* Met à jour tous les minuteurs affichés ; recharge la vitrine quand elle expire */
if (typeof window !== 'undefined') setInterval(() => {
  document.querySelectorAll('.js-countdown').forEach(el => {
    const left = Number(el.dataset.ends) - Date.now();
    el.textContent = fmtLongCountdown(left);
    if (left <= 0 && !el.dataset.reloading) { el.dataset.reloading = '1'; if (el.closest('.br-rule')) loadBrawl(); else loadDaily(); }
  });
}, 1000);

function renderBoutique() {
  if (!S.shop) return skeletonPage(t('title.boutique', 'Boutique'), 'grid');
  const { ornaments, owned, equipped, dust, credits, emotes, ownedEmotes, boosters } = S.shop;
  const tab = S.shopTab || 'ornaments';
  const header = `
    <h1 class="page-title">${t('title.boutique', 'Boutique')}</h1>
    <p class="page-sub">${t('sub.boutique', "Personnalise ton avatar, tes provocations, et achète des boosters supplémentaires.")}</p>
    <div class="panel" style="display:flex;gap:12px;flex-wrap:wrap;">
      <span class="credits-pill" style="margin-top:0;">🪙 <span data-count="credits" data-val="${credits}">${credits}</span> crédits</span>
      <span class="dust-pill" style="margin-top:0;">✧ <span data-count="dust" data-val="${dust}">${dust}</span> poussière</span>
    </div>
    ${renderDailyShowcase()}
    <div class="shop-tabs" style="max-width:560px;flex-wrap:wrap;">
      <div class="shop-tab ${tab === 'ornaments' ? 'active' : ''}" onclick="App.setShopTab('ornaments')">Ornements</div>
      <div class="shop-tab ${tab === 'emotes' ? 'active' : ''}" onclick="App.setShopTab('emotes')">Provocations</div>
      <div class="shop-tab ${tab === 'boosters' ? 'active' : ''}" onclick="App.setShopTab('boosters')">Boosters</div>
      <div class="shop-tab ${tab === 'banners' ? 'active' : ''}" onclick="App.setShopTab('banners')">Bannières</div>
      <div class="shop-tab ${tab === 'creditpacks' ? 'active' : ''}" onclick="App.setShopTab('creditpacks')">Crédits</div>
    </div>`;

  if (tab === 'banners') {
    const owned = S.profile.ownedBanners || [];
    const forSale = (S.bannerCatalog || []).filter(b => b.source === 'shop');
    return header + `<p class="page-sub">Un fond décoratif pour ta fiche joueur, visible par tous. D'autres bannières se gagnent en tournoi, avec les succès secrets et l'objectif communautaire.</p>
      ${!S.bannerCatalog ? skeletonRows(2) : `<div class="banner-grid shop">${forSale.map(b => {
        const has = owned.includes(b.id);
        return `<div class="banner-tile shop-item" style="--banner:${esc(b.bg)}"><span>${esc(b.name)}</span>
          ${has ? `<small>${S.profile.banner === b.id ? 'Équipée' : 'Possédée'}</small>${S.profile.banner === b.id ? '' : `<button class="btn small" onclick="App.setBanner('${esc(b.id)}')">Équiper</button>`}`
            : `<button class="btn small" ${credits < b.price ? 'disabled' : ''} onclick="App.buyBanner('${esc(b.id)}')">${b.price} 🪙</button>`}</div>`;
      }).join('')}</div>`}`;
  }

  if (tab === 'creditpacks') {
    const packs = S.creditPacks || [];
    return header + `
      <p class="page-sub">Échange de la poussière contre des crédits.</p>
      ${packs.length === 0 ? '<div class="empty">Aucun pack de crédits disponible pour le moment.</div>' : `
      <div class="shop-grid">
        ${packs.map(p => `
          <div class="shop-item">
            <div style="font-size:32px;margin-bottom:8px;">🪙</div>
            <div class="shop-name">${esc(p.name)}</div>
            <div class="shop-desc">${p.creditsAmount} crédits</div>
            <div class="btn-row" style="margin-top:8px;justify-content:center;">
              <button class="btn small" ${dust < p.dustPrice ? 'disabled' : ''} onclick="App.buyCreditPack('${p.id}')">✧ ${p.dustPrice}</button>
            </div>
          </div>`).join('')}
      </div>`}`;
  }

  if (tab === 'boosters') {
    return header + `
      <p class="page-sub">Chaque extension a son propre booster de 5 cartes, achetable en crédits et/ou en poussière selon ce que l'admin a configuré.</p>
      <div class="shop-grid">
        ${(boosters || []).map(b => `
          <div class="shop-item">
            <div style="width:70px;height:98px;border-radius:8px;overflow:hidden;margin:0 auto 12px;background:linear-gradient(150deg,var(--accent),var(--accent-dim));display:flex;align-items:center;justify-content:center;">
              ${b.packImage ? `<img src="${esc(b.packImage)}" style="width:100%;height:100%;object-fit:contain;">`
                : b.backImage ? `<img src="${esc(b.backImage)}" style="width:100%;height:100%;object-fit:cover;">`
                : '<span style="color:#fff;font-size:22px;">✦</span>'}
            </div>
            <div class="shop-name">${esc(b.name)}</div>
            <div class="shop-desc">${esc(b.description || '')} ${b.cardCount === 0 ? '<br><span style="color:var(--bad);">Aucune carte pour le moment</span>' : ''}</div>
            <div style="display:flex;align-items:center;justify-content:center;gap:8px;margin:8px 0;">
              <label style="font-size:11.5px;color:var(--muted);">Quantité</label>
              <input type="number" id="booster-qty-${b.id}" min="1" max="20" value="1" style="width:60px;text-align:center;padding:4px;">
            </div>
            <div class="btn-row" style="margin-top:0;justify-content:center;">
              ${b.creditPrice != null ? `<button class="btn small" ${(b.cardCount === 0) ? 'disabled' : ''} onclick="App.buyBooster('${b.id}','credits')">🪙 ${b.creditPrice} / unité</button>` : ''}
              ${b.dustPrice != null ? `<button class="btn small ghost" ${(b.cardCount === 0) ? 'disabled' : ''} onclick="App.buyBooster('${b.id}','dust')">✧ ${b.dustPrice} / unité</button>` : ''}
              ${b.creditPrice == null && b.dustPrice == null ? '<span class="tone-tag">Non vendu pour le moment</span>' : ''}
            </div>
          </div>`).join('')}
      </div>`;
  }

  if (tab === 'emotes') {
    return header + `
      <p class="page-sub">Les provocations s'affichent en direct chez ton adversaire pendant le combat. Compose ta roue de 6 depuis ton profil (onglet Collection).</p>
      <div class="shop-grid">
        ${emotes.map(e => {
          const isOwned = ownedEmotes.includes(e.id);
          const inWheel = (S.profile.emoteWheel || []).includes(e.id);
          return `<div class="emote-card ${isOwned ? 'owned' : ''}">
            <div class="emote-text">${esc(e.text)}</div>
            <div class="tone-tag">${esc(e.tone)}${inWheel ? ' · dans ta roue' : ''}</div>
            ${isOwned ? '<button class="btn small ghost" disabled>Débloquée</button>'
              : `<div><div class="shop-price">✧ ${e.price}</div>
                 <button class="btn small" ${dust < e.price ? 'disabled' : ''} onclick="App.buyEmote('${e.id}')">Acheter</button></div>`}
          </div>`;
        }).join('')}
      </div>`;
  }

  return header + `
    <div class="shop-grid">
      ${ornaments.filter(o => !(o.tournamentOnly || o.levelOnly) || owned.includes(o.id)).map(o => {
        const isOwned = owned.includes(o.id);
        const isEquipped = equipped === o.id;
        return `<div class="shop-item ${isEquipped ? 'equipped' : ''}">
          ${avatarHtml(S.profile.pseudo, S.profile.avatar, o.id)}
          <div class="shop-name">${esc(o.name)}</div>
          <div class="shop-desc">${esc(o.desc)}</div>
          ${o.levelOnly ? '<div class="shop-price">🆙 Récompense de niveau</div>' : o.tournamentOnly ? '<div class="shop-price">🏆 Récompense de tournoi</div>' : o.price > 0 ? `<div class="shop-price">✧ ${o.price}</div>` : '<div class="shop-price">Gratuit</div>'}
          ${isEquipped ? '<button class="btn small ghost" disabled>Équipé</button>' :
            isOwned ? `<button class="btn small" onclick="App.equipOrnament('${o.id}')">Équiper</button>` :
            `<button class="btn small" ${dust < o.price ? 'disabled' : ''} onclick="App.buyOrnament('${o.id}')">Acheter</button>`}
        </div>`;
      }).join('')}
    </div>`;
}

/* ---------- Frise des rangs ----------
   Tous les rangs de Bronze à Maître sur une ligne : ceux déjà atteints, le rang
   actuel (avec la position exacte du joueur dans ce rang) et ceux à venir, avec
   le nombre de victoires qu'il reste pour chacun. */
function renderRankTimeline(vp) {
  const ranks = (S.config && S.config.ranks) || [];
  const rs = (S.config && S.config.ranking) || { vpWin: 25 };
  if (!ranks.length) return '';
  const cur = ranks.reduce((acc, r, i) => vp >= r.min ? i : acc, 0);
  const nextR = ranks[cur + 1];
  const winsFor = target => Math.max(0, Math.ceil((target - vp) / (rs.vpWin || 25)));
  // Position du marqueur : chaque rang occupe une part égale de la frise
  const seg = 100 / (ranks.length - 1);
  const within = nextR ? Math.min(1, (vp - ranks[cur].min) / (nextR.min - ranks[cur].min)) : 0;
  const pos = Math.min(100, cur * seg + within * seg);
  return `<div class="rank-timeline" role="img" aria-label="Rang actuel : ${esc(ranks[cur].label)}, ${vp} points">
    <div class="rt-track"><div class="rt-fill" style="width:${pos.toFixed(1)}%"></div>
      <div class="rt-you" style="left:${pos.toFixed(1)}%"><span>${vp} pts</span></div>
    </div>
    <div class="rt-nodes">${ranks.map((r, i) => {
      const state = i < cur ? 'done' : i === cur ? 'current' : 'next';
      const w = winsFor(r.min);
      return `<div class="rt-node ${state}" style="--rc:${r.color};left:${(i * seg).toFixed(1)}%">
        <span class="rt-dot">${i < cur ? '✓' : i === cur ? '★' : ''}</span>
        <b>${esc(r.label)}</b>
        <small>${i === 0 ? 'départ' : `${r.min} pts`}</small>
        ${state === 'next' ? `<em>${w} victoire${w > 1 ? 's' : ''}</em>` : state === 'current' ? '<em class="cur">ton rang</em>' : ''}
      </div>`;
    }).join('')}</div>
    <p class="rt-hint">${nextR ? `Encore <b>${nextR.min - vp} points</b> avant <b>${esc(nextR.label)}</b>, soit environ <b>${winsFor(nextR.min)} victoire${winsFor(nextR.min) > 1 ? 's' : ''}</b>. Une défaite jouée rapporte aussi ${rs.vpLoss || 0} points, et ta première victoire du jour compte double.` : 'Tu as atteint le rang maximum : défends ta place au classement !'}</p>
  </div>`;
}

function renderClassement() {
  if (!S.leaderboard) return skeletonPage('Classement');
  const { season, leaderboard, myPosition, rewards, history } = S.leaderboard;
  return `
    <h1 class="page-title">${t('title.classement', 'Classement mensuel')} — saison ${esc(season)}</h1>
    ${(() => { const rs = (S.config && S.config.ranking) || {}; const rr = rs.rankRewards || {}; return `<p class="page-sub">Une victoire rapporte <b>${rs.vpWin} points</b> (<b>×${rs.firstWinMultiplier}</b> pour ta première victoire du jour), avec <b>+${rs.streakBonus}</b> à partir de ${rs.streakFrom} victoires de suite. Une défaite jouée jusqu'au bout (au moins ${rs.minLossTurns} tours) rapporte <b>${rs.vpLoss} points</b>. En fin de mois : ${rr.argent || 0} ✧ pour Argent, ${rr.or || 0} ✧ pour Or, ${rr.diamant || 0} ✧ pour Diamant, ${rr.maitre || 0} ✧ pour Maître, et ${rewards[0]} / ${rewards[1]} / ${rewards[2]} ✧ pour le podium. ${rs.softReset !== false ? 'Au nouveau mois, tu repars au début du rang en dessous.' : 'Le classement repart à zéro chaque mois.'}</p>`; })()}
    <div class="panel">${renderRankTimeline(S.profile.seasonVP || 0)}${myPosition ? `<p class="rt-pos">Tu es actuellement <b>${myPosition}e</b> du classement.</p>` : ''}</div>
    ${leaderboard.length === 0 ? '<div class="empty">Aucune partie jouée cette saison.</div>' :
      leaderboard.map((e, i) => `
      <div class="lb-row ${e.slug === S.profile.slug ? 'me' : ''} p${i + 1}">
        <div class="lb-pos">${i + 1}</div>
        ${avatarHtml(e.pseudo, e.avatar, e.ornament, 'sm')}
        <div class="lb-name">${esc(e.pseudo)} ${rankPill(e.rank)}${titleLine(e.title)}</div>
        <div style="color:var(--muted);font-size:12.5px;">${e.wins}V / ${e.losses}D</div>
        <div class="lb-vp">${e.vp} pts</div>
        ${i < rewards.length ? `<span class="lb-reward">+${rewards[i]} ✧ en fin de mois</span>` : ''}
      </div>`).join('')}
    ${history && history.length ? `
      <h3 style="margin-top:26px;">Saisons précédentes</h3>
      ${history.map(h => `<div class="panel"><b>${esc(h.season)}</b><br>${h.podium.map(p => `${p.position}. ${esc(p.pseudo)} — ${p.vp} pts (+${p.reward} ✧)`).join('<br>') || 'Aucun podium.'}</div>`).join('')}
    ` : ''}
  `;
}

/* Filtres du constructeur de deck : rareté (onglets), type et tri par coût */
const DECK_SORTS = { cost: 'Coût croissant', costDesc: 'Coût décroissant', name: 'Nom', rarity: 'Rareté' };
const RARITY_ORDER = ['commun', 'rare', 'epique', 'legendaire'];
function sortCardsForDeck(list, key, get) {
  const g = get || (x => x);
  const byName = (a, b) => String(g(a).name).localeCompare(String(g(b).name), 'fr');
  const cost = x => Number(g(x).cost) || 0;
  const rar = x => RARITY_ORDER.indexOf(g(x).rarity);
  const cmp = {
    cost: (a, b) => cost(a) - cost(b) || byName(a, b),
    costDesc: (a, b) => cost(b) - cost(a) || byName(a, b),
    name: byName,
    rarity: (a, b) => rar(b) - rar(a) || cost(a) - cost(b) || byName(a, b)
  }[key] || ((a, b) => cost(a) - cost(b) || byName(a, b));
  return list.slice().sort(cmp);
}
function renderManaCurve(draftCards) {
  const buckets = [0, 1, 2, 3, 4, 5, 6, 7].map(i => draftCards.filter(c => i === 7 ? (Number(c.cost) || 0) >= 7 : (Number(c.cost) || 0) === i).length);
  const max = Math.max(1, ...buckets);
  return `<div class="mana-curve" aria-label="Courbe de mana du deck">${buckets.map((n, i) => `
    <div class="mc-col" title="${n} carte${n > 1 ? 's' : ''} à ${i === 7 ? '7 mana ou plus' : i + ' mana'}">
      <span class="mc-n">${n || ''}</span><div class="mc-bar" style="height:${(n / max * 100).toFixed(0)}%"></div><span class="mc-cost">${i === 7 ? '7+' : i}</span>
    </div>`).join('')}</div>`;
}
/* Onglet Wiki : le guide du joueur (public/wiki/) affiché dans le jeu.
   L'interface est entièrement redessinée à chaque mise à jour (ami qui se
   connecte, notification…) : une iframe placée dans la page serait rechargée
   à chaque fois et le lecteur perdrait sa place. Le guide vit donc dans une
   iframe à part, créée une seule fois, posée par-dessus l'emplacement prévu. */
function renderWiki() {
  return `<div class="wiki-page">
    <div class="wiki-bar">
      <h1 class="page-title" style="margin:0;">${t('nav.wiki', 'Wiki')}</h1>
      <a class="btn ghost small" href="/wiki/" target="_blank" rel="noopener">Ouvrir dans un nouvel onglet</a>
    </div>
    <div id="wiki-slot" class="wiki-frame"></div>
  </div>`;
}
function syncWikiFrame() {
  if (typeof document === 'undefined') return;
  const slot = document.getElementById('wiki-slot');
  let host = document.getElementById('wiki-host');
  if (!slot) { if (host) host.style.display = 'none'; return; }
  if (!host) {
    host = document.createElement('iframe');
    host.id = 'wiki-host';
    host.src = '/wiki/?embed=1';
    host.title = 'Guide du joueur Clean Gang Decks';
    document.body.appendChild(host);
  }
  const r = slot.getBoundingClientRect();
  Object.assign(host.style, { display: 'block', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
}
if (typeof window !== 'undefined') {
  window.addEventListener('resize', () => syncWikiFrame());
  window.addEventListener('scroll', () => syncWikiFrame(), true);
}


/* ---------- Collection → Stats du deck ----------
   Analyse du deck en cours (composition, conseils, suggestions de cartes) et
   bilan des combats joués avec lui (entraînements compris). */
const REPORT_MODES = { practice: 'Entraînement', pvp: 'Joueur contre joueur', bot: 'Bot', boss: 'Boss' };
const ROLE_LABELS = [['minions', 'Serviteurs'], ['spells', 'Sorts'], ['weapons', 'Armes'], ['early', 'Cartes à 2 mana ou moins'],
  ['removal', 'Élimination'], ['draw', 'Pioche'], ['taunt', 'Provocation'], ['sustain', 'Soin et armure'], ['buffs', 'Bonus'], ['charge', 'Charge']];
function cardChip(id) {
  const c = cardById(id);
  if (!c) return `<span class="chip-card">Carte supprimée</span>`;
  const rc = (RARITIES[c.rarity] || {}).color || 'var(--muted)';
  return `<button type="button" class="chip-card" style="--rc:${rc}" onclick="App.open3DView('${esc(c.id)}')" title="Voir la carte"><span class="chip-cost">${c.cost}</span>${esc(c.name)}</button>`;
}
function renderDeckStats() {
  const st = S.deckStats;
  const draft = S.deckDraft || [];
  const head = `<h1 class="page-title">Stats du deck</h1>
    <p class="page-sub">L'analyse porte sur ton deck en cours dans l'onglet Deck (${draft.length}/${DECK_SIZE} cartes). Chaque combat joué avec un deck, entraînements compris, ajoute un bilan ci-dessous.</p>`;
  if (!st) return head + '<div class="panel"><div class="empty">Analyse en cours…</div></div>';
  if (st.error) return head + `<div class="panel"><div class="empty">${esc(st.error)}</div></div>`;
  const a = st.analysis, r = a.roles;
  const icon = { warn: '⚠️', info: '💡', good: '✅' };
  const sugg = st.suggestions || [];
  const agg = st.aggregate || { games: 0, perCard: {}, stuck: {} };
  const best = Object.keys(agg.perCard).map(id => Object.assign({ id }, agg.perCard[id])).filter(x => cardById(x.id))
    .sort((x, y) => (y.damage + y.kills * 3 + y.heal) - (x.damage + x.kills * 3 + x.heal)).slice(0, 5);
  const stuck = Object.keys(agg.stuck).map(id => ({ id, n: agg.stuck[id] })).filter(x => cardById(x.id)).sort((x, y) => y.n - x.n).slice(0, 5);
  const reports = st.reports || [];
  return head + `
    <div class="ds-grid">
      <div class="panel">
        <h3 style="margin-top:0;">Composition</h3>
        <div class="stat-kpis ds-kpis">
          <div class="stat-kpi"><b>${a.size}</b><span>cartes</span></div>
          <div class="stat-kpi"><b>${a.avgCost}</b><span>coût moyen</span></div>
          <div class="stat-kpi"><b>${r.minions}/${r.spells}/${r.weapons}</b><span>serv. / sorts / armes</span></div>
        </div>
        ${draft.length ? renderManaCurve(draft.map(id => cardById(id)).filter(Boolean)) : ''}
        <div class="ds-roles">${ROLE_LABELS.filter(([k]) => k !== 'minions' && k !== 'spells' && k !== 'weapons').map(([k, l]) => `<span class="ds-role ${r[k] ? '' : 'zero'}"><b>${r[k]}</b> ${l}</span>`).join('')}</div>
      </div>
      <div class="panel">
        <h3 style="margin-top:0;">Conseils</h3>
        <ul class="ds-tips">${a.tips.map(x => `<li class="${x.level}"><span>${icon[x.level] || '•'}</span>${esc(x.text)}</li>`).join('')}</ul>
      </div>
    </div>
    ${renderStrategyPanel(draft.map(id => cardById(id)).filter(Boolean))}

    <div class="panel">
      <h3 style="margin-top:0;">Suggestions de cartes</h3>
      <p class="page-sub" style="margin:0 0 12px;">Des cartes qui comblent les manques de ton deck ou renforcent ce qu'il fait déjà. Celles de ta collection s'ajoutent d'un clic au deck en cours.</p>
      ${sugg.length === 0 ? '<div class="empty">Rien à suggérer : ton deck couvre déjà l\'essentiel.</div>' : `<div class="ds-sugg">${sugg.map(x => {
        const c = cardById(x.cardId); if (!c) return '';
        return `<div class="ds-sugg-item">
          ${renderCardTile(c, {})}
          <p class="ds-why">${esc(x.reason)}</p>
          ${x.owned ? `<button class="btn small" onclick="App.addSuggested('${esc(c.id)}')">Ajouter au deck</button>` : '<span class="tone-tag">À obtenir dans les boosters</span>'}
        </div>`;
      }).join('')}</div>`}
    </div>

    <div class="panel">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;">
        <h3 style="margin:0;">Bilan des combats</h3>
        <button class="btn practice-btn" ${draft.length !== DECK_SIZE ? 'disabled' : ''} onclick="App.startPractice()">🤖 S'entraîner avec ce deck</button>
      </div>
      ${agg.games ? `<p class="page-sub" style="margin:10px 0;">${st.aggregateScope === 'deck' ? `${agg.games} combat(s) avec exactement ce deck` : `Aucun combat avec exactement ce deck : bilan de tes ${agg.games} derniers combats, tous decks confondus`}.</p>
        <div class="stat-kpis ds-kpis">
          <div class="stat-kpi"><b>${agg.winRate}%</b><span>de victoires (${agg.wins}/${agg.games})</span></div>
          <div class="stat-kpi ${agg.efficiency < 60 ? 'warn' : ''}"><b>${agg.efficiency}%</b><span>de ta mana utilisée</span></div>
        </div>
        ${agg.efficiency && agg.efficiency < 60 ? '<p class="ds-note">💡 Tu laisses beaucoup de mana inutilisée : ajoute des cartes moins chères ou mieux réparties sur la courbe.</p>' : ''}
        <div class="ds-grid">
          <div><h4>Les plus efficaces</h4>${best.length ? `<ul class="ds-list">${best.map(x => `<li>${cardChip(x.id)}<span>${x.damage} dégâts · ${x.kills} élim.${x.heal ? ` · ${x.heal} soin` : ''} · jouée ${x.played}×</span></li>`).join('')}</ul>` : '<div class="empty">Pas encore de données.</div>'}</div>
          <div><h4>Restent souvent en main</h4>${stuck.length ? `<ul class="ds-list">${stuck.map(x => `<li>${cardChip(x.id)}<span>en main en fin de combat ${x.n}×</span></li>`).join('')}</ul><p class="ds-note">Une carte qui reste en main est souvent trop chère ou mal adaptée : pense à la remplacer.</p>` : '<div class="empty">Aucune carte coincée en main.</div>'}</div>
        </div>` : '<div class="empty" style="margin-top:12px;">Aucun combat pour l\'instant. Lance un entraînement pour obtenir ton premier bilan.</div>'}
      ${reports.length ? `<h4>Derniers combats</h4><div class="ds-reports">${reports.slice(0, 10).map(rep => {
        const open = S.openReport === rep.id;
        const cards = Object.keys(rep.perCard || {}).map(id => Object.assign({ id }, rep.perCard[id])).filter(x => cardById(x.id)).sort((x, y) => y.damage - x.damage);
        return `<div class="ds-report ${rep.result} ${open ? 'open' : ''}">
          <button class="ds-report-head" onclick="App.openDeckReport('${esc(rep.id)}')" aria-expanded="${open}">
            <span class="ds-res">${rep.result === 'win' ? 'Victoire' : rep.result === 'loss' ? 'Défaite' : 'Égalité'}</span>
            <span>${esc(REPORT_MODES[rep.mode] || rep.mode)} · contre ${esc(rep.opponent || '?')}</span>
            <span class="ds-meta">${rep.turns} tours · mana ${rep.efficiency}% · ${rep.cardsPlayed} cartes jouées · ${rep.damageDealt} dégâts</span>
            <span class="ds-date">${new Date(rep.at).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
          </button>
          ${open ? `<div class="ds-report-body">
            <div class="stat-table-wrap"><table class="stat-table"><thead><tr><th>Carte</th><th class="n">Jouée</th><th class="n">Dégâts</th><th class="n">Éliminations</th><th class="n">Soins</th><th class="n">Pioche</th><th class="n">Morts</th></tr></thead>
            <tbody>${cards.length ? cards.map(x => `<tr><td>${cardChip(x.id)}</td><td class="n">${x.played}</td><td class="n">${x.damage}</td><td class="n">${x.kills}</td><td class="n">${x.heal}</td><td class="n">${x.drawn}</td><td class="n">${x.died}</td></tr>`).join('') : '<tr><td colspan="7" class="muted">Aucune carte jouée.</td></tr>'}</tbody></table></div>
            ${(rep.leftInHand || []).length ? `<p class="ds-note">Restées en main : ${rep.leftInHand.map(cardChip).join(' ')}</p>` : ''}
            <p class="ds-note">PV restants : toi ${rep.heroHealth}, adversaire ${rep.opponentHealth}. Mana utilisée : ${rep.manaSpent} sur ${rep.manaAvailable}.</p>
          </div>` : ''}
        </div>`;
      }).join('')}</div>` : ''}
    </div>`;
}

function normSearch(v) { return String(v || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim(); }


/* ======================================================
   TOURNOI (onglet joueur + admin)
   ====================================================== */
function loadTournament() {
  return api('/api/tournament').then(d => {
    S.tournament = d;
    // Notification : ton match de tournoi peut commencer (adversaire connu, ou déjà prêt)
    const tm = d.me && d.me.match;
    if (tm && tm.a && tm.b && !(tm.ready || {})[S.profile.slug]) {
      const oppSlug = tm.a === S.profile.slug ? tm.b : tm.a;
      const oppReady = !!(tm.ready || {})[oppSlug];
      notify('Ton match de tournoi est prêt', oppReady ? 'Ton adversaire est prêt : clique sur « Je suis prêt » !' : 'Ton adversaire est connu : prépare-toi !', 'tour-' + tm.id + (oppReady ? '-r' : ''));
    }
    // le contour en jeu doit être connu pour l'afficher (même s'il vient d'être créé)
    const add = o => { if (o && S.config && Array.isArray(S.config.ornaments) && !S.config.ornaments.some(x => x.id === o.id)) S.config.ornaments.push(o); };
    if (d.current) add(d.current.rewardOrnament);
    (d.history || []).forEach(h => add(h.rewardOrnament));
    render();
  }).catch(() => {});
}
function roundName(r, total) {
  const left = total - r;
  return left === 1 ? 'Finale' : left === 2 ? 'Demi-finales' : left === 3 ? 'Quarts de finale' : left === 4 ? 'Huitièmes de finale' : `Tour ${r + 1}`;
}
function tPlayer(t, slug) { return (t.players || []).find(p => p.slug === slug) || { slug, pseudo: slug || '?' }; }
function renderBracket(t, admin) {
  if (!t.rounds || !t.rounds.length) return '';
  return `<div class="bracket" role="list" aria-label="Arbre du tournoi">${t.rounds.map((round, r) => `
    <div class="br-round" role="listitem">
      <div class="br-title">${roundName(r, t.rounds.length)}</div>
      <div class="br-matches">${round.map(m => {
        const side = slug => {
          if (!slug) return `<div class="br-p empty">${m.bye && r === 0 ? 'Exempt' : 'À déterminer'}</div>`;
          const p = tPlayer(t, slug);
          const ready = m.ready && m.ready[slug] && !m.winner;
          return `<div class="br-p ${m.winner === slug ? 'win' : m.winner ? 'lose' : ''} ${slug === S.profile.slug ? 'me' : ''}">
            ${avatarHtml(p.pseudo, p.avatar, p.ornament, 'xs')}<span>${esc(p.pseudo)}</span>${ready ? '<em class="br-ready">prêt</em>' : ''}${m.winner === slug ? '<b>✓</b>' : ''}
            ${admin && !m.winner && m.a && m.b ? `<button class="btn small ghost" onclick="App.adminTournamentWinner('${esc(m.id)}','${esc(slug)}')">Vainqueur</button>` : ''}
          </div>`;
        };
        const st = m.status === 'playing' ? '<span class="br-status live">En combat</span>' : '';
        return `<div class="br-match ${m.status}">${st}${side(m.a)}${side(m.b)}</div>`;
      }).join('')}</div>
    </div>`).join('')}</div>`;
}
function renderTournoi() {
  const d = S.tournament;
  if (!d) return skeletonPage('Tournoi');
  const t = d.current;
  const head = '<h1 class="page-title">Tournoi</h1>';
  if (!t) return head + `<div class="panel"><div class="empty">Aucun tournoi pour le moment. Reviens bientôt !</div></div>${renderTournamentHistory(d)}`;
  const orn = t.rewardOrnament;
  const statusLabel = { registration: 'Inscriptions ouvertes', running: 'En cours', finished: 'Terminé', cancelled: 'Annulé' }[t.status];
  const me = d.me || {};
  const mm2 = me.match;
  let myPanel = '';
  if (t.status === 'registration') {
    myPanel = `<div class="panel t-cta">
      <div><b>${t.players.length}</b> inscrit${t.players.length > 1 ? 's' : ''} · il faut au moins ${d.minPlayers} joueurs. L'admin lance le tournoi quand tout le monde est prêt.</div>
      ${me.registered ? `<button class="btn ghost" onclick="App.tournamentUnregister()">Me désinscrire</button>` : `<button class="btn" onclick="App.tournamentRegister()">S'inscrire au tournoi</button>`}
    </div>`;
  } else if (t.status === 'running' && mm2) {
    const oppSlug = mm2.a === S.profile.slug ? mm2.b : mm2.a;
    const opp = oppSlug ? tPlayer(t, oppSlug) : null;
    const iReady = !!(mm2.ready && mm2.ready[S.profile.slug]);
    const oppReady = !!(opp && mm2.ready && mm2.ready[oppSlug]);
    myPanel = `<div class="panel t-cta mine">
      <div class="t-vs">
        <div>${avatarHtml(S.profile.pseudo, S.profile.avatar, S.profile.ornament, 'sm')}<b>Toi</b><span class="t-state ${iReady ? 'ok' : ''}">${iReady ? 'Prêt ✓' : 'Pas prêt'}</span></div>
        <span class="t-versus">VS</span>
        <div>${opp ? `${avatarHtml(opp.pseudo, opp.avatar, opp.ornament, 'sm')}<b>${esc(opp.pseudo)}</b><span class="t-state ${oppReady ? 'ok' : ''}">${oppReady ? 'Prêt ✓' : opp.online ? 'Pas prêt' : 'Hors ligne'}</span>` : '<b>Adversaire à déterminer</b><span class="t-state">en attente du match précédent</span>'}</div>
      </div>
      <p class="page-sub" style="margin:8px 0;">${roundName(mm2.round, t.rounds.length)} — le combat se lance automatiquement quand vous êtes prêts tous les deux, avec ton deck actif.</p>
      ${opp ? (iReady ? `<button class="btn ghost" onclick="App.tournamentReady(false)">Annuler « prêt »</button>` : `<button class="btn t-ready" onclick="App.tournamentReady(true)">✋ Je suis prêt</button>`) : ''}
    </div>`;
  } else if (t.status === 'running' && me.registered) {
    myPanel = '<div class="panel t-cta"><div>Tu as été éliminé. Merci d\'avoir participé ! Suis la suite dans l\'arbre ci-dessous.</div></div>';
  }
  const champ = t.status === 'finished' && t.champion ? tPlayer(t, t.champion) : null;
  return head + `
    <div class="panel t-hero">
      <div class="t-info">
        <span class="t-status ${t.status}">${statusLabel}</span>
        <h2>${esc(t.name)}</h2>
        ${t.desc ? `<p>${esc(t.desc)}</p>` : ''}
      </div>
      ${orn ? `<div class="t-reward">
        ${avatarHtml(S.profile.pseudo, S.profile.avatar, orn.id)}
        <div><span class="tone-tag">Récompense du vainqueur</span><b>${esc(orn.name)}</b><small>Contour d'avatar exclusif : il ne s'obtient qu'en gagnant ce tournoi.</small></div>
      </div>` : ''}
    </div>
    ${champ ? `<div class="panel t-champion">🏆 <b>${esc(champ.pseudo)}</b> remporte le tournoi et gagne le contour « ${esc(orn ? orn.name : '')} » !</div>` : ''}
    ${myPanel}
    ${t.status === 'registration' ? `<div class="panel"><h3 style="margin-top:0;">Inscrits</h3>${t.players.length ? `<div class="t-players">${t.players.map(p => `<div class="t-player">${avatarHtml(p.pseudo, p.avatar, p.ornament, 'sm')}<span>${esc(p.pseudo)}</span>${p.online ? '<i class="dot-online" title="En ligne"></i>' : ''}</div>`).join('')}</div>` : '<div class="empty">Personne pour l\'instant. Sois le premier !</div>'}</div>` : ''}
    ${t.rounds && t.rounds.length ? `<div class="panel"><h3 style="margin-top:0;">Arbre du tournoi</h3>${renderBracket(t, false)}</div>` : ''}
    ${renderTournamentHistory(d)}`;
}
function renderTournamentHistory(d) {
  const h = (d.history || []).filter(x => x.status === 'finished');
  if (!h.length) return '';
  return `<div class="panel"><h3 style="margin-top:0;">Anciens tournois</h3>${h.map(x => `<div class="row-card"><div class="info"><b>${esc(x.name)}</b> <span class="tone-tag">${x.players} joueurs</span></div><span>🏆 ${esc(x.championPseudo || '?')}</span>${x.rewardOrnament ? `<span class="tone-tag">${esc(x.rewardOrnament.name)}</span>` : ''}</div>`).join('')}</div>`;
}
function renderAdminTournament() {
  const d = S.tournament || {};
  const t = d.current;
  const exclusive = ((S.config && S.config.ornaments) || []).filter(o => o.tournamentOnly);
  return `<h1 class="page-title">Admin — Tournoi</h1>${renderAdminTabs()}
    <div class="panel">
      <label style="display:flex;gap:10px;align-items:center;font-weight:600;"><input type="checkbox" style="width:auto" ${d.tabEnabled ? 'checked' : ''} onchange="App.adminTournamentTab(this.checked)"> Afficher l'onglet « Tournoi » aux joueurs</label>
    </div>
    ${t && ['registration', 'running'].includes(t.status) ? `
    <div class="panel">
      <h3 style="margin-top:0;">${esc(t.name)} — ${t.status === 'registration' ? `inscriptions (${t.players.length} joueurs, minimum ${d.minPlayers})` : 'en cours'}</h3>
      <div class="btn-row" style="margin-top:0;">
        ${t.status === 'registration' ? `<button class="btn" ${t.players.length < d.minPlayers ? 'disabled' : ''} onclick="App.adminTournamentStart()">Lancer le tournoi</button>` : ''}
        <button class="btn danger" onclick="App.adminTournamentCancel()">Annuler le tournoi</button>
      </div>
      ${t.status === 'registration' ? `<p class="page-sub">Inscrits : ${t.players.map(p => esc(p.pseudo)).join(', ') || 'aucun'}</p>` : `<p class="page-sub">Bouton « Vainqueur » : à utiliser si un joueur est absent ou en cas de problème. Les autres matchs se lancent quand les deux joueurs sont prêts.</p>${renderBracket(t, true)}`}
    </div>` : `
    ${t && t.status === 'finished' ? `<div class="panel">🏆 « ${esc(t.name)} » est terminé : ${esc(t.championPseudo || '?')} a gagné. <button class="btn small ghost" onclick="App.adminTournamentArchive()">Ranger dans l'historique</button></div>` : ''}
    <div class="panel">
      <h3 style="margin-top:0;">Créer un tournoi</h3>
      <div class="field-row"><div><label>Nom</label><input type="text" id="tour-name" placeholder="Ex : Coupe d'automne"></div></div>
      <div class="field-row"><div><label>Description (optionnelle)</label><input type="text" id="tour-desc" placeholder="Règles, date, ambiance…"></div></div>
      <h4>Récompense : contour d'avatar exclusif</h4>
      <div class="field-row">
        <div><label>Nouveau contour (image PNG transparente)</label><input type="file" id="tour-orn-image" accept="image/png,image/webp" class="file-input"></div>
        <div><label>Nom du contour</label><input type="text" id="tour-orn-name" placeholder="Ex : Couronne du champion d'automne"></div>
      </div>
      <div class="field-row"><div><label>Titre du champion <span class="tone-tag">affiché sous son pseudo</span></label><input type="text" id="tour-title" maxlength="40" placeholder="Ex : Champion d'automne"></div></div>
      ${exclusive.length ? `<div class="field-row"><div><label>…ou reprendre un contour de tournoi existant</label><select id="tour-orn-existing"><option value="">— Aucun —</option>${exclusive.map(o => `<option value="${esc(o.id)}">${esc(o.name)}</option>`).join('')}</select></div></div>` : ''}
      <p class="page-sub">Ce contour n'est jamais vendu en boutique : seul le vainqueur de ce tournoi l'obtient.</p>
      <div class="field-row"><div><label>Bannière de profil offerte au vainqueur <span class="tone-tag">le finaliste reçoit « Finaliste »</span></label><select id="tour-banner">${(S.bannerCatalog || [{ id: 'champion', name: 'Champion' }]).filter(b => b.source !== 'shop').map(b => `<option value="${esc(b.id)}" ${b.id === 'champion' ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select></div></div>
      <div class="btn-row"><button class="btn" onclick="App.adminTournamentCreate()">Créer et ouvrir les inscriptions</button></div>
    </div>`}`;
}


/* ======================================================
   MODE HISTOIRE
   ====================================================== */
function loadStory() { return api('/api/story').then(r => { S.story = r; render(); }).catch(() => {}); }

function renderStory() {
  const st = S.story;
  if (!st) return skeletonPage('Histoire', 'grid');
  const chs = st.chapters || [];
  const sel = chs.find(c => c.id === S.storySelected) || chs.find(c => c.unlocked && !c.cleared) || chs.filter(c => c.unlocked).pop() || chs[0];
  const last = S.storyLast;
  const stars = q => '★'.repeat(1 + Math.round((q || 0) * 4)) + '☆'.repeat(4 - Math.round((q || 0) * 4));
  const rewardTxt = r => [r.dust ? `+${r.dust} ✧` : '', r.credits ? `+${r.credits} 🪙` : ''].filter(Boolean).join(' · ') || '—';
  const stepState = c => c.cleared ? 'cleared' : !c.enabled ? 'soon' : c.unlocked ? 'open' : 'locked';
  const stepIcon = c => c.cleared ? '✓' : !c.enabled ? '⏳' : c.unlocked ? c.index + 1 : '🔒';
  const stepSub = c => !c.enabled ? 'Bientôt disponible' : !c.unlocked ? 'Termine le chapitre précédent' : `${c.progress}/${c.fights.length} combats`;
  let detail = '<div class="panel"><div class="empty">Aucun chapitre pour le moment.</div></div>';
  if (sel) {
    const next = sel.fights.find(f => !f.won);
    detail = `<div class="panel story-chapter">
      <span class="tone-tag">Chapitre ${sel.index + 1}${sel.enabled ? '' : ' · bientôt disponible'}</span>
      <h2 class="story-title">${esc(sel.title)}</h2>
      <p class="story-intro">${esc(sel.intro)}</p>
      <ol class="story-fights" aria-label="Combats du chapitre">${sel.fights.map((f, k) => {
        const current = sel.unlocked && next && next.index === k;
        return `<li class="story-fight-step ${f.won ? 'won' : current ? 'current' : 'todo'} kind-${f.kind}">
          <div class="story-boss-img rar-${esc(f.rarity || 'commun')}">${f.image ? `<img src="${esc(f.image)}" alt="">` : `<span>${f.kind === 'boss' ? '👹' : '🗡️'}</span>`}</div>
          <div class="sf-txt">
            <small>${f.kind === 'boss' ? 'Boss du chapitre' : `Sbire ${k + 1}`}</small>
            <b>${esc(f.name)}</b>
            <span>${f.hp} PV${f.armor ? ` · ${f.armor} armure` : ''} · ${rewardTxt(f.reward)}</span>
          </div>
          ${f.won ? `<button class="btn small ghost" ${sel.unlocked ? `onclick="App.storyStart('${esc(sel.id)}', ${k})"` : 'disabled'}>Rejouer</button>`
            : current ? `<button class="btn story-fight" onclick="App.storyStart('${esc(sel.id)}', ${k})">⚔️ Combattre</button>`
            : '<span class="tone-tag">🔒</span>'}
        </li>`;
      }).join('')}</ol>
      <p class="story-diff">Difficulté du chapitre <span>${stars(sel.quality)}</span>${sel.cleared ? ' · chapitre terminé ✓' : ''}</p>
      ${!sel.enabled ? '<p class="page-sub">Ce chapitre ouvrira bientôt : prends le temps de terminer les précédents !</p>' : !sel.unlocked ? '<p class="page-sub">Termine le chapitre précédent pour débloquer celui-ci.</p>' : ''}
    </div>`;
  }
  return `<h1 class="page-title">Histoire</h1>
    <p class="page-sub">Chaque chapitre compte 3 combats : deux sbires, puis le boss. Chaque victoire rapporte de la poussière ou des crédits (moins quand tu rejoues un combat déjà gagné). De nouveaux chapitres ouvrent au fil du temps. Tu joues avec ton deck actif.</p>
    ${last ? `<div class="panel story-last"><b>📜 ${esc(last.title)} — ${last.isBoss ? 'boss vaincu !' : `combat ${last.fightNumber}/${last.fightCount} gagné`}</b><p>${esc(last.victory || '')}</p><button class="btn small ghost" onclick="App.storyDismiss()">Continuer</button></div>` : ''}
    <div class="story-layout">
      <ol class="story-path" aria-label="Chapitres">${chs.map(c => `
        <li class="story-step ${stepState(c)} ${sel && sel.id === c.id ? 'sel' : ''}">
          <button onclick="App.storySelect('${esc(c.id)}')" aria-label="Chapitre ${c.index + 1} : ${esc(c.title)}">
            <span class="story-num">${stepIcon(c)}</span>
            <span class="story-step-txt"><b>${esc(c.title)}</b><small>${stepSub(c)}</small></span>
          </button>
        </li>`).join('')}</ol>
      ${detail}
    </div>`;
}
/* ---------- Bac à sable : tester une carte contre le bot ---------- */
function renderAdminSandbox() {
  const sb = S.sandbox = S.sandbox || { hand: [], mine: [], theirs: [], mana: 10, oppHp: 30, q: '' };
  const q = normSearch(sb.q || '');
  const results = q ? (S.cardPool || []).filter(c => normSearch(c.name).includes(q)).slice(0, 12) : [];
  const zone = (key, title, max, hint) => `<div class="panel sb-zone"><h4 style="margin:0 0 8px;">${title} <span class="tone-tag">${sb[key].length}/${max}${hint ? ' · ' + hint : ''}</span></h4>
    ${sb[key].length ? `<div class="sb-chips">${sb[key].map((id, i) => `<span class="sb-chip">${cardChip(id)}<button class="btn small ghost" onclick="App.sandboxRemove('${key}', ${i})" aria-label="Retirer">✕</button></span>`).join('')}</div>` : '<div class="empty" style="padding:8px;">Vide</div>'}</div>`;
  return `<h1 class="page-title">Admin — Bac à sable</h1>${renderAdminTabs()}
    <div class="panel">
      <p class="page-sub" style="margin-top:0;">Prépare une situation (ta main, ton plateau, celui du bot), puis lance un combat de test : c'est ton tour, avec la mana choisie. Rien n'est enregistré (ni récompense, ni statistique). Idéal pour vérifier une nouvelle carte.</p>
      <div class="deck-search" style="max-width:none;"><span aria-hidden="true">🔍</span><input type="text" id="sb-search" placeholder="Chercher une carte…" value="${esc(sb.q)}" oninput="App.sandboxSearch(this.value)" autocomplete="off"></div>
      ${results.length ? `<div class="sb-results">${results.map(c => `<div class="row-card">${cardChip(c.id)}<span class="tone-tag">${esc(cardTypeLabel(c.type))}</span>
        <button class="btn small" onclick="App.sandboxAdd('hand','${esc(c.id)}')">+ Ma main</button>
        ${c.type === 'minion' ? `<button class="btn small ghost" onclick="App.sandboxAdd('mine','${esc(c.id)}')">+ Mon plateau</button><button class="btn small ghost" onclick="App.sandboxAdd('theirs','${esc(c.id)}')">+ Plateau du bot</button>` : ''}</div>`).join('')}</div>` : ''}
    </div>
    <div class="sb-grid">${zone('hand', 'Ma main', 10)}${zone('mine', 'Mon plateau', 7, 'prêts à attaquer')}${zone('theirs', 'Plateau du bot', 7)}</div>
    <div class="panel">
      <div class="field-row">
        <div style="max-width:180px;"><label>Ma mana</label><input type="number" min="1" max="10" value="${sb.mana}" onchange="App.sandboxSet('mana', this.value)"></div>
        <div style="max-width:180px;"><label>PV du bot</label><input type="number" min="1" max="200" value="${sb.oppHp}" onchange="App.sandboxSet('oppHp', this.value)"></div>
      </div>
      <div class="btn-row"><button class="btn" onclick="App.startSandbox()">▶ Lancer le test</button><button class="btn ghost" onclick="App.sandboxReset()">Tout vider</button></div>
    </div>`;
}


/* ---------- Equilibrium : simulateur d'équilibrage ---------- */
const EQ_VERDICT = { strong: ['🔥', 'var(--bad)'], good: ['💪', 'var(--legendaire)'], balanced: ['⚖️', 'var(--good)'], meh: ['🪶', 'var(--rare)'], weak: ['🧊', 'var(--rare)'], unplayed: ['❔', 'var(--muted)'] };
function renderEquilibrium() {
  const eq = S.eq = S.eq || { q: '', ext: 'all', games: 1000, history: [] };
  const q = normSearch(eq.q || '');
  const pool = (S.cardPool || []).filter(c => (eq.ext === 'all' || (c.extensionId || 'base') === eq.ext) && (!q || normSearch(c.name).includes(q)))
    .sort((a, b) => String(a.name).localeCompare(String(b.name), 'fr'));
  const sel = eq.cardId && cardById(eq.cardId);
  const running = eq.job && !eq.job.finished;
  const res = eq.job && eq.job.result;
  const kpi = (v, l, cls) => `<div class="stat-kpi ${cls || ''}"><b>${v}</b><span>${l}</span></div>`;
  return `<h1 class="page-title">Admin — Equilibrium</h1>${renderAdminTabs()}
    <div class="panel">
      <p class="page-sub" style="margin-top:0;">Teste une carte avant de la sortir : le bot joue des centaines de parties contre lui-même, <b>avec</b> la carte dans son deck puis <b>sans</b> (même deck, carte remplacée par d'autres au hasard). L'écart de victoires mesure son impact.</p>
      <div class="eq-pick">
        <div class="deck-search" style="max-width:none;flex:1;"><span aria-hidden="true">🔍</span><input type="text" id="eq-search" placeholder="Chercher une carte…" value="${esc(eq.q)}" oninput="App.eqSet('q', this.value)" autocomplete="off"></div>
        <select onchange="App.eqSet('ext', this.value)">${[['all', 'Toutes les extensions']].concat((S.extensions || []).map(e => [e.id, e.name])).map(([v, l]) => `<option value="${esc(v)}" ${eq.ext === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
      </div>
      <div class="eq-list">${pool.slice(0, 60).map(c => `<button class="eq-item ${eq.cardId === c.id ? 'on' : ''}" onclick="App.eqSet('cardId', '${esc(c.id)}')"><span class="chip-cost">${c.cost}</span>${esc(c.name)}<small>${esc(cardTypeLabel(c.type))} · ${esc((RARITIES[c.rarity] || {}).label || c.rarity)}</small></button>`).join('') || '<div class="empty">Aucune carte.</div>'}</div>
    </div>
    ${sel ? `<div class="panel eq-run">
      <div style="display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap;">
        <div style="width:190px;">${renderCardTile(sel, {})}</div>
        <div style="flex:1;min-width:260px;">
          <h3 style="margin-top:0;">${esc(sel.name)}</h3>
          <label>Nombre de parties simulées</label>
          <div class="seg" style="margin:6px 0 14px;">${[500, 1000, 2000, 5000].map(n => `<button class="${eq.games === n ? 'on' : ''}" onclick="App.eqSet('games', ${n})">${n}</button>`).join('')}</div>
          <p class="page-sub">Plus il y a de parties, plus le résultat est fiable (≈ ${Math.round(1.96 * Math.sqrt(0.5 / eq.games) * 1000) / 10} points de marge d'erreur).</p>
          <button class="btn" ${running ? 'disabled' : ''} onclick="App.eqRun()">${running ? 'Simulation en cours…' : '⚖️ Lancer Equilibrium'}</button>
          ${running ? `<div class="eq-progress"><div style="width:${Math.round(eq.job.done / eq.job.games * 100)}%"></div></div><p class="page-sub">${eq.job.done} / ${eq.job.games} parties</p>` : ''}
        </div>
      </div>
      ${res && res.cardId === sel.id ? `
        <div class="eq-verdict" style="--vc:${EQ_VERDICT[res.verdict][1]}"><span>${EQ_VERDICT[res.verdict][0]}</span><b>${esc(res.label)}</b>
          <small>${res.delta >= 0 ? '+' : ''}${res.delta} points de victoire avec la carte (marge d'erreur ± ${res.margin})</small></div>
        <div class="stat-kpis">
          ${kpi(res.withRate + ' %', 'de victoires avec la carte')}
          ${kpi(res.withoutRate + ' %', 'sans la carte (même deck)')}
          ${kpi(res.winWhenPlayed + ' %', 'de victoires quand elle est jouée')}
          ${kpi(res.playRate + ' %', 'des parties où elle est jouée')}
        </div>
        <div class="stat-kpis">
          ${kpi(res.avgTurnPlayed != null ? 'tour ' + res.avgTurnPlayed : '—', 'jouée en moyenne au')}
          ${kpi(res.damagePerGame, 'dégâts par partie jouée')}
          ${kpi(res.killsPerGame, 'serviteurs éliminés par partie')}
          ${kpi(res.healPerGame, 'PV soignés par partie')}
        </div>
        <p class="page-sub">${res.games} parties avec + ${res.games} sans, en ${res.seconds} s · parties de ${res.avgLength} tours en moyenne. Le bot joue simplement (cartes les plus chères d'abord, attaques directes) : prends ce résultat comme une indication, à confirmer en partie réelle.</p>` : ''}
    </div>` : '<div class="panel"><div class="empty">Choisis une carte dans la liste pour la tester.</div></div>'}
    ${eq.history.length ? `<div class="panel"><h3 style="margin-top:0;">Derniers tests</h3>${eq.history.map(r => `<div class="row-card eq-hist"><span>${EQ_VERDICT[r.verdict][0]}</span><div class="info"><b>${esc(r.cardName)}</b> <span class="tone-tag">${esc(r.label)}</span></div><span>${r.withRate} % avec · ${r.withoutRate} % sans · <b>${r.delta >= 0 ? '+' : ''}${r.delta}</b></span><button class="btn small ghost" onclick="App.eqSet('cardId', '${esc(r.cardId)}')">Voir</button></div>`).join('')}</div>` : ''}`;
}


/* ---------- Programmation ---------- */
function renderAdminSchedule() {
  const sc = S.schedule;
  if (!sc) return `<h1 class="page-title">Admin — Programmation</h1>${renderAdminTabs()}<div class="panel">${skeletonRows(4)}</div>`;
  const f = S.schedForm = S.schedForm || { action: 'story_chapter_open', enabled: true };
  const chapters = sc.chapters || [];
  const fmt = t => new Date(t).toLocaleString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
  const pending = sc.tasks.filter(t => t.status === 'pending'), past = sc.tasks.filter(t => t.status !== 'pending').reverse().slice(0, 15);
  const needsChapter = f.action === 'story_chapter_open', needsOnOff = /_tab$/.test(f.action);
  return `<h1 class="page-title">Admin — Programmation</h1>${renderAdminTabs()}
    <div class="panel">
      <p class="page-sub" style="margin-top:0;">Programme une action à l'avance : elle se déclenchera toute seule à l'heure choisie, même si tu n'es pas connecté (le serveur vérifie toutes les 20 secondes, et rattrape un oubli au redémarrage).</p>
      <div class="field-row">
        <div><label>Action</label><select onchange="App.schedSet('action', this.value)">${Object.entries(sc.actions).map(([k, l]) => `<option value="${k}" ${f.action === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></div>
        ${needsChapter ? `<div><label>Chapitre</label><select id="sched-chapter">${chapters.map(c => `<option value="${esc(c.id)}">${esc(c.title)}${c.enabled === false ? '' : ' (déjà ouvert)'}</option>`).join('')}</select>
          <label style="display:flex;gap:8px;align-items:center;margin-top:6px;font-weight:500;"><input type="checkbox" id="sched-also-tab" style="width:auto" checked> Afficher aussi l'onglet Histoire</label></div>` : ''}
        ${f.action === 'extension_publish' ? `<div><label>Extension</label><select id="sched-ext">${(S.extensions || []).filter(e => e.hidden).map(e => `<option value="${esc(e.id)}">${esc(e.name)}</option>`).join('') || '<option value="">Aucune extension cachée</option>'}</select></div>` : ''}
        ${needsOnOff ? `<div><label>Afficher ou masquer</label><select id="sched-enabled"><option value="1">Afficher l'onglet</option><option value="0">Masquer l'onglet</option></select></div>` : ''}
        <div><label>Date et heure</label><input type="datetime-local" id="sched-at"></div>
      </div>
      <div class="btn-row"><button class="btn" onclick="App.addSchedule()">⏰ Programmer</button></div>
    </div>
    <div class="panel"><h3 style="margin-top:0;">À venir</h3>
      ${pending.length ? pending.map(t => `<div class="row-card"><div class="info"><b>${esc(t.label)}</b><span class="tone-tag">${esc(fmt(t.at))}</span></div><button class="btn small ghost danger-text" onclick="App.deleteSchedule('${esc(t.id)}')">Annuler</button></div>`).join('') : '<div class="empty">Rien de programmé.</div>'}
    </div>
    ${past.length ? `<div class="panel"><h3 style="margin-top:0;">Déjà déclenché</h3>${past.map(t => `<div class="row-card"><div class="info"><b>${t.status === 'done' ? '✅' : '⚠️'} ${esc(t.label)}</b><span class="tone-tag">${esc(fmt(t.doneAt || t.at))}</span></div><span class="${t.status === 'done' ? '' : 'danger-text'}">${esc(t.result || '')}</span></div>`).join('')}</div>` : ''}
    <div class="panel"><h3 style="margin-top:0;">Images</h3>
      <p class="page-sub" style="margin-top:0;">Les nouvelles images sont allégées et converties en WebP par ton navigateur avant l'envoi. Ce bouton fait de même pour celles envoyées avant cette mise à jour : illustrations, calques 3D, boosters, dos de carte, contours et avatars.</p>
      <div class="btn-row" style="margin-top:0;"><button class="btn ghost" ${S.imgProgress ? 'disabled' : ''} onclick="App.optimizeImages()">${S.imgProgress ? `Conversion… ${S.imgProgress}` : '🗜️ Optimiser les images existantes'}</button></div>
    </div>`;
}

function renderAdminBugs() {
  const list = S.adminBugs;
  return `<h1 class="page-title">Admin — Bugs signalés</h1>${renderAdminTabs()}
    ${!list ? `<div class="panel">${skeletonRows(4)}</div>` : list.length === 0 ? '<div class="panel"><div class="empty">Aucun signalement pour le moment.</div></div>' : list.map(r => {
      const m = r.match;
      return `<div class="panel bug-item ${r.status}">
        <div class="bug-head"><b>${esc(r.pseudo)}</b><span class="tone-tag">${new Date(r.at).toLocaleString('fr-FR')}</span>${r.status === 'resolved' ? '<span class="tag done">résolu</span>' : '<span class="tag">ouvert</span>'}
          <span style="margin-left:auto;display:flex;gap:6px;">
            ${r.replayId ? `<button class="btn small" onclick="App.openAdminReplay('${esc(r.replayId)}','${esc(r.slug)}')">▶ Revoir le combat</button>` : ''}
            <button class="btn small ghost" onclick="App.setBugStatus('${esc(r.id)}','${r.status === 'resolved' ? 'open' : 'resolved'}')">${r.status === 'resolved' ? 'Rouvrir' : 'Marquer résolu'}</button>
            <button class="btn small ghost danger-text" onclick="App.setBugStatus('${esc(r.id)}',null,true)">Supprimer</button></span></div>
        <p class="bug-text">${esc(r.text)}</p>
        ${m ? `<details><summary>Partie au moment du signalement : tour ${m.turnNumber}, ${m.yourTurn ? 'son tour' : 'tour adverse'}, contre ${esc(m.opponent || '?')} (${esc(m.mode)})</summary>
          <p><b>Mana :</b> ${m.you.mana} · <b>Main :</b> ${m.you.hand.map(esc).join(', ') || '—'}</p>
          <p><b>Ses serviteurs :</b> ${m.you.board.map(x => `${esc(x.name)} ${x.attack}/${x.health}${x.sickness ? ' (vient d\'arriver)' : ''}${x.asleep ? ' (endormi)' : ''}${!x.canAttack ? ' (a attaqué)' : ''}`).join(' · ') || '—'}</p>
          <p><b>Dernières actions :</b></p><ul class="bug-log">${(m.log || []).slice(-10).map(l => `<li>${esc(l)}</li>`).join('')}</ul>
        </details>` : '<p class="page-sub">Envoyé hors combat.</p>'}
        ${r.clientState ? `<details><summary>État de l'interface</summary><pre class="bug-pre">${esc(r.clientState)}</pre><p class="page-sub">${esc(r.screen)} · ${esc(r.client)}</p></details>` : ''}
      </div>`;
    }).join('')}`;
}

function renderAdminRanking() {
  const rs = (S.config && S.config.ranking) || {};
  const th = rs.rankThresholds || [100, 300, 600, 1000];
  const rr = rs.rankRewards || {};
  const num = (id, label, v, hint) => `<div style="max-width:200px;"><label>${label}${hint ? ` <span class="tone-tag">${hint}</span>` : ''}</label><input type="number" id="${id}" value="${v}"></div>`;
  return `<h1 class="page-title">Admin — Classement</h1>${renderAdminTabs()}
    <div class="panel">
      <h3 style="margin-top:0;">Paliers des rangs (points)</h3>
      <div class="field-row">${num('rk-th-0', 'Argent', th[0])}${num('rk-th-1', 'Or', th[1])}${num('rk-th-2', 'Diamant', th[2])}${num('rk-th-3', 'Maître', th[3])}</div>
      <p class="page-sub">Avec ${rs.vpWin} points par victoire : Argent ≈ ${Math.ceil(th[0] / rs.vpWin)} victoires, Or ≈ ${Math.ceil(th[1] / rs.vpWin)}, Diamant ≈ ${Math.ceil(th[2] / rs.vpWin)}, Maître ≈ ${Math.ceil(th[3] / rs.vpWin)} (avant bonus).</p>
    </div>
    <div class="panel">
      <h3 style="margin-top:0;">Points par combat</h3>
      <div class="field-row">${num('rk-win', 'Victoire', rs.vpWin)}${num('rk-loss', 'Défaite jouée', rs.vpLoss)}${num('rk-minturns', 'Tours minimum', rs.minLossTurns, 'pour les points de défaite')}</div>
      <div class="field-row">${num('rk-first', '1re victoire du jour (×)', rs.firstWinMultiplier)}${num('rk-streak-from', 'Série à partir de', rs.streakFrom, 'victoires')}${num('rk-streak', 'Bonus de série', rs.streakBonus, 'points')}</div>
    </div>
    <div class="panel">
      <h3 style="margin-top:0;">Fin de mois</h3>
      <label style="display:flex;gap:10px;align-items:center;font-weight:600;margin-bottom:12px;"><input type="checkbox" id="rk-soft" style="width:auto" ${rs.softReset !== false ? 'checked' : ''}> Remise à zéro douce : on repart au début du rang en dessous (sinon tout repart de zéro)</label>
      <div class="field-row">${num('rk-rw-argent', 'Récompense Argent (✧)', rr.argent || 0)}${num('rk-rw-or', 'Or (✧)', rr.or || 0)}${num('rk-rw-diamant', 'Diamant (✧)', rr.diamant || 0)}${num('rk-rw-maitre', 'Maître (✧)', rr.maitre || 0)}</div>
      <p class="page-sub">Versée à chaque joueur selon le rang atteint, en plus des récompenses du podium.</p>
      <div class="btn-row"><button class="btn" onclick="App.saveRanking()">Enregistrer le classement</button></div>
    </div>`;
}

function renderAdminStory() {
  const chs = S.adminStory;
  if (!chs) return `<h1 class="page-title">Admin — Histoire</h1>${renderAdminTabs()}<div class="panel">${skeletonRows(4)}</div>`;
  const minions = (S.cardPool || []).filter(c => c.type === 'minion').sort((a, b) => String(a.name).localeCompare(String(b.name), 'fr'));
  return `<h1 class="page-title">Admin — Histoire</h1>${renderAdminTabs()}
    <div class="panel">
      <label style="display:flex;gap:10px;align-items:center;font-weight:600;"><input type="checkbox" style="width:auto" ${S.adminStoryEnabled ? 'checked' : ''} onchange="App.adminStoryTab(this.checked)"> Ouvrir le mode Histoire aux joueurs (onglet « Histoire » dans le menu)</label>
      <p class="page-sub" style="margin:6px 0 0;">Masqué au départ : prépare tes chapitres, puis coche la case quand tout est prêt.</p>
    </div>
    <div class="panel">
      <p class="page-sub" style="margin-top:0;"><b>Chaque chapitre = 2 sbires puis le boss.</b> Coche « Chapitre ouvert aux joueurs » pour ouvrir les chapitres petit à petit : un chapitre fermé reste visible mais marqué « Bientôt disponible ». N'oublie pas d'enregistrer.</p>
      <p class="page-sub">Les chapitres ont été créés à partir de tes cartes : les boss sont tes serviteurs, du moins puissant au plus puissant. Modifie les textes, le boss, ses PV, son armure, la difficulté de son deck (0 à 1) et la récompense, puis enregistre.</p>
      <div class="btn-row" style="margin-top:0;">
        <button class="btn" onclick="App.adminStorySave()">Enregistrer les chapitres</button>
        <button class="btn ghost" onclick="App.adminStoryAdd()">+ Ajouter un chapitre</button>
        <button class="btn ghost danger-text" onclick="App.adminStoryRegenerate()">Recréer à partir des cartes</button>
      </div>
    </div>
    ${chs.map((c, i) => `<div class="panel story-admin" data-i="${i}">
      <label class="story-open-toggle"><input type="checkbox" style="width:auto" data-k="enabled" ${c.enabled !== false ? 'checked' : ''}> Chapitre ${i + 1} ouvert aux joueurs</label>
      <div class="field-row">
        <div><label>Chapitre ${i + 1} — titre</label><input type="text" data-k="title" value="${esc(c.title)}"></div>
        <div><label>Boss (carte)</label><select data-k="bossCardId">${minions.map(m => `<option value="${esc(m.id)}" ${m.id === c.bossCardId ? 'selected' : ''}>${esc(m.name)} (${m.attack}/${m.health})</option>`).join('')}</select></div>
        <div><label>Nom affiché du boss</label><input type="text" data-k="bossName" value="${esc(c.bossName)}"></div>
      </div>
      <div class="field-row"><div><label>Texte d'introduction</label><textarea data-k="intro" rows="3">${esc(c.intro)}</textarea></div></div>
      <div class="field-row"><div><label>Texte de victoire</label><textarea data-k="victory" rows="2">${esc(c.victory)}</textarea></div></div>
      <div class="field-row">
        <div><label>PV du boss</label><input type="number" data-k="hp" value="${c.hp}"></div>
        <div><label>Armure du boss</label><input type="number" data-k="armor" value="${c.armor}"></div>
        <div><label>Difficulté du deck (0 à 1)</label><input type="number" step="0.1" min="0" max="1" data-k="quality" value="${c.quality}"></div>
        <div><label>Poussière gagnée</label><input type="number" data-k="dust" value="${(c.reward || {}).dust || 0}"></div>
        <div><label>Crédits gagnés</label><input type="number" data-k="credits" value="${(c.reward || {}).credits || 0}"></div>
      </div>
      <h4 style="margin:6px 0;">Sbires (combats avant le boss)</h4>
      ${(c.minions || []).map((m, k) => `<div class="field-row story-minion" data-m="${k}">
        <div><label>Sbire ${k + 1} (carte)</label><select data-mk="cardId">${minions.map(x => `<option value="${esc(x.id)}" ${x.id === m.cardId ? 'selected' : ''}>${esc(x.name)} (${x.attack}/${x.health})</option>`).join('')}</select></div>
        <div><label>Nom affiché</label><input type="text" data-mk="name" value="${esc(m.name)}"></div>
        <div><label>PV</label><input type="number" data-mk="hp" value="${m.hp}"></div>
        <div><label>Difficulté du deck (0 à 1)</label><input type="number" step="0.1" min="0" max="1" data-mk="quality" value="${m.quality}"></div>
      </div>`).join('') || '<p class="page-sub">Aucun sbire : ce chapitre se joue en un seul combat contre le boss.</p>'}
      <div class="btn-row" style="margin-top:0;"><button class="btn small ghost danger-text" onclick="App.adminStoryRemove(${i})">Supprimer ce chapitre</button></div>
    </div>`).join('')}`;
}
function readAdminStory() {
  return [...document.querySelectorAll('.story-admin')].map((el, i) => {
    const v = k => (el.querySelector(`[data-k="${k}"]`) || {}).value;
    const minions = [...el.querySelectorAll('.story-minion')].map(row => {
      const mv = k => (row.querySelector(`[data-mk="${k}"]`) || {}).value;
      return { cardId: mv('cardId'), name: mv('name'), hp: mv('hp'), quality: mv('quality'), armor: 0 };
    });
    return Object.assign({}, S.adminStory[i], { title: v('title'), bossCardId: v('bossCardId'), bossName: v('bossName'), intro: v('intro'), victory: v('victory'),
      hp: v('hp'), armor: v('armor'), quality: v('quality'), reward: { dust: v('dust'), credits: v('credits') },
      enabled: !!(el.querySelector('[data-k="enabled"]') || {}).checked, minions });
  });
}


/* ---------- Page Options ---------- */
/* ---------- Fenêtre « Signaler un bug » ---------- */
function renderBugModal() {
  if (!S.bugModal) return '';
  const inMatch = !!(S.matchState && S.matchState.status === 'active');
  return `<div class="emote-wheel-overlay" onclick="App.closeBugReport()">
    <div class="panel bug-modal" onclick="event.stopPropagation()" role="dialog" aria-label="Signaler un bug">
      <h3 style="margin-top:0;">🐞 Signaler un bug</h3>
      ${S.bugModal.sent ? `<p>Merci ! Ton signalement est envoyé${inMatch ? ', avec l\'état de la partie en cours' : ''}. L'admin pourra le voir et revoir le combat.</p>
        <div class="btn-row"><button class="btn" onclick="App.closeBugReport()">Fermer</button></div>` : `
      <p class="page-sub" style="margin-top:0;">Explique ce qui s'est passé et ce que tu essayais de faire.${inMatch ? ' La situation de la partie (plateau, main, dernières actions) est jointe automatiquement.' : ''}</p>
      <textarea id="bug-text" rows="5" maxlength="2000" placeholder="Ex : je n'arrive plus à attaquer avec mon serviteur depuis que j'ai joué une carte…" style="width:100%"></textarea>
      ${S.bugModal.error ? `<p class="admin-gate-error">${esc(S.bugModal.error)}</p>` : ''}
      <div class="btn-row"><button class="btn" onclick="App.sendBugReport()">Envoyer</button><button class="btn ghost" onclick="App.closeBugReport()">Annuler</button></div>`}
    </div>
  </div>`;
}

function renderOptions() {
  const perm = typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
  const sfx = (S.content && S.content.sfx) || {};
  const pct = v => Math.round(v * 100);
  return `<h1 class="page-title">Options</h1>
    <p class="page-sub">Ces réglages sont enregistrés dans ce navigateur.</p>
    <div class="panel opt-panel">
      <h3>Son</h3>
      <label class="opt-row"><span>Musique <small>${sfx.musicMenu || sfx.musicCombat ? '' : '(aucune musique ajoutée par l\'admin pour l\'instant)'}</small></span>
        <input type="range" min="0" max="100" value="${pct(OPTS.musicVol)}" oninput="App.setOpt('musicVol', this.value / 100, this)" aria-label="Volume de la musique"><b>${pct(OPTS.musicVol)} %</b></label>
      <label class="opt-row"><span>Effets sonores <small>sons des cartes, attaques, boosters…</small></span>
        <input type="range" min="0" max="100" value="${pct(OPTS.sfxVol)}" oninput="App.setOpt('sfxVol', this.value / 100, this)" onchange="App.testSfx()" aria-label="Volume des effets"><b>${pct(OPTS.sfxVol)} %</b></label>
      <p class="page-sub" style="margin:4px 0 0;">Le bouton 🔊 du combat coupe ou remet tout le son.</p>
    </div>
    <div class="panel opt-panel">
      <h3>Affichage</h3>
      <div class="opt-row"><span>Vitesse des animations</span>
        <div class="seg">${[['reduced', 'Réduites'], ['normal', 'Normales'], ['fast', 'Rapides']].map(([v, l]) => `<button class="${OPTS.anim === v ? 'on' : ''}" onclick="App.setOpt('anim', '${v}')">${l}</button>`).join('')}</div></div>
      <label class="opt-row"><span>Mode concentration en combat <small>sur téléphone : seulement le plateau et ta main, le reste dans le menu ☰</small></span>
        <input type="checkbox" style="width:auto" ${OPTS.focusMode !== false ? 'checked' : ''} onchange="App.setOpt('focusMode', this.checked)"></label>
      <label class="opt-row"><span>Info-bulles des mots-clés <small>survole « Provocation », « Charge », « Rage »… sur une carte pour voir ce qu'ils font</small></span>
        <input type="checkbox" style="width:auto" ${OPTS.kwTips !== false ? 'checked' : ''} onchange="App.setOpt('kwTips', this.checked)"></label>
      <div class="opt-row"><span>Taille du texte <small>menus et pages (le plateau de combat garde sa taille)</small></span>
        <div class="seg">${[[90, 'Petite'], [100, 'Normale'], [115, 'Grande'], [130, 'Très grande']].map(([v, l]) => `<button class="${OPTS.textScale === v ? 'on' : ''}" onclick="App.setOpt('textScale', ${v})">${l}</button>`).join('')}</div></div>
    </div>
    <div class="panel opt-panel">
      <h3>Spectateurs</h3>
      <label class="opt-row"><span>Autoriser les spectateurs <small>tes amis (et tout le monde pendant le tournoi) peuvent regarder tes combats en direct, sans voir ta main</small></span>
        <input type="checkbox" style="width:auto" ${S.profile && S.profile.allowSpectate === false ? '' : 'checked'} onchange="App.setAllowSpectate(this.checked)"></label>
    </div>
    <div class="panel opt-panel">
      <h3>Un problème ?</h3>
      <p class="page-sub" style="margin-top:0;">Pendant un combat, le bouton 🐞 en haut à droite envoie aussi l'état de la partie.</p>
      <div class="btn-row" style="margin-top:0;"><button class="btn ghost" onclick="App.openBugReport()">🐞 Signaler un bug</button></div>
    </div>
    <div class="panel opt-panel">
      <h3>Notifications</h3>
      <p class="page-sub" style="margin-top:0;">« C'est ton tour », « Défi reçu », « Ton match de tournoi est prêt », « Proposition d'échange » : même quand le jeu est fermé${PUSH.supported ? '' : ' (si ton navigateur le permet)'}.</p>
      ${PUSH.ios && !PUSH.standalone ? `<div class="push-tip">📱 <b>Sur iPhone</b> : ouvre le jeu dans Safari, touche <b>Partager</b> puis <b>« Sur l'écran d'accueil »</b>. Lance ensuite le jeu depuis cette icône et active les notifications ici.</div>` : ''}
      ${PUSH.installEvt ? `<div class="push-tip">📲 Installe le jeu comme une appli : icône sur l'écran d'accueil, plein écran et notifications. <button class="btn small" onclick="App.installApp()">Installer l'appli</button></div>` : ''}
      ${S.pushError ? `<div class="empty">${esc(S.pushError)}</div>` : ''}
      ${perm === 'unsupported' ? '<div class="empty">Ce navigateur ne permet pas les notifications.</div>'
        : perm === 'denied' ? '<div class="empty">Les notifications sont bloquées pour ce site : autorise-les dans les réglages du navigateur (icône du cadenas à gauche de l\'adresse).</div>'
        : `<label class="opt-row"><span>Activer les notifications</span><input type="checkbox" style="width:auto" ${OPTS.notify && perm === 'granted' ? 'checked' : ''} onchange="App.toggleNotifications(this.checked)"></label>
          ${OPTS.notify && perm === 'granted' && PUSH.active ? `<div class="opt-row"><span>Tester sur cet appareil <small>${esc(S.pushTest || '')}</small></span><button class="btn small ghost" onclick="App.testPush()">Envoyer un test</button></div>` : ''}`}
    </div>`;
}

/* ---------- Titres et statistiques de carrière (Mon profil) ---------- */
function renderTitlePicker(p) {
  const titles = p.titles || [];
  return `<div class="panel">
    <h3 style="margin-top:0;">Mon titre</h3>
    <p class="page-sub" style="margin-top:0;">Il s'affiche sous ton pseudo : dans le menu, au classement, sur ta fiche et en combat. Tu en débloques avec les succès, les tournois et ta carrière.</p>
    ${titles.length ? `<div class="title-list">
      <button class="title-chip ${!p.titleName ? 'on' : ''}" onclick="App.setTitle(null)">Aucun titre</button>
      ${titles.map(t => `<button class="title-chip ${p.title === t.id ? 'on' : ''}" onclick="App.setTitle('${esc(t.id)}')" title="${esc((t.desc || '') + (t.source ? ' — ' + t.source : ''))}">${esc(t.name)}</button>`).join('')}
    </div>` : '<div class="empty">Aucun titre pour le moment : joue ton premier combat pour débloquer « Nouvelle recrue » !</div>'}
  </div>`;
}
function renderCareer(cs, compact) {
  if (!cs) return '';
  const chip = cs.topCard && cardById(cs.topCard.id) ? cardChip(cs.topCard.id) : null;
  const MODES = { pvp: 'Joueurs', tournament: 'Tournoi', story: 'Histoire', practice: 'Entraînement', boss: 'Boss', bot: 'Bot' };
  return `<div class="panel">
    <h3 style="margin-top:0;">Statistiques de carrière</h3>
    <p class="page-sub" style="margin:-4px 0 10px;">Uniquement les combats contre de vrais joueurs (JcJ et tournois).</p>
    ${cs.games ? `<div class="stat-kpis">
      <div class="stat-kpi"><b>${cs.winRate}%</b><span>de victoires (${cs.wins}V / ${cs.losses}D)</span></div>
      <div class="stat-kpi"><b>${cs.games}</b><span>combats joués</span></div>
      <div class="stat-kpi"><b>${cs.bestStreak}</b><span>plus longue série de victoires${cs.curStreak > 1 ? ` (en cours : ${cs.curStreak})` : ''}</span></div>
      <div class="stat-kpi"><b>${cs.kills}</b><span>serviteurs détruits · ${cs.damage} dégâts</span></div>
    </div>
    <div class="career-lines">
      ${chip ? `<div><span>Carte la plus jouée</span>${chip}<small>${cs.topCard.count} fois</small></div>` : ''}
      ${cs.favoriteOpponent ? `<div><span>Adversaire favori</span><b>${esc(cs.favoriteOpponent.pseudo)}</b><small>${cs.favoriteOpponent.w}V / ${cs.favoriteOpponent.l}D</small></div>` : ''}
      ${cs.nemesis ? `<div><span>Bête noire</span><b>${esc(cs.nemesis.pseudo)}</b><small>${cs.nemesis.w}V / ${cs.nemesis.l}D</small></div>` : ''}
      ${!compact ? `<div><span>Par mode</span>${Object.keys(cs.byMode || {}).filter(k => k === 'pvp' || k === 'tournament').map(k => `<small class="mode-chip">${MODES[k] || k} : ${cs.byMode[k].w}V/${cs.byMode[k].l}D</small>`).join(' ')}</div>` : ''}
    </div>` : '<div class="empty">Pas encore de combat enregistré : tes statistiques commencent à ton prochain combat.</div>'}
  </div>`;
}
function titleLine(name) { return name ? `<span class="player-title">${esc(name)}</span>` : ''; }


/* ---------- Progression : niveau, défis du jour, évolution des cartes ---------- */
function evoInfo(cardId) { const e = S.profile && S.profile.progress && S.profile.progress.evo && S.profile.progress.evo[cardId]; return e || null; }
function evoClass(cardId) { const e = evoInfo(cardId); return e && e.tier ? 'evo-' + e.tier : ''; }
function evoBadge(cardId) {
  const e = evoInfo(cardId); if (!e || !e.tier) return '';
  const t = (S.profile.progress.evoTiers || [])[e.tier - 1] || {};
  return `<span class="evo-badge" title="Cadre ${esc(t.name || '')} : jouée ${e.plays} fois">★</span>`;
}
function renderDailyPanel(p, compact) {
  const d = p && p.progress && p.progress.daily;
  if (!d) return '';
  return `<div class="panel daily-panel"><h3 style="margin-top:0;">🎯 Défis du jour <span class="tone-tag">nouveaux défis chaque jour</span></h3>
    <div class="daily-list">${d.map(ch => `<div class="daily ${ch.done ? 'done' : ''}">
      <div class="daily-top"><span>${ch.done ? '✅' : '⬜'} ${esc(ch.text)}</span><b>${ch.reward.credits ? `+${ch.reward.credits} 🪙` : `+${ch.reward.xp} XP`}</b></div>
      <div class="xp-bar big"><i style="width:${Math.round(ch.progress / ch.target * 100)}%"></i></div>
      <small>${ch.progress} / ${ch.target}</small></div>`).join('')}</div></div>`;
}
function levelRewardIcon(n) {
  if (n.kind === 'ornament' && n.ornamentId) return avatarHtml(S.profile.pseudo, S.profile.avatar, n.ornamentId, 'sm');
  if (n.kind === 'banner' && n.bannerId) { const b = bannerById(n.bannerId); return `<i class="lvl-banner" style="${b ? `--banner:${esc(b.bg)}` : ''}"></i>`; }
  return { credits: '🪙', dust: '✧', booster: '🎁', title: '🏷️', none: '·' }[n.kind] || '🎁';
}
function renderProgressPanel(p) {
  const pr = p.progress; if (!pr) return '';
  const pct = pr.xpNext ? Math.round(pr.xp / pr.xpNext * 100) : 100;
  return `<div class="panel progress-panel">
    <div class="lvl-head"><div class="lvl-badge">${pr.level}</div>
      <div style="flex:1;"><h3 style="margin:0;">Niveau ${pr.level}</h3>
        <div class="xp-bar big"><i style="width:${pct}%"></i></div>
        <small>${pr.xpNext ? `${pr.xp} / ${pr.xpNext} XP avant le niveau ${pr.level + 1}` : 'Tu as atteint le niveau maximum !'}</small></div></div>
    <p class="page-sub">L'XP se gagne en combattant (tous les modes), en ouvrant des boosters, en débloquant des succès et en réussissant les défis du jour.</p>
    ${pr.next.length ? `<div class="lvl-track">${pr.next.map(n => `<div class="lvl-step k-${esc(n.kind || '')}" title="${esc(n.reward)}">
      <b>Niv. ${n.level}</b>
      <div class="lvl-ico">${levelRewardIcon(n)}</div>
      <span>${esc(n.reward)}</span></div>`).join('')}</div>` : ''}
    <p class="page-sub" style="margin-bottom:0;">⭐ <b>Évolution des cartes</b> : plus tu joues une carte, plus son cadre devient prestigieux : ${(pr.evoTiers || []).map(t => `${t.name} (${t.plays} parties, +${t.dust} ✧)`).join(' · ')}.</p>
  </div>${renderDailyPanel(p)}`;
}
/* Notifications de progression (niveau, défi réussi, carte évoluée) : petites bulles */
function checkNotices() {
  const n = S.profile && S.profile.notices;
  if (!n || !n.length) return;
  S.profile.notices = [];
  S.toasts = (S.toasts || []).concat(n.map(x => ({ id: Math.random(), text: x.text, kind: x.kind })));
  api('/api/me/notices/ack', 'POST', {}).catch(() => {});
  S.toasts.forEach(t => { if (!t.timer) t.timer = setTimeout(() => { S.toasts = S.toasts.filter(y => y !== t); render(); }, 6000); });
  setTimeout(render, 0);
}
function renderToasts() {
  if (!S.toasts || !S.toasts.length) return '';
  const ico = { level: '🆙', daily: '🎯', evo: '⭐' };
  return `<div class="toast-stack" role="status">${S.toasts.slice(-4).map(t => `<div class="toast ${t.kind}">${ico[t.kind] || '✨'} ${esc(t.text)}</div>`).join('')}</div>`;
}




/* ======================================================
   CHAT GÉNÉRAL (en bas à droite, ordinateur uniquement)
   Le panneau vit en dehors du rendu principal : la saisie en cours n'est
   jamais effacée, et les nouveaux messages sont simplement ajoutés.
   ====================================================== */
const CHAT = { msgs: [], online: 0, open: true, unread: 0, emojiOpen: false };
try { CHAT.open = localStorage.getItem('cgd-chat-open') !== '0'; } catch (e) {}
const CHAT_EMOJIS = ['😂', '🔥', '👍', '😭', '😎', '🤯', '💀', '🙏', '❤️', '😡', '🎉', '👀', 'GG'];
function chatAllowed() {
  if (typeof window === 'undefined' || !S.profile) return false;
  if (isPhone() || window.innerWidth < 1000) return false; // pas sur téléphone ni petit écran
  return !inCombatNow();                                     // le plateau de combat garde toute la place
}
function chatTime(at) { return new Date(at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }); }
function chatMsgHTML(m) {
  // @pseudo mis en avant (et en couleur si c'est toi)
  const txt = esc(m.text).replace(/@([\wÀ-ÿ.-]{2,24})/g, (all, name) => `<span class="chat-at ${S.profile && name.toLowerCase() === String(S.profile.pseudo).toLowerCase() ? 'me' : ''}">@${name}</span>`);
  return `<div class="chat-msg ${S.profile && m.slug === S.profile.slug ? 'mine' : ''}" data-id="${esc(m.id)}">
    <div class="chat-av">${avatarHtml(m.pseudo, m.avatar, m.ornament, 'sm')}</div>
    <div class="chat-body">
      <div class="chat-head"><b onclick="App.chatMention(${jsArg(m.pseudo)})" title="Mentionner">${esc(m.pseudo)}</b><span class="chat-time">${chatTime(m.at)}</span>
        ${S.isAdmin ? `<button class="chat-del" title="Supprimer ce message" onclick="App.chatDelete('${esc(m.id)}')">✕</button>` : ''}</div>
      <div class="chat-text">${txt}</div>
    </div>
  </div>`;
}
function chatRoot() {
  let root = document.getElementById('chat-root');
  if (!root) {
    root = document.createElement('div');
    root.id = 'chat-root';
    root.innerHTML = `<div class="chat-panel">
      <div class="chat-top">
        <div class="chat-banner"><span class="chat-logo">💬</span><span class="chat-word">CHAT</span><span class="chat-bolt">⚡</span></div>
        <span class="chat-online" title="Joueurs connectés"><span class="chat-signal">((•))</span> <b id="chat-online-n">0</b></span>
        <button class="chat-toggle" onclick="App.chatToggle()" title="Réduire le chat" aria-label="Réduire le chat">↘</button>
      </div>
      <div class="chat-tools">
        <button class="chat-support" onclick="App.openBugReport()"><span>🎧</span> Signaler un problème</button>
        <button class="chat-rules" onclick="App.chatRules()" title="Règles du chat">🛡️</button>
      </div>
      <div class="chat-list" id="chat-list" aria-live="polite"></div>
      <div class="chat-emojis" id="chat-emojis">${CHAT_EMOJIS.map(e => `<button onclick="App.chatEmoji('${e}')">${e}</button>`).join('')}</div>
      <div class="chat-input">
        <input id="chat-input" type="text" maxlength="200" placeholder="Ton message…" autocomplete="off" onkeydown="if(event.key==='Enter'){event.preventDefault();App.chatSend()}">
        <button class="chat-emo-btn" onclick="App.chatEmojiToggle()" title="Émojis">🙂</button>
        <button class="chat-send" onclick="App.chatSend()" title="Envoyer" aria-label="Envoyer">➤</button>
      </div>
    </div>
    <button class="chat-bubble" onclick="App.chatToggle()" aria-label="Ouvrir le chat">💬<span class="chat-unread" id="chat-unread"></span></button>`;
    document.body.appendChild(root);
    chatRenderAll();
  }
  return root;
}
function chatRenderAll() {
  const list = document.getElementById('chat-list'); if (!list) return;
  list.innerHTML = CHAT.msgs.map(chatMsgHTML).join('') || '<div class="chat-empty">Pas encore de message. Lance la conversation !</div>';
  list.scrollTop = list.scrollHeight;
}
function syncChat() {
  if (typeof document === 'undefined') return;
  const allowed = chatAllowed();
  const root = allowed ? chatRoot() : document.getElementById('chat-root');
  if (!root) return;
  root.style.display = allowed ? '' : 'none';
  root.classList.toggle('closed', !CHAT.open);
  const n = document.getElementById('chat-online-n'); if (n) n.textContent = CHAT.online;
  const u = document.getElementById('chat-unread'); if (u) { u.textContent = CHAT.unread > 9 ? '9+' : CHAT.unread || ''; u.style.display = CHAT.unread ? '' : 'none'; }
  const em = document.getElementById('chat-emojis'); if (em) em.style.display = CHAT.emojiOpen ? '' : 'none';
}
function chatOnMessage(m) {
  CHAT.msgs.push(m); CHAT.msgs = CHAT.msgs.slice(-80);
  const list = document.getElementById('chat-list');
  if (list) {
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
    const empty = list.querySelector('.chat-empty'); if (empty) empty.remove();
    list.insertAdjacentHTML('beforeend', chatMsgHTML(m));
    while (list.children.length > 80) list.firstElementChild.remove();
    if (atBottom || (S.profile && m.slug === S.profile.slug)) list.scrollTop = list.scrollHeight;
  }
  if (!CHAT.open && S.profile && m.slug !== S.profile.slug) CHAT.unread++;
  syncChat();
}

/* ---------- Fiche détaillée d'une carte (combat) ----------
   Remplace la vue 3D pendant les combats : la carte en grand, ce qu'elle fait,
   l'explication de chaque mot-clé et, pour un serviteur sur le plateau, son
   état actuel (ATQ/PV, endormi, bouclier…). */
function inCombatNow() { return !!(S.matchState && S.matchState.status === 'active' && S.tab === 'combat'); }
const KEYWORD_HELP = {
  'Provocation': "Les ennemis doivent l'attaquer en premier.",
  'Charge': 'Peut attaquer dès le tour où il est posé.',
  'Bouclier': 'Le premier coup reçu est ignoré.',
  'Furie': 'Peut attaquer deux fois par tour.',
  'Camouflage': "Ne peut pas être ciblé par l'adversaire tant qu'il n'a pas attaqué.",
  'Rage': "Tant qu'il n'a pas tous ses PV, il gagne un bonus d'ATQ. Soigné complètement, il le perd.",
  'Silence': "Le serviteur visé perd tous ses effets : mots-clés, aura, Râle d'agonie, endormissement et bonus reçus. Ses dégâts restent.",
  'Toujours debout': 'Tous les 2 tours passés en vie, il gagne un niveau : +1 ATQ et +1 PV (3 niveaux maximum).',
  "Râle d'agonie": 'Effet déclenché à sa mort.',
  'Cri de guerre': 'Effet déclenché quand il est posé.',
  'Aura': 'Donne un bonus à tes autres serviteurs tant qu\'il est en vie.',
  'Combo': 'Avec son partenaire sur le plateau, une troisième carte apparaît.',
  'Daltonisme': "Peut se tromper de cible quand il attaque.",
  'Piège': "Posé face cachée, il se déclenche pendant le tour adverse."
};
/* ---------- Recadrage de l'avatar ---------- */
const CROP_VIEW = 260; // taille du cercle à l'écran (px)
function cropScale(c) { return Math.max(CROP_VIEW / c.iw, CROP_VIEW / c.ih) * c.zoom; }
function cropClamp(c) {
  const sc = cropScale(c);
  const mx = Math.max(0, (c.iw * sc - CROP_VIEW) / 2), my = Math.max(0, (c.ih * sc - CROP_VIEW) / 2);
  c.x = Math.max(-mx, Math.min(mx, c.x)); c.y = Math.max(-my, Math.min(my, c.y));
}
function cropTransform(c) {
  const sc = cropScale(c);
  return `translate(-50%,-50%) translate(${c.x}px,${c.y}px) scale(${sc})`;
}
/* Pendant le glisser, on déplace l'image directement (sans tout redessiner) */
function cropApply() {
  const c = S.avatarCrop, el = document.querySelector('.crop-img');
  if (c && el) el.style.transform = cropTransform(c);
}
function renderAvatarCrop() {
  const c = S.avatarCrop; if (!c) return '';
  return `<div class="emote-wheel-overlay crop-overlay" onclick="App.cropCancel()">
    <div class="crop-modal panel" onclick="event.stopPropagation()" role="dialog" aria-label="Recadrer l'avatar">
      <h3 style="margin-top:0;">Recadre ton avatar</h3>
      <p class="page-sub" style="margin-top:0;">Fais glisser l'image pour la placer, et zoome avec le curseur (ou la molette).</p>
      <div class="crop-stage" style="width:${CROP_VIEW}px;height:${CROP_VIEW}px">
        <img class="crop-img" src="${esc(c.url)}" alt="" draggable="false" style="width:${c.iw}px;height:${c.ih}px;transform:${cropTransform(c)}">
        <div class="crop-ring"></div>
      </div>
      <label class="crop-zoom">🔍<input type="range" min="1" max="4" step="0.01" value="${c.zoom}" oninput="App.cropZoom(this.value)" aria-label="Zoom"></label>
      <div class="btn-row" style="justify-content:center;">
        <button class="btn" ${c.saving ? 'disabled' : ''} onclick="App.cropSave()">${c.saving ? 'Enregistrement…' : 'Enregistrer'}</button>
        <button class="btn ghost" onclick="App.cropCancel()">Annuler</button>
      </div>
    </div>
  </div>`;
}
if (typeof document !== 'undefined') {
  let drag = null;
  document.addEventListener('pointerdown', (e) => {
    const stage = e.target.closest && e.target.closest('.crop-stage');
    if (!stage || !S.avatarCrop) return;
    e.preventDefault();
    drag = { x: e.clientX, y: e.clientY, ox: S.avatarCrop.x, oy: S.avatarCrop.y, id: e.pointerId };
    try { stage.setPointerCapture(e.pointerId); } catch (err) {}
  });
  document.addEventListener('pointermove', (e) => {
    if (!drag || !S.avatarCrop || e.pointerId !== drag.id) return;
    const c = S.avatarCrop;
    c.x = drag.ox + (e.clientX - drag.x); c.y = drag.oy + (e.clientY - drag.y);
    cropClamp(c); cropApply();
  });
  const end = () => { drag = null; };
  document.addEventListener('pointerup', end);
  document.addEventListener('pointercancel', end);
  document.addEventListener('wheel', (e) => {
    const stage = e.target.closest && e.target.closest('.crop-stage');
    if (!stage || !S.avatarCrop) return;
    e.preventDefault();
    const c = S.avatarCrop;
    c.zoom = Math.max(1, Math.min(4, c.zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08)));
    cropClamp(c); cropApply();
    const r = document.querySelector('.crop-zoom input'); if (r) r.value = c.zoom;
  }, { passive: false });
}

/* Info-bulles des mots-clés (désactivables dans les Options) :
   on entoure les mots-clés d'un <span class="kw"> dans le texte DÉJÀ échappé
   d'une carte ; une seule bulle flottante suit la souris. */
let KW_RE = null;
function kwWrap(escaped) {
  if (OPTS.kwTips === false || !escaped) return escaped;
  if (!KW_RE) {
    const keys = Object.keys(KEYWORD_HELP).sort((a, b) => b.length - a.length).map(k => esc(k).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    KW_RE = new RegExp('(^|[^\\p{L}])(' + keys.join('|') + ')(?![\\p{L}])', 'giu');
  }
  return escaped.replace(KW_RE, (m0, pre, word) => `${pre}<span class="kw" data-kw="${word}">${word}</span>`);
}
function kwCanonical(word) {
  const w = String(word || '').toLowerCase();
  return Object.keys(KEYWORD_HELP).find(k => k.toLowerCase() === w || esc(k).toLowerCase() === w) || null;
}
if (typeof document !== 'undefined') {
  let tip = null;
  const hide = () => { if (tip) tip.style.display = 'none'; };
  document.addEventListener('mouseover', (e) => {
    const el = e.target && e.target.closest ? e.target.closest('.kw') : null;
    if (!el || OPTS.kwTips === false) { hide(); return; }
    const key = kwCanonical(el.dataset.kw);
    if (!key) { hide(); return; }
    if (!tip) { tip = document.createElement('div'); tip.className = 'kw-tip'; tip.setAttribute('role', 'tooltip'); document.body.appendChild(tip); }
    tip.innerHTML = `<b>${esc(key)}</b><span>${esc(KEYWORD_HELP[key])}</span>`;
    tip.style.display = 'block';
    const r = el.getBoundingClientRect(), tw = tip.offsetWidth, th = tip.offsetHeight;
    let x = r.left + r.width / 2 - tw / 2, y = r.top - th - 8;
    if (y < 6) y = r.bottom + 8;
    x = Math.max(6, Math.min(window.innerWidth - tw - 6, x));
    tip.style.left = x + 'px'; tip.style.top = y + 'px';
  });
  document.addEventListener('scroll', hide, true);
  document.addEventListener('pointerdown', hide, true);
}

function renderCardInfoModal() {
  const ci = S.cardInfo; if (!ci) return '';
  const c = ci.card, m = ci.minion;
  const parts = cardEffectSummary(c).split(' · ').filter(Boolean);
  const kws = Object.keys(KEYWORD_HELP).filter(k => parts.some(p => p.startsWith(k)) || (k === 'Provocation' && c.taunt) || (k === 'Charge' && c.charge) || (k === 'Piège' && c.effectType === 'trap') || (k === 'Silence' && [c.effectType, c.bcEffect, c.bc2Effect, c.bc3Effect, c.drEffect, c.trapEffect].includes('silence')));
  const state = m ? [m.attack !== c.attack ? `ATQ actuelle : ${m.attack}` : '', m.health !== c.health ? `PV actuels : ${m.health}/${m.maxHealth || c.health}` : '',
    m.asleep ? '💤 Endormi' : '', m.shield ? '🛡️ Bouclier actif' : '', m.stealth ? '🌫️ Camouflé' : '', m.auraBonus ? `✨ +${m.auraBonus} ATQ grâce à une aura` : '',
    m.rageBonus ? `😡 Rage : +${m.rageBonus} ATQ (blessé)` : '', m.silenced ? '🔇 Réduit au silence : plus aucun effet' : '',
    m.standing ? `⭐ Toujours debout : niveau ${m.standLevel || 0}/3${(m.standLevel || 0) < 3 ? ` (prochain niveau dans ${2 - ((m.standTurns || 0) % 2)} tour${2 - ((m.standTurns || 0) % 2) > 1 ? 's' : ''})` : ' (max)'}` : '',
    m.sickness ? 'Vient d\'arriver : ne peut pas encore attaquer' : ''].filter(Boolean) : [];
  return `<div class="card-info-overlay" onclick="App.closeCardInfo()" role="dialog" aria-label="${esc(c.name)}">
    <div class="card-info" onclick="event.stopPropagation()">
      <div class="card-info-tile">${renderCardTile(c, {})}</div>
      <div class="card-info-text">
        <h3>${esc(c.name)}</h3>
        <p class="tone-tag">${esc(cardTypeLabel(c.type))} · ${esc((RARITIES[c.rarity] || {}).label || c.rarity)} · ${c.cost} mana${c.type === 'minion' ? ` · ${c.attack}/${c.health}` : ''}</p>
        ${parts.length ? `<ul class="ci-effects">${parts.map(p => `<li>${esc(p)}</li>`).join('')}</ul>` : '<p class="page-sub">Pas d\'effet particulier.</p>'}
        ${state.length ? `<div class="ci-state"><b>Sur le plateau</b>${state.map(x => `<span>${esc(x)}</span>`).join('')}</div>` : ''}
        ${kws.length && OPTS.kwTips !== false ? `<dl class="ci-kw">${kws.map(k => `<dt>${esc(k)}</dt><dd>${esc(KEYWORD_HELP[k])}</dd>`).join('')}</dl>` : ''}
        ${c.desc ? `<p class="ci-desc">${esc(c.desc)}</p>` : ''}
        <button class="btn small ghost" onclick="App.closeCardInfo()">Fermer</button>
      </div>
    </div>
  </div>`;
}

/* ---------- Synergies du constructeur de deck ----------
   Dès que le deck en cours a quelques cartes, les cartes de la collection qui
   vont bien avec lui s'illuminent, avec la raison. Les combos (deux cartes qui
   en font apparaître une troisième) sont mis en avant en doré. */
function deckDraftCards() { return (S.deckDraft || []).map(id => cardById(id)).filter(Boolean); }
function cardEffects(c) { return [c.effectType, c.bcEffect, c.bc2Effect, c.bc3Effect, c.drEffect].filter(Boolean); }

/* ======================================================
   STRATÉGIE : interactions entre les effets des cartes
   1) chaque carte reçoit des « rôles » d'après ses effets (jetons, aura,
      Furie, Provocation, Râle d'agonie, élimination, pièges…) ;
   2) des règles d'interaction relient deux rôles (« les jetons profitent
      des bonus de zone », « une Provocation avec Bouclier tient deux coups »…) ;
   3) les rôles du deck donnent un score à chaque style de jeu (aggro,
      contrôle, mur, nuée, Râle d'agonie, combo, pièges) et des conseils.
   ====================================================== */
function cardRoles(c) {
  const r = new Set(); if (!c) return r;
  const e = cardEffects(c);
  const has = (...x) => x.some(k => e.includes(k));
  const minion = c.type === 'minion', spell = !minion && c.type !== 'weapon';
  if (minion) r.add('minion'); if (spell) r.add('spell'); if (c.type === 'weapon') r.add('weapon');
  if ((Number(c.cost) || 0) <= 2) r.add('cheap'); if ((Number(c.cost) || 0) >= 6) r.add('late');
  if (minion && (Number(c.attack) || 0) >= 4) r.add('bigBody');
  if (minion && (Number(c.health) || 0) >= 5) r.add('sturdy');
  if (has('summon')) r.add('token');
  if (c.auraAttack) r.add('aura');
  if (has('buff_all_allies')) r.add('aoeBuff');
  if (has('buff_attack', 'buff_ally_and_heal', 'modify_stats')) r.add('buffAtk');
  if (c.windfury) r.add('windfury'); if (has('give_windfury')) r.add('windfuryGiver');
  if (c.charge) r.add('charge');
  if (c.taunt) r.add('taunt'); if (has('give_taunt')) r.add('tauntGiver');
  if (c.shield) r.add('shield'); if (has('give_shield')) r.add('shieldGiver');
  if (c.stealth) r.add('stealth'); if (has('give_stealth')) r.add('stealthGiver');
  if (minion && c.standing) r.add('standing');
  if (minion && c.rage) r.add('rage');
  if (has('silence')) { r.add('silence'); r.add('removal'); }
  if (minion && c.drEffect) r.add('deathrattle'); if (has('give_deathrattle')) r.add('drGiver');
  if (has('heal', 'aoe_heal', 'buff_ally_and_heal')) r.add('heal');
  if (has('armor') || c.armor) r.add('armor');
  if (has('damage', 'destroy', 'sleep')) r.add('removal');
  if (has('aoe_damage', 'damage_all', 'board_wipe')) r.add('aoe');
  if (has('damage_all', 'board_wipe', 'destroy')) r.add('selfKill'); // peut aussi tuer tes propres serviteurs
  if (has('draw', 'random_cards')) r.add('draw');
  if (has('trap') || c.effectType === 'trap') r.add('trap');
  if (c.comboPartnerId) r.add('combo');
  if (c.colorblind) r.add('chaos');
  return r;
}
/* a + b → pourquoi elles vont bien ensemble ; arch = style de jeu renforcé */
const INTERACTIONS = [
  { a: 'token', b: 'aura', arch: 'swarm', text: "les jetons invoqués profitent de l'aura" },
  { a: 'token', b: 'aoeBuff', arch: 'swarm', text: 'plus de serviteurs = un bonus de zone plus rentable' },
  { a: 'aura', b: 'cheap', arch: 'swarm', text: "l'aura renforce une table remplie de petits serviteurs" },
  { a: 'windfuryGiver', b: 'bigBody', arch: 'aggro', text: 'Furie sur un gros serviteur = deux grosses attaques par tour' },
  { a: 'buffAtk', b: 'windfury', arch: 'aggro', text: 'chaque point d\'ATQ gagné compte deux fois avec Furie' },
  { a: 'buffAtk', b: 'charge', arch: 'aggro', text: 'un bonus sur un serviteur à Charge frappe dès ce tour' },
  { a: 'stealthGiver', b: 'bigBody', arch: 'aggro', text: 'camouflé, un gros serviteur ne peut pas être ciblé avant de frapper' },
  { a: 'shieldGiver', b: 'taunt', arch: 'wall', text: 'une Provocation avec Bouclier encaisse un coup gratuit' },
  { a: 'tauntGiver', b: 'sturdy', arch: 'wall', text: 'donner Provocation à un serviteur solide crée un vrai mur' },
  { a: 'heal', b: 'taunt', arch: 'wall', text: 'les soins font durer tes Provocations' },
  { a: 'armor', b: 'taunt', arch: 'wall', text: "armure + Provocation : l'adversaire n'atteint plus ton héros" },
  { a: 'heal', b: 'standing', arch: 'wall', text: 'soigner un serviteur « Toujours debout » le garde en vie jusqu\'à ses niveaux' },
  { a: 'shieldGiver', b: 'standing', arch: 'wall', text: 'un Bouclier protège un « Toujours debout » le temps qu\'il monte de niveau' },
  { a: 'rage', b: 'standing', arch: 'wall', text: 'un « Toujours debout » enragé frappe de plus en plus fort tant qu\'il tient' },
  { a: 'tauntGiver', b: 'rage', arch: 'wall', text: 'une Provocation enragée encaisse les coups et riposte plus fort' },
  { a: 'silence', b: 'charge', arch: 'aggro', text: 'le Silence retire la Provocation qui bloque tes attaques directes' },
  { a: 'taunt', b: 'standing', arch: 'wall', text: 'tes Provocations encaissent pendant que « Toujours debout » grandit' },
  { a: 'trap', b: 'taunt', arch: 'traps', text: "la Provocation force l'adversaire à attaquer… et à déclencher ton piège" },
  { a: 'drGiver', b: 'selfKill', arch: 'deathrattle', text: "donne un Râle d'agonie puis sacrifie le serviteur pour le déclencher" },
  { a: 'deathrattle', b: 'selfKill', arch: 'deathrattle', text: "un nettoyage du plateau déclenche aussi TES Râles d'agonie" },
  { a: 'deathrattle', b: 'taunt', arch: 'deathrattle', text: "une Provocation à Râle d'agonie punit l'adversaire qui la détruit" },
  { a: 'drGiver', b: 'cheap', arch: 'deathrattle', text: "un petit serviteur qui meurt vite rend son Râle d'agonie rentable" },
  { a: 'removal', b: 'late', arch: 'control', text: 'éliminer les menaces le temps de poser tes grosses cartes' },
  { a: 'aoe', b: 'sturdy', arch: 'control', text: 'tes serviteurs solides survivent à tes propres dégâts de zone' },
  { a: 'draw', b: 'removal', arch: 'control', text: 'la pioche nourrit ta main de sorts de contrôle' },
  { a: 'draw', b: 'cheap', arch: 'aggro', text: 'piocher des cartes pas chères pour enchaîner plusieurs poses par tour' },
  { a: 'combo', b: 'draw', arch: 'combo', text: 'la pioche aide à réunir les deux pièces du combo' }
];
const ARCHETYPES = {
  aggro: { core: ['charge', 'windfury', 'windfuryGiver', 'buffAtk'], name: 'Aggro', icon: '⚡', weights: { cheap: 1, charge: 2, windfury: 2, windfuryGiver: 2, buffAtk: 1.5, stealthGiver: 1 },
    plan: 'Pose des serviteurs dès les premiers tours et vise le héros adverse. Garde tes bonus d\'attaque pour un tour décisif.',
    keep: 'Au début : garde les cartes à 1-2 mana, rejette les cartes à 5 mana et plus.' },
  control: { core: ['removal', 'aoe'], name: 'Contrôle', icon: '🧊', weights: { removal: 2, aoe: 2.5, late: 1.5, draw: 1.5, heal: 1, armor: 1 },
    plan: 'Réponds aux menaces au lieu de foncer, nettoie la table, puis gagne avec tes grosses cartes de fin de partie.',
    keep: 'Au début : garde tes éliminations à petit coût et ta pioche.' },
  wall: { core: ['taunt', 'tauntGiver'], name: 'Mur', icon: '🛡️', weights: { taunt: 2, tauntGiver: 2, shield: 1.5, shieldGiver: 1.5, heal: 1.5, armor: 1.5, sturdy: 1, standing: 1.5, rage: 1 },
    plan: 'Tiens la table avec tes Provocations soignées et protégées ; laisse l\'adversaire s\'épuiser contre ton mur.',
    keep: 'Au début : garde une ou deux Provocations bon marché.' },
  swarm: { core: ['token', 'aura', 'aoeBuff'], name: 'Nuée', icon: '🐜', weights: { token: 2.5, aura: 2.5, aoeBuff: 2, cheap: 1 },
    plan: 'Remplis la table (jetons, petits serviteurs), puis renforce tout le monde d\'un coup avec tes auras et bonus de zone.',
    keep: 'Au début : garde tes invocations et petits serviteurs ; pose l\'aura quand la table est pleine.' },
  deathrattle: { core: ['deathrattle', 'drGiver'], name: "Râle d'agonie", icon: '💀', weights: { deathrattle: 2.5, drGiver: 2.5, selfKill: 1.5 },
    plan: 'Laisse mourir tes serviteurs au bon moment : chaque mort te rapporte un effet. Un nettoyage du plateau déclenche tout d\'un coup.',
    keep: "Au début : garde tes serviteurs à Râle d'agonie pas chers." },
  traps: { core: ['trap'], name: 'Pièges', icon: '🪤', weights: { trap: 3, taunt: 1, stealth: 0.5 },
    plan: "Pose tes pièges avant de passer ton tour, et force l'adversaire à attaquer dans le vide.",
    keep: 'Au début : garde un piège et une Provocation.' },
  combo: { core: ['combo'], name: 'Combo', icon: '🔗', weights: { combo: 3, draw: 1 },
    plan: 'Réunis les deux pièces de ton combo sur la table pour faire apparaître la troisième carte, en les protégeant.',
    keep: 'Au début : garde une pièce du combo et de la pioche.' }
};
function analyzeStrategy(cards) {
  const list = cards.filter(Boolean);
  const roles = list.map(c => ({ c, r: cardRoles(c) }));
  const count = k => roles.filter(x => x.r.has(k)).length;
  // Interactions présentes dans le deck (une paire de cartes par règle)
  const found = [], linked = new Set();
  INTERACTIONS.forEach(rule => {
    const A = roles.filter(x => x.r.has(rule.a)), B = roles.filter(x => x.r.has(rule.b));
    const pair = A.flatMap(a => B.filter(b => b.c.id !== a.c.id).map(b => [a.c, b.c]))[0];
    if (!pair) return;
    found.push({ rule, a: pair[0], b: pair[1], n: Math.min(A.length, B.length) });
    const GENERIC = ['cheap', 'sturdy', 'late', 'bigBody']; // rôles trop larges pour rendre une carte « utile »
    (GENERIC.includes(rule.a) ? [] : A).concat(GENERIC.includes(rule.b) ? [] : B).forEach(x => linked.add(x.c.id));
  });
  // Combos explicites (deux cartes précises)
  list.forEach(c => { if (c.comboPartnerId && list.some(x => x.id === c.comboPartnerId)) {
    const p = list.find(x => x.id === c.comboPartnerId);
    found.unshift({ rule: { arch: 'combo', text: `ensemble sur la table, elles font apparaître ${(cardById(c.comboSpawnId) || {}).name || 'une carte'}` }, a: c, b: p, n: 1, explicit: true });
    linked.add(c.id); linked.add(p.id);
  } });
  // Score de chaque style de jeu : rôles pondérés + bonus pour les interactions qui le servent
  const n = Math.max(1, list.length);
  const scores = Object.entries(ARCHETYPES).map(([k, a]) => {
    let sc = Object.entries(a.weights).reduce((t, [role, w]) => t + count(role) * w, 0) / n * 10;
    if (a.core && !a.core.some(role => count(role))) sc *= 0.25; // sans ses cartes « cœur », ce style ne tient pas
    sc += found.filter(f => f.rule.arch === k).length * 2.5;
    const key = roles.filter(x => Object.keys(a.weights).some(role => x.r.has(role) && a.weights[role] >= 2)).map(x => x.c);
    return { key: k, arch: a, score: sc, keyCards: [...new Map(key.map(c => [c.id, c])).values()].slice(0, 6) };
  }).sort((x, y) => y.score - x.score);
  const best = scores.filter(x => x.score >= 4);
  const top = (best.length ? best : scores.slice(0, 1)).slice(0, 2);
  const total = top.reduce((t, x) => t + x.score, 0) || 1;
  // Ce qui manque au style principal
  const tips = [];
  const main = top[0] && top[0].key;
  if (main === 'swarm' && !count('aura') && !count('aoeBuff')) tips.push('Ta nuée n\'a aucun bonus de zone : ajoute une aura ou « bonus d\'attaque à tous tes serviteurs ».');
  if (main === 'aggro' && list.filter(c => (Number(c.cost) || 0) >= 6).length > 3) tips.push('Trop de cartes chères pour un deck aggro : remplace-les par des cartes à 1-3 mana.');
  if (main === 'control' && !count('draw')) tips.push('Un deck de contrôle s\'essouffle sans pioche : ajoute une ou deux cartes qui piochent.');
  if (main === 'control' && !count('late')) tips.push('Ton contrôle n\'a pas de quoi finir la partie : ajoute une ou deux grosses cartes.');
  if (main === 'wall' && !count('heal') && !count('armor')) tips.push('Ton mur ne se soigne pas : ajoute du soin ou de l\'armure.');
  if (main === 'deathrattle' && !count('selfKill') && !count('drGiver')) tips.push("Ajoute de quoi déclencher tes Râles d'agonie toi-même (nettoyage du plateau, destruction).");
  if (main === 'traps' && !count('taunt')) tips.push("Ajoute des Provocations pour forcer l'adversaire à attaquer dans tes pièges.");
  if (count('aoe') && count('token') >= 3) tips.push('Attention : tes dégâts de zone détruisent aussi tes propres jetons. Lance-les avant d\'invoquer.');
  if (count('selfKill') && count('aura') && !count('deathrattle')) tips.push('Attention : un nettoyage du plateau tuera aussi tes serviteurs à aura.');
  const isolated = list.filter((c, i, a) => a.findIndex(x => x.id === c.id) === i && !linked.has(c.id));
  return { styles: top.map(x => Object.assign(x, { pct: Math.round(x.score / total * 100) })), interactions: found, tips, isolated };
}
function renderStrategyPanel(cards) {
  if (cards.length < 5) return `<div class="panel strat-panel"><h3 style="margin-top:0;">🧠 Stratégie</h3><div class="empty">Ajoute au moins 5 cartes : le jeu analysera comment leurs effets se combinent et te conseillera une stratégie.</div></div>`;
  const st = analyzeStrategy(cards);
  return `<div class="panel strat-panel">
    <h3 style="margin-top:0;">🧠 Stratégie conseillée</h3>
    <div class="strat-styles">${st.styles.map(x => `<div class="strat-style"><div class="strat-head"><span>${x.arch.icon}</span><b>${esc(x.arch.name)}</b>${st.styles.length > 1 ? `<em>${x.pct} %</em>` : ''}</div>
      <p>${esc(x.arch.plan)}</p><p class="strat-keep">🃏 ${esc(x.arch.keep)}</p>
      ${x.keyCards.length ? `<div class="strat-cards">${x.keyCards.map(c => cardChip(c.id)).join('')}</div>` : ''}</div>`).join('')}</div>
    ${st.interactions.length ? `<h4>Interactions entre tes cartes</h4><ul class="strat-inter">${st.interactions.slice(0, 8).map(f => `<li class="${f.explicit ? 'combo' : ''}">${cardChip(f.a.id)}<span class="strat-plus">+</span>${cardChip(f.b.id)}<span class="strat-why">${f.explicit ? '🔗 ' : ''}${esc(f.rule.text)}</span></li>`).join('')}</ul>` : '<p class="page-sub">Aucune interaction forte entre tes cartes pour l\'instant : les cartes en surbrillance dans ta collection peuvent en créer.</p>'}
    ${st.tips.length ? `<ul class="ds-tips">${st.tips.map(t => `<li class="warn"><span>⚠️</span>${esc(t)}</li>`).join('')}</ul>` : ''}
    ${st.isolated.length && cards.length >= 15 ? `<p class="page-sub" style="margin-bottom:6px;">Cartes qui n'interagissent avec aucune autre (à remplacer en priorité si ton deck manque de cohérence) :</p><div class="strat-cards">${st.isolated.slice(0, 10).map(c => cardChip(c.id)).join('')}</div>` : ''}
  </div>`;
}

function synergyFor(card, draft) {
  if (!card || draft.length < 3) return [];
  const out = [];
  // Interactions d'effets avec une carte précise du deck (dans les deux sens)
  const mine = cardRoles(card);
  INTERACTIONS.forEach(rule => {
    if (out.length >= 3) return;
    const partnerRole = mine.has(rule.a) ? rule.b : mine.has(rule.b) ? rule.a : null;
    if (!partnerRole) return;
    const partner = draft.find(c => c.id !== card.id && cardRoles(c).has(partnerRole));
    if (partner) out.push({ text: `Avec ${partner.name} : ${rule.text}` });
  });
  const has = (c, effs) => cardEffects(c).some(e => effs.includes(e));
  const inDraft = id => draft.some(c => c.id === id);
  // Combos
  const partnerOf = draft.find(c => c.comboPartnerId === card.id);
  if (partnerOf) out.push({ combo: true, text: `Combo avec ${partnerOf.name} : fait apparaître ${(cardById(partnerOf.comboSpawnId) || {}).name || 'une carte'}` });
  if (card.comboPartnerId && inDraft(card.comboPartnerId)) out.push({ combo: true, text: `Combo avec ${(cardById(card.comboPartnerId) || {}).name || 'une carte du deck'}` });
  const minions = draft.filter(c => c.type === 'minion').length;
  const spells = draft.filter(c => c.type !== 'minion' && c.type !== 'weapon').length;
  const summons = draft.filter(c => has(c, ['summon'])).length;
  const boosters = draft.filter(c => c.auraAttack || has(c, ['buff_all_allies'])).length;
  const sustain = draft.filter(c => has(c, ['heal', 'aoe_heal', 'armor', 'buff_ally_and_heal']) || c.armor).length;
  const chargers = draft.filter(c => c.charge || c.windfury).length;
  const attackBuffs = draft.filter(c => has(c, ['buff_attack', 'give_windfury', 'buff_all_allies'])).length;
  const taunts = draft.filter(c => c.taunt).length;
  const deathrattles = draft.filter(c => c.drEffect && c.type === 'minion').length;
  if ((card.auraAttack || has(card, ['buff_all_allies'])) && (minions >= 10 || summons >= 2)) out.push({ text: 'Renforce tes nombreux serviteurs' });
  if (has(card, ['summon']) && boosters >= 1) out.push({ text: 'Des jetons de plus pour tes bonus de zone' });
  if (card.taunt && sustain >= 2) out.push({ text: 'Tient la ligne avec tes soins et ton armure' });
  if (has(card, ['heal', 'aoe_heal', 'armor']) && taunts >= 3) out.push({ text: 'Fait durer tes Provocations' });
  if ((card.charge || card.windfury) && attackBuffs >= 2) out.push({ text: 'Frappe vite avec tes bonus d\'attaque' });
  if (has(card, ['buff_attack', 'give_windfury']) && chargers >= 3) out.push({ text: 'Booste tes serviteurs à Charge ou Furie' });
  if (has(card, ['draw']) && spells >= 8) out.push({ text: 'Recharge ta main pour tes nombreux sorts' });
  if (has(card, ['give_deathrattle', 'destroy']) && deathrattles >= 3) out.push({ text: "Va bien avec tes Râles d'agonie" });
  if (card.drEffect && card.type === 'minion' && draft.some(c => has(c, ['give_deathrattle']))) out.push({ text: "Profite de tes cartes à Râle d'agonie" });
  return out;
}

function renderDeckBuilder() {
  const draft = S.deckDraft || [];
  const counts = {};
  draft.forEach(id => { counts[id] = (counts[id] || 0) + 1; });
  const ownedAll = ownedCardsList(S.profile.collection);
  const decks = S.savedDecks || [];
  const f = S.deckFilter || { rarity: '', type: '', sort: 'cost' };
  const isSpell = c => c.type !== 'minion' && c.type !== 'weapon';
  // Recherche par nom : insensible aux majuscules et aux accents (« eclair » trouve « Éclair »)
  const q = normSearch(S.deckSearch || '');
  // Extension choisie (vide = toutes)
  const extOf = c => c.extensionId || 'base';
  const favSet = new Set(S.profile.favoriteCards || []);
  const matchType = c => (!f.type || (f.type === 'sort' ? isSpell(c) : c.type === f.type)) && (!q || normSearch(c.name).includes(q)) && (!f.ext || extOf(c) === f.ext) && (!f.fav || favSet.has(c.id));
  const ownedExts = [...new Set(ownedAll.map(x => extOf(x.card)))];
  const extName = id => ((S.extensions || []).find(e => e.id === id) || {}).name || (id === 'base' ? 'Base' : id);
  const extList = (S.extensions || []).map(e => e.id).filter(id => ownedExts.includes(id)).concat(ownedExts.filter(id => !(S.extensions || []).some(e => e.id === id)));
  const filtered = f.rarity || f.type || q || f.ext || f.fav;
  const owned = sortCardsForDeck(ownedAll.filter(x => (!f.rarity || x.card.rarity === f.rarity) && matchType(x.card)), f.sort, x => x.card);
  const rarityCount = r => ownedAll.filter(x => (!r || x.card.rarity === r) && matchType(x.card)).length;
  const deckCards = Object.keys(counts).map(id => cardById(id)).filter(Boolean);
  // Les onglets de rareté et le filtre de type s'appliquent aussi au deck en cours (affichage seulement)
  const deckSorted = sortCardsForDeck(deckCards.filter(c => (!f.rarity || c.rarity === f.rarity) && matchType(c)), f.sort);
  const draftCards = draft.map(id => cardById(id)).filter(Boolean);
  const typeBtn = (v, label) => `<button class="chip ${f.type === v ? 'active' : ''}" onclick="App.setDeckFilter('type', '${v}')">${label}</button>`;
  const P = {
    head: `
    <h1 class="page-title">${t('title.deck', 'Deck')} (${draft.length}/${DECK_SIZE})</h1>
    <p class="page-sub">${t('sub.deck', `Un deck de ${DECK_SIZE} cartes est requis pour combattre. Maximum 2 exemplaires par carte (1 pour les légendaires).`)}</p>`,
    decks: `
    <div class="panel">
      <h3 style="margin-top:0;">Mes decks (${decks.length}/12)</h3>
      ${decks.length === 0 ? '<div class="empty">Aucun deck enregistré pour l\'instant — construis un deck ci-dessous puis clique sur "Enregistrer sous...".</div>' :
        decks.map(d => {
          const isActive = d.id === S.profile.activeDeckId;
          return `<div class="row-card">
            <div class="info"><b>${esc(d.name)}</b> ${isActive ? '<span class="tag done">actif</span>' : ''} <span class="tone-tag">${(d.cardIds || []).length} cartes</span></div>
            <button class="btn small ghost" onclick="App.loadSavedDeckIntoDraft('${d.id}')">Modifier</button>
            <button class="btn small ${isActive ? 'ghost' : ''}" ${isActive ? 'disabled' : ''} onclick="App.activateSavedDeck('${d.id}')">Activer</button>
            <button class="btn small ghost" onclick="App.renameSavedDeck('${d.id}', ${jsArg(d.name)})">Renommer</button>
            <button class="btn small danger" onclick="App.deleteSavedDeck('${d.id}', ${jsArg(d.name)})">Supprimer</button>
          </div>`;
        }).join('')}
      <div class="btn-row"><button class="btn ghost small" onclick="App.saveDeckAs()">💾 Enregistrer le deck en cours sous un nom…</button></div>
    </div>`,
    tools: `
    <div class="panel deck-tools">
      <div class="btn-row" style="margin-top:0;">
        <button class="btn" ${draft.length !== DECK_SIZE ? 'disabled' : ''} onclick="App.saveDeck()">Enregistrer comme deck actif</button>
        <button class="btn ghost" onclick="App.autoFillDeck()">Remplissage automatique</button>
        <button class="btn ghost danger-text" ${draft.length === 0 ? 'disabled' : ''} onclick="App.clearDeckDraft()">Vider le deck</button>
      </div>
      <div class="practice-row">
        <button class="btn practice-btn" ${draft.length !== DECK_SIZE ? 'disabled title="Il faut un deck de 30 cartes"' : ''} onclick="App.startPractice()">🤖 S'entraîner contre le bot avec ce deck</button>
        <button class="btn ghost small" onclick="App.goTab('deckstats')">📊 Stats et conseils pour ce deck</button>
        <button class="btn ghost small" ${draft.length ? '' : 'disabled'} onclick="App.shareDeckImage()">🖼️ Partager en image</button>
        <span class="tone-tag">Sans risque ni récompense : à la fin, le bilan du combat t'attend dans « Stats du deck ».</span>
      </div>
      ${draftCards.length ? renderManaCurve(draftCards) : ''}
    </div>`,
    filters: `
    <div class="deck-filters">
      <div class="rarity-tabs" role="tablist" aria-label="Filtrer par rareté">
        ${[['', 'Toutes']].concat(RARITY_ORDER.map(r => [r, RARITIES[r].label])).map(([r, label]) => `<button role="tab" aria-selected="${(f.rarity || '') === r}" class="rtab ${(f.rarity || '') === r ? 'active' : ''}" style="${r ? `--rc:${RARITIES[r].color}` : ''}" onclick="App.setDeckFilter('rarity', '${r}')">${r ? '<span class="rdot"></span>' : ''}${label} <span class="rcount">${rarityCount(r)}</span></button>`).join('')}
      </div>
      <div class="deck-search">
        <span aria-hidden="true">🔍</span>
        <input type="text" enterkeyhint="search" id="deck-search" placeholder="Rechercher une carte par son nom…" value="${esc(S.deckSearch || '')}" oninput="App.setDeckSearch(this.value)" aria-label="Rechercher une carte par son nom" autocomplete="off">
        ${S.deckSearch ? `<button type="button" class="deck-search-clear" onclick="App.setDeckSearch('')" aria-label="Effacer la recherche">✕</button>` : ''}
      </div>
      <div class="deck-filter-row">
        <div class="chips">${typeBtn('', 'Tous types')}${typeBtn('minion', 'Serviteurs')}${typeBtn('sort', 'Sorts')}${typeBtn('weapon', 'Armes')}<button class="chip fav-chip ${f.fav ? 'active' : ''}" onclick="App.setDeckFilter('fav', ${f.fav ? 'false' : 'true'})">★ Favoris</button></div>
        ${extList.length > 1 || f.ext ? `<label class="sort-label">Extension <select onchange="App.setDeckFilter('ext', this.value)" aria-label="Afficher les cartes d'une seule extension">
          <option value="" ${!f.ext ? 'selected' : ''}>Toutes les extensions</option>
          ${extList.map(id => `<option value="${esc(id)}" ${f.ext === id ? 'selected' : ''}>${esc(extName(id))} (${ownedAll.filter(x => extOf(x.card) === id).length})</option>`).join('')}
        </select></label>` : ''}
        <label class="sort-label">Trier par <select onchange="App.setDeckFilter('sort', this.value)">${Object.keys(DECK_SORTS).map(k => `<option value="${k}" ${f.sort === k ? 'selected' : ''}>${DECK_SORTS[k]}</option>`).join('')}</select></label>
      </div>
    </div>`,
    deck: `
    <h3>Deck en cours${filtered ? ' (filtré)' : ''}</h3>
    ${deckSorted.length === 0 ? (deckCards.length ? '<div class="empty">Aucune carte du deck ne correspond à ces filtres.</div>' : '<div class="empty">Clique sur des cartes de ta collection pour les ajouter.</div>') :
      `<div class="grid">${deckSorted.map(c => renderCardTile(c, { count: counts[c.id], onClick: `App.removeFromDeck('${c.id}')` })).join('')}</div>`}`,
    coll: `
    <h3>Ta collection${filtered ? ` (${owned.length} carte${owned.length > 1 ? 's' : ''} trouvée${owned.length > 1 ? 's' : ''})` : ''}</h3>
    ${ownedAll.length === 0 ? '<div class="empty">Ouvre des boosters pour obtenir des cartes.</div>' : owned.length === 0 ? '<div class="empty">Aucune carte ne correspond à ces filtres.</div>' :
      `<div class="grid">${(() => {
        // Synergies : on ne met en avant que les meilleures cartes (pas encore
        // dans le deck), sinon tout s'allume et ça ne veut plus rien dire.
        const draftCards = deckDraftCards();
        const scored = owned.filter(x => !counts[x.card.id]).map(x => ({ id: x.card.id, syn: synergyFor(x.card, draftCards) }))
          .filter(x => x.syn.length).sort((a, b) => (b.syn.some(y => y.combo) - a.syn.some(y => y.combo)) || b.syn.length - a.syn.length);
        S.__synTop = new Map(scored.slice(0, 10).map(x => [x.id, x.syn]));
        return '';
      })()}${owned.map(x => {
        const inDeck = counts[x.card.id] || 0;
        const limit = COPY_LIMITS[x.card.rarity] || 2;
        const full = inDeck >= Math.min(limit, x.count);
        const syn = S.__synTop.get(x.card.id) || [];
        return renderCardTile(x.card, { count: x.count, fav: true, selected: inDeck > 0, onClick: full ? '' : `App.addToDeck('${x.card.id}')`,
          synergy: syn, footer: inDeck ? `Dans le deck : ${inDeck}/${Math.min(limit, x.count)}` : (syn.length ? `${syn.some(y => y.combo) ? '🔗' : '✨'} ${syn[0].text}` : '') });
      }).join('')}</div>`}
  `
  };
  // Grand écran : deux colonnes, la collection à gauche et le deck toujours visible à droite
  if (deckWideLayout()) {
    const list = sortCardsForDeck(deckCards, 'cost');
    return P.head + `<div class="db-layout">
      <div class="db-main">${P.filters}${P.coll}</div>
      <aside class="db-side">
        <div class="db-side-head"><b>Deck en cours</b><span class="db-count ${draft.length === DECK_SIZE ? 'full' : ''}">${draft.length}/${DECK_SIZE}</span></div>
        <div class="db-actions">
          <button class="btn" ${draft.length !== DECK_SIZE ? 'disabled' : ''} onclick="App.saveDeck()">Enregistrer comme deck actif</button>
          <div class="db-actions-row">
            <button class="btn ghost small" onclick="App.autoFillDeck()" title="Remplissage automatique">✨ Compléter</button>
            <button class="btn ghost small" onclick="App.saveDeckAs()" title="Enregistrer sous un nom">💾 Sous un nom</button>
            <button class="btn ghost small danger-text" ${draft.length === 0 ? 'disabled' : ''} onclick="App.clearDeckDraft()">Vider</button>
          </div>
          <div class="db-actions-row">
            <button class="btn ghost small" ${draft.length !== DECK_SIZE ? 'disabled' : ''} onclick="App.startPractice()">🤖 S'entraîner</button>
            <button class="btn ghost small" onclick="App.goTab('deckstats')">📊 Stats</button>
            <button class="btn ghost small" ${draft.length ? '' : 'disabled'} onclick="App.shareDeckImage()">🖼️ Image</button>
          </div>
        </div>
        <div class="db-list">${list.length ? list.map(c => `<button class="db-row" style="--rc:${(RARITIES[c.rarity] || {}).color || '#888'}" onclick="App.removeFromDeck('${c.id}')" title="Retirer ${esc(c.name)} du deck">
          <i>${c.cost}</i><span>${esc(c.name)}</span>${counts[c.id] > 1 ? `<b>×${counts[c.id]}</b>` : ''}<em>−</em></button>`).join('') : '<div class="empty">Clique sur des cartes de ta collection pour les ajouter.</div>'}</div>
        ${draftCards.length ? `<details class="db-fold" ${S.__dbCurve === false ? '' : 'open'} ontoggle="S.__dbCurve = this.open"><summary>Courbe de mana</summary>${renderManaCurve(draftCards)}</details>` : ''}
        <details class="db-fold" ${S.__dbStrat ? 'open' : ''} ontoggle="S.__dbStrat = this.open"><summary>🧠 Stratégie conseillée</summary>${renderStrategyPanel(draftCards)}</details>
        <details class="db-fold" ${S.__dbDecks ? 'open' : ''} ontoggle="S.__dbDecks = this.open"><summary>Mes decks (${decks.length}/12)</summary>${P.decks}</details>
      </aside>
    </div>`;
  }
  return P.head + P.decks + P.tools + `
    ${renderStrategyPanel(draftCards)}` + P.filters + P.deck + P.coll;
}

function deckWideLayout() { return typeof window !== 'undefined' && !phoneUI() && window.innerWidth >= 1150; }

/* ---------- Replays : Combat → Historique ---------- */
const REPLAY_MODES = { practice: 'Entraînement', pvp: 'Joueur contre joueur', bot: 'Bot', boss: 'Boss', story: 'Histoire', tournament: 'Tournoi', survival: 'Survie', blitz: 'Blitz', draft: 'Draft', brawl: 'Bagarre', duel: 'Duel entre amis', puzzle: 'Puzzle' };
function renderReplayHistory() {
  const list = S.replayList;
  if (!list) return '';
  return `<div class="panel"><h3 style="margin-top:0;">Historique des combats</h3>
    ${list.length === 0 ? '<div class="empty">Tes combats apparaîtront ici : tu pourras les revoir action par action.</div>' :
      `<div class="rp-list">${list.map(r => `<div class="rp-item ${r.result}">
        <span class="rp-res">${r.result === 'win' ? 'Victoire' : r.result === 'loss' ? 'Défaite' : 'Égalité'}</span>
        <span>${esc(REPLAY_MODES[r.mode] || r.mode)} · contre <b>${esc(r.opponent || '?')}</b> · ${r.turns} tours</span>
        <span class="rp-date">${new Date(r.at).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
        <button class="btn small" onclick="App.openReplay('${esc(r.id)}')">▶ Revoir</button>
      </div>`).join('')}</div>`}
  </div>`;
}
/* ---------- Prévisualisation des dégâts ----------
   Quand un attaquant est sélectionné, chaque cible ennemie affiche ce qui se
   passera : PV restants de la cible et de l'attaquant, crâne si l'un meurt.
   Au survol sur PC, en permanence sur écran tactile. Mêmes règles que le
   moteur : Bouclier ignore le coup, l'armure d'un serviteur absorbe d'abord. */
function previewHit(m, amount) {
  if (amount <= 0) return { hp: m.health, shield: false };
  if (m.shield) return { hp: m.health, shield: true };
  const left = Math.max(0, amount - (m.armor || 0));
  return { hp: m.health - left, shield: false };
}
function attackPreview(target, isHero) {
  const st = S.matchState;
  if (!st || !S.selectedAttacker || !st.yourTurn) return '';
  const heroAtk = S.selectedAttacker === 'hero';
  const a = heroAtk ? null : st.you.board.find(m => m.instanceId === S.selectedAttacker);
  if (!heroAtk && !a) return '';
  const power = heroAtk ? ((st.you.weapon || {}).attack || 0) : a.attack;
  if (isHero) {
    if (st.opponent.hasTaunt) return '';
    const armor = st.opponent.heroArmor || 0, hpLeft = st.opponent.heroHealth - Math.max(0, power - armor);
    return `<div class="dmg-preview hero"><span class="dp-line ${hpLeft <= 0 ? 'dead' : ''}">${hpLeft <= 0 ? '💀 Victoire !' : `❤ ${st.opponent.heroHealth} → <b>${hpLeft}</b>`}</span><span class="dp-mini"><b class="${hpLeft <= 0 ? 'dead' : ''}">${hpLeft <= 0 ? '💀' : '❤' + hpLeft}</b></span></div>`;
  }
  if (target.stealth || (st.opponent.hasTaunt && !target.taunt)) return '';
  const t = previewHit(target, power);
  const tDead = t.hp <= 0;
  let back;
  if (heroAtk) { const hp = st.you.heroHealth - Math.max(0, target.attack); back = { label: 'Ton héros', hp, dead: hp <= 0, shield: false }; }
  else { const r = previewHit(a, target.attack); back = { label: a.name, hp: r.hp, dead: r.hp <= 0, shield: r.shield }; }
  return `<div class="dmg-preview">
    <span class="dp-line ${tDead ? 'dead' : ''}">${t.shield ? '🛡 coup bloqué' : tDead ? '💀 détruit' : `❤ <b>${t.hp}</b> restant${t.hp > 1 ? 's' : ''}`}</span>
    <span class="dp-line back ${back.dead ? 'dead' : ''}" title="${esc(back.label)}">↩ ${back.shield ? '🛡 riposte bloquée' : back.dead ? '💀 ' + (heroAtk ? 'ton héros' : 'le tien meurt') : `le tien : ❤ <b>${back.hp}</b>`}</span>
    <span class="dp-mini"><b class="${tDead ? 'dead' : ''}">${t.shield ? '🛡' : tDead ? '💀' : '❤' + t.hp}</b><i class="${back.dead ? 'dead' : ''}">↩${back.shield ? '🛡' : back.dead ? '💀' : back.hp}</i></span>
  </div>`;
}
function replayMinion(m) {
  const cls = ['minion'];
  if (m.taunt) cls.push('taunt'); if (m.shield) cls.push('kw-shield'); if (m.stealth) cls.push('kw-stealth'); if (m.asleep) cls.push('asleep');
  if (m.standLevel > 0) cls.push('stand-lv', 'stand-lv' + m.standLevel);
  if (m.silenced) cls.push('silenced');
  return `<div class="${cls.join(' ')}" title="${esc(m.name)}" onclick="App.open3DView('${esc(m.cardId)}')">
    <div class="minion-portrait-wrap">
      ${(m.windfury || m.drEffect) ? `<span class="kw-badges">${m.windfury ? '<i>🌀</i>' : ''}${m.drEffect ? '<i>💀</i>' : ''}</span>` : ''}
      ${m.taunt ? '<div class="taunt-shield"><svg viewBox="0 0 24 24"><path d="M12 1.5 4 4.5v6c0 5.2 3.4 9.6 8 11 4.6-1.4 8-5.8 8-11v-6L12 1.5z"/></svg></div>' : ''}
      <div class="minion-portrait">${m.image ? `<img src="${esc(m.image)}" alt="">` : `<span class="minion-portrait-fallback">${esc((m.name || '?').slice(0, 1))}</span>`}</div>
    </div>
    <div class="minion-name">${esc(m.name)}</div><div class="atk-gem">${m.attack}</div><div class="hp-gem-minion">${m.health}</div>
  </div>`;
}
function renderReplayViewer() {
  const R = S.replay;
  if (!R || !R.data) return `<h1 class="page-title">Revoir un combat</h1><div class="panel">${skeletonRows(4)}</div>`;
  const rp = R.data, frames = rp.frames, idx = Math.min(R.idx, frames.length - 1), f = frames[idx];
  const meI = Math.max(0, rp.players.findIndex(p => p.slug === R.viewer)), opI = 1 - meI;
  const prevSeq = idx > 0 ? frames[idx - 1].lastSeq : 0;
  const stepEvents = rp.events.filter(e => e.seq > prevSeq && e.seq <= f.lastSeq);
  const rows = replayFeedRows(rp, meI, stepEvents);
  return `<div class="rp-head"><h1 class="page-title" style="margin:0;">Revoir le combat</h1><button class="btn ghost small" onclick="App.closeReplay()">✕ Fermer</button></div>
    <div class="rp-controls panel">
      <button class="btn small ghost" onclick="App.replayGo(0)" title="Début">⏮</button>
      <button class="btn small ghost" onclick="App.replayStep(-1)" title="Action précédente">◀</button>
      <button class="btn small" onclick="App.replayToggle()">${R.playing ? '⏸ Pause' : '▶ Lecture'}</button>
      <button class="btn small ghost" onclick="App.replayStep(1)" title="Action suivante">▶</button>
      <button class="btn small ghost" onclick="App.replayGo(${frames.length - 1})" title="Fin">⏭</button>
      <input type="range" min="0" max="${frames.length - 1}" value="${idx}" oninput="App.replayGo(+this.value)" aria-label="Position dans le combat">
      <span class="rp-pos">Tour ${f.turnNumber} · étape ${idx + 1}/${frames.length}</span>
      <button class="btn small ghost" onclick="App.replaySpeed()">×${R.speed}</button>
    </div>
    ${replayBoardHtml(rp, f, meI, rows, 'Cette étape', false)}`;
}
/* Journal d'événements, du point de vue du joueur affiché en bas */
function replayFeedRows(rp, meI, events, spectator) {
  const saved = S.matchState;
  S.matchState = spectator
    ? { you: { slug: '__spectateur__' }, opponent: { pseudo: '' }, names: Object.fromEntries(rp.players.map(p => [p.slug, p.pseudo])) }
    : { you: { slug: rp.players[meI].slug }, opponent: { pseudo: rp.players[1 - meI].pseudo } };
  const rows = events.map(e => feedRow(e, false)).join('');
  S.matchState = saved;
  return rows;
}
/* Plateau « neutre » (mains cachées) : replays et mode spectateur */
function replayBoardHtml(rp, f, meI, rows, sideTitle, spectator) {
  const opI = 1 - meI;
  const pl = i => rp.players[i], fp = i => f.players[i];
  const hero = (i, top) => `<div class="hero-row ${top ? 'opp' : ''}">
      <div class="hero-info"><div class="hero-name">${esc(pl(i).pseudo)}${!spectator && i === meI ? ' (toi)' : ''}</div><div class="hero-sub">${fp(i).hand} en main · ${fp(i).deck} en pioche</div></div>
      <div class="hero-center">${fp(i).weapon ? `<div class="weapon-badge" title="${esc(fp(i).weapon.name)}"><span class="weapon-fallback">🪓</span><span class="gem weapon-atk-gem">${fp(i).weapon.attack}</span><span class="gem weapon-durability-gem">${fp(i).weapon.durability}</span></div>` : ''}
        <div class="hero-portrait-wrap">${avatarHtml(pl(i).pseudo, pl(i).avatar, pl(i).ornament)}${armorGem(fp(i).armor)}<div class="hp-gem">${Math.max(0, fp(i).hp)}</div></div></div>
      <div class="hero-mana"><span class="mana-count">${fp(i).mana}/${fp(i).maxMana}</span></div>
    </div>`;
  const turnLabel = spectator ? `Tour de ${esc(pl(f.turn).pseudo)}` : (f.turn === meI ? 'Ton tour' : 'Tour de ' + esc(pl(opI).pseudo));
  return `<div class="rp-layout">
      <div class="board-screen premium arena-v2 rp-board">
        ${hero(opI, true)}
        <div class="arena-table">
          <div class="board-row">${fp(opI).board.length ? fp(opI).board.map(replayMinion).join('') : '<span class="empty board-empty">Plateau vide</span>'}</div>
          <div class="board-divider"><span class="helper-text">${turnLabel}</span></div>
          <div class="board-row mine">${fp(meI).board.length ? fp(meI).board.map(replayMinion).join('') : '<span class="empty board-empty">Plateau vide</span>'}</div>
        </div>
        ${hero(meI, false)}
      </div>
      <aside class="panel rp-events"><h4 style="margin-top:0;">${sideTitle}</h4>${rows || '<div class="empty">Début du tour.</div>'}</aside>
    </div>`;
}

/* ---------- Mode spectateur ---------- */
const SPECTATE_MODES = { pvp: 'Classé', blitz: 'Blitz', tournament: 'Tournoi', survival: 'Survie', draft: 'Draft', bot: 'Contre le bot' };
function renderSpectate() {
  const sp = S.spectate, d = sp && sp.data;
  if (!d) return `<div class="rp-head"><h1 class="page-title" style="margin:0;">👁 Spectateur</h1><button class="btn ghost small" onclick="App.stopSpectate()">✕ Quitter</button></div>${skeletonPage('', 'rows')}`;
  const finished = d.status === 'finished';
  const winner = finished ? d.players.find(p => p.slug === d.winner) : null;
  const rows = replayFeedRows({ players: d.players }, 0, d.events.slice(-12).reverse(), true);
  const status = finished ? `🏁 Combat terminé${winner ? ` : victoire de <b>${esc(winner.pseudo)}</b>` : ''}`
    : sp.ended ? '⏸ Le combat a été mis en pause.'
    : d.phase === 'mulligan' ? 'Les joueurs choisissent leur main de départ…'
    : `Tour ${d.frame.turnNumber} · ${esc(d.players[d.frame.turn].pseudo)} joue`;
  return `<div class="rp-head"><h1 class="page-title" style="margin:0;">${finished || sp.ended ? '👁' : '<span class="live-dot"></span>'} ${esc(d.players[1].pseudo)} contre ${esc(d.players[0].pseudo)}</h1>
      <button class="btn ghost small" onclick="App.stopSpectate()">✕ Quitter</button></div>
    <div class="panel spec-bar"><span class="spec-mode">${SPECTATE_MODES[d.mode] || 'Combat'}</span><span>${status}</span><span class="spec-count">👁 ${d.spectators} spectateur${d.spectators > 1 ? 's' : ''}</span>
      <small>Les cartes en main restent cachées.</small></div>
    ${replayBoardHtml({ players: d.players }, d.frame, 0, rows, 'En direct', true)}`;
}
function renderLiveMatches(compact) {
  const list = S.liveMatches;
  if (!list || !list.length) return compact ? '' : `<div class="panel"><h3 style="margin-top:0;">👁 En direct</h3><div class="empty">Aucun combat de tes amis ou du tournoi en ce moment.</div>
    <div class="btn-row"><button class="btn small ghost" onclick="App.loadLive(true)">↻ Rafraîchir</button></div></div>`;
  return `<div class="panel live-panel"><h3 style="margin-top:0;"><span class="live-dot"></span> En direct</h3>
    <div class="live-list">${list.map(m => `<div class="live-row">
      <div class="live-vs">${avatarHtml(m.players[0].pseudo, m.players[0].avatar, m.players[0].ornament, 'sm')}<b>${esc(m.players[0].pseudo)}</b><small>${m.players[0].hp} PV</small>
        <span class="live-sep">vs</span>
        <b>${esc(m.players[1].pseudo)}</b><small>${m.players[1].hp} PV</small></div>
      <span class="spec-mode">${SPECTATE_MODES[m.mode] || ''}</span><small class="live-turn">Tour ${m.turnNumber}${m.spectators ? ` · 👁 ${m.spectators}` : ''}</small>
      <button class="btn small" onclick="App.spectate('${esc(m.matchId)}')">👁 Regarder</button></div>`).join('')}</div>
    <div class="btn-row"><button class="btn small ghost" onclick="App.loadLive(true)">↻ Rafraîchir</button></div></div>`;
}

function renderCombat() {
  if (S.replay) return renderReplayViewer();
  const inner = renderCombatInner();
  if (S.queueStatus === 'in-match' && S.matchState) return inner;
  if (!phoneUI() && S.queueStatus !== 'waiting') return inner; // les défis du jour sont déjà en haut de la page Jouer
  return inner + renderDailyPanel(S.profile, true);
}
function renderCombatInner() {
  if (S.queueStatus === 'in-match' && S.matchState) return renderBoardScreen();

  const friends = S.friends || [];
  if (S.queueStatus === 'waiting') {
    return `<h1 class="page-title">${phoneUI() ? 'Combat' : 'Jouer'}</h1>
    <div class="panel" style="text-align:center;">
      <div style="font-size:15px;font-weight:700;color:var(--accent);">${S.queueBlitz ? '⚡ Recherche d\'un adversaire Blitz…' : 'Recherche d\'un adversaire…'}</div>
      <p class="page-sub" style="margin:10px auto 0;">Ouvre le jeu dans une autre fenêtre (ou demande à un ami) pour te matcher.</p>
      <button class="btn ghost" onclick="App.leaveQueue()">Annuler</button>
    </div>`;
  }
  // Ordinateur : la page « Jouer » réunit l'ancien Accueil et l'ancien Combat
  const pcHub = !phoneUI();
  return `${pcHub ? renderHomePC() : `<h1 class="page-title">Combat</h1>
    <p class="page-sub">${t('sub.combat', "Affronte un joueur au hasard, ou défie directement un ami connecté. Chaque victoire rapporte entre +10 et +29 points de classement et 20 ✧.")}</p>
    ${renderModeTiles()}
    ${renderCommunityPanel()}`}
    ${renderLiveMatches(true)}
    <div class="panel">
      <h3 style="margin-top:0;">Défier un ami</h3>
      ${duelModeChips()}
      ${friends.length === 0 ? '<div class="empty">Ajoute des amis dans Social → Joueurs pour pouvoir les défier.</div>' :
        `<div class="player-list">${friends.map(f => `
          <div class="player-row">
            <div style="display:flex;align-items:center;gap:10px;">
              ${avatarHtml(f.pseudo, f.avatar, f.ornament, 'sm')}
              <div><b>${esc(f.pseudo)}</b> ${rankPill(f.rank)}<br>
                <span style="font-size:12px;color:var(--muted);"><span class="online-dot ${f.online ? 'on' : ''}"></span>${f.online ? 'en ligne' : 'hors ligne'}</span>
              </div>
            </div>
            ${f.inMatch && f.watchable ? `<button class="btn small ghost" onclick="App.spectateFriend('${f.slug}')">👁 Regarder</button>` : `<button class="btn small" ${f.online && !f.inMatch ? '' : 'disabled'} onclick="App.challengeFriend('${f.slug}', S.duelMode)">${f.inMatch ? 'En combat' : 'Défier'}</button>`}
          </div>`).join('')}</div>`}
    </div>
    ${renderReplayHistory()}`;
}

/* ======================================================
   MODES : Survie, Blitz, objectif communautaire
   ====================================================== */
function loadSurvival() { return api('/api/survival').then(r => { S.survival = r; render(); }).catch(e => { S.survival = { error: e.message }; render(); }); }
function loadCommunity() { return api('/api/community').then(r => { S.community = r.community; render(); }).catch(() => {}); }
function pushToast(text, kind) {
  const t = { id: Math.random(), text, kind: kind || 'info' };
  S.toasts = (S.toasts || []).concat([t]);
  t.timer = setTimeout(() => { S.toasts = (S.toasts || []).filter(y => y !== t); render(); }, 6000);
  render();
}
function timeLeftLabel(ms) {
  const h = Math.max(0, Math.floor(ms / 3600000));
  return h >= 48 ? `${Math.floor(h / 24)} jours` : h >= 1 ? `${h} h` : `${Math.max(1, Math.ceil(ms / 60000))} min`;
}

/* Objectif communautaire de la semaine (Combat, Accueil téléphone) */
function renderCommunityPanel(compact) {
  const c = S.community;
  if (!c) return '';
  const pct = Math.min(100, Math.round(c.progress / (c.goal.target || 1) * 100));
  return `<div class="panel community-panel ${c.completed ? 'done' : ''}">
    <div class="community-head"><span class="community-ico">${esc(c.goal.icon || '🤝')}</span>
      <div><div class="community-kicker">Objectif communautaire de la semaine</div><b>${esc(c.goal.text)}</b></div>
      <span class="community-time">${c.completed ? '✅ Atteint !' : `⏳ ${timeLeftLabel(c.endsAt - Date.now())}`}</span></div>
    <div class="community-bar"><i style="width:${pct}%"></i><span>${c.progress} / ${c.goal.target}</span></div>
    <div class="community-meta">
      <span>Ta participation : <b>${c.mine}</b></span><span>${c.players} joueur${c.players > 1 ? 's' : ''}</span>
      <span>Récompense : 🎁 booster + ${c.reward.credits} 🪙 + bannière « Esprit de gang »</span>
    </div>
    ${!compact && c.top && c.top.length ? `<div class="community-top">${c.top.map((t, i) => `<span>${['🥇', '🥈', '🥉'][i]} ${esc(t.pseudo)} <small>${t.amount}</small></span>`).join('')}</div>` : ''}
    ${c.completed ? `<p class="page-sub" style="margin:6px 0 0;">${c.rewarded ? 'Ta récompense est dans ta réserve de boosters.' : 'Participe une fois cette semaine pour recevoir toi aussi la récompense !'}</p>`
      : `<p class="page-sub" style="margin:6px 0 0;">Tous les joueurs avancent ensemble. Si l'objectif est atteint, chaque participant reçoit la récompense. Nouvel objectif chaque lundi.</p>`}
  </div>`;
}

/* Grille des modes de jeu (Combat et Accueil PC) */
function renderModeTiles() {
  const p = S.profile, sv = p.survival || {};
  const tiles = [
    { cls: 'ranked', ic: '⚔️', name: 'Classé', sub: `Affronte un joueur au hasard · ${p.rank ? esc(p.rank.label || '') : ''}`, act: 'App.joinQueue()', cta: 'Rechercher', alts: [["App.openDuel('normal')", '👥 Défier un ami']] },
    { cls: 'blitz', ic: '⚡', name: 'Blitz', sub: 'Tours de 20 s, 3 mana dès le départ', act: 'App.joinQueue(true)', cta: 'Rechercher', alts: [['App.blitzBot()', 'contre le bot'], ["App.openDuel('blitz')", '👥 Ami']] },
    { cls: 'puzzle', ic: '🧩', name: 'Puzzle du jour', sub: (p.puzzle || {}).solvedToday ? `Réussi aujourd'hui ✔${(p.puzzle || {}).streak > 1 ? ` · série de ${p.puzzle.streak} jours` : ''}` : 'Gagne en un seul tour', act: "App.goTab('puzzle')", cta: (p.puzzle || {}).solvedToday ? 'Voir' : 'Jouer' },
    { cls: 'brawl', ic: '🥊', name: 'Bagarre de la semaine', sub: (p.brawl && p.brawl.rule) ? `${p.brawl.rule.icon} ${esc(p.brawl.rule.name)}${p.brawl.firstDone ? '' : ' · 1re victoire : booster'}` : 'Une règle spéciale chaque lundi', act: "App.goTab('bagarre')", cta: 'Jouer', alts: [["App.openDuel('brawl')", '👥 Défier un ami']] },
    { cls: 'draft', ic: '🃏', name: 'Draft', sub: (p.draft || {}).run ? `En cours : ${p.draft.run.picks < 30 ? `choix ${p.draft.run.picks + 1}/30` : `${p.draft.run.wins} V · ${p.draft.run.losses} D`}` : (p.draft || {}).free ? 'Entrée gratuite disponible' : `Ton record : ${(p.draft || {}).best || 0} victoire${((p.draft || {}).best || 0) > 1 ? 's' : ''}`, act: "App.goTab('draft')", cta: (p.draft || {}).run ? 'Continuer' : 'Jouer', alts: (p.draft || {}).run && p.draft.run.picks >= 30 ? [["App.openDuel('draft')", '👥 Duel']] : [] },
    { cls: 'survie', ic: '🏔️', name: 'Survie', sub: sv.run ? `Partie en cours : manche ${sv.run.round}` : `Ton record : ${sv.best || 0} manche${(sv.best || 0) > 1 ? 's' : ''}`, act: "App.goTab('survie')", cta: sv.run ? 'Reprendre' : 'Jouer' },
    ...(S.story && S.story.tabEnabled ? [{ cls: 'story', ic: '🗺️', name: 'Histoire', sub: (() => { const ch = S.story.chapters || []; return ch.length ? `${ch.filter(c => c.cleared).length} / ${ch.length} chapitres` : 'Affronte les boss'; })(), act: "App.goTab('histoire')", cta: 'Continuer' }] : []),
    ...(S.tournament && S.tournament.tabEnabled ? [{ cls: 'tour', ic: '🎖️', name: 'Tournoi', sub: S.tournament.current ? ({ registration: 'Inscriptions ouvertes', running: 'En cours', finished: 'Terminé' }[S.tournament.current.status] || '') : 'Aucun tournoi pour le moment', act: "App.goTab('tournoi')", cta: 'Voir' }] : []),
    ...(S.events && S.events.tabEnabled ? [{ cls: 'event', ic: '🎉', name: 'Événements', sub: 'Boss du jour et mini-jeux', act: "App.goTab('evenements')", cta: 'Voir' }] : []),
    { cls: 'practice', ic: '🤖', name: 'Entraînement', sub: 'Contre le bot, avec ton deck actif, sans risque', act: 'App.practiceActiveDeck()', cta: "S'entraîner" }
  ];
  return `<div class="mode-grid">${tiles.map(m => `<div class="mode-tile m-${m.cls}" onclick="${m.act}" role="button" tabindex="0">
    <div class="mode-ico">${m.ic}</div>
    <div class="mode-txt"><b>${m.name}</b><small>${m.sub}</small></div>
    <div class="mode-cta"><span class="btn small">${m.cta}</span>${(m.alts || (m.alt ? [m.alt] : [])).map(a => `<button class="btn small ghost" onclick="event.stopPropagation();${a[0]}">${a[1]}</button>`).join('')}</div>
  </div>`).join('')}</div>`;
}

/* Accueil sur ordinateur : tout l'essentiel dès l'arrivée */
function renderHomePC() {
  const p = S.profile, pr = p.progress || {}, ps = S.packStatus || {};
  const pct = pr.xpNext ? Math.round(pr.xp / pr.xpNext * 100) : 100;
  const daily = pr.daily || [];
  const inv = (p.boosterInventory || []).length;
  const sv = p.survival || {};
  return `<div class="home-hero ${p.banner && bannerById(p.banner) ? 'has-banner' : ''}" style="${bannerStyle(p.banner)}">
      <div class="home-id">
        ${avatarHtml(p.pseudo, p.avatar, p.ornament)}
        <div><div class="home-name">${esc(p.pseudo)} ${rankPill(p.rank)}</div>${titleLine(p.titleName)}
          <div class="home-lvl"><b>Niveau ${pr.level || 1}</b><span class="xp-bar big"><i style="width:${pct}%"></i></span><small>${pr.xpNext ? `${pr.xp} / ${pr.xpNext} XP` : ''}</small></div></div>
      </div>
      <div class="home-play">
        <button class="btn home-play-btn" onclick="App.joinQueue()">⚔️ JOUER</button>
        <button class="btn ghost" onclick="App.joinQueue(true)">⚡ Blitz</button>
      </div>
    </div>
    <div class="home-row">
      <div class="panel home-card" onclick="App.goTab('boosters')" role="button">
        <div class="home-card-h">🎁 Boosters</div>
        ${ps.ready ? '<b class="home-big ok">Booster gratuit prêt !</b>' : `<b class="home-big">${ps.remainingMs ? fmtLongCountdown(ps.remainingMs) : '—'}</b><small>avant le prochain booster gratuit</small>`}
        ${inv ? `<small>${inv} booster${inv > 1 ? 's' : ''} en réserve</small>` : ''}
        <span class="btn small">${ps.ready ? 'Ouvrir' : 'Voir'}</span>
      </div>
      <div class="panel home-card" onclick="App.goTab('survie')" role="button">
        <div class="home-card-h">🏔️ Survie</div>
        <b class="home-big">${sv.run ? `Manche ${sv.run.round}` : `Record : ${sv.best || 0}`}</b>
        <small>${sv.run ? `${sv.run.hp} PV · partie en cours` : 'Deck au hasard, difficulté croissante'}</small>
        <span class="btn small">${sv.run ? 'Reprendre' : 'Jouer'}</span>
      </div>
      <div class="panel home-card home-daily">
        <div class="home-card-h">🎯 Défis du jour <span>${daily.filter(d => d.done).length} / ${daily.length}</span></div>
        ${daily.map(d => `<div class="mh-daily ${d.done ? 'done' : ''}"><span>${d.done ? '✅' : '🎯'} ${esc(d.text)}</span><div class="xp-bar"><i style="width:${Math.round(d.progress / d.target * 100)}%"></i></div></div>`).join('') || '<small>Reviens demain pour de nouveaux défis.</small>'}
      </div>
    </div>
    ${renderCommunityPanel(true)}
    <h3 class="home-sec">Modes de jeu</h3>
    ${renderModeTiles()}`;
}

/* Panneau Blitz (onglet Combat) */
function renderBlitzPanel() {
  return `<div class="panel blitz-panel">
    <div class="blitz-head"><span class="blitz-ico">⚡</span><div><b>Mode Blitz</b><div class="page-sub" style="margin:2px 0 0;">Tours de 20 secondes et 3 cristaux de mana dès le départ : des parties de 5 minutes, idéales sur téléphone. Pas de points de classement.</div></div></div>
    <div class="btn-row" style="margin-top:10px;">
      <button class="btn" onclick="App.joinQueue(true)">⚡ Rechercher un adversaire Blitz</button>
      <button class="btn ghost" onclick="App.blitzBot()">🤖 S'entraîner en Blitz contre le bot</button>
    </div>
  </div>`;
}

/* Onglet Survie */
/* ---------- Puzzle du jour ---------- */
function loadPuzzle() { return api('/api/puzzle').then(r => { S.puzzle = r; render(); }).catch(e => { S.puzzle = { error: e.message }; render(); }); }
function pzMinion(c, enemy) {
  return `<div class="pz-minion ${enemy ? 'enemy' : ''} rar-${esc(c.rarity)}" style="--rarity:${(RARITIES[c.rarity] || {}).color || '#888'}" onclick="App.open3DView('${esc(c.id)}')" title="${esc(cardEffectSummary(Object.assign({}, c, { type: 'minion' })) || c.name)}">
    ${c.taunt ? '<span class="pz-taunt" title="Provocation">🛡️</span>' : ''}
    <div class="pz-art">${c.image ? `<img src="${esc(c.image)}" alt="">` : `<span>${esc((c.name || '?').slice(0, 1))}</span>`}</div>
    <b>${esc(c.name)}</b>
    <div class="pz-stats"><span class="a">${c.attack}</span><span class="h">${c.health}</span></div>
    <small>${esc([c.charge ? 'Charge' : '', c.windfury ? 'Furie' : '', c.shield ? 'Bouclier' : '', c.stealth ? 'Camouflage' : '', c.rage ? 'Rage' : ''].filter(Boolean).join(' · '))}</small>
  </div>`;
}
function renderPuzzle() {
  const d = S.puzzle;
  if (!d) return skeletonPage('🧩 Puzzle du jour', 'grid');
  if (d.error) return `<div class="empty">${esc(d.error)}</div>`;
  const admin = S.isAdmin ? `<div class="panel"><h3 style="margin-top:0;">Admin</h3><div class="btn-row" style="margin-top:0;"><button class="btn small ghost" onclick="App.adminPuzzleRegen()">↻ Fabriquer un autre puzzle pour aujourd'hui</button></div></div>` : '';
  if (!d.available) return `<h1 class="page-title">🧩 Puzzle du jour</h1><div class="panel"><div class="empty">Pas de puzzle aujourd'hui : il n'a pas pu être fabriqué avec les cartes actuelles.</div></div>${admin}`;
  const pz = d.puzzle;
  const stars = '★'.repeat(pz.difficulty) + '☆'.repeat(3 - pz.difficulty);
  return `<h1 class="page-title">🧩 Puzzle du jour</h1>
    <p class="page-sub">La même situation pour tout le monde : gagne <b>pendant ce tour-ci</b>. Finir ton tour = puzzle raté, mais tu peux réessayer autant que tu veux.</p>
    <div class="panel pz-head">
      <div class="pz-kpi"><b>${d.solvers}</b><span>joueur${d.solvers > 1 ? 's ont' : ' a'} réussi${d.tried ? ` sur ${d.tried} qui ${d.tried > 1 ? 'ont' : 'a'} essayé` : ''}</span></div>
      <div class="pz-kpi"><b class="pz-stars">${stars}</b><span>difficulté</span></div>
      <div class="pz-kpi"><b>${d.streak ? '🔥 ' + d.streak : '—'}</b><span>série de jours${d.bestStreak ? ` (record ${d.bestStreak})` : ''}</span></div>
      <div class="pz-kpi"><b>${d.solvedToday ? '✔ Réussi' : `+${d.reward.credits} 🪙 · +${d.reward.dust} ✧`}</b><span>${d.solvedToday ? "reviens demain pour le suivant" : `à la 1re réussite du jour · booster tous les ${d.streakBoosterEvery} jours de suite`}</span></div>
    </div>
    <div class="panel pz-board">
      <div class="pz-side"><span class="pz-label">Adversaire</span><span class="pz-hp">❤ ${pz.oppHp} PV</span></div>
      <div class="pz-row">${pz.oppBoard.map(c => pzMinion(c, true)).join('') || '<span class="empty">Plateau vide</span>'}</div>
      <div class="pz-divider"></div>
      <div class="pz-row">${pz.myBoard.map(c => pzMinion(c, false)).join('') || '<span class="empty">Plateau vide</span>'}</div>
      <div class="pz-side"><span class="pz-label">Toi</span><span class="pz-hp">❤ ${pz.myHp} PV</span><span class="pz-mana">💧 ${pz.mana} mana</span></div>
      <div class="pz-hand-title">Ta main</div>
      <div class="pz-hand">${pz.hand.map(c => renderCardTile(c, { noShiny: true })).join('')}</div>
    </div>
    <div class="btn-row pz-actions">
      <button class="btn big" onclick="App.puzzleStart()">🧩 ${d.solvedToday ? 'Rejouer le puzzle' : 'Jouer le puzzle'}</button>
      ${!d.solution ? `<button class="btn ghost" onclick="App.puzzleReveal()">Voir la solution</button>` : ''}
    </div>
    ${d.solution ? `<div class="panel pz-solution"><h3 style="margin-top:0;">Solution (${d.solution.length} actions)</h3><ol>${d.solution.map(x => `<li>${esc(x)}</li>`).join('')}</ol>
      <p class="page-sub" style="margin:0;">Il peut exister d'autres solutions !</p></div>` : ''}
    ${admin}`;
}

/* ---------- Bagarre de la semaine ---------- */
function loadBrawl() { return api('/api/brawl').then(r => { S.brawl = r; render(); }).catch(e => { S.brawl = { error: e.message }; render(); }); }
function renderBrawl() {
  const b = S.brawl;
  if (!b) return skeletonPage('🥊 Bagarre de la semaine');
  if (b.error) return `<div class="empty">${esc(b.error)}</div>`;
  const r = b.rule, rw = b.rewards;
  const noDeck = b.needsOwnDeck && !(S.profile.deck && S.profile.deck.length === DECK_SIZE);
  return `<h1 class="page-title">🥊 Bagarre de la semaine</h1>
    <p class="page-sub">Un combat contre le bot avec une règle spéciale, qui change chaque lundi.</p>
    <div class="panel br-rule">
      <div class="br-icon">${r.icon}</div>
      <div class="br-txt"><small>Règle de la semaine</small><h2>${esc(r.name)}</h2><p>${esc(r.desc)}</p>
        <span class="br-timer">Nouvelle règle dans <b class="js-countdown" data-ends="${b.endsAt}">${fmtLongCountdown(b.endsAt - Date.now())}</b></span></div>
      <div class="br-play">
        <button class="btn big" ${noDeck ? 'disabled' : ''} onclick="App.brawlFight()">🥊 Combattre</button>
        <button class="btn ghost small" onclick="App.openDuel('brawl')">👥 Défier un ami</button>
        ${noDeck ? `<small>Configure d'abord un deck de ${DECK_SIZE} cartes.</small>` : `<small>${b.needsOwnDeck ? 'Avec ton deck actif' : 'Deck tiré au hasard pour toi'}</small>`}
      </div>
    </div>
    <div class="panel br-progress">
      <div class="pz-kpi"><b>${b.wins}</b><span>victoire${b.wins > 1 ? 's' : ''} cette semaine (${b.played} combat${b.played > 1 ? 's' : ''})</span></div>
      <div class="pz-kpi ${b.firstDone ? 'done' : ''}"><b>${b.firstDone ? '✔' : '🎁'} 1 booster + ${rw.first.credits} 🪙</b><span>${b.firstDone ? 'première victoire déjà gagnée' : 'pour ta première victoire de la semaine'}</span></div>
      <div class="pz-kpi"><b>+${rw.dustPerWin} ✧</b><span>par victoire ensuite (${rw.dustWinsMax} max par semaine)</span></div>
    </div>
    <div class="panel"><h3 style="margin-top:0;">La semaine prochaine</h3><p class="page-sub" style="margin:0;">${b.next.icon} <b>${esc(b.next.name)}</b> — ${esc(b.next.desc)}</p></div>
    ${S.isAdmin ? `<div class="panel"><h3 style="margin-top:0;">Admin : règle de cette semaine</h3><div class="btn-row" style="margin-top:0;flex-wrap:wrap;">${b.rules.map(x => `<button class="btn small ${x.id === r.id ? '' : 'ghost'}" onclick="App.adminBrawlRule('${x.id}')">${x.icon} ${esc(x.name)}</button>`).join('')}<button class="btn small ghost" onclick="App.adminBrawlRule(null)">↺ Règle automatique</button></div></div>` : ''}`;
}

function loadDraft() { return api('/api/draft').then(r => { S.draft = r; render(); }).catch(e => { S.draft = { error: e.message }; render(); }); }
function draftRewardText(r) {
  return [r.credits ? `+${r.credits} 🪙` : '', r.dust ? `+${r.dust} ✧` : '', r.boosters ? `${r.boosters} booster${r.boosters > 1 ? 's' : ''}` : '', r.title ? `titre « ${esc(r.title)} »` : ''].filter(Boolean).join(' · ') || 'rien cette fois';
}
function renderDraft() {
  const d = S.draft;
  if (!d) return skeletonPage('Draft');
  if (d.error) return `<div class="empty">${esc(d.error)}</div>`;
  const medals = ['🥇', '🥈', '🥉'];
  const podium = `<div class="panel">
    <h3 style="margin-top:0;">🏆 Top 3 du Draft</h3>
    ${d.top.length ? `<div class="sv-podium">${d.top.map((p, i) => `<div class="sv-podium-row ${p.slug === S.profile.slug ? 'me' : ''}"><span class="sv-medal">${medals[i]}</span>${avatarHtml(p.pseudo, p.avatar, p.ornament, 'sm')}<b>${esc(p.pseudo)}</b><span class="sv-best">${p.best} victoire${p.best > 1 ? 's' : ''}</span></div>`).join('')}</div>`
      : '<div class="empty">Personne n\'a encore gagné de combat en Draft : sois le premier !</div>'}
    <p class="page-sub" style="margin:10px 0 0;">Ton record : <b>${d.best}</b> victoire${d.best > 1 ? 's' : ''}.</p>
  </div>`;
  const table = `<div class="panel dr-rewards"><h3 style="margin-top:0;">Récompenses</h3>
    <div class="dr-table">${d.rewardTable.map(r => `<div class="${d.run && d.run.wins >= r.wins ? 'on' : ''}"><b>${r.wins} V</b><span>${draftRewardText(r)}</span></div>`).join('')}</div>
    <p class="page-sub" style="margin:8px 0 0;">Tu reçois les récompenses à la fin du Draft (3 défaites, ${d.rules.maxWins} victoires, ou si tu t'arrêtes).</p></div>`;
  const rules = `<div class="panel sv-rules"><h3 style="margin-top:0;">Règles</h3><ul>
    <li>Choisis <b>1 carte parmi 3</b>, ${d.rules.deckSize} fois de suite : c'est ton deck. Pas besoin de posséder les cartes.</li>
    <li>Les choix n° ${d.rules.specialPicks.join(', ')} ne proposent que des cartes <b>rares ou mieux</b>.</li>
    <li>Affronte le bot, <b>de plus en plus fort</b> à chaque victoire, jusqu'à <b>${d.rules.maxLosses} défaites</b> (ou ${d.rules.maxWins} victoires).</li>
    <li>Entrée <b>gratuite une fois par jour</b>, ensuite ${d.price} crédits. Les combats comptent pour les défis du jour (pas pour tes statistiques de carrière).</li>
  </ul></div>`;
  const ended = S.draftEnded && S.draftEnded.rewards ? `<div class="panel dr-ended">🎁 Draft terminé : ${draftRewardText(S.draftEnded.rewards)}${S.draftEnded.newRecord ? ' · 🏆 nouveau record !' : ''}</div>` : '';
  const run = d.run;
  if (!run) {
    return `<h1 class="page-title">🃏 Draft</h1>
      <p class="page-sub">Construis un deck de 30 cartes en choisissant 1 carte parmi 3, puis va le plus loin possible.</p>
      ${ended}
      <div class="panel sv-start"><div class="sv-big">🃏</div>
        <p>${d.free ? "Ton entrée gratuite du jour t'attend !" : `Entrée gratuite déjà utilisée aujourd'hui : ${d.price} 🪙.`}</p>
        <button class="btn" onclick="App.draftStart()">${d.free ? 'Lancer un Draft (gratuit)' : `Lancer un Draft (${d.price} 🪙)`}</button>
        ${d.history.length ? `<p class="page-sub" style="margin:12px 0 0;">Derniers Drafts : ${d.history.map(h => `<b>${h.wins} V</b>`).join(' · ')}</p>` : ''}</div>
      ${table}${podium}${rules}`;
  }
  const n = run.picks.length;
  const counts = {}; run.picks.forEach(c => { counts[c.id] = (counts[c.id] || 0) + 1; });
  const uniq = [...new Map(run.picks.map(c => [c.id, c])).values()].sort((a, b) => a.cost - b.cost || a.name.localeCompare(b.name));
  const minions = run.picks.filter(c => c.type === 'minion').length;
  const deckList = `<div class="sv-deck-list">${uniq.map(c => `<span class="sv-deck-card" style="--rc:${(RARITIES[c.rarity] || {}).color || '#888'}" onclick="App.open3DView('${esc(c.id)}')"><i>${c.cost}</i>${esc(c.name)}${counts[c.id] > 1 ? ` <small>×${counts[c.id]}</small>` : ''}</span>`).join('') || '<span class="empty">Aucune carte pour l\'instant.</span>'}</div>`;
  if (n < d.rules.deckSize) {
    const special = d.rules.specialPicks.includes(n + 1);
    return `<h1 class="page-title">🃏 Draft — choix ${n + 1} / ${d.rules.deckSize}</h1>
      <div class="dr-progress"><i style="width:${Math.round(n / d.rules.deckSize * 100)}%"></i></div>
      <p class="page-sub">${special ? '✨ <b>Choix spécial</b> : que des cartes rares ou mieux !' : 'Choisis la carte qui ira dans ton deck.'} <span class="tone-tag">${minions} serviteur${minions > 1 ? 's' : ''} · ${n - minions} autre${n - minions > 1 ? 's' : ''}</span></p>
      <div class="dr-offer ${S.draftPicking ? 'busy' : ''}">${run.offer.map(c => `<div class="dr-pick">${renderCardTile(c, { onClick: `App.draftPick('${esc(c.id)}')`, noShiny: true })}<button class="btn small" onclick="App.draftPick('${esc(c.id)}')">Choisir</button></div>`).join('')}</div>
      <div class="dr-layout">
        <details class="panel sv-deck" ${n ? 'open' : ''}><summary><b>Ton deck</b> <span class="tone-tag">${n} / ${d.rules.deckSize}</span></summary>${deckList}${n ? renderManaCurve(run.picks) : ''}</details>
      </div>
      <div class="btn-row"><button class="btn ghost danger-text" onclick="App.draftAbandon()">Abandonner (entrée rendue)</button></div>`;
  }
  const hearts = '❤'.repeat(d.rules.maxLosses - run.losses) + '🖤'.repeat(run.losses);
  return `<h1 class="page-title">🃏 Draft</h1>
    <div class="panel sv-run">
      <div class="sv-round"><small>Victoires</small><b>${run.wins}</b></div>
      <div class="sv-stats">
        <div><span>Vies</span><b class="dr-hearts">${hearts}</b></div>
        <div><span>Prochain adversaire</span><b>${esc(run.next.botName)}</b><small>${run.next.botHp} PV</small></div>
        <div><span>Si tu t'arrêtes</span><b>${draftRewardText(run.rewardsNow)}</b></div>
      </div>
      <div class="btn-row">
        <button class="btn" onclick="App.draftFight()">⚔️ Combattre</button>
        <button class="btn ghost" onclick="App.openDuel('draft')" title="Chacun joue avec son deck de Draft ; ton Draft n'est pas modifié">👥 Duel contre un ami</button>
        <button class="btn ghost danger-text" onclick="App.draftAbandon()">M'arrêter et récupérer</button>
      </div>
    </div>
    <details class="panel sv-deck"><summary><b>Ton deck</b> <span class="tone-tag">30 cartes choisies</span></summary>${deckList}${renderManaCurve(run.picks)}</details>
    ${table}${podium}${rules}`;
}

function renderSurvie() {
  const sv = S.survival;
  if (!sv) return skeletonPage('🏔️ Survie');
  if (sv.error) return `<div class="empty">${esc(sv.error)}</div>`;
  const run = sv.run, nx = sv.next || {};
  const medals = ['🥇', '🥈', '🥉'];
  const stars = Math.min(5, 1 + Math.floor(((nx.round || 1) - 1) / 4));
  const podium = `<div class="panel">
    <h3 style="margin-top:0;">🏆 Top 3 de la Survie</h3>
    ${sv.top.length ? `<div class="sv-podium">${sv.top.map((p, i) => `<div class="sv-podium-row ${p.slug === S.profile.slug ? 'me' : ''}"><span class="sv-medal">${medals[i]}</span>${avatarHtml(p.pseudo, p.avatar, p.ornament, 'sm')}<b>${esc(p.pseudo)}</b><span class="sv-best">${p.best} manche${p.best > 1 ? 's' : ''}</span></div>`).join('')}</div>`
      : '<div class="empty">Personne n\'a encore gagné de manche : sois le premier !</div>'}
    <p class="page-sub" style="margin:10px 0 0;">Ton record : <b>${sv.best}</b> manche${sv.best > 1 ? 's' : ''} gagnée${sv.best > 1 ? 's' : ''} d'affilée.</p>
  </div>`;
  const rules = `<div class="panel sv-rules">
    <h3 style="margin-top:0;">Règles</h3>
    <ul>
      <li>Un deck de 30 cartes est <b>tiré au hasard</b> au début de la partie : impossible de le changer.</li>
      <li>Tu enchaînes des manches contre le bot, <b>de plus en plus difficiles</b> (plus de PV, d'armure, de mana et de meilleures cartes).</li>
      <li>Tes PV sont <b>conservés</b> d'une manche à l'autre (+${sv.rules.heal} PV après chaque victoire). Une défaite termine la partie.</li>
      <li><b>Pause</b> : bouton ⏸ pendant ton tour, ou quitte simplement entre deux manches. Ta partie est sauvegardée.</li>
      <li>Toutes les ${sv.rules.milestoneEvery} manches : crédits et poussière. Les combats comptent pour les <b>défis du jour</b> (pas pour tes statistiques de carrière).</li>
    </ul>
  </div>`;
  if (!run) {
    return `<h1 class="page-title">🏔️ Survie</h1>
      <p class="page-sub">Combien de manches tiendras-tu avec un deck tiré au hasard ?</p>
      <div class="panel sv-start"><div class="sv-big">🏔️</div><p>${sv.runs ? `Tu as déjà tenté ${sv.runs} partie${sv.runs > 1 ? 's' : ''}.` : 'Prêt pour ta première partie ?'}</p>
        <button class="btn" onclick="App.survivalStart()">Lancer une partie de Survie</button></div>
      ${podium}${rules}`;
  }
  const deck = run.deck || [];
  const counts = {}; deck.forEach(c => { counts[c.id] = (counts[c.id] || 0) + 1; });
  const uniq = [...new Map(deck.map(c => [c.id, c])).values()].sort((a, b) => a.cost - b.cost || a.name.localeCompare(b.name));
  return `<h1 class="page-title">🏔️ Survie</h1>
    <div class="panel sv-run">
      <div class="sv-round"><small>Manche</small><b>${run.round}</b></div>
      <div class="sv-stats">
        <div><span>❤ Tes PV</span><b>${run.hp} / ${sv.rules.startHp}</b><div class="sv-hp"><i style="width:${Math.round(run.hp / sv.rules.startHp * 100)}%"></i></div></div>
        <div><span>Adversaire</span><b>${esc(nx.botName || 'Bot')}</b><small>${nx.botHp} PV${nx.botArmor ? ` · ${nx.botArmor} armure` : ''}${nx.botMana ? ` · +${nx.botMana} mana` : ''}</small></div>
        <div><span>Difficulté</span><b class="sv-stars">${'★'.repeat(stars)}${'☆'.repeat(5 - stars)}</b></div>
      </div>
      ${run.paused ? `<div class="sv-paused">⏸ Combat en pause (tour ${run.paused.turn}, le bot a ${run.paused.botHp} PV).</div>` : ''}
      <div class="btn-row">
        <button class="btn" onclick="App.survivalFight()">${run.paused ? '▶ Reprendre le combat' : `⚔️ Combattre la manche ${run.round}`}</button>
        <button class="btn ghost danger-text" onclick="App.survivalAbandon()">Abandonner la partie</button>
      </div>
    </div>
    <details class="panel sv-deck"><summary><b>Ton deck</b> <span class="tone-tag">30 cartes tirées au hasard, impossible à modifier</span></summary>
      <div class="sv-deck-list">${uniq.map(c => `<span class="sv-deck-card" style="--rc:${(RARITIES[c.rarity] || {}).color || '#888'}" onclick="App.open3DView('${esc(c.id)}')"><i>${c.cost}</i>${esc(c.name)}${counts[c.id] > 1 ? ` <small>×${counts[c.id]}</small>` : ''}</span>`).join('')}</div>
      ${renderManaCurve(deck)}
    </details>
    ${podium}${rules}`;
}

/* ---------- Image du deck à partager ---------- */
function loadImg(src) {
  return new Promise(res => { if (!src) return res(null); const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = src; setTimeout(() => res(null), 4000); });
}
function roundRect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
async function buildDeckImage(ids, title) {
  const cards = ids.map(id => cardById(id)).filter(Boolean);
  const counts = {}; cards.forEach(c => { counts[c.id] = (counts[c.id] || 0) + 1; });
  const uniq = [...new Map(cards.map(c => [c.id, c])).values()].sort((a, b) => a.cost - b.cost || a.name.localeCompare(b.name));
  const W = 1200, ROW = 46, colRows = Math.ceil(uniq.length / 2);
  const H = 260 + colRows * ROW + 230;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, W, H); g.addColorStop(0, '#1d1238'); g.addColorStop(0.6, '#120c24'); g.addColorStop(1, '#0a0716');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(W * 0.8, 0, 10, W * 0.8, 0, 600); glow.addColorStop(0, 'rgba(140,90,255,.35)'); glow.addColorStop(1, 'rgba(140,90,255,0)');
  ctx.fillStyle = glow; ctx.fillRect(0, 0, W, H);
  const logo = await loadImg(logoUrl());
  if (logo) ctx.drawImage(logo, 40, 30, 150, 150);
  ctx.fillStyle = '#fff'; ctx.font = '900 54px Cinzel, Georgia, serif'; ctx.textBaseline = 'top';
  ctx.fillText(String(title || 'Mon deck').slice(0, 28), 215, 48);
  ctx.fillStyle = '#b9a8e8'; ctx.font = '600 24px Inter, Arial, sans-serif';
  ctx.fillText(`par ${S.profile.pseudo} · ${cards.length} cartes`, 218, 116);
  const st = cards.length >= 5 ? analyzeStrategy(cards) : null;
  if (st && st.styles.length) {
    const label = st.styles.map(s => `${s.arch.icon} ${s.arch.name} ${s.pct} %`).join('   ·   ');
    ctx.font = '700 24px Inter, Arial, sans-serif';
    const w = ctx.measureText(label).width + 40;
    roundRect(ctx, 215, 160, w, 46, 23); ctx.fillStyle = 'rgba(140,100,255,.22)'; ctx.fill(); ctx.strokeStyle = 'rgba(180,140,255,.6)'; ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = '#efe8ff'; ctx.fillText(label, 235, 171);
  }
  // Liste des cartes sur deux colonnes
  const arts = await Promise.all(uniq.map(c => loadImg(c.image)));
  uniq.forEach((c, i) => {
    const col = i < colRows ? 0 : 1, row = col ? i - colRows : i;
    const x = 40 + col * 570, y = 240 + row * ROW, w = 550, h = ROW - 8;
    const rc = (RARITIES[c.rarity] || {}).color || '#888';
    roundRect(ctx, x, y, w, h, 10); ctx.fillStyle = 'rgba(255,255,255,.06)'; ctx.fill();
    if (arts[i]) { ctx.save(); roundRect(ctx, x + w - 170, y, 170, h, 10); ctx.clip(); const im = arts[i]; const sc = Math.max(170 / im.width, h / im.height); ctx.globalAlpha = 0.55; ctx.drawImage(im, x + w - 170, y + (h - im.height * sc) / 2, im.width * sc, im.height * sc); ctx.restore(); ctx.globalAlpha = 1;
      const fade = ctx.createLinearGradient(x + w - 170, 0, x + w - 90, 0); fade.addColorStop(0, 'rgba(24,16,44,1)'); fade.addColorStop(1, 'rgba(24,16,44,0)'); ctx.fillStyle = fade; ctx.fillRect(x + w - 171, y, 82, h); }
    ctx.fillStyle = rc; ctx.fillRect(x, y + 6, 5, h - 12);
    ctx.beginPath(); ctx.arc(x + 32, y + h / 2, 16, 0, Math.PI * 2); ctx.fillStyle = '#2f6fe0'; ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = '800 20px Inter, Arial, sans-serif'; ctx.textAlign = 'center'; ctx.fillText(String(c.cost), x + 32, y + h / 2 - 11); ctx.textAlign = 'left';
    ctx.font = '700 21px Inter, Arial, sans-serif'; ctx.fillStyle = '#f3eeff';
    let name = c.name; while (ctx.measureText(name).width > 330 && name.length > 4) name = name.slice(0, -2);
    ctx.fillText(name === c.name ? name : name + '…', x + 60, y + h / 2 - 12);
    if (counts[c.id] > 1) { ctx.fillStyle = '#ffd36a'; ctx.font = '800 21px Inter, Arial, sans-serif'; ctx.fillText('×' + counts[c.id], x + w - 46, y + h / 2 - 12); }
  });
  // Courbe de mana
  const cy = 240 + colRows * ROW + 30;
  ctx.fillStyle = '#b9a8e8'; ctx.font = '700 22px Inter, Arial, sans-serif'; ctx.fillText('Courbe de mana', 40, cy);
  const buckets = Array(8).fill(0); cards.forEach(c => { buckets[Math.min(7, Math.max(0, Number(c.cost) || 0))]++; });
  const maxB = Math.max(1, ...buckets);
  buckets.forEach((n, i) => {
    const bx = 40 + i * 70, bh = Math.round(n / maxB * 110), by = cy + 160 - bh;
    const bg = ctx.createLinearGradient(0, by, 0, cy + 160); bg.addColorStop(0, '#7fb2ff'); bg.addColorStop(1, '#3a62d8');
    roundRect(ctx, bx, by, 52, Math.max(4, bh), 6); ctx.fillStyle = bg; ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = '700 18px Inter, Arial, sans-serif'; ctx.textAlign = 'center';
    if (n) ctx.fillText(String(n), bx + 26, by - 24);
    ctx.fillStyle = '#9a8fbf'; ctx.fillText(i === 7 ? '7+' : String(i), bx + 26, cy + 168); ctx.textAlign = 'left';
  });
  ctx.fillStyle = '#8f83b8'; ctx.font = '600 20px Inter, Arial, sans-serif'; ctx.textAlign = 'right';
  ctx.fillText((location && location.host) || 'Clean Gang Decks', W - 40, H - 44); ctx.textAlign = 'left';
  return cv;
}
function renderDeckImageModal() {
  const di = S.deckImage;
  if (!di) return '';
  return `<div class="emote-wheel-overlay" onclick="App.closeDeckImage()">
    <div class="deck-image-modal" onclick="event.stopPropagation()">
      <h3 style="margin-top:0;">🖼️ Image du deck</h3>
      ${di.url ? `<img src="${di.url}" alt="Image du deck">` : '<div class="empty">Création de l\'image…</div>'}
      <div class="btn-row" style="justify-content:center;">
        ${di.url ? `<a class="btn" href="${di.url}" download="${esc(di.file)}">⬇ Télécharger</a>` : ''}
        ${di.url && window.ClipboardItem && navigator.clipboard ? '<button class="btn ghost" onclick="App.copyDeckImage()">📋 Copier (à coller dans Discord)</button>' : ''}
        <button class="btn ghost" onclick="App.closeDeckImage()">Fermer</button>
      </div>
      ${di.msg ? `<p class="page-sub" style="text-align:center;">${esc(di.msg)}</p>` : ''}
    </div>
  </div>`;
}

/* ---------- Bannières de profil ---------- */
function loadBannerCatalog() { if (S.bannerCatalog || S.__bannerLoading) return; S.__bannerLoading = true; api('/api/banners').then(r => { S.bannerCatalog = r.banners; render(); }).catch(() => {}).finally(() => { S.__bannerLoading = false; }); }
function bannerById(id) { return ((S.bannerCatalog || []).find(b => b.id === id)) || null; }
function bannerStyle(id) { const b = bannerById(id); return b ? `--banner:${esc(b.bg)}` : ''; }
function renderBannerPicker(p) {
  const cat = S.bannerCatalog || [];
  if (!cat.length) return '';
  const owned = p.ownedBanners || [];
  const how = b => b.source === 'shop' ? `Boutique · ${b.price} 🪙` : b.source === 'tournament' ? 'Gagnée en tournoi' : b.source === 'community' ? 'Objectif communautaire' : 'Succès secret';
  return `<div class="panel">
    <h3 style="margin-top:0;">🎏 Bannière de profil</h3>
    <p class="page-sub" style="margin-top:0;">Le fond de ta fiche joueur. Tu en gagnes en tournoi, avec les succès secrets et l'objectif communautaire, ou tu les achètes en boutique.</p>
    <div class="banner-grid">
      <button class="banner-tile none ${!p.banner ? 'on' : ''}" onclick="App.setBanner(null)"><span>Aucune</span></button>
      ${cat.map(b => {
        const has = owned.includes(b.id);
        return `<button class="banner-tile ${has ? '' : 'locked'} ${p.banner === b.id ? 'on' : ''}" style="--banner:${esc(b.bg)}" ${has ? `onclick="App.setBanner('${esc(b.id)}')"` : 'disabled'} title="${esc(b.name)} — ${esc(how(b))}">
          <span>${has ? '' : '🔒 '}${esc(b.name)}</span><small>${esc(has ? (p.banner === b.id ? 'Équipée' : 'Possédée') : how(b))}</small></button>`;
      }).join('')}
    </div>
  </div>`;
}

/* ---------- Succès secrets (onglet Succès) ---------- */
function renderSecretsPanel() {
  const sc = S.secrets;
  if (!sc) return `<div class="panel">${skeletonRows(4)}</div>`;
  const n = sc.unlocked.length, pct = Math.round(n / sc.total * 100);
  const locked = sc.total - n;
  return `<div class="panel secrets-panel">
    <h3 style="margin-top:0;">🕵️ Succès secrets <span class="tone-tag">${n} / ${sc.total}</span></h3>
    <p class="page-sub" style="margin-top:0;">Ils sont cachés : tu découvres ce qu'il fallait faire seulement en les débloquant. Certains offrent une bannière ou un titre.</p>
    <div class="community-bar"><i style="width:${pct}%"></i><span>${pct} %</span></div>
    <div class="secrets-grid">
      ${sc.unlocked.map(s => `<div class="secret-card on"><div class="secret-ico">🕵️</div><div><b>${esc(s.name)}</b><div class="achievement-desc">${esc(s.desc)}</div>
        <div class="tone-tag">+${s.credits} 🪙 · +${s.dust} ✧${s.banner ? ` · 🎏 ${esc((bannerById(s.banner) || {}).name || 'bannière')}` : ''}${s.title ? ` · titre « ${esc(s.title)} »` : ''}</div></div></div>`).join('')}
      ${Array.from({ length: Math.min(locked, 12) }, () => '<div class="secret-card"><div class="secret-ico">❔</div><div><b>???</b><div class="achievement-desc">Succès secret</div></div></div>').join('')}
    </div>
    ${locked > 12 ? `<p class="page-sub" style="text-align:center;margin:10px 0 0;">… et ${locked - 12} autres succès secrets à découvrir.</p>` : ''}
  </div>`;
}


function renderMulliganScreen() {
  const st = S.matchState;
  const selected = S.mulliganSelected || new Set();
  const waiting = st.yourMulliganDone && !st.opponentMulliganDone;
  return `
    <div class="board-screen premium mulligan-screen">
      <h1 class="page-title" style="text-align:center;">${t('combat.mulliganTitle', 'Choisis ta main de départ')}</h1>
      <p class="page-sub" style="text-align:center;margin:0 auto 26px;max-width:480px;">
        Clique sur les cartes que tu veux <b>remplacer</b> par de nouvelles piochées au hasard.
        Les cartes non sélectionnées restent dans ta main.
      </p>
      <div class="mulligan-hand">
        ${st.you.hand.map((c, i) => {
          const marked = selected.has(i);
          return `<div class="mulligan-card ${marked ? 'marked' : ''}" onclick="${st.yourMulliganDone ? '' : `App.toggleMulliganCard(${i})`}">
            <div class="hand-card rar-${esc(c.rarity)} type-${esc(c.type)} ${(st.you.foils || []).includes(c.id) ? 'shiny' : ''}">
              <div class="card-cost">${c.cost}</div>${(st.you.foils || []).includes(c.id) ? shinyFx() : ''}
              ${handCardArt(c)}
              <div class="card-type-tag">${esc(cardTypeLabel(c.type))}</div>
              <div class="card-name">${esc(c.name)}</div>
              ${handStatLine(c, 15)}
              ${cardTextHTML(c, 'card-desc hand-card-desc')}
            </div>
            <div class="mulligan-mark">${marked ? '↺ Remplacer' : 'Garder'}</div>
          </div>`;
        }).join('')}
      </div>
      <div class="btn-row" style="justify-content:center;">
        ${st.yourMulliganDone
          ? `<div class="mulligan-waiting">En attente de ${esc(st.opponent.pseudo)}…</div>`
          : `<button class="btn" onclick="App.confirmMulligan()">${t('combat.mulliganConfirm', 'Valider ma main')}${selected.size > 0 ? ` (${selected.size} à remplacer)` : ''}</button>`}
      </div>
    </div>`;
}

function manaCrystals(current, max) {
  let out = '';
  for (let i = 1; i <= max; i++) {
    out += `<span class="mana-gem ${i <= current ? 'filled' : 'used'}"></span>`;
  }
  return `<div class="mana-row">${out}</div>`;
}

function weaponBadge(weapon) {
  if (!weapon) return '';
  const usedUp = weapon.usesThisTurn >= weapon.usesPerTurn;
  return `<div class="weapon-badge ${usedUp ? 'used-up' : ''}" title="${esc(weapon.name)} — ${weapon.attack} ATQ, ${weapon.durability} utilisation(s) restante(s)${weapon.usesPerTurn > 1 ? ' · ' + weapon.usesPerTurn + '×/tour' : ''}">
    ${weapon.image ? `<img src="${esc(weapon.image)}" alt="">` : '<span class="weapon-fallback">⚔</span>'}
    <span class="weapon-atk-gem">${weapon.attack}</span>
    <span class="weapon-durability-gem">🛡${weapon.durability}</span>
  </div>`;
}

function renderBoardScreen() {
  const st = S.matchState;
  const anim = S.combatAnim || emptyCombatAnim();
  const finished = st.status === 'finished';
  const iWon = finished && (st.forfeitBy ? st.forfeitBy !== st.you.slug : st.winner === st.you.slug);
  const draw = finished && st.winner === null && !st.forfeitBy;

  let helper = '';
  if (!finished) {
    if (!st.yourTurn) helper = "Tour de l'adversaire…";
    else if (S.targetingSpell) {
      const bc = S.targetingSpell.battlecry ? `Cri de guerre de ${S.targetingSpell.battlecry} : ` : '';
      helper = bc + (S.targetingSpell.mode === 'damage' ? 'Choisis une cible pour ce sort de dégâts.'
        : S.targetingSpell.mode === 'heal' ? 'Choisis une cible amie à soigner (ton héros ou un de tes serviteurs).'
        : S.targetingSpell.mode === 'modify' ? 'Choisis le serviteur à modifier (allié ou ennemi).'
        : S.targetingSpell.mode === 'sleep' ? 'Choisis le serviteur à endormir (allié ou ennemi).'
        : S.targetingSpell.mode === 'destroy' ? 'Choisis le serviteur à détruire (allié ou ennemi).'
        : S.targetingSpell.mode === 'silence' ? 'Choisis le serviteur à réduire au silence : il perd tous ses effets (allié ou ennemi).'
        : 'Choisis un de tes serviteurs à renforcer.');
    }
    else if (S.selectedAttacker) helper = st.opponent.hasTaunt ? 'Provocation active : tu dois viser un serviteur avec Provocation.' : 'Choisis une cible pour ton attaque.';
    else helper = "C'est ton tour : joue des cartes, attaque, puis termine ton tour.";
  }

  function floatersFor(target) {
    return anim.floaters.filter(f => f.target === target)
      .map(f => `<div class="dmg-float ${f.kind}">${f.kind === 'heal' ? '+' : '-'}${f.amount}</div>`).join('');
  }

  function minionTile(m, mine, dying) {
    const cls = ['minion'];
    if (m.taunt) cls.push('taunt');
    if (mine && evoClass(m.cardId)) cls.push(evoClass(m.cardId));
    if (m.shield) cls.push('kw-shield');
    if (m.stealth) cls.push('kw-stealth');
    if (m.standLevel > 0) cls.push('stand-lv', 'stand-lv' + m.standLevel);
    if (m.rageBonus) cls.push('raging');
    if (m.silenced) cls.push('silenced');
    if (dying) cls.push('minion-dying');
    else if (anim.enterIds.has(m.instanceId)) cls.push('minion-enter');
    if (anim.hitIds.has(m.instanceId)) cls.push('minion-hit');
    if (anim.healIds.has(m.instanceId)) cls.push('minion-healed');
    if (anim.attackedIds.has(m.instanceId)) cls.push(mine ? 'minion-attack-fwd' : 'minion-attack-back');
    if (mine && !dying) {
      if (!m.sickness && m.canAttack && st.yourTurn && m.attack > 0) cls.push('can-attack');
      if (m.sickness) cls.push('sick');
      // A déjà attaqué ce tour-ci : une croix apparaît au survol
      if (m.asleep) cls.push('asleep');
      else if (!m.sickness && !m.canAttack && st.yourTurn) cls.push('exhausted');
      if (S.selectedAttacker === m.instanceId) cls.push('selected');
      if (S.targetingSpell && ['buff', 'heal', 'damage', 'modify', 'sleep', 'destroy', 'silence'].includes(S.targetingSpell.mode)) cls.push('targetable');
    } else if (!dying) {
      if (!m.stealth && (S.selectedAttacker || (S.targetingSpell && ['damage', 'modify', 'sleep', 'destroy', 'silence'].includes(S.targetingSpell.mode)))) cls.push('targetable');
    }
    const click = dying ? '' : (mine ? `App.clickMyMinion('${m.instanceId}')` : `App.clickEnemyMinion('${m.instanceId}')`);
    const fxTip = cardEffectSummary(Object.assign({}, m, { type: 'minion' }));
    const tip = (mine && m.attack <= 0 && !m.asleep ? `${m.name} — 0 ATQ : ne peut pas attaquer`
      : m.asleep ? `${m.name} — endormi : ne peut pas attaquer${m.asleepTurns > 0 ? ` (encore ${m.asleepTurns} tour${m.asleepTurns > 1 ? 's' : ''} après celui-ci)` : ' ce tour-ci'}`
      : cls.includes('exhausted') ? `${m.name} — a déjà attaqué ce tour-ci` : (mine && m.sickness && !dying ? `${m.name} — vient d'arriver, pourra attaquer au prochain tour` : m.name))
      + (fxTip ? `\n${fxTip}` : '') + (m.armor ? `\nArmure restante : ${m.armor}` : '');
    const shinyM = !dying && ((mine ? st.you.foils : st.opponent.foils) || []).includes(m.cardId);
    if (shinyM) cls.push('shiny');
    return `<div class="${cls.join(' ')}" data-iid="${esc(m.instanceId)}" title="${esc(tip)}" onclick="${click}">
      <div class="minion-portrait-wrap">${shinyM ? shinyFx() : ''}
        ${(m.windfury || m.drEffect || m.auraAttack) ? `<span class="kw-badges">${m.auraAttack ? `<i title="Aura : ${m.auraScope === 'adjacent' ? 'ses voisins ont' : 'tes autres serviteurs ont'} +${m.auraAttack} ATQ">✨</i>` : ''}${m.windfury ? '<i title="Furie : attaque deux fois par tour">🌀</i>' : ''}${m.drEffect ? '<i title="Râle d\'agonie">💀</i>' : ''}</span>` : ''}
        ${m.taunt ? '<div class="taunt-shield" title="Provocation"><svg viewBox="0 0 24 24"><path d="M12 1.5 4 4.5v6c0 5.2 3.4 9.6 8 11 4.6-1.4 8-5.8 8-11v-6L12 1.5z"/></svg></div>' : ''}
        <div class="minion-portrait">
          ${m.image ? `<img src="${esc(m.image)}" alt="">` : `<span class="minion-portrait-fallback">${esc((m.name || '?').slice(0, 1))}</span>`}
        </div>
        ${m.taunt ? '<div class="taunt-ring"></div>' : ''}
      </div>
      ${!mine && !dying ? attackPreview(m, false) : ''}
      ${m.standing ? `<div class="stand-badge${m.standLevel ? ' on' : ''}" title="Toujours debout : niveau ${m.standLevel || 0}/3">${m.standLevel ? '⭐'.repeat(m.standLevel) : '☆'}</div>` : ''}
      <div class="minion-name">${esc(m.name)}</div>
      ${m.silenced ? '<div class="silence-badge" title="Réduit au silence : plus aucun effet">🔇</div>' : ''}
      <div class="atk-gem ${m.auraBonus ? 'aura-up' : ''} ${m.rageBonus ? 'rage-up' : ''}" ${m.auraBonus || m.rageBonus ? `title="${[m.auraBonus ? `+${m.auraBonus} ATQ grâce à une aura` : '', m.rageBonus ? `+${m.rageBonus} ATQ de Rage (blessé)` : ''].filter(Boolean).join(' · ')}"` : ''}>${m.attack}</div>
      <div class="hp-gem-minion">${m.health}</div>
      ${floatersFor(m.instanceId)}
    </div>`;
  }

  const oppTargetable = S.selectedAttacker || (S.targetingSpell && S.targetingSpell.mode === 'damage');
  const myHeroTargetable = S.targetingSpell && S.targetingSpell.mode === 'heal';
  const myWeaponUsable = !finished && st.yourTurn && !S.targetingSpell && st.you.weapon &&
    st.you.weapon.durability > 0 && st.you.weapon.usesThisTurn < st.you.weapon.usesPerTurn;
  const oppDying = anim.dyingMinions.filter(m => m.side === 'opp');
  const youDying = anim.dyingMinions.filter(m => m.side === 'you');

  return `
    <div class="board-screen premium">
      <div class="board-exit-bar">
        <button class="btn ghost small" onclick="App.toggleSound()" title="${S.soundOn ? 'Couper les sons' : 'Réactiver les sons'}">${S.soundOn ? '🔊' : '🔇'}</button>
        <button class="btn ghost small" onclick="App.openBugReport()" title="Signaler un bug">🐞</button>
        ${isPhone() && !document.fullscreenElement && document.documentElement.requestFullscreen ? '<button class="btn ghost small" onclick="App.enterLandscape()" title="Plein écran">⛶</button>' : ''}
        ${!finished && st.survival ? `<button class="btn ghost small" ${st.yourTurn ? '' : 'disabled title="Pendant ton tour seulement"'} onclick="App.survivalPause()">⏸ Pause</button>` : ''}
        ${!finished && st.puzzle ? `<button class="btn ghost small" onclick="App.puzzleRetry()">↺ Recommencer</button>` : ''}
        ${!finished ? `<button class="btn ghost small" onclick="App.forfeitMatch()">Abandonner</button>` : ''}
      </div>
      ${st.spectators && !finished && !(st.survival || st.blitz || st.draft || st.puzzle || st.brawl) ? `<div class="mode-badge spec" title="Des joueurs regardent ce combat (ils ne voient pas ta main)">👁 ${st.spectators} spectateur${st.spectators > 1 ? 's' : ''}</div>` : ''}
      ${st.survival || st.blitz || st.draft || st.puzzle || st.brawl ? `<div class="mode-badge ${st.blitz ? 'blitz' : st.draft ? 'draft' : st.puzzle ? 'puzzle' : st.brawl ? 'brawl' : 'survie'}">${st.blitz ? '⚡ Blitz' : st.puzzle ? '🧩 Puzzle<span class="mb-long"> du jour · gagne ce tour-ci</span>' : st.brawl ? `🥊 Bagarre<span class="mb-long"> · ${esc(st.brawl.name)}</span>` : st.draft ? `🃏 Draft · ${st.draft.wins} V / ${st.draft.losses} D` : `🏔️ Survie · manche ${st.survival.round}`}${st.spectators && !finished ? ` · 👁 ${st.spectators}` : ''}</div>` : ''}
      ${finished ? `<div class="result-banner ${draw ? '' : (iWon ? 'win' : 'lose')}">
        ${draw ? 'Égalité !' : (iWon ? 'Victoire !' : 'Défaite.')}
        ${st.rewards && st.rewards.won && !st.rewards.isBot ? ` +${st.rewards.vpGain} points de classement · +20 ✧` : ''}${st.rewards && st.rewards.credits > 0 ? ` · +${st.rewards.credits} 🪙` : ''}
        ${st.rewards && st.rewards.isBot && !st.rewards.isBossFight ? ' <span class="tone-tag">Combat de test — aucune récompense</span>' : ''}
        <button class="btn small ghost" style="margin-left:12px;" onclick="App.returnToMenuAfterMatch()">Quitter</button>
      </div>
      ${st.rewards && st.rewards.bonusBooster ? `<div class="result-banner win bonus-drop-banner">
        🎁 Coup de chance ! Un booster « ${esc(st.rewards.bonusBooster.extensionName)} » bonus est apparu dans ta collection : ${st.rewards.bonusBooster.cards.map(c => esc(c.name)).join(', ')}
      </div>` : ''}
      ${st.rewards && st.rewards.isBossFight ? (st.rewards.bossReward
        ? `<div class="result-banner win bonus-drop-banner">👹 Boss vaincu ! Récompense : ${st.rewards.bossReward.dust ? '+' + st.rewards.bossReward.dust + ' ✧' : ''}${st.rewards.bossReward.dust && st.rewards.bossReward.credits ? ' · ' : ''}${st.rewards.bossReward.credits ? '+' + st.rewards.bossReward.credits + ' 🪙' : ''}</div>`
        : `<div class="result-banner">👹 Défaite contre le boss — retente ta chance demain !</div>`) : ''}` : ''}

      <div class="hero-row opp ${anim.oppHeroHit ? 'hero-hit' : ''} ${anim.oppHeroHeal ? 'hero-heal' : ''}">
        <div class="hero-info">
          <div class="hero-name">${esc(st.opponent.pseudo)}</div>${titleLine(st.opponent.title)}
          <div class="hero-sub">${st.opponent.handCount} en main · ${st.opponent.libraryCount} en pioche</div>
        </div>
        <div class="hero-center">
          ${weaponBadge(st.opponent.weapon)}
          <div class="hero-portrait-wrap ${anim.oppHeroAttacked ? 'hero-attack-back' : ''} ${(S.targetingSpell && S.targetingSpell.mode === 'damage') || (S.selectedAttacker && !st.opponent.hasTaunt) ? 'targetable' : ''}" data-hero="opp" onclick="App.clickEnemyHero()">
            ${S.activeEmotes[st.opponent.slug] ? `<div class="emote-bubble from-opp">${esc(S.activeEmotes[st.opponent.slug].text)}</div>` : ''}
            ${st.opponent.slug === 'boss' && S.bossDialogueActive ? `<div class="emote-bubble from-opp boss-dialogue">${esc(S.bossDialogueActive)}</div>` : ''}
            ${avatarHtml(st.opponent.pseudo, st.opponent.avatar, st.opponent.ornament, '', oppTargetable ? 'targetable' : '')}
            ${armorGem(st.opponent.heroArmor)}
            ${st.opponent.trapCount ? `<div class="trap-badges" title="${st.opponent.trapCount} piège${st.opponent.trapCount > 1 ? 's' : ''} posé${st.opponent.trapCount > 1 ? 's' : ''} face cachée">${'<span class="trap-card">?</span>'.repeat(st.opponent.trapCount)}</div>` : ''}
            <div class="hp-gem ${anim.oppHeroHit ? 'pulse' : ''}">${st.opponent.heroHealth}</div>
            ${attackPreview(null, true)}
            ${floatersFor('opp-hero')}
          </div>
        </div>
        <div class="hero-mana">${manaCrystals(st.opponent.mana, st.opponent.maxMana)}<span class="mana-count">${st.opponent.mana}/${st.opponent.maxMana}</span></div>
      </div>

      <div class="arena-table">
        <div class="board-row">${st.opponent.board.length === 0 && oppDying.length === 0 ? '<span class="empty board-empty">Plateau adverse vide</span>' : st.opponent.board.map(m => minionTile(m, false, false)).join('') + oppDying.map(m => minionTile(m, false, true)).join('')}</div>

        <div class="board-divider"><span class="helper-text">${S.matchError ? `<span style="color:var(--bad);">${esc(S.matchError)}</span>` : st.opponentDisconnected != null ? `<span style="color:var(--legendaire);">📡 ${esc(st.opponent.pseudo)} s'est déconnecté : s'il ne revient pas d'ici ${st.opponentDisconnected} s, tu gagnes par forfait.</span>` : esc(helper)}</span>
        ${S.targetingSpell && S.targetingSpell.battlecry ? `<button class="btn small" onclick="App.playWithoutBattlecry()">Poser sans l'effet</button>` : ''}
        ${(S.targetingSpell || S.selectedAttacker) ? `<button class="btn ghost small" onclick="App.cancelTargeting()">${S.targetingSpell && S.targetingSpell.battlecry ? 'Reprendre la carte' : 'Annuler la sélection'}</button>` : ''}</div>

        <div class="board-row mine">${st.you.board.length === 0 && youDying.length === 0 ? '<span class="empty board-empty">Glisse une carte ici pour la jouer</span>' : st.you.board.map(m => minionTile(m, true, false)).join('') + youDying.map(m => minionTile(m, true, true)).join('')}</div>

        <button class="end-turn-wheel ${(!st.yourTurn || finished) ? 'disabled' : ''}" ${(!st.yourTurn || finished) ? 'disabled' : ''} onclick="App.endTurn()">
          ${finished ? '' : `<span class="turn-timer" id="turn-timer" role="timer" aria-label="Temps restant pour ce tour">
            <svg viewBox="0 0 36 36" aria-hidden="true"><circle class="tt-track" cx="18" cy="18" r="15"></circle><circle class="tt-left" cx="18" cy="18" r="15"></circle></svg>
            <b class="tt-num"></b></span>`}
          <span>${st.yourTurn ? t('combat.endTurnReady', 'Fin du tour') : t('combat.endTurnWaiting', 'Tour adverse')}</span>
        </button>
      </div>

      <div class="hero-row ${anim.youHeroHit ? 'hero-hit' : ''} ${anim.youHeroHeal ? 'hero-heal' : ''}">
        <div class="hero-info">
          <div class="hero-name">${esc(st.you.pseudo)} (toi)</div>${titleLine(st.you.title)}
          <div class="hero-sub">${st.you.libraryCount} cartes en pioche</div>
        </div>
        <div class="hero-center">
          ${weaponBadge(st.you.weapon)}
          <div class="hero-portrait-wrap ${S.targetingSpell && S.targetingSpell.mode === 'heal' ? 'targetable' : ''} ${S.selectedAttacker === 'hero' ? 'selected' : ''} ${myWeaponUsable ? 'weapon-ready' : ''} ${st.yourTurn && st.you.weapon && st.you.weapon.usesThisTurn >= st.you.weapon.usesPerTurn ? 'exhausted' : ''} ${anim.youHeroAttacked ? 'hero-attack-fwd' : ''}" data-hero="you" onclick="App.clickMyHero()" title="${myWeaponUsable ? 'Clique pour attaquer avec ton arme' : 'Clique pour envoyer une provocation'}">
            ${S.activeEmotes[st.you.slug] ? `<div class="emote-bubble from-me">${esc(S.activeEmotes[st.you.slug].text)}</div>` : ''}
            ${avatarHtml(st.you.pseudo, st.you.avatar, st.you.ornament, '', (myHeroTargetable ? 'targetable ' : '') + (finished ? '' : 'emote-ready'))}
            ${finished ? `<span class="emote-hint" onclick="event.stopPropagation();App.openEmoteWheel()">💬</span>` : ''}
            ${armorGem(st.you.heroArmor)}
            ${(st.you.traps || []).length ? `<div class="trap-badges mine">${st.you.traps.map(t => `<span class="trap-card" title="${esc(t.name)} — ${esc(cardEffectSummary(Object.assign({ type: 'sort', effectType: 'trap' }, t)))}">🪤</span>`).join('')}</div>` : ''}
            <div class="hp-gem ${anim.youHeroHit ? 'pulse' : ''}">${st.you.heroHealth}</div>
            ${floatersFor('you-hero')}
          </div>
        </div>
        <div class="hero-mana">${manaCrystals(st.you.mana, st.you.maxMana)}<span class="mana-count">${st.you.mana}/${st.you.maxMana}</span></div>
      </div>

      <div class="hand-row hand-fan">
        ${st.you.hand.map((c, i) => {
          const noTarget = spellNeedsMissingTarget(c, st);
          const affordable = c.cost <= st.you.mana && st.yourTurn && !finished && !noTarget;
          const statLine = handStatLine(c, 15);
          const shinyH = (st.you.foils || []).includes(c.id);
          return `<div class="hand-card rar-${esc(c.rarity)} type-${esc(c.type)} ${shinyH ? 'shiny' : ''} ${c.baseCost != null && c.cost < c.baseCost ? 'discounted' : ''} ${evoClass(c.id)} ${affordable ? '' : (st.yourTurn ? 'unaffordable' : 'waiting')} ${S.targetingSpell && S.targetingSpell.cardId === c.id ? 'pending-target' : ''}" style="${handFanStyle(i, st.you.hand.length)}" ${affordable ? `onpointerdown="App.startCardDrag(event,'${c.id}')"` : `onclick="App.open3DView('${c.id}')" title="${noTarget && st.yourTurn ? esc(noTarget) : 'Clique pour lire la carte'}"`}>
            <div class="card-cost">${c.cost}</div>
            ${shinyH ? shinyFx() : ''}
            ${handCardArt(c)}
            <div class="card-type-tag">${esc(cardTypeLabel(c.type))}</div>
            <div class="card-name">${esc(c.name)}</div>
            ${statLine}
            ${cardTextHTML(c, 'card-desc hand-card-desc')}
          </div>`;
        }).join('')}
      </div>



      ${renderOppPlayReveal()}
    </div>`;
}


/* ---------------- Journal de combat visuel ----------------
   Chaque action du match arrive du serveur sous forme d'événement structuré
   (qui joue quoi, qui frappe qui, combien). On l'affiche en fil d'actualité
   illustré : vignettes des cartes, flèche d'action, pastilles de dégâts (rouge),
   de soin (vert) ou de bonus (or), tête de mort quand quelque chose meurt. */
/* Identifiant de la carte derrière une vignette du journal : la carte jouée,
   le serviteur (sa carte d'origine) ou l'arme d'un héros. null pour un héros sans arme. */
function feedCardId(ref) {
  if (!ref) return null;
  if (ref.kind === 'card') return ref.id || null;
  if (ref.kind === 'minion') return ref.cardId || null;
  if (ref.kind === 'hero' && ref.weapon) return ref.weaponCardId || null;
  return null;
}
function feedThumb(ref) {
  if (!ref) return '';
  const rc = (RARITIES[ref.rarity] || {}).color || 'var(--line)';
  const img = ref.image && /^(\/|https?:)/.test(ref.image) ? ref.image : null;
  const initials = esc(String(ref.name || '?').trim().slice(0, 2).toUpperCase());
  const inner = img ? `<img src="${esc(img)}" alt="">` : `<b>${initials}</b>`;
  const cid = feedCardId(ref);
  // Vignette d'une carte : un clic l'ouvre en grand (zoom 3D, molette pour zoomer davantage)
  return cid
    ? `<button type="button" class="feed-thumb zoomable ${ref.kind === 'hero' ? 'hero' : ''}" style="--rc:${rc}" title="${esc(ref.name || '')} — clique pour voir la carte" onclick="event.stopPropagation();App.zoomFeedCard(${jsArg(cid)}, ${jsArg(ref)})">${inner}</button>`
    : `<span class="feed-thumb ${ref.kind === 'hero' ? 'hero' : ''}" style="--rc:${rc}" title="${esc(ref.name || '')}">${inner}</span>`;
}
function feedBadge(amount, kind, died) {
  const cls = kind === 'heal' ? 'heal' : kind === 'buff' ? 'buff' : 'dmg';
  const txt = kind === 'heal' ? '+' + amount : kind === 'buff' ? '+' + amount + ' ATQ' : '-' + amount;
  return `${amount > 0 || kind !== 'dmg' ? `<span class="feed-badge ${cls}">${txt}</span>` : ''}${died ? '<span class="feed-skull" title="Détruit">💀</span>' : ''}`;
}
function feedWho(slug) {
  const st = S.matchState;
  if (!st) return '';
  if (st.names) return esc(st.names[slug] || '?'); // mode spectateur : on nomme les deux joueurs
  return slug === st.you.slug ? 'Tu' : esc(st.opponent.pseudo);
}
function feedSentence(e) {
  const who = S.matchState && S.matchState.names ? (S.matchState.names[e.by] || '?') : e.by === (S.matchState && S.matchState.you.slug) ? 'Tu' : (S.matchState ? S.matchState.opponent.pseudo : '');
  const tn = t => (t || []).map(x => `${x.name}${x.amount ? ` (${x.amount})` : ''}${x.died ? ' ☠' : ''}`).join(', ');
  switch (e.type) {
    case 'play': return `${who} ${who === 'Tu' ? 'joues' : 'joue'} ${e.card.name} (${cardTypeLabel(e.card.type)})`;
    case 'attack': return `${e.attacker.weapon ? e.attacker.name + ' (' + e.attacker.weapon + ')' : e.attacker.name} attaque ${e.target.name} : ${e.dmg} dégât(s)${e.back ? `, riposte ${e.back}` : ''}${e.targetDied ? `, ${e.target.name} est détruit` : ''}${e.attackerDied ? `, ${e.attacker.name} est détruit` : ''}`;
    case 'damage': return `${e.source.name} inflige des dégâts : ${tn(e.targets)}`;
    case 'heal': return `${e.source.name} soigne : ${tn(e.targets)}`;
    case 'buff': return `${e.source.name} renforce : ${tn(e.targets)}`;
    case 'destroy': return e.area ? `${e.source.name} détruit tous les serviteurs` : `${e.source.name} détruit ${(e.targets || []).map(x => x.name).join(', ')}`;
    case 'gift': return e.by === (S.matchState && S.matchState.you.slug) ? `${e.source.name} te donne : ${(e.cards || []).map(c => c.name).join(', ')}` : `${e.source.name} donne ${(e.cards || []).length} carte(s) à l'adversaire`;
    case 'combo': return `Combo ! ${e.source.name} + ${e.partner.name} : ${e.spawned.name} apparaît`;
    case 'summon': return `${e.source.name} invoque ${(e.targets || []).length} × ${((e.targets || [])[0] || {}).name || 'jeton'}`;
    case 'trapSet': return e.by === (S.matchState && S.matchState.you.slug) ? `Tu poses un piège : ${e.source.name}` : 'Un piège est posé face cachée';
    case 'trap': return `Piège ! ${e.source.name} se déclenche${e.target ? ' sur ' + e.target.name : ''}`;
    case 'grant': return `${e.source.name} donne ${e.keyword} à ${(e.targets || []).map(x => x.name).join(', ')}`;
    case 'deathrattle': return `Râle d'agonie de ${e.source.name}`;
    case 'sleep': return `${e.source.name} endort ${(e.targets || []).map(x => x.name).join(', ')} pendant ${((e.targets || [])[0] || {}).turns || 1} tour(s)`;
    case 'armor': return `${e.source.name} : ${(e.targets || [])[0] ? e.targets[0].name : ''} gagne ${(e.targets || [])[0] ? e.targets[0].amount : 0} d'armure`;
    case 'draw': return `${e.source.name} : ${e.by === (S.matchState && S.matchState.you.slug) ? 'tu pioches' : 'pioche'} ${e.amount} carte${e.amount > 1 ? 's' : ''}`;
    case 'colorblind': return `Daltonisme ! ${e.attacker.name} se trompe de cible et frappe ${e.target.name}`;
    case 'modify': return `${e.source.name} modifie ${(e.targets || []).map(x => `${x.name} (${signed(x.atk)} ATQ, ${signed(x.hp)} PV)${x.died ? ' ☠' : ''}`).join(', ')}`;
    case 'break': return `${e.name} se brise`;
    case 'silence': return `${e.source.name} réduit ${(e.targets || []).map(x => x.name).join(', ')} au silence`;
    case 'levelup': return `${e.source.name} est toujours debout : niveau ${e.level} (+1/+1)`;
    default: return '';
  }
}
function feedRow(e, isNew) {
  const st = S.matchState;
  const mine = st && e.by === st.you.slug;
  const side = mine ? 'me' : 'opp';
  const title = esc(feedSentence(e));
  const wrap = inner => `<div class="feed-row ${side} ${isNew ? 'new' : ''}" title="${title}">${inner}</div>`;
  if (e.type === 'turn') return `<div class="feed-turn ${side}">Tour ${e.turn} · ${mine ? 'à toi' : esc(e.name)}</div>`;
  if (e.type === 'play') {
    return wrap(`${feedThumb(e.card)}<div class="feed-text"><b>${feedWho(e.by)}</b> ${mine ? 'joues' : 'joue'} <b>${esc(e.card.name)}</b><span class="feed-type t-${esc(e.card.type)}">${esc(cardTypeLabel(e.card.type))}</span></div>`);
  }
  if (e.type === 'attack') {
    return wrap(`<span class="feed-unit">${feedThumb(e.attacker)}${feedBadge(e.back, 'dmg', e.attackerDied)}</span>
      <span class="feed-arrow">⚔</span>
      <span class="feed-unit">${feedThumb(e.target)}${feedBadge(e.dmg, 'dmg', e.targetDied)}</span>
      <div class="feed-text small">${esc(e.attacker.weapon ? e.attacker.weapon : e.attacker.name)} → ${esc(e.target.name)}</div>`);
  }
  if (e.type === 'damage' || e.type === 'heal' || e.type === 'buff' || e.type === 'destroy') {
    const kind = e.type === 'damage' || e.type === 'destroy' ? 'dmg' : e.type;
    const icon = { damage: '✦', heal: '✚', buff: '▲', destroy: '☠' }[e.type];
    const targets = (e.targets || []).slice(0, 6);
    const more = (e.targets || []).length - targets.length;
    return wrap(`${feedThumb(e.source)}<span class="feed-arrow ${kind}">${icon}</span>
      <span class="feed-targets">${targets.length ? targets.map(x => `<span class="feed-unit">${feedThumb(x)}${e.type === 'destroy' ? '<span class="feed-skull">💀</span>' : feedBadge(x.amount, kind, x.died)}</span>`).join('') : '<span class="feed-text small">aucune cible</span>'}${more > 0 ? `<span class="feed-text small">+${more}</span>` : ''}</span>`);
  }
  if (e.type === 'gift') {
    const mineG = e.by === (S.matchState && S.matchState.you.slug);
    return wrap(`${feedThumb(e.source)}<span class="feed-arrow buff">🎁</span>${mineG ? `<span class="feed-targets">${(e.cards || []).map(c => `<span class="feed-unit">${feedThumb(c)}</span>`).join('')}</span>` : `<div class="feed-text">${(e.cards || []).length} carte(s) pour l'adversaire</div>`}`);
  }
  if (e.type === 'combo') {
    return wrap(`${feedThumb(e.source)}<span class="feed-arrow">+</span>${feedThumb(e.partner)}<span class="feed-arrow buff">🔗</span><span class="feed-unit">${feedThumb(e.spawned)}</span>`);
  }
  if (e.type === 'summon') {
    return wrap(`${feedThumb(e.source)}<span class="feed-arrow buff">✚</span><span class="feed-targets">${(e.targets || []).map(x => `<span class="feed-unit">${feedThumb(x)}</span>`).join('')}</span>`);
  }
  if (e.type === 'trapSet') {
    const mineT = e.by === (S.matchState && S.matchState.you.slug);
    return wrap(`${mineT ? feedThumb(e.source) : '<span class="feed-thumb"><b>?</b></span>'}<div class="feed-text">${mineT ? `Tu poses le piège <b>${esc(e.source.name)}</b>` : 'Un piège est posé <b>face cachée</b>'}</div>`);
  }
  if (e.type === 'trap') {
    return wrap(`${feedThumb(e.source)}<span class="feed-arrow" title="Piège">🪤</span>${e.target ? `<span class="feed-unit">${feedThumb(e.target)}</span>` : ''}<div class="feed-text small"><b>Piège !</b> ${esc(e.source.name)}</div>`);
  }
  if (e.type === 'grant') {
    const tg = (e.targets || [])[0] || {};
    return wrap(`${feedThumb(e.source)}<span class="feed-arrow buff">✦</span><span class="feed-unit">${feedThumb(tg)}<span class="feed-badge buff">${esc(e.keyword)}</span></span>`);
  }
  if (e.type === 'silence') {
    const tg = (e.targets || [])[0] || {};
    return wrap(`${feedThumb(e.source)}<span class="feed-arrow" title="Silence">🔇</span><span class="feed-unit">${feedThumb(tg)}<span class="feed-badge sleep">silence</span></span>`);
  }
  if (e.type === 'levelup') {
    return wrap(`<span class="feed-unit">${feedThumb(e.source)}<span class="feed-badge buff">+1/+1</span></span><span class="feed-arrow buff" title="Toujours debout">⭐</span><div class="feed-text"><b>Toujours debout</b> · niveau ${e.level}</div>`);
  }
  if (e.type === 'deathrattle') {
    return wrap(`${feedThumb(e.source)}<span class="feed-arrow" title="Râle d'agonie">💀</span><div class="feed-text"><b>Râle d'agonie</b> de ${esc(e.source.name)}</div>`);
  }
  if (e.type === 'sleep') {
    const tg = (e.targets || [])[0] || {};
    return wrap(`${feedThumb(e.source)}<span class="feed-arrow" title="Endormissement">💤</span><span class="feed-unit">${feedThumb(tg)}<span class="feed-badge sleep">${tg.turns || 1} tour${(tg.turns || 1) > 1 ? 's' : ''}</span></span>`);
  }
  if (e.type === 'armor') {
    const tg = (e.targets || [])[0] || {};
    return wrap(`${feedThumb(e.source)}<span class="feed-arrow buff">🛡</span><span class="feed-unit">${feedThumb(tg)}<span class="feed-badge armor">+${tg.amount || 0} 🛡</span></span>`);
  }
  if (e.type === 'draw') {
    return wrap(`${feedThumb(e.source)}<span class="feed-arrow buff">🂠</span><div class="feed-text"><b>${feedWho(e.by)}</b> ${mine ? 'pioches' : 'pioche'} <b>${e.amount}</b> carte${e.amount > 1 ? 's' : ''}${e.battlecry ? ' <span class="feed-type t-minion">cri de guerre</span>' : ''}</div>`);
  }
  if (e.type === 'colorblind') {
    return wrap(`<span class="feed-unit">${feedThumb(e.attacker)}</span><span class="feed-arrow" title="Daltonisme">🎨</span><span class="feed-unit">${feedThumb(e.target)}</span>
      <div class="feed-text small"><b>Daltonisme !</b> ${esc(e.attacker.name)} se trompe de cible : ${esc(e.target.name)}</div>`);
  }
  if (e.type === 'modify') {
    return wrap(`${feedThumb(e.source)}<span class="feed-arrow buff">⇅</span><span class="feed-targets">${(e.targets || []).map(x => `<span class="feed-unit">${feedThumb(x)}<span class="feed-badge ${x.atk >= 0 ? 'buff' : 'dmg'}">${signed(x.atk)} ATQ</span><span class="feed-badge ${x.hp >= 0 ? 'heal' : 'dmg'}">${signed(x.hp)} PV</span>${x.died ? '<span class="feed-skull">💀</span>' : ''}</span>`).join('')}</span>`);
  }
  if (e.type === 'break') return wrap(`<span class="feed-arrow">🪓</span><div class="feed-text"><b>${esc(e.name)}</b> se brise</div>`);
  return '';
}
/* Ctrl+A hors d'un champ de saisie : ne sélectionne pas toute la page */
if (typeof document !== 'undefined' && document.addEventListener) {
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
      const t = e.target, tag = t && t.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (t && t.isContentEditable)) return;
      e.preventDefault();
    }
  });
}

/* ---------- Mode concentration (téléphone) ----------
   Pendant un combat sur téléphone, seuls le plateau et la main restent à
   l'écran. Le bouton ☰ (ou un glissé vers le bas depuis le haut de l'écran)
   ouvre le menu : journal, son, bug, plein écran, abandon. */
function renderFocusMenu() {
  const st = S.matchState;
  if (!st) return '';
  const finished = st.status === 'finished';
  const unread = S.feedUnread || 0;
  return `<button class="focus-menu-btn ${S.focusMenuOpen ? 'open' : ''}" onclick="App.toggleFocusMenu()" aria-label="Menu du combat">☰${unread && !S.focusMenuOpen ? `<span class="badge">${unread}</span>` : ''}</button>
    ${S.focusMenuOpen ? `<div class="focus-sheet-backdrop" onclick="App.toggleFocusMenu(false)"></div>
    <div class="focus-sheet" role="menu">
      <div class="focus-grip"></div>
      <button onclick="App.toggleFocusMenu(false); App.toggleCombatFeed()">📜 Journal du combat${unread ? ` <span class="badge">${unread}</span>` : ''}</button>
      <button onclick="App.toggleSound()">${S.soundOn ? '🔊 Son activé' : '🔇 Son coupé'}</button>
      ${document.documentElement.requestFullscreen && !document.fullscreenElement ? '<button onclick="App.toggleFocusMenu(false); App.enterLandscape()">⛶ Plein écran</button>' : ''}
      ${!finished && st.survival ? `<button ${st.yourTurn ? '' : 'disabled'} onclick="App.survivalPause()">⏸ Mettre la Survie en pause${st.yourTurn ? '' : ' (pendant ton tour)'}</button>` : ''}
      ${!finished && st.puzzle ? `<button onclick="App.puzzleRetry()">↺ Recommencer le puzzle</button>` : ''}
      <button onclick="App.toggleFocusMenu(false); App.openBugReport()">🐞 Signaler un bug</button>
      <button onclick="App.setOpt('focusMode', false); App.toggleFocusMenu(false)">👁 Quitter le mode concentration</button>
      ${!finished ? '<button class="danger" onclick="App.toggleFocusMenu(false); App.forfeitMatch()">🏳 Abandonner</button>' : ''}
    </div>` : ''}`;
}
if (typeof document !== 'undefined' && typeof window !== 'undefined' && document.addEventListener && !window.__focusSwipe) {
  window.__focusSwipe = true;
  let y0 = null;
  document.addEventListener('touchstart', e => { const t = e.touches[0]; y0 = document.body.classList.contains('focus-mode') && t && t.clientY < 36 ? t.clientY : null; }, { passive: true });
  document.addEventListener('touchmove', e => {
    if (y0 === null) return;
    const t = e.touches[0];
    if (t && t.clientY - y0 > 60) { y0 = null; if (!S.focusMenuOpen) App.toggleFocusMenu(true); }
  }, { passive: true });
  document.addEventListener('touchend', () => { y0 = null; }, { passive: true });
}

function renderCombatFeed() {
  const st = S.matchState;
  if (!st || st.phase === 'mulligan') return '';
  // Regroupe par tour : l'en-tête « Tour N » au-dessus de ses actions, le tour le plus récent en haut
  const groups = [];
  (st.events || []).forEach(e => {
    if (e.type === 'turn' || !groups.length) groups.push({ head: e.type === 'turn' ? e : null, items: [] });
    if (e.type !== 'turn') groups[groups.length - 1].items.push(e);
  });
  const events = [];
  groups.reverse().forEach(g => { if (g.head) events.push(g.head); events.push(...g.items.slice().reverse()); });
  const fresh = Date.now() - (S.newEventsAt || 0) < 500; // surlignage/entrée seulement juste après l'arrivée
  const newSeqs = new Set(fresh ? (S.newEvents || []).map(e => e.seq) : []);
  const open = S.feedOpen !== undefined ? S.feedOpen : (typeof window !== 'undefined' && window.innerWidth >= 1500);
  const unread = S.feedUnread || 0;
  return `<button class="combat-feed-toggle ${open ? 'open' : ''}" onclick="App.toggleCombatFeed()">📜 Journal${!open && unread ? ` <span class="badge">${unread}</span>` : ''}</button>
    ${open ? `<aside class="combat-feed" aria-label="Journal de combat">
      <div class="feed-list">${events.length ? events.map(e => feedRow(e, newSeqs.has(e.seq))).join('') : '<div class="feed-empty">Les actions du combat apparaîtront ici.</div>'}</div>
      <details class="feed-raw"><summary>Détail texte</summary><div class="combat-log">${st.log.map(l => `<div class="log-line">${esc(l)}</div>`).join('')}</div></details>
    </aside>` : ''}`;
}

/* Carte jouée par l'adversaire : grande prévisualisation 2 s à gauche du plateau */
function renderOppPlayReveal() {
  const c = S.oppPlayReveal;
  if (!c) return '';
  const enter = Date.now() - (S.oppPlayRevealAt || 0) < 400 ? 'enter' : '';
  return `<div class="opp-reveal ${enter}">
    <div class="opp-reveal-who">${esc(S.matchState ? S.matchState.opponent.pseudo : '')} joue</div>
    <div class="hand-card rar-${esc(c.rarity)} type-${esc(c.type)}">
      <div class="card-cost">${c.cost}</div>
      ${handCardArt(c)}
      <div class="card-type-tag">${esc(cardTypeLabel(c.type))}</div>
      <div class="card-name">${esc(c.name)}</div>
      ${handStatLine(c, 15)}
      ${cardTextHTML(c, 'card-desc hand-card-desc')}
    </div>
  </div>`;
}

function renderEmoteWheel() {
  if (!S.emoteWheelOpen || !S.matchState) return '';
  const wheel = (S.profile.emoteWheel || []);
  const all = (S.config && S.config.emotes) || [];
  const radius = 118;
  const slots = wheel.map((id, i) => {
    const e = all.find(x => x.id === id);
    if (!e) return '';
    // Répartition circulaire, en démarrant en haut
    const angle = (Math.PI * 2 * i / wheel.length) - Math.PI / 2;
    const x = Math.cos(angle) * radius;
    const y = Math.sin(angle) * radius;
    return `<div class="emote-slot" style="transform:translate(calc(-50% + ${x.toFixed(0)}px), calc(-50% + ${y.toFixed(0)}px));"
      onclick="App.sendEmote('${e.id}')">${esc(e.text)}</div>`;
  }).join('');
  return `<div class="emote-wheel-overlay" onclick="App.closeEmoteWheel()">
    <div class="emote-wheel" onclick="event.stopPropagation()">
      ${slots}
      <button class="emote-wheel-close" onclick="App.closeEmoteWheel()">Fermer</button>
    </div>
  </div>`;
}

function renderJoueurs() {
  if (S.viewedPlayer) {
    const p = S.viewedPlayer;
    const isFriend = (S.profile.friends || []).includes(p.slug);
    const theirCards = ownedCardsList(p.collection);
    const myCards = ownedCardsList(S.profile.collection);
    const builder = S.tradeBuilder && S.tradeBuilder.slug === p.slug ? S.tradeBuilder : null;
    const requestIds = builder ? builder.requestIds : new Set();
    const offerIds = builder ? builder.offerIds : new Set();

    let tradePanel = '';
    if (builder) {
      tradePanel = `<div class="panel trade-builder">
        <h3 style="margin-top:0;">Construire un échange avec ${esc(p.pseudo)}</h3>
        <p class="page-sub" style="margin-bottom:14px;">Clique sur les cartes que tu demandes ci-dessous, puis sur celles que tu offres. Tu peux aussi offrir ou demander sans contrepartie — au moins une carte au total suffit.</p>
        <div class="trade-summary">
          <div><b>Tu demandes</b> (${requestIds.size}) : ${requestIds.size === 0 ? '<span class="tone-tag">aucune</span>' : Array.from(requestIds).map(id => esc((cardById(id) || {}).name || id)).join(', ')}</div>
          <div><b>Tu offres</b> (${offerIds.size}) : ${offerIds.size === 0 ? '<span class="tone-tag">aucune</span>' : Array.from(offerIds).map(id => esc((cardById(id) || {}).name || id)).join(', ')}</div>
        </div>
        <div class="btn-row">
          <button class="btn" ${(requestIds.size === 0 && offerIds.size === 0) ? 'disabled' : ''} onclick="App.confirmTradeBuilder()">Envoyer la proposition</button>
          <button class="btn ghost" onclick="App.cancelTradeBuilder()">Annuler</button>
        </div>
      </div>`;
    } else {
      tradePanel = `<div class="btn-row" style="margin-bottom:14px;"><button class="btn ghost" onclick="App.startTradeBuilder('${p.slug}')">🔁 Proposer un échange</button></div>`;
    }

    return `
      <div class="player-sheet-head ${p.banner && bannerById(p.banner) ? 'has-banner' : ''}" style="display:flex;align-items:center;gap:16px;margin-bottom:8px;${bannerStyle(p.banner)}">
        ${avatarHtml(p.pseudo, p.avatar, p.ornament)}
        <div>
          <h1 class="page-title" style="margin:0;">${esc(p.pseudo)}</h1>${titleLine(p.title)}
          <div style="margin-top:6px;">${rankPill(p.rank)} <span style="color:var(--muted);font-size:13px;margin-left:8px;">${p.seasonVP} pts · ${p.seasonWins}V / ${p.seasonLosses}D</span></div>
          ${p.bio ? `<p class="profile-bio">${esc(p.bio)}</p>` : ''}
        </div>
      </div>
      ${renderCardShowcaseView(p.cardShowcase)}
      ${p.careerStats && p.careerStats.games ? renderCareer(p.careerStats, true) : ''}
      ${p.achievementShowcase && p.achievementShowcase.length > 0 ? `
      <div class="showcase-row">
        ${p.achievementShowcase.map(a => `<div class="showcase-badge" title="${esc(a.name)}">
          ${a.icon ? `<img src="${esc(a.icon)}" alt="">` : '🏅'}
        </div>`).join('')}
      </div>` : ''}
      <div class="btn-row" style="margin-bottom:14px;">
        <button class="btn ghost" onclick="App.backToDirectory()">← Retour</button>
        <button class="btn ${isFriend ? 'ghost' : ''}" onclick="App.toggleFriend('${p.slug}')">${isFriend ? '✓ Ami (retirer)' : '+ ' + t('btn.addFriend', 'Ajouter en ami')}</button>
        ${isFriend && p.online ? `<button class="btn" onclick="App.challengeFriend('${p.slug}')">${t('btn.challenge', 'Défier en combat')}</button>` : ''}
      </div>
      ${tradePanel}
      <h3>Sa collection ${builder ? '(clique pour marquer ce que tu demandes)' : ''}</h3>
      ${theirCards.length === 0 ? '<div class="empty">Ce joueur n\'a pas encore de cartes.</div>' :
        `<div class="grid">${theirCards.map(x => renderCardTile(x.card, {
          count: x.count, selected: requestIds.has(x.card.id),
          onClick: builder ? `App.toggleTradeCard('request','${x.card.id}')` : ''
        })).join('')}</div>`}
      ${builder ? `
      <h3 style="margin-top:26px;">Ta collection (clique pour marquer ce que tu offres)</h3>
      ${myCards.length === 0 ? '<div class="empty">Tu n\'as aucune carte à offrir.</div>' :
        `<div class="grid">${myCards.map(x => renderCardTile(x.card, {
          count: x.count, selected: offerIds.has(x.card.id),
          onClick: `App.toggleTradeCard('offer','${x.card.id}')`
        })).join('')}</div>`}` : ''}
    `;
  }
  const filter = (S.playerFilter || '').toLowerCase();
  const others = (S.playersList || []).filter(u => u.pseudo.toLowerCase().includes(filter));
  const friendSlugs = S.profile.friends || [];
  const friends = (S.playersList || []).filter(u => friendSlugs.includes(u.slug));
  const rowFor = (u) => `<div class="player-row" onclick="App.viewPlayer('${u.slug}')">
      <div style="display:flex;align-items:center;gap:10px;">
        ${avatarHtml(u.pseudo, u.avatar, u.ornament, 'sm')}
        <div><b>${esc(u.pseudo)}</b> ${rankPill(u.rank)}<br>
          <span style="font-size:12px;color:var(--muted);"><span class="online-dot ${u.online ? 'on' : ''}"></span>${u.online ? 'en ligne' : 'hors ligne'}</span></div>
      </div>
      <span class="tag">Voir</span>
    </div>`;
  return `<h1 class="page-title">${t('title.joueurs', 'Joueurs')}</h1>
    <p class="page-sub">${t('sub.joueurs', "Consulte les collections, ajoute des amis, propose des échanges et lance des défis.")}</p>
    <div class="panel">
      <h3 style="margin-top:0;">Mes amis (${friends.length})</h3>
      ${friends.length === 0 ? '<div class="empty">Aucun ami pour l\'instant.</div>' : `<div class="player-list">${friends.map(rowFor).join('')}</div>`}
    </div>
    <div class="panel">
      <h3 style="margin-top:0;">Rechercher un joueur</h3>
      <input type="text" class="search-input" placeholder="Nom du joueur…" oninput="App.setPlayerFilter(this.value)" value="${esc(S.playerFilter || '')}" />
      ${others.length === 0 ? `<div class="empty">${t('empty.players', 'Aucun joueur trouvé.')}</div>` : `<div class="player-list">${others.map(rowFor).join('')}</div>`}
    </div>`;
}

function renderAchievements() {
  const list = S.achievements || [];
  const unlockedCount = list.filter(a => a.unlocked).length;
  const showcase = S.showcaseDraft || [];
  return `
    <h1 class="page-title">${icon('icon.achievements', '🏅')} ${t('nav.achievements', 'Succès')}</h1>
    <p class="page-sub">${list.length === 0 ? "Aucun succès n'a encore été créé." : `${unlockedCount} / ${list.length} débloqué(s)`}</p>
    ${unlockedCount > 0 ? `
    <div class="panel">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:0;">
        <div><b>Vitrine de succès</b> — <span class="tone-tag">${showcase.length}/5 sélectionné(s)</span><br>
        <span style="color:var(--muted);font-size:12.5px;">Coche jusqu'à 5 succès débloqués pour les afficher sur ton profil, visibles des autres joueurs.</span></div>
        <button class="btn small" onclick="App.saveShowcase()">Enregistrer la vitrine</button>
      </div>
    </div>` : ''}
    ${renderSecretsPanel()}
    ${list.length === 0 ? '<div class="empty">Reviens plus tard !</div>' : `
    <div class="grid achievements-grid">
      ${list.map(a => `
        <div class="achievement-card ${a.unlocked ? 'unlocked' : ''}">
          <div class="achievement-icon">${a.icon ? `<img src="${esc(a.icon)}" alt="">` : '🏅'}</div>
          <div class="achievement-body">
            <div class="achievement-name">${esc(a.name)}</div>
            <div class="achievement-desc">${esc(a.description || '')}</div>
            ${a.unlocked
              ? `<div class="achievement-status done">✓ Débloqué</div>
                 <label style="display:flex;align-items:center;gap:6px;margin-top:6px;font-size:12px;cursor:pointer;">
                   <input type="checkbox" style="width:auto;" ${showcase.includes(a.id) ? 'checked' : ''} onchange="App.toggleShowcase('${a.id}')"> Dans ma vitrine
                 </label>`
              : `<div class="achievement-progress-bar"><div class="achievement-progress-fill" style="width:${Math.round((a.progress || 0) * 100)}%"></div></div>`}
            ${(a.rewardCredits || a.rewardDust) ? `<div class="tone-tag">Récompense : ${a.rewardCredits ? a.rewardCredits + ' 🪙 ' : ''}${a.rewardDust ? a.rewardDust + ' ✧' : ''}</div>` : ''}
          </div>
        </div>
      `).join('')}
    </div>`}
  `;
}

function renderEvenements() {
  const ev = S.events || { casino: {}, boss: {}, blackjack: {} };
  const casinoOn = ev.casino && ev.casino.active;
  const bossOn = ev.boss && ev.boss.active;
  const blackjackOn = ev.blackjack && ev.blackjack.active;
  const r = S.casinoResult;

  return `
    <h1 class="page-title">${icon('icon.evenements', '🎉')} ${t('nav.evenements', 'Événements')}</h1>
    <p class="page-sub">Des mini-jeux temporaires, activés et réglés par l'admin.</p>
    ${!casinoOn && !bossOn && !blackjackOn ? '<div class="empty">Aucun événement actif pour le moment — reviens plus tard !</div>' : ''}

    ${casinoOn ? `
    <div class="panel event-casino">
      <h3 style="margin-top:0;">🎰 Casino</h3>
      <p class="page-sub" style="margin-bottom:16px;">Aligne 3 symboles identiques pour remporter le gain.
      ${ev.casino.daysRemaining !== null && ev.casino.daysRemaining !== undefined ? ` <span class="tone-tag">⏳ ${ev.casino.daysRemaining} jour(s) restant(s)</span>` : ''}</p>
      <div class="slot-machine-frame">
        <div class="slot-machine-topper"><span>✦ JACKPOT ✦</span></div>
        <div class="slot-window">
          <div class="slot-reels">
            ${[0, 1, 2].map(i => `<div class="slot-reel ${S.casinoSpinning ? 'spinning' : ''}"><span class="slot-symbol">${esc((S.casinoReelDisplay || ['❔','❔','❔'])[i])}</span></div>`).join('')}
          </div>
          <div class="slot-payline"></div>
        </div>
        ${r ? `<div class="slot-result ${r.payout > 0 ? 'win' : ''}">${r.payout > 0 ? `🎉 Gagné : +${r.payout} ${r.currency === 'credits' ? '🪙' : '✧'}` : 'Perdu — retente ta chance !'}</div>` : ''}
        <div class="btn-row" style="justify-content:center;flex-wrap:wrap;">
          ${ev.casino.costPerSpinDust > 0 ? `<button class="btn" ${S.casinoSpinning ? 'disabled' : ''} onclick="App.spinCasino('dust')">${S.casinoSpinning ? 'Ça tourne…' : `Jouer — ${ev.casino.costPerSpinDust} ✧`}</button>` : ''}
          ${ev.casino.costPerSpinCredits > 0 ? `<button class="btn" ${S.casinoSpinning ? 'disabled' : ''} onclick="App.spinCasino('credits')">${S.casinoSpinning ? 'Ça tourne…' : `Jouer — ${ev.casino.costPerSpinCredits} 🪙`}</button>` : ''}
        </div>
        <div style="text-align:center;color:var(--muted);font-size:12.5px;margin-top:8px;">Ta poussière : ${S.profile.dust} ✧ · Tes crédits : ${S.profile.credits} 🪙</div>
        <div class="slot-paytable">
          ${ev.casino.symbols.map(s => `<span>${esc(s.icon)}${esc(s.icon)}${esc(s.icon)} = ×${s.payout}</span>`).join(' · ')}
        </div>
      </div>
    </div>` : ''}

    ${bossOn ? `
    <div class="panel event-boss">
      <h3 style="margin-top:0;">👹 Boss de l'événement</h3>
      <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap;">
        <div class="boss-portrait">${ev.boss.image ? `<img src="${esc(ev.boss.image)}" alt="">` : '👹'}</div>
        <div style="flex:1;min-width:200px;">
          <div style="font-weight:700;font-size:16px;">${esc(ev.boss.name)}</div>
          <div style="color:var(--muted);font-size:13px;margin:4px 0 10px;">${ev.boss.heroHealth} PV · Récompense de victoire : ${ev.boss.rewardDust ? ev.boss.rewardDust + ' ✧' : ''}${ev.boss.rewardDust && ev.boss.rewardCredits ? ' + ' : ''}${ev.boss.rewardCredits ? ev.boss.rewardCredits + ' 🪙' : ''}
          ${ev.boss.daysRemaining !== null && ev.boss.daysRemaining !== undefined ? ` <span class="tone-tag">⏳ ${ev.boss.daysRemaining} jour(s) restant(s)</span>` : ''}</div>
          <button class="btn" ${!S.bossAvailableToday ? 'disabled' : ''} onclick="App.startBossFight()">${S.bossAvailableToday ? 'Affronter le boss' : "Déjà affronté aujourd'hui — reviens demain"}</button>
        </div>
      </div>
    </div>` : ''}

    ${blackjackOn ? renderBlackjackPanel(ev) : ''}
  `;
}

function playingCardHtml(card) {
  if (card.hidden) return `<div class="pcard pcard-back">🂠</div>`;
  const red = card.suit === '♥' || card.suit === '♦';
  return `<div class="pcard ${red ? 'red' : ''}"><span>${esc(card.rank)}</span><span class="pcard-suit">${esc(card.suit)}</span></div>`;
}

function renderBlackjackPanel(ev) {
  const bj = S.blackjackState;
  const playing = bj && bj.status === 'playing';
  const finished = bj && bj.status === 'finished';
  return `
    <div class="panel event-blackjack">
      <h3 style="margin-top:0;">🃏 Blackjack</h3>
      <p class="page-sub" style="margin-bottom:16px;">Approche-toi de 21 sans le dépasser. Un blackjack naturel (as + figure) paie 3 pour 2.
      ${ev.blackjack.daysRemaining !== null && ev.blackjack.daysRemaining !== undefined ? ` <span class="tone-tag">⏳ ${ev.blackjack.daysRemaining} jour(s) restant(s)</span>` : ''}</p>

      ${!bj || finished ? `
        ${finished ? `<div class="bj-result ${bj.outcome.result}">
          ${bj.outcome.result === 'win' ? '🎉 Gagné !' : bj.outcome.result === 'blackjack' ? '🂡 Blackjack !' : bj.outcome.result === 'push' ? 'Égalité — mise rendue.' : 'Perdu.'}
          ${bj.outcome.multiplier > 0 ? ` +${Math.round(bj.bet * bj.outcome.multiplier)} ${bj.currency === 'credits' ? '🪙' : '✧'}` : ''}
        </div>` : ''}
        <div class="btn-row" style="justify-content:center;flex-wrap:wrap;">
          ${ev.blackjack.costDust > 0 ? `<button class="btn" onclick="App.startBlackjack('dust')">Miser ${ev.blackjack.costDust} ✧</button>` : ''}
          ${ev.blackjack.costCredits > 0 ? `<button class="btn" onclick="App.startBlackjack('credits')">Miser ${ev.blackjack.costCredits} 🪙</button>` : ''}
        </div>
        <div style="text-align:center;color:var(--muted);font-size:12.5px;margin-top:8px;">Ta poussière : ${S.profile.dust} ✧ · Tes crédits : ${S.profile.credits} 🪙</div>
      ` : `
        <div class="bj-table">
          <div class="bj-hand-label">Croupier ${bj.dealerTotal !== null ? `(${bj.dealerTotal})` : ''}</div>
          <div class="bj-hand">${bj.dealerCards.map(playingCardHtml).join('')}</div>
          <div class="bj-hand-label" style="margin-top:16px;">Toi (${bj.playerTotal})</div>
          <div class="bj-hand">${bj.playerCards.map(playingCardHtml).join('')}</div>
        </div>
        ${playing ? `<div class="btn-row" style="justify-content:center;">
          <button class="btn" onclick="App.blackjackHit()">Tirer</button>
          <button class="btn ghost" onclick="App.blackjackStand()">Rester</button>
        </div>` : ''}
      `}
    </div>`;
}

function renderEchanges() {
  const received = (S.trades.received || []).slice().sort((a, b) => b.createdAt - a.createdAt);
  const sent = (S.trades.sent || []).slice().sort((a, b) => b.createdAt - a.createdAt);
  function tagFor(s) {
    if (s === 'pending') return '<span class="tag pending">en attente</span>';
    if (s === 'accepté') return '<span class="tag done">accepté</span>';
    if (s === 'refusé' || s === 'invalide') return `<span class="tag bad">${s}</span>`;
    return '<span class="tag">annulé</span>';
  }
  function cardListStr(cards) { return (cards || []).map(c => esc(c.name)).join(', ') || '—'; }
  return `<h1 class="page-title">${t('title.echanges', 'Échanges')}</h1>
    <p class="page-sub">${t('sub.echanges', "Les propositions se lancent depuis la fiche d'un joueur (Social → Joueurs).")}</p>
    <div class="panel">
      <h3 style="margin-top:0;">Demandes reçues</h3>
      ${received.length === 0 ? `<div class="empty">${t('empty.trades', "Rien pour l'instant.")}</div>` : received.map(r => `
        <div class="row-card">
          <div class="info"><b>${esc(r.fromPseudo)}</b> t'offre <b>${cardListStr(r.offerCards)}</b> contre <b>${cardListStr(r.requestCards)}</b> ${tagFor(r.status)}</div>
          ${r.status === 'pending' ? `<button class="btn small" onclick="App.acceptTrade('${r.id}')">Accepter</button><button class="btn small ghost" onclick="App.declineTrade('${r.id}')">Refuser</button>` : ''}
        </div>`).join('')}
    </div>
    <div class="panel">
      <h3 style="margin-top:0;">Demandes envoyées</h3>
      ${sent.length === 0 ? '<div class="empty">Aucune demande envoyée.</div>' : sent.map(r => `
        <div class="row-card">
          <div class="info">À <b>${esc(r.toPseudo)}</b> : tu offres <b>${cardListStr(r.offerCards)}</b> contre <b>${cardListStr(r.requestCards)}</b> ${tagFor(r.status)}</div>
          ${r.status === 'pending' ? `<button class="btn small ghost" onclick="App.cancelTrade('${r.id}')">Annuler</button>` : ''}
        </div>`).join('')}
    </div>`;
}

const ADMIN_RARITIES = ['commun', 'rare', 'epique', 'legendaire'];

/* ---------------- Export de la liste des cartes (panel admin) ----------------
   Tout se fait dans le navigateur à partir du pool déjà chargé : CSV pour
   Excel / Google Sheets (séparateur « ; » et BOM UTF-8 pour que les accents
   et les colonnes s'ouvrent correctement dans Excel en français), ou JSON brut
   avec absolument tous les champs. */
const EXPORT_EFFECT_LABELS = {
  damage: 'Dégâts (cible)', heal: 'Soin (cible)', buff_attack: 'Bonus ATQ (cible)',
  aoe_damage: 'Dégâts de zone (ennemis)', aoe_heal: 'Soin de zone (alliés)',
  damage_all: 'Dégâts à tous', buff_all_allies: 'Bonus ATQ (tous les alliés)',
  board_wipe: 'Destruction totale', buff_ally_and_heal: 'Bonus ATQ + soin', modify_stats: 'Modifier ATQ et PV', draw: 'Piocher des cartes', armor: 'Armure du héros', sleep: 'Endormissement', destroy: 'Détruire une cible', silence: 'Silence',
  give_shield: 'Donner Bouclier', give_windfury: 'Donner Furie', give_stealth: 'Donner Camouflage', give_taunt: 'Donner Provocation', give_deathrattle: "Donner un Râle d'agonie", summon: 'Invocation', trap: 'Piège', random_cards: 'Cartes au hasard'
};
// Les sorts sont enregistrés avec le type « sort » : tout ce qui n'est ni serviteur ni arme est un sort
const isSpellCard = c => c.type !== 'minion' && c.type !== 'weapon';
const signed = n => { const v = Math.round(Number(n) || 0); return (v >= 0 ? '+' : '−') + Math.abs(v); };
/* Texte d'une carte en jeu : l'EFFET en clair (généré à partir des données de
   la carte : « Détruit tous les serviteurs », « Provocation · Charge »...) en
   premier, puis la description de la carte en italique. Si la description dit
   déjà la même chose, on ne répète pas l'effet. */
function cardEffectParts(c) {
  if (!c) return [];
  const card = c.instanceId && !c.type ? Object.assign({}, c, { type: 'minion' }) : c; // serviteur posé sur le plateau
  const txt = cardEffectSummary(card);
  if (!txt) return [];
  const desc = String(c.desc || '').toLowerCase();
  // On ne répète pas ce que la description dit déjà : soit la phrase entière,
  // soit son mot-clé (« Cri de guerre », « Provocation », « Charge »...).
  return txt.split(' · ').filter(part => {
    if (!part) return false;
    const low = part.toLowerCase();
    const key = low.includes(':') ? low.split(':')[0].trim() : low;
    return !desc.includes(low) && !(key.length > 3 && /^(cri de guerre|provocation|charge|à l'équipement)/.test(key) && desc.includes(key));
  });
}
function cardTextHTML(c, cls) {
  const parts = cardEffectParts(c);
  const desc = String(c.desc || '').trim();
  if (!parts.length && !desc) return `<div class="${cls}"></div>`;
  return `<div class="${cls}">${parts.length ? `<b class="card-fx">${kwWrap(esc(parts.join(' · ')))}.</b>` : ''}${parts.length && desc ? ' ' : ''}${desc ? `<span class="card-flavor">${esc(desc)}</span>` : ''}</div>`;
}

function spellEffectText(effectType, v, v2) {
  return cardEffectSummary({ type: 'sort', effectType, value: v, value2: v2 }).split(' · ')[0];
}
function cardEffectSummary(c) {
  const parts = [];
  if (isSpellCard(c)) {
    const v = c.value, v2 = c.value2;
    const txt = {
      damage: `Inflige ${v} dégâts à une cible`, heal: `Rend ${v} PV à une cible`, buff_attack: `Donne +${v} ATQ à un de tes serviteurs`,
      aoe_damage: `Inflige ${v} dégâts à tous les serviteurs adverses`, aoe_heal: `Rend ${v} PV à ton héros et à tous tes serviteurs`,
      damage_all: `Inflige ${v} dégâts à tous les serviteurs des deux camps`, buff_all_allies: `Donne +${v} ATQ à tous tes serviteurs`,
      board_wipe: 'Détruit tous les serviteurs des deux camps', buff_ally_and_heal: `Donne +${v} ATQ à un de tes serviteurs et rend ${v2 || 0} PV à ton héros`,
      modify_stats: `Un serviteur au choix : ${signed(v)} ATQ et ${signed(v2)} PV`,
      draw: `Pioche ${v || 1} carte${(v || 1) > 1 ? 's' : ''}`,
      armor: `Donne ${v || 1} d'armure à ton héros`,
      destroy: 'Détruit un serviteur au choix',
      silence: 'Réduit un serviteur au silence : il perd tous ses effets',
      random_cards: `Te donne ${v || 2} carte${(v || 2) > 1 ? 's' : ''} au hasard${c.randomPool && c.randomPool.length ? ` (parmi ${c.randomPool.length} carte${c.randomPool.length > 1 ? 's' : ''} choisie${c.randomPool.length > 1 ? 's' : ''})` : ''}`,
      summon: `Invoque ${v || 1} ${c.tokenName || 'jeton'} ${c.tokenAttack != null ? c.tokenAttack : 1}/${c.tokenHealth != null ? c.tokenHealth : 1}`,
      trap: `Piège : ${({ enemy_attack: 'quand un ennemi attaque', enemy_minion: "quand l'adversaire pose un serviteur", enemy_spell: "quand l'adversaire lance un sort" })[c.trapTrigger || 'enemy_attack']}, ${({ sleep: 'il est endormi', destroy: 'il est détruit', silence: 'il est réduit au silence', damage: `il subit ${c.trapValue || 1} dégât${(c.trapValue || 1) > 1 ? 's' : ''}`, draw: `tu pioches ${c.trapValue || 1} carte${(c.trapValue || 1) > 1 ? 's' : ''}`, armor: `ton héros gagne ${c.trapValue || 1} d'armure`, summon: `tu invoques ${c.trapValue || 1} ${c.tokenName || 'jeton'}` })[c.trapEffect || 'sleep']}`,
      give_shield: 'Donne Bouclier à un de tes serviteurs', give_windfury: 'Donne Furie à un de tes serviteurs',
      give_stealth: 'Donne Camouflage à un de tes serviteurs', give_taunt: 'Donne Provocation à un de tes serviteurs',
      give_deathrattle: `Donne à un de tes serviteurs : Râle d'agonie (${c.drEffect ? cardEffectSummary({ type: 'sort', effectType: c.drEffect, value: c.drValue, value2: c.drValue2 }).split(' · ')[0] : '?'})`,
      sleep: `Endort un serviteur pendant ${v || 1} tour${(v || 1) > 1 ? 's' : ''} : il ne peut pas attaquer`
    }[c.effectType];
    parts.push(txt || `${EXPORT_EFFECT_LABELS[c.effectType] || c.effectType || 'Effet'}${v != null ? ' ' + v : ''}`);
  }
  const bcs = [[c.bcEffect, c.bcValue, c.bcValue2], [c.bc2Effect, c.bc2Value, c.bc2Value2], [c.bc3Effect, c.bc3Value, c.bc3Value2]].filter(x => x[0]);
  if (!isSpellCard(c) && bcs.length) parts.push('Cri de guerre : ' + bcs.map(([e, v, v2]) => cardEffectSummary({ type: 'sort', effectType: e, value: v, value2: v2 }).split(' · ')[0]).join(' + '));
  if (c.taunt) parts.push('Provocation');
  if (!isSpellCard(c) && c.comboPartnerId) parts.push(`Combo avec ${(typeof cardById === 'function' && cardById(c.comboPartnerId) || {}).name || 'une autre carte'} : fait apparaître ${(typeof cardById === 'function' && cardById(c.comboSpawnId) || {}).name || 'une carte'}`);
  if (!isSpellCard(c) && c.auraAttack) parts.push(`Aura : ${c.auraScope === 'adjacent' ? 'ses voisins ont' : 'tes autres serviteurs ont'} +${c.auraAttack} ATQ`);
  if (!isSpellCard(c) && c.shield) parts.push('Bouclier');
  if (!isSpellCard(c) && c.windfury) parts.push('Furie');
  if (!isSpellCard(c) && c.stealth) parts.push('Camouflage');
  if (!isSpellCard(c) && c.standing) parts.push('Toujours debout');
  if (!isSpellCard(c) && c.rage) parts.push(`Rage (+${c.rage} ATQ tant qu'il est blessé)`);
  if (!isSpellCard(c) && c.drEffect) parts.push("Râle d'agonie : " + cardEffectSummary({ type: 'sort', effectType: c.drEffect, value: c.drValue, value2: c.drValue2 }).split(' · ')[0]);
  if (c.colorblind) parts.push(`Daltonisme (${c.colorblindChance || 50} % de frapper une cible au hasard)`);
  if (c.charge) parts.push('Charge');
  if (c.armor) parts.push(`Donne ${c.armor} d'armure à ton héros`);
  if (c.battlecryHeal) parts.push(c.type === 'weapon' ? `À l'équipement : +${c.battlecryHeal} PV` : `Cri de guerre : +${c.battlecryHeal} PV`);
  if (c.type === 'weapon' && c.usesPerTurn > 1) parts.push(`${c.usesPerTurn} attaques par tour`);
  return parts.join(' · ');
}
function cardExportRows(pool) {
  const yes = b => b ? 'oui' : '';
  const num = v => (v === undefined || v === null || v === '') ? '' : v;
  const header = ['ID', 'Nom', 'Extension', 'Rareté', 'Type', 'Coût', 'ATQ', 'PV', 'Durabilité (arme)', 'Attaques par tour (arme)',
    'Effet (sort)', 'Valeur', 'Valeur 2', 'Provocation', 'Charge', 'Armure', 'Soin (cri / équipement)', 'Résumé des effets',
    'Description', 'Poids de tirage', '% par booster (estimé)', 'Image', 'Son', 'Parallaxe 3D'];
  const rows = pool.map(c => [
    c.id, c.name, c.extensionName || 'Base', (RARITIES[c.rarity] || {}).label || c.rarity, cardTypeLabel(c.type), num(c.cost),
    isSpellCard(c) ? '' : num(c.attack), c.type === 'minion' ? num(c.health) : '',
    c.type === 'weapon' ? num(c.durability) : '', c.type === 'weapon' ? num(c.usesPerTurn || 1) : '',
    isSpellCard(c) ? (EXPORT_EFFECT_LABELS[c.effectType] || c.effectType || '') : '', isSpellCard(c) ? num(c.value) : '', isSpellCard(c) ? num(c.value2) : '',
    yes(c.taunt), yes(c.charge), num(c.armor || ''), num(c.battlecryHeal || ''), cardEffectSummary(c),
    c.desc || '', num(c.dropWeight || 1),
    (p => p == null ? '' : p.toFixed(2).replace('.', ','))(estimatedDropPercent(c.rarity, c.dropWeight || 1, pool.filter(x => x.id !== c.id))),
    c.image || '', c.sound || '', yes(c.parallax)
  ]);
  return [header, ...rows];
}
function toCsv(rows) {
  const cell = v => { const s = String(v == null ? '' : v); return /[;"\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  return '\ufeff' + rows.map(r => r.map(cell).join(';')).join('\r\n');
}
function downloadText(filename, text, mime) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function estimatedDropPercent(rarity, weight, pool) {
  const cfg = S.config;
  if (!cfg || !cfg.rarityWeights) return null;
  const bucket = (pool || S.cardPool).filter(c => c.rarity === rarity);
  const weights = bucket.map(c => Math.max(0.05, Number(c.dropWeight) || 1));
  const total = weights.reduce((a, b) => a + b, 0) + Math.max(0.05, Number(weight) || 1);
  const rarityPercent = cfg.rarityWeights[rarity] || 0;
  return total > 0 ? (rarityPercent * Math.max(0.05, Number(weight) || 1) / total) : 0;
}

function renderAdminGate() {
  return `<h1 class="page-title">Admin</h1>
  <div class="panel" style="max-width:340px;">
    <label>Code d'accès</label>
    <input type="password" id="admin-code" placeholder="Code admin" onkeydown="if(event.key==='Enter')App.tryAdminLogin()" />
    ${S.adminGateError ? `<p class="admin-gate-error" role="alert">${esc(S.adminGateError)}</p>` : ''}
    <button class="btn" onclick="App.tryAdminLogin()">Entrer</button>
  </div>`;
}


/* ---------------- Admin → Stats : cartes jouées sur le mois ---------------- */
const MONTH_NAMES = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
function monthLabel(m) { const [y, mo] = String(m).split('-'); return `${MONTH_NAMES[(+mo || 1) - 1]} ${y}`; }

/* Fusionne les stats du serveur avec le pool : les cartes jamais jouées
   apparaissent avec 0, les cartes supprimées gardent leur nom enregistré. */
function buildCardStatRows(stats, pool, filter) {
  const byId = {};
  (stats.cards || []).forEach(s => { byId[s.id] = s; });
  const rows = pool.map(c => {
    const s = byId[c.id] || {};
    return { id: c.id, name: c.name, rarity: c.rarity, type: c.type, ext: c.extensionName || 'Base', deleted: false,
      plays: s.plays || 0, botPlays: s.botPlays || 0, matches: s.matches || 0, wins: s.wins || 0 };
  });
  (stats.cards || []).forEach(s => {
    if (!pool.some(c => c.id === s.id)) rows.push({ id: s.id, name: s.name || s.id, rarity: '', type: '', ext: '—', deleted: true,
      plays: s.plays || 0, botPlays: s.botPlays || 0, matches: s.matches || 0, wins: s.wins || 0 });
  });
  const f = filter || {};
  return rows.filter(r => (!f.ext || r.ext === f.ext) && (!f.type || (f.type === 'sort' ? (r.type !== 'minion' && r.type !== 'weapon' && !r.deleted) : r.type === f.type)) && (!f.rarity || r.rarity === f.rarity));
}

function statBars(rows, max, color) {
  if (!rows.length) return '<div class="empty">Aucune carte.</div>';
  return `<div class="stat-bars">${rows.map(r => {
    const pct = max > 0 ? Math.max(r.plays > 0 ? 2 : 0, r.plays / max * 100) : 0;
    const rc = (RARITIES[r.rarity] || {}).color || 'var(--muted)';
    return `<div class="stat-bar-row" title="${esc(r.name)} : ${r.plays} fois">
      <div class="stat-bar-name"><span class="stat-dot" style="background:${rc}"></span>${esc(r.name)}</div>
      <div class="stat-bar-track"><div class="stat-bar-fill" style="width:${pct.toFixed(1)}%;background:${color}"></div></div>
      <div class="stat-bar-val">${r.plays}</div>
    </div>`;
  }).join('')}</div>`;
}

function statDaysChart(days, month) {
  const [y, mo] = month.split('-').map(Number);
  const n = new Date(y, mo, 0).getDate();
  const vals = Array.from({ length: n }, (_, i) => days[String(i + 1)] || 0);
  const max = Math.max(1, ...vals);
  const W = 720, H = 180, pad = 26, bw = (W - pad * 2) / n;
  const bars = vals.map((v, i) => {
    const h = v / max * (H - pad * 2);
    return `<rect x="${(pad + i * bw + 1).toFixed(1)}" y="${(H - pad - h).toFixed(1)}" width="${Math.max(1, bw - 2).toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="var(--accent)" opacity="${v ? 0.9 : 0.25}"><title>${i + 1} ${MONTH_NAMES[mo - 1]} : ${v} carte(s) jouée(s)</title></rect>`;
  }).join('');
  const ticks = [1, 5, 10, 15, 20, 25, n].filter((d, i, a) => a.indexOf(d) === i).map(d =>
    `<text x="${(pad + (d - 0.5) * bw).toFixed(1)}" y="${H - 8}" text-anchor="middle" class="stat-axis">${d}</text>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" class="stat-days" role="img" aria-label="Cartes jouées par jour">
    <line x1="${pad}" y1="${H - pad}" x2="${W - pad}" y2="${H - pad}" class="stat-baseline"/>
    <text x="${pad}" y="14" class="stat-axis">max ${max} / jour</text>${bars}${ticks}</svg>`;
}

function renderAdminStats() {
  const st = S.adminCardStats;
  if (!st) return `<h1 class="page-title">Admin — Stats</h1>${renderAdminTabs()}<div class="panel">${skeletonRows(5)}</div>`;
  const f = S.statsFilter || {};
  const rows = buildCardStatRows(st, S.cardPool || [], f);
  const byPlays = rows.slice().sort((a, b) => b.plays - a.plays || a.name.localeCompare(b.name));
  const total = rows.reduce((a, r) => a + r.plays, 0);
  const vsBot = rows.reduce((a, r) => a + r.botPlays, 0);
  const played = rows.filter(r => r.plays > 0).length;
  const never = rows.filter(r => r.plays === 0 && !r.deleted).length;
  const max = byPlays.length ? byPlays[0].plays : 0;
  const top = byPlays.slice(0, 10);
  const bottom = byPlays.filter(r => !r.deleted).slice(-10).reverse();
  const exts = [...new Set((S.cardPool || []).map(c => c.extensionName || 'Base'))].sort();
  const sortDir = S.statsSort || 'desc';
  const table = sortDir === 'desc' ? byPlays : byPlays.slice().reverse();
  const opt = (v, cur, label) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(label)}</option>`;
  return `
    <h1 class="page-title">Admin — Stats des cartes</h1>
    <p class="page-sub">Nombre de fois où chaque carte a été posée par de vrais joueurs pendant le mois (les coups du bot et du boss ne comptent pas). Les parties et victoires ne concernent que les combats entre joueurs.</p>
    ${renderAdminTabs()}
    <div class="panel stat-filters">
      <div><label>Mois</label><select onchange="App.loadCardStats(this.value)">${st.months.map(m => opt(m, st.month, monthLabel(m))).join('')}</select></div>
      <div><label>Extension</label><select onchange="App.setStatsFilter('ext', this.value)">${opt('', f.ext || '', 'Toutes')}${exts.map(e => opt(e, f.ext || '', e)).join('')}</select></div>
      <div><label>Type</label><select onchange="App.setStatsFilter('type', this.value)">${opt('', f.type || '', 'Tous')}${opt('minion', f.type || '', 'Serviteurs')}${opt('sort', f.type || '', 'Sorts')}${opt('weapon', f.type || '', 'Armes')}</select></div>
      <div><label>Rareté</label><select onchange="App.setStatsFilter('rarity', this.value)">${opt('', f.rarity || '', 'Toutes')}${Object.keys(RARITIES).map(k => opt(k, f.rarity || '', RARITIES[k].label)).join('')}</select></div>
      <div style="align-self:flex-end;"><button class="btn small ghost" onclick="App.exportCardStats()">⬇ Exporter (CSV)</button></div>
    </div>
    <div class="stat-kpis">
      <div class="stat-kpi"><b>${total}</b><span>cartes jouées</span></div>
      <div class="stat-kpi"><b>${st.pvpMatches}</b><span>parties entre joueurs</span></div>
      <div class="stat-kpi"><b>${played}</b><span>cartes différentes jouées</span></div>
      <div class="stat-kpi ${never ? 'warn' : ''}"><b>${never}</b><span>cartes jamais jouées</span></div>
      <div class="stat-kpi"><b>${total ? Math.round(vsBot / total * 100) : 0}%</b><span>des poses contre le bot</span></div>
    </div>
    <div class="panel"><h3 style="margin-top:0;">Cartes jouées par jour — ${monthLabel(st.month)}</h3>${statDaysChart(st.days || {}, st.month)}</div>
    <div class="stat-two">
      <div class="panel"><h3 style="margin-top:0;">🔥 Les 10 plus jouées</h3>${statBars(top, max, 'linear-gradient(90deg,#7c5cff,#b69cff)')}</div>
      <div class="panel"><h3 style="margin-top:0;">🧊 Les 10 moins jouées</h3>${statBars(bottom, max, 'linear-gradient(90deg,#4a5670,#8a94ab)')}</div>
    </div>
    <div class="panel">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;">
        <h3 style="margin:0;">Toutes les cartes (${rows.length})</h3>
        <button class="btn small ghost" onclick="App.toggleStatsSort()">Trier : ${sortDir === 'desc' ? 'plus jouées d\'abord' : 'moins jouées d\'abord'}</button>
      </div>
      <div class="stat-table-wrap"><table class="stat-table">
        <thead><tr><th>#</th><th>Carte</th><th>Extension</th><th>Type</th><th class="n">Jouée</th><th class="n">Part</th><th class="n">dont vs bot</th><th class="n">Parties JcJ</th><th class="n">Victoires</th><th class="n">Taux de victoire</th></tr></thead>
        <tbody>${table.map((r, i) => {
          const rc = (RARITIES[r.rarity] || {}).color || 'var(--muted)';
          const wr = r.matches >= 5 ? Math.round(r.wins / r.matches * 100) + '%' : (r.matches ? `<span class="muted" title="Moins de 5 parties : pas assez pour conclure">${Math.round(r.wins / r.matches * 100)}%*</span>` : '—');
          return `<tr class="${r.plays === 0 ? 'zero' : ''}">
            <td class="muted">${sortDir === 'desc' ? i + 1 : table.length - i}</td>
            <td><span class="stat-dot" style="background:${rc}"></span>${esc(r.name)}${r.deleted ? ' <span class="tone-tag">supprimée</span>' : ''}</td>
            <td>${esc(r.ext)}</td><td>${r.deleted ? '—' : esc(cardTypeLabel(r.type))}</td>
            <td class="n"><b>${r.plays}</b></td><td class="n">${total ? (r.plays / total * 100).toFixed(1) + '%' : '—'}</td>
            <td class="n">${r.botPlays}</td><td class="n">${r.matches}</td><td class="n">${r.wins}</td><td class="n">${wr}</td>
          </tr>`;
        }).join('')}</tbody>
      </table></div>
      <p class="page-sub" style="margin:10px 0 0;font-size:12px;">* Taux de victoire sur moins de 5 parties : indicatif seulement.</p>
    </div>`;
}

/* ---------- Admin : récompenses de niveau ---------- */
function renderAdminLevels() {
  const d = S.adminLevels;
  if (!d) { if (!S.__lvlLoading) { S.__lvlLoading = true; App.adminLevelsLoad(); } return `<h1 class="page-title">Admin — Niveaux</h1>${renderAdminTabs()}<div class="panel">${skeletonRows(5)}</div>`; }
  const ed = S.adminLevelEdit || (d.levels[0] ? Object.assign({ level: d.levels[0].level }, d.levels[0].reward) : { level: 2, kind: 'credits' });
  const KIND = { credits: 'Crédits', dust: 'Poussière', booster: 'Booster', title: 'Titre', ornament: "Contour d'avatar", banner: 'Bannière de profil', none: 'Aucune' };
  const field = () => {
    if (ed.kind === 'credits' || ed.kind === 'dust') return `<div><label>Montant</label><input type="number" id="lvl-amount" min="1" value="${esc(ed.amount || '')}"></div>`;
    if (ed.kind === 'title') return `<div><label>Titre offert</label><input type="text" id="lvl-title" maxlength="40" value="${esc(ed.title || '')}"></div>`;
    if (ed.kind === 'ornament') return `<div><label>Contour (créé dans l'onglet Ornements)</label><select id="lvl-orn">${d.ornaments.map(o => `<option value="${esc(o.id)}" ${ed.ornamentId === o.id ? 'selected' : ''}>${esc(o.name)}${o.levelOnly ? ' (niveau)' : ''}</option>`).join('')}</select></div>`;
    if (ed.kind === 'banner') return `<div><label>Bannière</label><select id="lvl-banner">${d.banners.map(b => `<option value="${esc(b.id)}" ${ed.bannerId === b.id ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select></div>`;
    if (ed.kind === 'booster') return `<div><label>Extension du booster</label><select id="lvl-ext"><option value="">Édition de base (par défaut)</option>${d.extensions.map(e => `<option value="${esc(e.id)}" ${ed.extensionId === e.id ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}</select></div>`;
    return '';
  };
  return `<h1 class="page-title">Admin — Niveaux</h1>${renderAdminTabs()}
    <div class="panel">
      <h3 style="margin-top:0;">Modifier une récompense</h3>
      <p class="page-sub" style="margin-top:0;">Chaque niveau a une récompense par défaut. Tu peux la remplacer ici, ou revenir à celle par défaut. Le changement vaut pour les prochains joueurs qui atteindront ce niveau.</p>
      <div class="field-row">
        <div><label>Niveau</label><input type="number" id="lvl-level" min="2" max="1000" value="${esc(ed.level)}"></div>
        <div><label>Type</label><select id="lvl-kind" onchange="App.adminLevelKind(this.value)">${d.kinds.map(k => `<option value="${k}" ${ed.kind === k ? 'selected' : ''}>${KIND[k] || k}</option>`).join('')}</select></div>
        ${field()}
      </div>
      <div class="btn-row"><button class="btn" onclick="App.adminLevelSave()">Enregistrer pour ce niveau</button>
        <button class="btn ghost" onclick="App.adminLevelReset()">Remettre la récompense par défaut</button></div>
    </div>
    <div class="panel">
      <h3 style="margin-top:0;">Toutes les récompenses</h3>
      <div class="lvl-admin-list">${d.levels.map(l => `<div class="lvl-admin-row ${l.isCustom ? 'custom' : ''}">
        <b>Niv. ${l.level}</b><span class="lvl-ico">${levelRewardIcon({ kind: l.reward.kind, ornamentId: l.reward.ornamentId, bannerId: l.reward.bannerId })}</span>
        <span>${esc(l.reward.label)}${l.isCustom ? ` <span class="tone-tag">personnalisé (défaut : ${esc(l.byDefault.label)})</span>` : ''}</span>
        <button class="btn small ghost" onclick="App.adminLevelPick(${l.level})">Modifier</button></div>`).join('')}</div>
      <div class="btn-row"><button class="btn ghost small" onclick="App.adminLevelsLoad(${d.levels.length + 41})">Afficher 40 niveaux de plus</button></div>
    </div>`;
}
function renderAdminTabs() {
  const tabs = [['cards', 'Cartes'], ['extensions', 'Extensions'], ['ornaments', 'Ornements'], ['emotes', 'Provocations'], ['content', 'Contenu'], ['events', 'Événements'], ['achievements', 'Succès'], ['users', 'Comptes'], ['stats', 'Stats'], ['tournament', 'Tournoi'], ['story', 'Histoire'], ['ranking', 'Classement'], ['bugs', 'Bugs'], ['sandbox', 'Bac à sable'], ['equilibrium', 'Equilibrium'], ['schedule', 'Programmation'], ['levels', 'Niveaux']];
  return `<div class="gate-tabs" style="max-width:860px;margin:0 0 22px;">
    ${tabs.map(([id, label]) => `<div class="gate-tab ${S.adminTab === id ? 'active' : ''}" onclick="App.setAdminTab('${id}')">${label}</div>`).join('')}
  </div>`;
}

function renderAdminCards() {
  const isMinion = S.adminCardType === 'minion';
  const isWeapon = S.adminCardType === 'weapon';
  const rarity = S.adminCardRarity || 'commun';
  const estimate = S.adminCustomDrop ? null : estimatedDropPercent(rarity, 1);
  const editingCard = S.adminEditingCardId ? cardById(S.adminEditingCardId) : null;
  const selectedSpellEffect = S.adminSpellEffect || (editingCard && editingCard.effectType) || 'damage';
  const extensions = S.extensions || [];

  return `
    <h1 class="page-title">Admin — Cartes</h1>
    <p class="page-sub">Chaque carte peut recevoir une image et un son. Le code est revérifié par le serveur à chaque envoi.</p>
    ${renderAdminTabs()}

    <div class="panel">
      <h3 style="margin-top:0;">Combat de test</h3>
      <p class="page-sub" style="margin-bottom:12px;">Lance un combat contre un bot avec des decks tirés au hasard dans tout le pool (idéal pour tester une carte que tu viens de créer). Ne compte jamais pour le classement.</p>
      <button class="btn" onclick="App.startBotMatch()">Lancer un combat de test</button>
    </div>

    <div class="panel" id="card-form-panel">
      <h3 style="margin-top:0;">${editingCard ? 'Modifier « ' + esc(editingCard.name) + ' »' : 'Créer une nouvelle carte'}</h3>
      <div class="field-row">
        <div style="flex:2;"><label>Nom</label><input type="text" id="new-card-name" placeholder="Ex : Sorcière des Cimes" value="${editingCard ? esc(editingCard.name) : ''}" /></div>
        <div><label>Type</label>
          <select onchange="App.setAdminCardType(this.value)" ${editingCard ? 'disabled title="Le type ne se change pas après création"' : ''}>
            <option value="minion" ${S.adminCardType === 'minion' ? 'selected' : ''}>Serviteur</option>
            <option value="weapon" ${S.adminCardType === 'weapon' ? 'selected' : ''}>Arme</option>
            <option value="sort" ${S.adminCardType === 'sort' ? 'selected' : ''}>Sort</option>
          </select>
        </div>
      </div>
      <div class="field-row">
        <div><label>Extension</label>
          <select id="new-card-extension">
            ${extensions.map(e => `<option value="${e.id}" ${(editingCard ? (editingCard.extensionId || 'base') : (S.adminCardExt && S.adminCardExt !== 'all' ? S.adminCardExt : 'base')) === e.id ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}
          </select>
        </div>
      </div>

      <label>Rareté</label>
      <div class="rarity-picker">
        ${ADMIN_RARITIES.map(r => `<button type="button" class="rarity-btn rar-${r} ${rarity === r ? 'active' : ''}" onclick="App.setAdminCardRarity('${r}')">${RARITIES[r].label}</button>`).join('')}
      </div>

      <div class="panel" style="background:var(--panel-alt);margin:14px 0;">
        <label style="display:flex;align-items:center;gap:8px;margin-bottom:${S.adminCustomDrop ? '10px' : '0'};cursor:pointer;">
          <input type="checkbox" style="width:auto;" ${S.adminCustomDrop ? 'checked' : ''} onchange="App.toggleAdminCustomDrop()">
          Personnaliser le taux de drop de cette carte
        </label>
        ${S.adminCustomDrop ? `
          <label>Poids de tirage (1 = comme les autres cartes ${RARITIES[rarity].label.toLowerCase()}s ; plus haut = plus fréquente, plus bas = plus rare)</label>
          <input type="number" id="new-card-dropweight" min="0.05" max="20" step="0.05" value="1" oninput="App.previewDropWeight(this.value)" placeholder="1">
          <div class="drop-estimate" id="drop-estimate-preview">≈ ${(estimatedDropPercent(rarity, 1) || 0).toFixed(2)}% de chance dans un booster</div>
        ` : `<div class="drop-estimate">Taux standard : ≈ ${(estimate || 0).toFixed(2)}% de chance dans un booster (partagé équitablement entre les cartes ${RARITIES[rarity].label.toLowerCase()}s)</div>`}
      </div>

      ${isMinion ? `
      <div class="field-row">
        <div><label>Attaque</label><input type="number" id="new-card-attack" placeholder="Ex : 3" value="${editingCard ? editingCard.attack : ''}" /></div>
        <div><label>Points de vie</label><input type="number" id="new-card-health" placeholder="Ex : 4" value="${editingCard ? editingCard.health : ''}" /></div>
      </div>
      <div class="field-row">
        <div><label>Armure donnée au héros <span class="tone-tag">points de bouclier ajoutés au héros quand le serviteur est posé</span></label><input type="number" id="new-card-armor" placeholder="0" min="0" value="${editingCard ? (editingCard.armor || 0) : ''}" /></div>
        <div><label>Soin au cri de guerre <span class="tone-tag">en jouant la carte</span></label><input type="number" id="new-card-bcheal" placeholder="0" value="${editingCard ? (editingCard.battlecryHeal || 0) : ''}" /></div>
      </div>
      <div class="field-row" style="margin-bottom:14px;">
        <div><label><input type="checkbox" id="new-card-taunt" style="width:auto;margin-right:6px;" ${editingCard && editingCard.taunt ? 'checked' : ''}> Provocation</label></div>
        <div><label><input type="checkbox" id="new-card-charge" style="width:auto;margin-right:6px;" ${editingCard && editingCard.charge ? 'checked' : ''}> Charge</label></div>
      </div>
      <div class="field-row" style="margin-bottom:14px;">
        <div><label><input type="checkbox" id="new-card-colorblind" style="width:auto;margin-right:6px;" ${editingCard && editingCard.colorblind ? 'checked' : ''}> Daltonisme <span class="tone-tag">peut se tromper de cible en attaquant : ennemi, allié ou son propre héros, au hasard</span></label></div>
        <div><label>Chance de se tromper (%)</label><input type="number" id="new-card-colorblind-chance" min="1" max="100" placeholder="50" value="${editingCard && editingCard.colorblindChance ? editingCard.colorblindChance : ''}" /></div>
      </div>
      <div class="field-row" style="margin-bottom:14px;">
        <div><label><input type="checkbox" id="new-card-shield" style="width:auto;margin-right:6px;" ${editingCard && editingCard.shield ? 'checked' : ''}> Bouclier <span class="tone-tag">le premier coup reçu est ignoré</span></label></div>
        <div><label><input type="checkbox" id="new-card-windfury" style="width:auto;margin-right:6px;" ${editingCard && editingCard.windfury ? 'checked' : ''}> Furie <span class="tone-tag">attaque deux fois par tour</span></label></div>
        <div><label><input type="checkbox" id="new-card-stealth" style="width:auto;margin-right:6px;" ${editingCard && editingCard.stealth ? 'checked' : ''}> Camouflage <span class="tone-tag">impossible à cibler tant qu'il n'a pas attaqué</span></label></div>
        <div><label><input type="checkbox" id="new-card-standing" style="width:auto;margin-right:6px;" ${editingCard && editingCard.standing ? 'checked' : ''}> Toujours debout <span class="tone-tag">gagne un niveau (+1/+1) tous les 2 tours passés en vie, 3 niveaux max</span></label></div>
      </div>
      <div class="field-row">
        <div><label>Râle d'agonie <span class="tone-tag">effet déclenché à la mort du serviteur</span></label>
          <select id="new-card-dr-effect">${[['', 'Aucun'], ['draw', 'Piocher des cartes'], ['armor', "Donner de l'armure à ton héros"], ['damage', 'Infliger des dégâts (cible au hasard)'],
              ['heal', 'Soigner ton héros'], ['buff_attack', "Bonus d'attaque à un allié au hasard"], ['aoe_damage', 'Dégâts à tous les serviteurs ennemis'],
              ['aoe_heal', 'Soin de tes serviteurs et de ton héros'], ['buff_all_allies', "Bonus d'attaque à tous tes serviteurs"], ['damage_all', 'Dégâts à tous les serviteurs'],
              ['sleep', 'Endormir un ennemi au hasard'], ['destroy', 'Détruire un ennemi au hasard'], ['silence', 'Réduire un ennemi au hasard au silence'], ['give_shield', 'Donner Bouclier à un allié au hasard'], ['summon', 'Invoquer des jetons (voir « Jetons »)'], ['random_cards', 'Donner des cartes au hasard']].map(([v, label]) => `<option value="${v}" ${(editingCard && (editingCard.drEffect || '') === v) ? 'selected' : ''}>${label}</option>`).join('')}</select></div>
        <div><label>Valeur</label><input type="number" id="new-card-dr-value" placeholder="1" value="${editingCard && editingCard.drValue != null ? editingCard.drValue : ''}" /></div>
        <div><label>Valeur 2</label><input type="number" id="new-card-dr-value2" placeholder="0" value="${editingCard && editingCard.drValue2 != null ? editingCard.drValue2 : ''}" /></div>
      </div>
      <div class="field-row">
        <div><label>Cri de guerre <span class="tone-tag">effet déclenché quand le serviteur est posé</span></label>
          <select id="new-card-bc-effect">
            ${BC_OPTIONS.map(([v, label]) => `<option value="${v}" ${(editingCard && (editingCard.bcEffect || '') === v) ? 'selected' : ''}>${label}</option>`).join('')}
          </select></div>
        <div><label>Valeur <span class="tone-tag">cartes piochées, PV, dégâts, ATQ ou tours de sommeil</span></label><input type="number" id="new-card-bc-value" placeholder="1" value="${editingCard && editingCard.bcValue != null ? editingCard.bcValue : ''}" /></div>
        <div><label>Valeur 2 <span class="tone-tag">PV pour « modifier », soin du héros pour l'effet combiné</span></label><input type="number" id="new-card-bc-value2" placeholder="0" value="${editingCard && editingCard.bcValue2 != null ? editingCard.bcValue2 : ''}" /></div>
      </div>
      <div class="field-row">
        <div><label>Jetons — nom <span class="tone-tag">pour les effets « Invoquer »</span></label><input type="text" id="new-card-token-name" maxlength="40" placeholder="Ex : Petite frappe" value="${esc((editingCard && editingCard.tokenName) || '')}"></div>
        <div><label>Jetons — ATQ</label><input type="number" id="new-card-token-attack" min="0" placeholder="1" value="${editingCard && editingCard.tokenAttack != null ? editingCard.tokenAttack : ''}"></div>
        <div><label>Jetons — PV</label><input type="number" id="new-card-token-health" min="1" placeholder="1" value="${editingCard && editingCard.tokenHealth != null ? editingCard.tokenHealth : ''}"></div>
      </div>
      <div class="field-row">
        <div><label>Aura : bonus d'ATQ donné aux alliés <span class="tone-tag">tant que ce serviteur est en vie (0 = aucune)</span></label><input type="number" id="new-card-aura-attack" min="0" max="10" placeholder="0" value="${editingCard && editingCard.auraAttack ? editingCard.auraAttack : ''}"></div>
        <div><label>Portée de l'aura</label><select id="new-card-aura-scope"><option value="others" ${!(editingCard && editingCard.auraScope === 'adjacent') ? 'selected' : ''}>Tous tes autres serviteurs</option><option value="adjacent" ${editingCard && editingCard.auraScope === 'adjacent' ? 'selected' : ''}>Seulement ses voisins</option></select></div>
        <div><label>Rage : bonus d'ATQ quand il est blessé <span class="tone-tag">tant qu'il n'a pas tous ses PV (0 = aucune)</span></label><input type="number" id="new-card-rage" min="0" max="10" placeholder="0" value="${editingCard && editingCard.rage ? editingCard.rage : ''}"></div>
      </div>
      ${renderSpecialFields(editingCard, true)}
      <p class="page-sub" style="margin:4px 0 8px;">Effets cumulés : le serviteur peut déclencher jusqu'à 3 effets à la pose (ex. endormir un ennemi + piocher une carte). Le premier effet à cible utilise la cible choisie ; les suivants la réutilisent si elle leur convient, sinon ils visent au hasard.</p>
      ${[2, 3].map(k => `<div class="field-row">
        <div><label>Effet supplémentaire ${k - 1}</label>
          <select id="new-card-bc${k}-effect">${BC_OPTIONS.map(([v, label]) => `<option value="${v}" ${(editingCard && (editingCard['bc' + k + 'Effect'] || '') === v) ? 'selected' : ''}>${label}</option>`).join('')}</select></div>
        <div><label>Valeur</label><input type="number" id="new-card-bc${k}-value" placeholder="1" value="${editingCard && editingCard['bc' + k + 'Value'] != null ? editingCard['bc' + k + 'Value'] : ''}" /></div>
        <div><label>Valeur 2</label><input type="number" id="new-card-bc${k}-value2" placeholder="0" value="${editingCard && editingCard['bc' + k + 'Value2'] != null ? editingCard['bc' + k + 'Value2'] : ''}" /></div>
      </div>`).join('')}` : isWeapon ? `
      <p class="page-sub" style="margin:-6px 0 12px;">Les armes s'équipent au héros (visibles à côté de son portrait) et lui permettent d'attaquer directement, à la place ou en plus de ses serviteurs.</p>
      <div class="field-row">
        <div><label>Attaque</label><input type="number" id="new-card-attack" placeholder="Ex : 3" value="${editingCard ? editingCard.attack : ''}" /></div>
        <div><label>Durabilité <span class="tone-tag">nombre total d'utilisations avant que l'arme se brise</span></label><input type="number" id="new-card-durability" min="1" placeholder="Ex : 2" value="${editingCard ? editingCard.durability : ''}" /></div>
      </div>
      <div class="field-row" style="margin-bottom:14px;">
        <div><label>Utilisations par tour <span class="tone-tag">1 = comme dans Hearthstone, plus haut = attaque plusieurs fois par tour</span></label><input type="number" id="new-card-usesperturn" min="1" placeholder="1" value="${editingCard ? (editingCard.usesPerTurn || 1) : ''}" /></div>
        <div><label>Soin à l'équipement <span class="tone-tag">rend des PV au héros en s'équipant</span></label><input type="number" id="new-card-bcheal" placeholder="0" value="${editingCard ? (editingCard.battlecryHeal || 0) : ''}" /></div>
      </div>` : `
      <div class="field-row">
        <div><label>Type d'effet</label><select id="new-card-effect" onchange="App.setAdminSpellEffect(this.value)">
          ${[
            ['damage', 'Dégâts (cible unique)'], ['heal', 'Soin (cible amie)'], ['buff_attack', "Bonus d'attaque (un allié)"],
            ['aoe_damage', 'Dégâts de zone (serviteurs ennemis)'], ['aoe_heal', 'Soin de zone (tes serviteurs + héros)'],
            ['damage_all', 'Dégâts à TOUS les serviteurs (les deux camps)'], ['buff_all_allies', 'Bonus d\'attaque à TOUS tes serviteurs'],
            ['board_wipe', 'Détruit tous les serviteurs en jeu'], ['buff_ally_and_heal', "Bonus d'attaque à un allié + soin du héros"],
            ['modify_stats', "Modifier l'ATQ et les PV d'un serviteur (deux effets, + ou −)"], ['draw', 'Piocher des cartes (valeur = nombre de cartes)'], ['armor', "Donner de l'armure à ton héros (valeur = points d'armure)"], ['sleep', 'Endormir un serviteur (valeur = nombre de tours)'], ['destroy', 'Détruire un serviteur au choix'], ['silence', 'Réduire un serviteur au silence (retire tous ses effets)'],
            ['give_shield', 'Donner Bouclier à un de tes serviteurs'], ['give_windfury', 'Donner Furie à un de tes serviteurs'],
            ['give_stealth', 'Donner Camouflage à un de tes serviteurs'], ['give_taunt', 'Donner Provocation à un de tes serviteurs'],
            ['give_deathrattle', "Donner un Râle d'agonie à un de tes serviteurs (choisis l'effet ci-dessous)"],
            ['summon', 'Invoquer des jetons (valeur = nombre, voir « Jetons »)'], ['trap', 'Piège : posé face cachée, se déclenche au tour adverse'],
            ['random_cards', 'Donner des cartes au hasard (valeur = nombre, voir « Cartes au hasard »)']
          ].map(([v, label]) => `<option value="${v}" ${selectedSpellEffect === v ? 'selected' : ''}>${label}</option>`).join('')}
        </select></div>
        <div><label id="new-card-value-label">${selectedSpellEffect === 'modify_stats' ? 'Changement d\'ATQ (ex : 2 ou -1)' : selectedSpellEffect === 'draw' ? 'Nombre de cartes à piocher' : 'Valeur principale'}</label><input type="number" id="new-card-value" placeholder="Ex : 4" value="${editingCard ? (editingCard.value != null ? editingCard.value : '') : ''}" /></div>
      </div>
      ${renderSpecialFields(editingCard, false)}
      <div id="new-card-trap-row" style="${selectedSpellEffect === 'trap' ? '' : 'display:none;'}">
        <div class="field-row">
          <div><label>Le piège se déclenche…</label><select id="new-card-trap-trigger">${[['enemy_attack', 'quand un ennemi attaque'], ['enemy_minion', "quand l'adversaire pose un serviteur"], ['enemy_spell', "quand l'adversaire lance un sort"]].map(([v, l]) => `<option value="${v}" ${(editingCard && editingCard.trapTrigger) === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
          <div><label>…et alors</label><select id="new-card-trap-effect">${[['sleep', "le serviteur ennemi est endormi (l'attaque est annulée)"], ['destroy', 'le serviteur ennemi est détruit'], ['silence', 'le serviteur ennemi est réduit au silence'], ['damage', 'le serviteur ennemi subit des dégâts'], ['draw', 'tu pioches des cartes'], ['armor', "ton héros gagne de l'armure"], ['summon', 'tu invoques des jetons']].map(([v, l]) => `<option value="${v}" ${(editingCard && editingCard.trapEffect) === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
          <div><label>Valeur <span class="tone-tag">tours, dégâts, cartes, armure ou jetons</span></label><input type="number" id="new-card-trap-value" min="1" placeholder="1" value="${editingCard && editingCard.trapValue != null ? editingCard.trapValue : ''}"></div>
        </div>
      </div>
      <div id="new-card-spell-token-row" style="${selectedSpellEffect === 'summon' || selectedSpellEffect === 'trap' ? '' : 'display:none;'}">      <div class="field-row">
        <div><label>Jetons — nom <span class="tone-tag">pour les effets « Invoquer »</span></label><input type="text" id="new-card-stoken-name" maxlength="40" placeholder="Ex : Petite frappe" value="${esc((editingCard && editingCard.tokenName) || '')}"></div>
        <div><label>Jetons — ATQ</label><input type="number" id="new-card-stoken-attack" min="0" placeholder="1" value="${editingCard && editingCard.tokenAttack != null ? editingCard.tokenAttack : ''}"></div>
        <div><label>Jetons — PV</label><input type="number" id="new-card-stoken-health" min="1" placeholder="1" value="${editingCard && editingCard.tokenHealth != null ? editingCard.tokenHealth : ''}"></div>
      </div></div>
      <div class="field-row" id="new-card-spell-dr-row" style="${selectedSpellEffect === 'give_deathrattle' ? '' : 'display:none;'}">
        <div><label>Râle d'agonie à donner</label>
          <select id="new-card-spell-dr-effect">${[['', 'Aucun'], ['draw', 'Piocher des cartes'], ['armor', "Donner de l'armure à ton héros"], ['damage', 'Infliger des dégâts (cible au hasard)'],
              ['heal', 'Soigner ton héros'], ['buff_attack', "Bonus d'attaque à un allié au hasard"], ['aoe_damage', 'Dégâts à tous les serviteurs ennemis'],
              ['aoe_heal', 'Soin de tes serviteurs et de ton héros'], ['buff_all_allies', "Bonus d'attaque à tous tes serviteurs"], ['damage_all', 'Dégâts à tous les serviteurs'],
              ['sleep', 'Endormir un ennemi au hasard'], ['destroy', 'Détruire un ennemi au hasard'], ['silence', 'Réduire un ennemi au hasard au silence'], ['give_shield', 'Donner Bouclier à un allié au hasard'], ['summon', 'Invoquer des jetons (voir « Jetons »)'], ['random_cards', 'Donner des cartes au hasard']].slice(1).map(([v, label]) => `<option value="${v}" ${(editingCard && editingCard.drEffect === v) ? 'selected' : ''}>${label}</option>`).join('')}</select></div>
        <div><label>Valeur</label><input type="number" id="new-card-spell-dr-value" placeholder="1" value="${editingCard && editingCard.drValue != null ? editingCard.drValue : ''}" /></div>
        <div><label>Valeur 2</label><input type="number" id="new-card-spell-dr-value2" placeholder="0" value="${editingCard && editingCard.drValue2 != null ? editingCard.drValue2 : ''}" /></div>
      </div>
      <div class="field-row" id="new-card-value2-row" style="${selectedSpellEffect === 'buff_ally_and_heal' || selectedSpellEffect === 'modify_stats' ? '' : 'display:none;'}">
        <div><label id="new-card-value2-label">${selectedSpellEffect === 'modify_stats' ? 'Changement de PV (ex : 3 ou -1)' : 'Soin du héros (pour l\'effet combiné uniquement)'}</label><input type="number" id="new-card-value2" placeholder="Ex : 5" value="${editingCard && editingCard.value2 != null ? editingCard.value2 : ''}" /></div>
      </div>`}

      <div class="field-row">
        <div><label>${editingCard ? 'Remplacer l\'image de la carte (laisser vide pour garder l\'actuelle)' : 'Image de la carte'}</label>
          ${editingCard && editingCard.image ? `<div class="admin-current-img"><img src="${esc(editingCard.image)}" alt=""><span>Image actuelle</span></div>` : ''}
          <input type="file" id="new-card-image" accept="image/*" class="file-input" style="width:100%;"></div>
        <div><label>${editingCard ? 'Remplacer le son de pose (optionnel)' : 'Son joué à la pose (MP3, WAV, OGG — 2 Mo max)'}</label>
          <input type="file" id="new-card-sound" accept="audio/*" class="file-input" style="width:100%;"></div>
      </div>

      <div class="panel" style="background:var(--panel-alt);margin:14px 0;">
        <label style="display:flex;align-items:center;gap:8px;margin-bottom:${S.adminCardParallax ? '10px' : '0'};cursor:pointer;">
          <input type="checkbox" id="new-card-parallax" style="width:auto;" ${S.adminCardParallax ? 'checked' : ''} onchange="App.toggleAdminCardParallax(this.checked)">
          Effet parallaxe <span class="tone-tag">visible uniquement dans la visionneuse 3D</span>
        </label>
        ${S.adminCardParallax ? `
          <p class="page-sub" style="margin:0 0 12px;">Deux images séparées (fond et personnage), superposées à des profondeurs différentes pour un effet de relief quand la carte pivote en 3D. Les deux sont nécessaires ensemble — le parallaxe ne remplace que la vue 3D, jamais les autres écrans.</p>
          <div class="field-row">
            <div><label>Fond <span class="tone-tag">le plus loin — un peu zoomé pour l'effet de profondeur</span></label><input type="file" id="new-card-parallax-bg" accept="image/*" class="file-input" style="width:100%;">${editingCard && editingCard.parallaxBackground ? '<span class="tag done">déjà réglé</span>' : ''}</div>
            <div><label>Personnage <span class="tone-tag">au premier plan</span></label><input type="file" id="new-card-parallax-char" accept="image/*" class="file-input" style="width:100%;">${editingCard && editingCard.parallaxCharacter ? '<span class="tag done">déjà réglé</span>' : ''}</div>
          </div>
          <p class="page-sub" style="margin:8px 0 0;">⚠️ Pense aussi à remplir "Image de la carte" plus haut : c'est elle qui s'affiche PARTOUT ailleurs (main, plateau, grilles) — sans elle, la carte apparaît sans image en dehors de la visionneuse 3D. Si tu la laisses vide, l'image "Personnage" est utilisée par défaut.</p>
          ${editingCard ? '<p class="page-sub" style="margin:4px 0 0;">Laisse un champ de calque vide pour garder celui déjà en place — un fichier choisi le remplace.</p>' : ''}
        ` : ''}
      </div>
      <div style="height:14px;"></div>
      <label>Description</label>
      <textarea id="new-card-desc" rows="2" placeholder="Une phrase d'ambiance">${editingCard ? esc(editingCard.desc || '') : ''}</textarea>
      <label>Coût en mana</label>
      <input type="number" id="new-card-cost" placeholder="Ex : 4" style="max-width:160px;" value="${editingCard ? editingCard.cost : ''}">
      <div class="btn-row">
        ${editingCard
          ? `<button class="btn" onclick="App.saveCardEdit()">Enregistrer les modifications</button><button class="btn ghost" onclick="App.cancelEditCard()">Annuler</button>`
          : `<button class="btn" onclick="App.createCard()">Ajouter la carte</button>`}
      </div>
    </div>

    <div class="panel">
      <h3 style="margin-top:0;">Serviteurs avec un Râle d'agonie</h3>
      <p class="page-sub" style="margin-bottom:10px;">Liste de toutes les cartes qui ont un Râle d'agonie, pour retirer ceux qui n'ont rien à faire là.</p>
      ${S.adminDeathrattles ? (S.adminDeathrattles.length === 0 ? '<div class="empty">Aucun serviteur n\'a de Râle d\'agonie.</div>' : `
        <div class="dr-list">${S.adminDeathrattles.map(c => `<div class="row-card"><div class="info"><b>${esc(c.name)}</b> <span class="tone-tag">${esc(((S.extensions || []).find(e => e.id === c.extensionId) || {}).name || c.extensionId)}</span> <span class="tone-tag">💀 ${esc(cardEffectSummary({ type: 'sort', effectType: c.drEffect, value: c.drValue, value2: c.drValue2 }).split(' · ')[0])}</span></div>
          <button class="btn small ghost danger-text" onclick="App.clearDeathrattles({ cardIds: ['${esc(c.id)}'] })">Retirer</button></div>`).join('')}</div>
        <div class="btn-row"><button class="btn small danger" onclick="App.clearDeathrattles({ extensionId: 'base' }, 'de toutes les cartes de l\'Édition de base')">Retirer de toutes les cartes de base</button>
          <button class="btn small ghost danger-text" onclick="App.clearDeathrattles({ all: true }, 'de toutes les cartes du jeu')">Retirer de toutes les cartes</button></div>`)
        : '<div class="btn-row" style="margin-top:0;"><button class="btn small ghost" onclick="App.loadDeathrattles()">Afficher la liste</button></div>'}
    </div>

    <div class="panel">
      <h3 style="margin-top:0;">Cartes supprimées encore chez des joueurs</h3>
      <p class="page-sub" style="margin-bottom:10px;">Une carte supprimée avec ✕ est retirée tout de suite des collections et des decks. Ce bouton sert pour les cartes supprimées avant cette mise à jour : il affiche d'abord ce qu'il va retirer et te demande de confirmer.</p>
      <div class="btn-row" style="margin-top:0;"><button class="btn small ghost" onclick="App.cleanupOrphanCards()">Vérifier et nettoyer</button></div>
    </div>

    <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;">
      <h3>Cartes du pool (${S.cardPool.length})</h3>
      <div class="btn-row" style="margin:0;">
        <button class="btn small" onclick="App.exportCards('csv')">⬇ Exporter pour Excel (CSV)</button>
        <button class="btn small ghost" onclick="App.exportCards('json')">⬇ Exporter en JSON</button>
      </div>
    </div>
    ${(() => {
      // Un onglet par extension pour s'y retrouver ; « Toutes » garde la vue complète
      const exts = S.extensions || [];
      const cur = S.adminCardExt || (exts[0] ? exts[0].id : 'all');
      const countOf = id => S.cardPool.filter(c => (c.extensionId || 'base') === id).length;
      return `<div class="rarity-tabs ext-tabs" role="tablist" aria-label="Cartes par extension">
        ${exts.map(e => `<button role="tab" aria-selected="${cur === e.id}" class="rtab ${cur === e.id ? 'active' : ''}" onclick="App.setAdminCardExt('${esc(e.id)}')" ${e.hidden ? 'title="Extension cachée aux joueurs"' : ''}>${e.hidden ? '🙈 ' : ''}${esc(e.name)} <span class="rcount">${countOf(e.id)}</span></button>`).join('')}
        <button role="tab" aria-selected="${cur === 'all'}" class="rtab ${cur === 'all' ? 'active' : ''}" onclick="App.setAdminCardExt('all')">Toutes <span class="rcount">${S.cardPool.length}</span></button>
      </div>`;
    })()}
    <div class="grid">
      ${S.cardPool.filter(c => { const cur = S.adminCardExt || ((S.extensions || [])[0] || {}).id || 'all'; return cur === 'all' || (c.extensionId || 'base') === cur; }).map(c => {
        // Chance de tirage calculée dans le booster de SON extension (chaque extension a son booster)
        const pct = estimatedDropPercent(c.rarity, c.dropWeight || 1, S.cardPool.filter(x => x.id !== c.id && (x.extensionId || 'base') === (c.extensionId || 'base')));
        return `<div style="position:relative;">
        ${renderCardTile(c, { showDesc: false, footer: `
          <button class="btn small ghost" style="width:100%;margin-bottom:6px;" onclick="event.stopPropagation();App.startEditCard('${c.id}')">✏️ Modifier</button>
          <label class="file-input" style="display:block;text-align:center;font-size:11px;padding:6px;margin-bottom:6px;">Changer l'image<input type="file" accept="image/*" style="display:none" onchange="App.replaceCardImage('${c.id}', this)"></label>
          <label class="file-input" style="display:block;text-align:center;font-size:11px;padding:6px;margin-bottom:6px;">${c.sound ? '🔊 Remplacer le son' : '＋ Ajouter un son'}<input type="file" accept="audio/*" style="display:none" onchange="App.replaceCardSound('${c.id}', this)"></label>
          ${c.sound ? `<div class="sound-actions" style="margin-bottom:6px;">
            <button class="btn small ghost" onclick="event.stopPropagation();App.previewSound('${c.sound}')">▶ Écouter</button>
            <button class="btn small danger" onclick="event.stopPropagation();App.removeCardSound('${c.id}')">Retirer</button>
          </div>` : ''}
          <div class="drop-estimate" style="margin:6px 0;">≈ ${pct.toFixed(2)}% / booster · ${esc(c.extensionName || 'Base')}</div>
          <div class="price-edit">
            <input type="number" min="0.05" max="20" step="0.05" id="card-dropweight-${c.id}" value="${c.dropWeight || 1}" title="Poids de tirage">
            <button class="btn small" onclick="App.updateCardDropWeight('${c.id}')">Fixer</button>
          </div>` })}
        <button class="btn danger" style="position:absolute;top:8px;right:8px;padding:4px 8px;font-size:11px;z-index:5;" title="Supprimer la carte" onclick="App.deleteCard('${c.id}')">✕</button>
      </div>`;
      }).join('')}
    </div>`;
}

function renderAdminExtensions() {
  const exts = S.extensions || [];
  const dropChance = S.settings ? S.settings.matchDropChance : 0.5;
  return `
    <h1 class="page-title">Admin — Extensions</h1>
    <p class="page-sub">Une extension regroupe des cartes et un dos de carte propre, comme un set dans un vrai TCG. Chaque extension a son propre booster, achetable en boutique.</p>
    ${renderAdminTabs()}

    <div class="panel">
      <h3 style="margin-top:0;">Crédits de fin de combat</h3>
      <p class="page-sub" style="margin-bottom:14px;">Crédits gagnés à la fin d'un combat entre joueurs (jamais contre le bot). Il faut au moins 4 tours joués, et celui qui abandonne ne reçoit rien : on ne peut pas enchaîner des parties express pour accumuler des crédits.</p>
      <div class="field-row">
        <div style="max-width:200px;"><label>Gagnant (crédits)</label><input type="number" id="win-credits" min="0" step="1" value="${S.settings && S.settings.winCredits != null ? S.settings.winCredits : 50}"></div>
        <div style="max-width:200px;"><label>Perdant (crédits)</label><input type="number" id="loss-credits" min="0" step="1" value="${S.settings && S.settings.lossCredits != null ? S.settings.lossCredits : 25}"></div>
      </div>
      <div class="btn-row"><button class="btn" onclick="App.saveMatchCredits()">Enregistrer</button></div>
    </div>
    <div class="panel">
      <h3 style="margin-top:0;">Booster bonus en fin de match</h3>
      <p class="page-sub" style="margin-bottom:14px;">Chance qu'un joueur reçoive un booster gratuit en gagnant un combat (jamais contre le bot). Le booster est tiré au hasard parmi les extensions cochées « éligible » ci-dessous.</p>
      <div class="field-row">
        <div style="max-width:200px;"><label>Probabilité (%)</label><input type="number" id="match-drop-chance" min="0" max="100" step="0.1" value="${dropChance}"></div>
      </div>
      <div class="btn-row" style="margin-top:0;"><button class="btn small" onclick="App.updateMatchDropChance()">Enregistrer</button></div>
    </div>
    <div class="panel">
      <h3 style="margin-top:0;">✨ Cartes brillantes</h3>
      <p class="page-sub" style="margin-bottom:14px;">Chance qu'une carte de booster sorte brillante : commune 2 %, rare 3 %, épique 4 %, légendaire 6 %, multipliée par ce réglage (1 = normal, 2 = deux fois plus, 0 = jamais). Fabrication avec la poussière : 100 / 200 / 400 / 800 ✧.</p>
      <div class="field-row"><div style="max-width:200px;"><label>Multiplicateur</label><input type="number" id="shiny-mult" min="0" max="20" step="0.1" value="${S.settings && S.settings.shinyMultiplier != null ? S.settings.shinyMultiplier : 1}"></div></div>
      <div class="btn-row" style="margin-top:0;"><button class="btn small" onclick="App.saveShinyMultiplier()">Enregistrer</button></div>
    </div>

    <div class="panel">
      <h3 style="margin-top:0;">Créer une extension</h3>
      <div class="field-row">
        <div><label>Nom</label><input type="text" id="new-ext-name" placeholder="Ex : Aurore Sanglante" /></div>
        <div><label>Description</label><input type="text" id="new-ext-desc" placeholder="Une phrase de présentation" /></div>
      </div>
      <div class="field-row">
        <div><label>Prix du booster en crédits <span class="tone-tag">vide = non vendu contre des crédits</span></label><input type="number" id="new-ext-credit" placeholder="Ex : 100" /></div>
        <div><label>Prix du booster en poussière <span class="tone-tag">vide = non vendu contre de la poussière</span></label><input type="number" id="new-ext-dust" placeholder="Ex : 80" /></div>
      </div>
      <label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin-bottom:14px;">
        <input type="checkbox" id="new-ext-drop" style="width:auto;"> Éligible au booster bonus de fin de match
      </label>
      <label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin-bottom:14px;">
        <input type="checkbox" id="new-ext-hidden" style="width:auto;" checked> 🙈 Cachée aux joueurs pour l'instant (tu la publieras quand elle sera prête)
      </label>
      <label>Dos de carte (image affichée au dos de toutes les cartes de cette extension)</label>
      <input type="file" id="new-ext-back" accept="image/*" class="file-input" style="width:100%;margin-bottom:14px;">
      <div class="btn-row" style="margin-top:0;"><button class="btn" onclick="App.createExtension()">Créer l'extension</button></div>
    </div>

    ${exts.map(e => `
      <div class="panel">
        <div style="display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap;">
          <div style="width:70px;height:98px;border-radius:8px;overflow:hidden;background:linear-gradient(150deg,var(--accent),var(--accent-dim));flex-shrink:0;display:flex;align-items:center;justify-content:center;">
            ${e.backImage ? `<img src="${esc(e.backImage)}" style="width:100%;height:100%;object-fit:cover;">` : '<span style="color:#fff;font-size:22px;">✦</span>'}
          </div>
          <div style="flex:1;min-width:220px;">
            <h3 style="margin:0 0 4px;">${esc(e.name)} ${e.id === 'base' ? '<span class="tag">par défaut</span>' : ''} ${e.hidden ? '<span class="tag ext-hidden-tag">🙈 cachée</span>' : '<span class="tag done">publiée</span>'} ${e.matchDropEligible ? '<span class="tag done">éligible au drop</span>' : ''}</h3>
            <div class="field-row">
              <div><label>Nom</label><input type="text" id="ext-name-${e.id}" value="${esc(e.name)}" maxlength="60"></div>
              <div><label>Description</label><input type="text" id="ext-desc-${e.id}" value="${esc(e.description || '')}" maxlength="300"></div>
            </div>
            ${e.id !== 'base' ? `<label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin-bottom:10px;">
              <input type="checkbox" id="ext-hidden-${e.id}" style="width:auto;" ${e.hidden ? 'checked' : ''}> 🙈 Cachée aux joueurs (ni booster en boutique, ni drop, ni cartes visibles dans le Codex)
            </label>` : ''}
            <div class="field-row">
              <div><label>Prix crédits</label><input type="number" id="ext-credit-${e.id}" value="${e.boosterCreditPrice != null ? e.boosterCreditPrice : ''}" placeholder="Non vendu"></div>
              <div><label>Prix poussière</label><input type="number" id="ext-dust-${e.id}" value="${e.boosterDustPrice != null ? e.boosterDustPrice : ''}" placeholder="Non vendu"></div>
            </div>
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin-bottom:10px;">
              <input type="checkbox" id="ext-drop-${e.id}" style="width:auto;" ${e.matchDropEligible ? 'checked' : ''}> Éligible au booster bonus de fin de match
            </label>
            <div class="btn-row" style="margin-top:0;">
              <button class="btn small" onclick="App.updateExtensionPrices('${e.id}')">Enregistrer</button>
              ${e.id !== 'base' && e.hidden ? `<button class="btn small ext-publish" onclick="App.publishExtension('${e.id}')">🚀 Publier maintenant</button>` : ''}
              <label class="file-input" style="padding:8px 12px;font-size:12.5px;">Changer le dos de carte<input type="file" accept="image/*" style="display:none" onchange="App.replaceExtensionBack('${e.id}', this)"></label>
              <label class="file-input" style="padding:8px 12px;font-size:12.5px;">${e.packImage ? "Changer l'image du booster" : "Ajouter une image de booster"}<input type="file" accept="image/*" style="display:none" onchange="App.replaceExtensionPackImage('${e.id}', this)"></label>
              ${e.packImage ? `<span class="media-slot-preview" style="width:40px;height:40px;"><img src="${esc(e.packImage)}" alt=""></span>` : ''}
              ${e.id !== 'base' ? `<button class="btn small danger" onclick="App.deleteExtension('${e.id}')">Supprimer</button>` : ''}
            </div>
          </div>
        </div>
      </div>`).join('')}

    <div class="panel">
      <h3 style="margin-top:0;">Packs de crédits (poussière → crédits)</h3>
      <p class="page-sub" style="margin-bottom:14px;">Des packs achetables en boutique (onglet "Crédits") qui échangent de la poussière contre des crédits.</p>
      <div class="field-row">
        <div><label>Nom</label><input type="text" id="pack-name" placeholder="Ex : Petit pack"></div>
        <div><label>Crédits donnés</label><input type="number" id="pack-credits" min="1" value="100"></div>
        <div><label>Prix en poussière</label><input type="number" id="pack-dust" min="1" value="50"></div>
      </div>
      <div class="btn-row" style="margin-top:0;"><button class="btn small" onclick="App.createCreditPack()">Créer le pack</button></div>
    </div>

    ${(S.adminCreditPacks || []).map(p => `
      <div class="panel">
        <div class="field-row" style="align-items:flex-end;">
          <div><label>Nom</label><input type="text" id="pack-edit-name-${p.id}" value="${esc(p.name)}"></div>
          <div><label>Crédits donnés</label><input type="number" id="pack-edit-credits-${p.id}" min="1" value="${p.creditsAmount}"></div>
          <div><label>Prix en poussière</label><input type="number" id="pack-edit-dust-${p.id}" min="1" value="${p.dustPrice}"></div>
        </div>
        <div class="btn-row" style="margin-top:6px;">
          <button class="btn small" onclick="App.updateCreditPack('${p.id}')">Mettre à jour</button>
          <button class="btn small danger" onclick="App.deleteCreditPack('${p.id}', ${jsArg(p.name)})">Supprimer</button>
        </div>
      </div>`).join('')}
  `;
}

/* Regroupement purement visuel pour le formulaire admin — les valeurs par
   défaut réelles viennent toujours du serveur (S.content), jamais d'ici. */
const CONTENT_STRING_GROUPS = [
  { label: 'Menu latéral', keys: [
    ['nav.collection', 'Collection'], ['nav.codex', 'Codex'], ['nav.boosters', 'Boosters'],
    ['nav.deck', 'Deck'], ['nav.combat', 'Combat'], ['nav.classement', 'Classement'],
    ['nav.poussiere', 'Désenchantement'], ['nav.boutique', 'Boutique'], ['nav.joueurs', 'Joueurs'],
    ['nav.echanges', 'Échanges'], ['nav.admin', 'Admin']
  ]},
  { label: 'Titres de page', keys: [
    ['title.collection', 'Collection'], ['title.codex', 'Codex'], ['title.boosters', 'Boosters'],
    ['title.deck', 'Deck'], ['title.classement', 'Classement'], ['title.poussiere', 'Désenchantement'],
    ['title.boutique', 'Boutique'], ['title.joueurs', 'Joueurs'], ['title.echanges', 'Échanges']
  ]},
  { label: 'Combat', keys: [
    ['combat.endTurnReady', "Bouton : c'est ton tour"], ['combat.endTurnWaiting', 'Bouton : tour adverse'],
    ['combat.mulliganTitle', 'Titre de l\'écran de mulligan'], ['combat.mulliganConfirm', 'Bouton de validation du mulligan']
  ]},
  { label: 'Sous-titres de page', keys: [
    ['sub.codex', 'Codex'], ['sub.poussiere', 'Désenchantement'], ['sub.boutique', 'Boutique'],
    ['sub.joueurs', 'Joueurs'], ['sub.echanges', 'Échanges'], ['sub.combat', 'Combat'], ['sub.deck', 'Deck']
  ]},
  { label: 'Types de carte', keys: [
    ['cardtype.minion', 'Serviteur'], ['cardtype.weapon', 'Arme'], ['cardtype.spell', 'Sort']
  ]},
  { label: 'Boutons courants', keys: [
    ['btn.logout', 'Se déconnecter'], ['btn.addFriend', "Ajouter en ami"], ['btn.challenge', 'Défier en combat']
  ]},
  { label: 'Monnaies', keys: [['currency.credits', 'Mot "crédits"'], ['currency.dust', 'Mot "poussière"']] },
  { label: 'Messages vides', keys: [
    ['empty.collection', 'Collection vide'], ['empty.players', 'Aucun joueur trouvé'], ['empty.trades', 'Aucun échange en attente']
  ]},
  { label: 'Écran de connexion', keys: [['gate.title', 'Nom de l\'application'], ['gate.tagline', 'Sous-titre de présentation']] }
];
const CONTENT_ICON_KEYS = [
  ['icon.collection', 'Collection'], ['icon.codex', 'Codex'], ['icon.boosters', 'Boosters'], ['icon.deck', 'Deck'],
  ['icon.combat', 'Combat'], ['icon.classement', 'Classement'], ['icon.poussiere', 'Désenchantement'],
  ['icon.boutique', 'Boutique'], ['icon.joueurs', 'Joueurs'], ['icon.echanges', 'Échanges'], ['icon.admin', 'Admin'],
  ['icon.credits', 'Crédits'], ['icon.dust', 'Poussière']
];
const CONTENT_SFX_KEYS = [
  ['attackHit', 'Impact d\'attaque'], ['packOpen', 'Ouverture de booster'],
  ['cardReveal_commun', 'Révélation d\'une carte Commune (booster)'], ['cardReveal_rare', 'Révélation d\'une carte Rare (booster)'],
  ['cardReveal_epique', 'Révélation d\'une carte Épique (booster)'], ['cardReveal_legendaire', 'Révélation d\'une carte Légendaire (booster)'],
  ['cardReveal', 'Révélation de carte, toutes raretés (utilisé pour une rareté qui n\'a pas son propre son)'],
  ['turnStart', 'Début de tour'], ['victory', 'Victoire'], ['defeat', 'Défaite'], ['cardPlayDefault', 'Pose de carte (sans son personnalisé sur la carte elle-même)'],
  ['levelUp', 'Passage de niveau (écran de fin de combat)'], ['dailyDone', 'Défi du jour réussi (écran de fin de combat)'],
  ['musicMenu', 'Musique de fond — menus (en boucle, 12 Mo max)'], ['musicCombat', 'Musique de fond — combat (en boucle, 12 Mo max)']
];

function renderAdminContent() {
  const c = S.content || { strings: {}, icons: {}, media: {}, sfx: {} };
  const MEDIA_SPECS = {
    logo: { label: 'Logo', recommendedSize: '256×256 px', description: "Sidebar et écran de connexion. Fond transparent recommandé (PNG)." },
    boardBackground: { label: 'Fond du plateau de combat', recommendedSize: '1600×1000 px', description: "Derrière le plateau, plein écran pendant un combat." },
    gateBackground: { label: "Fond de l'écran de connexion", recommendedSize: '1920×1080 px', description: "Toute la page derrière le formulaire de connexion." },
    sidebarBackground: { label: 'Fond du menu latéral', recommendedSize: '300×1200 px', description: "Texture verticale derrière les boutons du menu." },
    panelTexture: { label: 'Texture des panneaux', recommendedSize: '512×512 px', description: "Motif répété en fond de chaque encadré (panel) de l'application." }
  };
  return `
    <h1 class="page-title">Admin — Contenu</h1>
    <p class="page-sub">Personnalise les textes, icônes, images et sons de l'application. Un champ laissé tel quel garde sa valeur d'origine ; le bouton "Réinitialiser" sur les médias et sons revient au réglage par défaut.</p>
    ${renderAdminTabs()}

    <div class="panel">
      <h3 style="margin-top:0;">Images d'interface</h3>
      <p class="page-sub" style="margin-bottom:14px;">La taille indiquée est recommandée pour un rendu net, sans déformation — une autre taille fonctionne aussi mais peut être recadrée ou étirée.</p>
      ${Object.keys(MEDIA_SPECS).map(key => {
        const spec = MEDIA_SPECS[key];
        const url = c.media[key];
        return `<div class="media-slot-row">
          <div class="media-slot-preview">${url ? `<img src="${esc(url)}" alt="${esc(spec.label)}">` : (key === 'logo' ? `<img src="/branding/logo.png" alt="Logo par défaut">` : '<span class="tone-tag">aucune</span>')}</div>
          <div class="media-slot-info">
            <div style="font-weight:700;">${esc(spec.label)} <span class="tone-tag">${spec.recommendedSize}</span></div>
            <div style="color:var(--muted);font-size:12.5px;margin:2px 0 8px;">${esc(spec.description)}</div>
            <div class="btn-row" style="margin-top:0;">
              <label class="file-input" style="padding:7px 12px;font-size:12.5px;">Uploader<input type="file" accept="image/*" style="display:none" onchange="App.uploadContentMedia('${key}', this)"></label>
              ${url ? `<button class="btn small ghost" onclick="App.resetContentMedia('${key}')">Réinitialiser</button>` : ''}
            </div>
          </div>
        </div>`;
      }).join('')}
    </div>

    <div class="panel">
      <h3 style="margin-top:0;">Sons de jeu</h3>
      <p class="page-sub" style="margin-bottom:14px;">Sons synthétisés par défaut (aucun fichier requis). Uploade un fichier pour remplacer l'un d'eux par un vrai son.</p>
      ${CONTENT_SFX_KEYS.map(([key, label]) => `
        <div class="row-card">
          <div class="info">${esc(label)} ${c.sfx[key] ? '<span class="tag done">personnalisé</span>' : '<span class="tone-tag">son synthétisé</span>'}</div>
          <label class="file-input" style="padding:7px 12px;font-size:12.5px;">Uploader<input type="file" accept="audio/*" style="display:none" onchange="App.uploadContentSfx('${key}', this)"></label>
          ${c.sfx[key] ? `<button class="btn small ghost" onclick="App.resetContentSfx('${key}')">Réinitialiser</button>` : ''}
        </div>`).join('')}
    </div>

    <div class="panel">
      <h3 style="margin-top:0;">Icônes</h3>
      <div class="field-row" style="flex-wrap:wrap;">
        ${CONTENT_ICON_KEYS.map(([key, label]) => `
          <div style="min-width:110px;flex:0 0 auto;"><label>${esc(label)}</label><input type="text" id="content-icon-${key}" value="${esc(c.icons[key] || '')}" style="text-align:center;font-size:18px;"></div>
        `).join('')}
      </div>
      <div class="btn-row" style="margin-top:0;"><button class="btn small" onclick="App.saveContentIcons()">Enregistrer les icônes</button></div>
    </div>

    ${CONTENT_STRING_GROUPS.map(group => `
      <div class="panel">
        <h3 style="margin-top:0;">${esc(group.label)}</h3>
        ${group.keys.map(([key, label]) => `
          <label>${esc(label)}</label>
          <input type="text" id="content-str-${key}" value="${esc(c.strings[key] || '')}">
        `).join('')}
        <div class="btn-row" style="margin-top:0;"><button class="btn small" onclick="App.saveContentStrings(${jsArg(group.keys.map(k => k[0]))})">Enregistrer</button></div>
      </div>
    `).join('')}
  `;
}

function renderAdminEvents() {
  const ev = S.events || { tabEnabled: false, casino: { symbols: [] }, boss: {}, blackjack: {} };
  const bossDeckIds = S.bossDeckDraft || ev.boss.deckCardIds || [];
  const bossDeckCounts = {};
  bossDeckIds.forEach(id => { bossDeckCounts[id] = (bossDeckCounts[id] || 0) + 1; });
  const dialogue = S.bossDialogueDraft || ev.boss.dialogue || [];

  return `
    <h1 class="page-title">Admin — Événements</h1>
    <p class="page-sub">Active l'onglet "Événements" et règle les mini-jeux qui s'y trouvent. Un mini-jeu désactivé n'apparaît pas, même si l'onglet est actif.</p>
    ${renderAdminTabs()}

    <div class="panel">
      <label style="display:flex;align-items:center;gap:10px;cursor:pointer;margin-bottom:0;">
        <input type="checkbox" id="events-tab-enabled" style="width:auto;" ${ev.tabEnabled ? 'checked' : ''}>
        <b>Afficher l'onglet "Événements" dans le menu</b>
      </label>
      <div class="btn-row" style="margin-top:12px;"><button class="btn small" onclick="App.saveEventsTab()">Enregistrer</button></div>
    </div>

    <div class="panel">
      <h3 style="margin-top:0;">🎰 Casino</h3>
      <label style="display:flex;align-items:center;gap:10px;cursor:pointer;margin-bottom:14px;">
        <input type="checkbox" id="casino-enabled" style="width:auto;" ${ev.casino.enabled ? 'checked' : ''}> Activer le casino
      </label>
      <label>Coût par tour</label>
      <div class="field-row">
        <div><label style="font-size:11px;color:var(--muted);">En poussière ✧ (0 = non proposé)</label><input type="number" id="casino-cost-dust" min="0" value="${ev.casino.costPerSpinDust}"></div>
        <div><label style="font-size:11px;color:var(--muted);">En crédits 🪙 (0 = non proposé)</label><input type="number" id="casino-cost-credits" min="0" value="${ev.casino.costPerSpinCredits}"></div>
      </div>
      <label style="margin-bottom:6px;">Symboles — poids de tirage (plus haut = plus fréquent) et gain si 3 identiques (× la mise)</label>
      ${(ev.casino.symbols || []).map((s, i) => `
        <div class="field-row" style="align-items:flex-end;">
          <div style="max-width:70px;"><label style="font-size:20px;text-align:center;">${esc(s.icon)}</label></div>
          <div><label>Poids</label><input type="number" id="casino-weight-${i}" min="1" value="${s.weight}"></div>
          <div><label>Gain (×mise)</label><input type="number" id="casino-payout-${i}" min="0" value="${s.payout}"></div>
        </div>
      `).join('')}
      <label style="margin-top:6px;">Période d'activation <span class="tone-tag">optionnelle — vide = pas de limite de dates, seul l'interrupteur compte</span></label>
      <div class="field-row">
        <div><label>Début</label><input type="date" id="casino-start" value="${ev.casino.startDate || ''}"></div>
        <div><label>Fin</label><input type="date" id="casino-end" value="${ev.casino.endDate || ''}"></div>
      </div>
      ${ev.casino.daysRemaining !== null && ev.casino.daysRemaining !== undefined ? `<p class="tone-tag">Il reste ${ev.casino.daysRemaining} jour(s) avant la fin.</p>` : ''}
      <div class="btn-row" style="margin-top:6px;"><button class="btn small" onclick="App.saveEventsCasino()">Enregistrer le casino</button></div>
    </div>

    <div class="panel">
      <h3 style="margin-top:0;">🃏 Blackjack</h3>
      <label style="display:flex;align-items:center;gap:10px;cursor:pointer;margin-bottom:14px;">
        <input type="checkbox" id="blackjack-enabled" style="width:auto;" ${ev.blackjack.enabled ? 'checked' : ''}> Activer le blackjack
      </label>
      <label>Mise par manche</label>
      <div class="field-row">
        <div><label style="font-size:11px;color:var(--muted);">En poussière ✧ (0 = non proposé)</label><input type="number" id="bj-cost-dust" min="0" value="${ev.blackjack.costDust}"></div>
        <div><label style="font-size:11px;color:var(--muted);">En crédits 🪙 (0 = non proposé)</label><input type="number" id="bj-cost-credits" min="0" value="${ev.blackjack.costCredits}"></div>
      </div>
      <label style="margin-top:6px;">Période d'activation <span class="tone-tag">optionnelle — vide = pas de limite de dates, seul l'interrupteur compte</span></label>
      <div class="field-row">
        <div><label>Début</label><input type="date" id="bj-start" value="${ev.blackjack.startDate || ''}"></div>
        <div><label>Fin</label><input type="date" id="bj-end" value="${ev.blackjack.endDate || ''}"></div>
      </div>
      ${ev.blackjack.daysRemaining !== null && ev.blackjack.daysRemaining !== undefined ? `<p class="tone-tag">Il reste ${ev.blackjack.daysRemaining} jour(s) avant la fin.</p>` : ''}
      <div class="btn-row" style="margin-top:6px;"><button class="btn small" onclick="App.saveEventsBlackjack()">Enregistrer le blackjack</button></div>
    </div>

    <div class="panel">
      <h3 style="margin-top:0;">👹 Boss</h3>
      <label style="display:flex;align-items:center;gap:10px;cursor:pointer;margin-bottom:14px;">
        <input type="checkbox" id="boss-enabled" style="width:auto;" ${ev.boss.enabled ? 'checked' : ''}> Activer le boss (1 tentative par jour et par joueur)
      </label>
      <div style="display:flex;align-items:center;gap:16px;margin-bottom:16px;flex-wrap:wrap;">
        <div class="boss-portrait">${ev.boss.image ? `<img src="${esc(ev.boss.image)}" alt="">` : '👹'}</div>
        <label class="file-input" style="padding:9px 14px;">Changer l'image<input type="file" accept="image/*" style="display:none" onchange="App.uploadBossImage(this)"></label>
        <label class="file-input" style="padding:9px 14px;">${ev.boss.entrySound ? "Changer le son d'entrée" : "Ajouter un son d'entrée"}<input type="file" accept="audio/*" style="display:none" onchange="App.uploadBossSound(this)"></label>
        ${ev.boss.entrySound ? '<span class="tag done">son configuré</span>' : ''}
      </div>
      <div class="field-row">
        <div><label>Nom du boss</label><input type="text" id="boss-name" value="${esc(ev.boss.name || '')}"></div>
        <div><label>Points de vie</label><input type="number" id="boss-hp" min="1" value="${ev.boss.heroHealth}"></div>
      </div>
      <div class="field-row">
        <div><label>Récompense en poussière ✧ (victoire)</label><input type="number" id="boss-reward-dust" min="0" value="${ev.boss.rewardDust}"></div>
        <div><label>Récompense en crédits 🪙 (victoire)</label><input type="number" id="boss-reward-credits" min="0" value="${ev.boss.rewardCredits}"></div>
      </div>
      <label>Période d'activation <span class="tone-tag">optionnelle — vide = pas de limite de dates, seul l'interrupteur compte</span></label>
      <div class="field-row">
        <div><label>Début</label><input type="date" id="boss-start" value="${ev.boss.startDate || ''}"></div>
        <div><label>Fin</label><input type="date" id="boss-end" value="${ev.boss.endDate || ''}"></div>
      </div>
      ${ev.boss.daysRemaining !== null && ev.boss.daysRemaining !== undefined ? `<p class="tone-tag">Il reste ${ev.boss.daysRemaining} jour(s) avant la fin.</p>` : ''}

      <h4 style="margin:18px 0 8px;">Deck du boss</h4>
      <p class="page-sub" style="margin-bottom:12px;">${bossDeckIds.length === 0 ? 'Vide = deck aléatoire dans tout le pool (comme le bot d\u2019entraînement).' : `Deck personnalisé : ${bossDeckIds.length} carte(s).`}</p>
      <div class="grid">${Object.keys(bossDeckCounts).map(id => renderCardTile(cardById(id), { count: bossDeckCounts[id], showDesc: false, onClick: `App.removeFromBossDeck('${id}')` })).join('')}</div>
      <details style="margin-top:10px;"><summary style="cursor:pointer;color:var(--muted);font-size:13px;">Choisir des cartes à ajouter…</summary>
        <div class="grid" style="margin-top:10px;">${(S.cardPool || []).map(c => renderCardTile(c, { showDesc: false, onClick: `App.addToBossDeck('${c.id}')` })).join('')}</div>
      </details>
      <div class="btn-row" style="margin-top:10px;">
        ${bossDeckIds.length > 0 ? `<button class="btn small ghost" onclick="App.clearBossDeck()">Vider (deck aléatoire)</button>` : ''}
      </div>

      <h4 style="margin:18px 0 8px;">Dialogue / lore du boss</h4>
      <p class="page-sub" style="margin-bottom:12px;">Une réplique s'affiche automatiquement quand les PV du boss passent sous le seuil indiqué, une seule fois par combat. Décoche une réplique pour la désactiver sans la supprimer.</p>
      ${dialogue.map((d, i) => `
        <div class="field-row" style="align-items:flex-end;${d.enabled === false ? 'opacity:.5;' : ''}">
          <div style="max-width:60px;"><label title="Activer/désactiver">Actif</label><input type="checkbox" style="width:auto;height:22px;" ${d.enabled !== false ? 'checked' : ''} onchange="App.toggleBossDialogueEnabled(${i})"></div>
          <div style="max-width:110px;"><label>Seuil de PV (%)</label><input type="number" min="0" max="100" value="${d.hpPercent}" onchange="App.updateBossDialogueField(${i}, 'hpPercent', this.value)"></div>
          <div><label>Réplique</label><input type="text" value="${esc(d.text)}" onchange="App.updateBossDialogueField(${i}, 'text', this.value)"></div>
          <button class="btn small danger" style="margin-bottom:2px;" onclick="App.removeBossDialogueLine(${i})">Retirer</button>
        </div>
      `).join('')}
      <div class="btn-row" style="margin-top:4px;">
        <button class="btn small ghost" onclick="App.addBossDialogueLine()">+ Ajouter une réplique</button>
      </div>

      <div class="btn-row" style="margin-top:16px;"><button class="btn" onclick="App.saveEventsBoss()">Enregistrer le boss</button></div>
    </div>
  `;
}

function renderAdminAchievementParamField() {
  const ct = S.adminConditionTypes[S.adminAchievementType];
  const paramType = ct ? ct.paramType : 'none';
  if (paramType === 'cardType') {
    return `<div><label>Type de carte</label><select id="ach-param">
      <option value="minion">Serviteur</option><option value="weapon">Arme</option><option value="sort">Sort</option>
    </select></div>`;
  }
  if (paramType === 'cardId') {
    return `<div><label>Carte</label><select id="ach-param">
      ${(S.cardPool || []).map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}
    </select></div>`;
  }
  if (paramType === 'playerSlug') {
    return `<div><label>Joueur</label><select id="ach-param">
      ${(S.playersList || []).map(p => `<option value="${p.slug}">${esc(p.pseudo)}</option>`).join('')}
    </select></div>`;
  }
  if (paramType === 'rank') {
    const ranks = (S.config && S.config.ranks) || [];
    return `<div><label>Rang</label><select id="ach-param">
      ${ranks.map(r => `<option value="${esc(r.name || r)}">${esc(r.name || r)}</option>`).join('')}
    </select></div>`;
  }
  if (paramType === 'extensionOrAll') {
    return `<div><label>Extension</label><select id="ach-param">
      <option value="all">Toutes les extensions (collection complète)</option>
      ${(S.extensions || []).map(e => `<option value="${e.id}">${esc(e.name)}</option>`).join('')}
    </select></div>`;
  }
  return ''; // paramType 'none' : aucune sélection nécessaire
}

function renderAdminAchievements() {
  const list = S.adminAchievements || [];
  return `
    <h1 class="page-title">Admin — Succès</h1>
    <p class="page-sub">Crée des succès déblocables sur toutes sortes de conditions liées au jeu, aux événements, ou à l'économie.</p>
    ${renderAdminTabs()}

    <div class="panel">
      <h3 style="margin-top:0;">Créer un succès</h3>
      <div class="field-row">
        <div><label>Nom</label><input type="text" id="ach-name" placeholder="Ex : Collectionneur"></div>
        <div><label>Description</label><input type="text" id="ach-desc" placeholder="Ex : Possède toutes les cartes de l'édition de base"></div>
      </div>
      <div class="field-row">
        <div><label>Condition</label><select id="ach-type" onchange="App.setAdminAchievementType(this.value)">
          ${Object.keys(S.adminConditionTypes).map(k => `<option value="${k}" ${S.adminAchievementType === k ? 'selected' : ''}>${esc(S.adminConditionTypes[k].label)}</option>`).join('')}
        </select></div>
        ${renderAdminAchievementParamField()}
        <div><label>${S.adminConditionTypes[S.adminAchievementType] ? esc(S.adminConditionTypes[S.adminAchievementType].targetLabel) : 'Cible'}</label><input type="number" id="ach-target" min="1" value="1"></div>
      </div>
      <div class="field-row">
        <div><label>Récompense en crédits 🪙</label><input type="number" id="ach-reward-credits" min="0" value="0"></div>
        <div><label>Récompense en poussière ✧</label><input type="number" id="ach-reward-dust" min="0" value="0"></div>
        <div><label>Titre offert (optionnel) <span class="tone-tag">affiché sous le pseudo</span></label><input type="text" id="ach-reward-title" maxlength="40" placeholder="Ex : Tueur de boss"></div>
      </div>
      <div class="btn-row" style="margin-top:0;"><button class="btn" onclick="App.createAchievement()">Créer le succès</button></div>
    </div>

    ${list.length === 0 ? '<div class="empty">Aucun succès créé pour l\'instant.</div>' : list.map(a => `
      <div class="panel">
        <div style="display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap;">
          <div style="width:56px;height:56px;border-radius:12px;overflow:hidden;background:linear-gradient(150deg,var(--accent),var(--accent-dim));display:flex;align-items:center;justify-content:center;flex-shrink:0;">
            ${a.icon ? `<img src="${esc(a.icon)}" style="width:100%;height:100%;object-fit:cover;">` : '<span style="font-size:24px;">🏅</span>'}
          </div>
          <div style="flex:1;min-width:220px;">
            <h3 style="margin:0 0 4px;">${esc(a.name)}</h3>
            <p style="color:var(--muted);font-size:13px;margin:0 0 8px;">${esc(a.description || '')}</p>
            <div class="tone-tag">${esc((S.adminConditionTypes[a.condition.type] || {}).label || a.condition.type)}${a.condition.param ? ' — ' + esc(a.condition.param) : ''} · cible : ${a.condition.target}</div>
            <div class="field-row" style="margin-top:10px;">
              <div><label>Récompense en crédits 🪙</label><input type="number" min="0" id="ach-edit-credits-${a.id}" value="${a.rewardCredits || 0}"></div>
              <div><label>Récompense en poussière ✧</label><input type="number" min="0" id="ach-edit-dust-${a.id}" value="${a.rewardDust || 0}"></div>
            </div>
            <div class="btn-row" style="margin-top:6px;">
              <button class="btn small" onclick="App.updateAchievementReward('${a.id}')">Mettre à jour la récompense</button>
              <label class="file-input" style="padding:7px 12px;font-size:12.5px;">Changer l'icône<input type="file" accept="image/*" style="display:none" onchange="App.uploadAchievementIcon('${a.id}', this)"></label>
              <button class="btn small danger" onclick="App.deleteAchievement('${a.id}', ${jsArg(a.name)})">Supprimer</button>
            </div>
          </div>
        </div>
      </div>
    `).join('')}
  `;
}

function renderAdminOrnaments() {
  const ornaments = (S.config && S.config.ornaments) || [];
  return `
    <h1 class="page-title">Admin — Ornements</h1>
    <p class="page-sub">Les ornements de type CSS (Bronze, Argent, Or...) sont intégrés au jeu. Ajoute ici tes propres ornements en PNG (idéalement une image carrée avec fond transparent, en forme d'anneau autour de l'avatar).</p>
    ${renderAdminTabs()}
    <div class="panel">
      <div class="field-row">
        <div><label>Nom</label><input type="text" id="new-orn-name" placeholder="Ex : Couronne Céleste" /></div>
        <div><label>Prix en poussière</label><input type="number" id="new-orn-price" placeholder="Ex : 500" /></div>
      </div>
      <label>Image PNG (fond transparent recommandé)</label>
      <input type="file" id="new-orn-image" accept="image/png,image/webp" class="file-input" style="width:100%;margin-bottom:14px;">
      <label>Description</label>
      <textarea id="new-orn-desc" rows="2" placeholder="Une phrase de présentation"></textarea>
      <div class="btn-row"><button class="btn" onclick="App.createOrnament()">Ajouter à la boutique</button></div>
    </div>
    <div class="shop-grid">
      ${ornaments.map(o => `<div class="shop-item">
        ${avatarHtml('', null, o.id)}
        <div class="shop-name">${esc(o.name)} ${o.image ? '<span class="tone-tag">personnalisé</span>' : ''}</div>
        <div class="shop-desc">${esc(o.desc || '')}</div>
        <div class="price-edit" style="justify-content:center;">
          <input type="number" min="0" id="orn-price-${o.id}" value="${o.price}" ${o.id === 'none' ? 'disabled' : ''}>
          <button class="btn small" ${o.id === 'none' ? 'disabled' : ''} onclick="App.updateOrnamentPrice('${o.id}')">Fixer</button>
        </div>
        ${o.id !== 'none' ? `<button class="btn small danger" style="margin-top:8px;" onclick="App.deleteOrnament('${o.id}')">Supprimer</button>` : ''}
      </div>`).join('')}
    </div>`;
}

function renderAdminEmotes() {
  const adminEmotes = (S.config && S.config.emotes) || [];
  return `
    <h1 class="page-title">Admin — Provocations</h1>
    <p class="page-sub">Les joueurs les achètent en poussière et les placent dans leur roue de combat. Prix <b>0</b> = offerte immédiatement à tous.</p>
    ${renderAdminTabs()}
    <div class="panel">
      <div class="field-row">
        <div style="flex:2;"><label>Texte affiché en combat (60 caractères max)</label>
          <input type="text" id="new-emote-text" maxlength="60" placeholder="Ex : Tu vas regretter ce tour." /></div>
        <div><label>Prix en poussière</label><input type="number" id="new-emote-price" placeholder="Ex : 120" /></div>
        <div><label>Ton</label><select id="new-emote-tone">
          <option value="neutre">Neutre</option>
          <option value="amical">Amical</option>
          <option value="piquant">Piquant</option>
          <option value="fier">Fier</option>
        </select></div>
      </div>
      <div class="btn-row" style="margin-top:0;"><button class="btn" onclick="App.createEmote()">Ajouter à la boutique</button></div>
    </div>
    <div class="shop-grid">
      ${adminEmotes.map(e => `<div class="emote-card">
        <div class="emote-text">${esc(e.text)}</div>
        <div class="tone-tag">${esc(e.tone || 'neutre')} · ${e.price > 0 ? '✧ ' + e.price : 'gratuite'}</div>
        <div class="price-edit">
          <input type="number" min="0" id="emote-price-${e.id}" value="${e.price}" title="0 = offerte à tous">
          <button class="btn small" onclick="App.updateEmotePrice('${e.id}')">Fixer</button>
        </div>
        <button class="btn small danger" onclick="App.deleteEmote('${e.id}')">Supprimer</button>
      </div>`).join('')}
    </div>`;
}

function renderAdminUsers() {
  if (S.adminViewedUser) {
    const u = S.adminViewedUser;
    const owned = ownedCardsList(u.collection || {});
    return `
      <h1 class="page-title">${esc(u.pseudo)}</h1>
      ${renderAdminTabs()}
      <div class="btn-row" style="margin-bottom:16px;">
        <button class="btn ghost" onclick="App.backToAdminUsers()">← Retour à la liste</button>
      </div>
      <div class="panel admin-grant">
        <h3 style="margin-top:0;">Ajouter une carte à ${esc(u.pseudo)}</h3>
        <div class="admin-grant-row">
          <input type="search" id="admin-grant-search" class="search-input" style="margin:0;flex:1;min-width:200px;" placeholder="Rechercher une carte du pool…" value="${esc(S.adminGrantSearch || '')}" oninput="App.adminGrantSearch(this.value)">
          <input type="number" id="admin-grant-qty" min="1" max="99" value="1" style="width:80px;" title="Nombre d'exemplaires">
        </div>
        <div class="admin-grant-results">${renderAdminGrantResults(u)}</div>
      </div>
      <h3>Collection (${owned.reduce((a, x) => a + x.count, 0)} cartes)</h3>
      ${owned.length === 0 ? '<div class="empty">Ce compte ne possède aucune carte.</div>' :
        `<div class="grid">${owned.map(x => `<div class="admin-coll-item">
          ${renderCardTile(x.card, { count: x.count })}
          <div class="admin-coll-actions">
            <button class="btn small ghost" onclick="App.adminRemoveCard('${esc(u.slug)}', '${esc(x.card.id)}', 1)" title="Retirer un exemplaire">−1</button>
            <span class="admin-coll-count">×${x.count}</span>
            <button class="btn small ghost" onclick="App.adminGrantCard('${esc(u.slug)}', '${esc(x.card.id)}', 1)" title="Ajouter un exemplaire">+1</button>
            <button class="btn small danger" onclick="App.adminRemoveCard('${esc(u.slug)}', '${esc(x.card.id)}', 'all', ${jsArg(x.card.name)})" title="Retirer toutes les copies">Retirer</button>
          </div>
        </div>`).join('')}</div>`}
    `;
  }

  const filter = (S.adminUserFilter || '').toLowerCase();
  const users = (S.adminUsers || []).filter(u => u.pseudo.toLowerCase().includes(filter));
  return `
    <h1 class="page-title">Admin — Comptes (${(S.adminUsers || []).length})</h1>
    <p class="page-sub">Consulte les collections, réinitialise un mot de passe oublié, ajuste la poussière ou supprime un compte.</p>
    ${renderAdminTabs()}
    <input type="text" class="search-input" placeholder="Rechercher un pseudo…" oninput="App.setAdminUserFilter(this.value)" value="${esc(S.adminUserFilter || '')}" />
    <div class="btn-row" style="margin-top:-8px;margin-bottom:16px;"><button class="btn ghost small" onclick="App.refreshAdminUsers()">↻ Actualiser</button></div>
    ${!S.adminUsers ? skeletonRows(5) : users.length === 0 ? '<div class="empty">Aucun compte trouvé.</div>' :
      users.map(u => `
      <div class="row-card">
        <div class="info">
          <b>${esc(u.pseudo)}</b> ${rankPill(u.rank)}
          <span class="tag"><span class="online-dot ${u.online ? 'on' : ''}"></span>${u.online ? 'en ligne' : 'hors ligne'}</span>
          <div style="color:var(--muted);font-size:12.5px;margin-top:4px;">
            ${u.collectionCount} cartes · ${u.seasonWins}V/${u.seasonLosses}D cette saison · 🪙 ${u.credits} crédits · ✧ ${u.dust} poussière
          </div>
          <div class="admin-user-actions">
            <button class="btn small ghost" onclick="App.viewAdminUser('${u.slug}')">Voir la collection</button>
            <button class="btn small ghost" onclick="App.resetUserPassword('${u.slug}', ${jsArg(u.pseudo)})">Réinitialiser le mot de passe</button>
            <button class="btn small ghost" onclick="App.grantStarterDeck('${u.slug}', ${jsArg(u.pseudo)})">Offrir un deck de départ</button>
            <input type="number" id="credits-delta-${u.slug}" placeholder="± crédits 🪙" class="dust-delta-input">
            <button class="btn small" onclick="App.adjustUserCreditsCustom('${u.slug}')">Appliquer</button>
            <input type="number" id="dust-delta-${u.slug}" placeholder="± poussière ✧" class="dust-delta-input">
            <button class="btn small" onclick="App.adjustUserDustCustom('${u.slug}')">Appliquer</button>
            <button class="btn small danger" onclick="App.deleteUserAccount('${u.slug}', ${jsArg(u.pseudo)})">Supprimer</button>
          </div>
        </div>
      </div>`).join('')}
  `;
}

/* Résultats de recherche « Ajouter une carte » (admin → fiche d'un joueur) */
function renderAdminGrantResults(u) {
  const q = (S.adminGrantSearch || '').trim().toLowerCase();
  if (!q) return '<div class="page-sub" style="margin:8px 0 0;">Tape le nom d\'une carte pour la trouver.</div>';
  const found = (S.cardPool || []).filter(c => String(c.name).toLowerCase().includes(q)).slice(0, 12);
  if (!found.length) return '<div class="empty" style="margin-top:8px;">Aucune carte ne correspond.</div>';
  return `<div class="admin-grant-list">${found.map(c => {
    const r = RARITIES[c.rarity] || {};
    const have = (u.collection || {})[c.id] || 0;
    return `<div class="admin-grant-item">
      <span class="stat-dot" style="background:${r.color || 'var(--muted)'}"></span>
      <b>${esc(c.name)}</b><span class="tone-tag">${esc(cardTypeLabel(c.type))} · ${esc(r.label || c.rarity)}</span>
      <span class="admin-grant-have">${have ? `possède ×${have}` : 'ne la possède pas'}</span>
      <button class="btn small" onclick="App.adminGrantCard('${esc(u.slug)}', '${esc(c.id)}')">Ajouter</button>
    </div>`;
  }).join('')}</div>`;
}

function renderAdmin() {
  if (!S.isAdmin) return renderAdminGate();
  if (S.adminTab === 'extensions') return renderAdminExtensions();
  if (S.adminTab === 'ornaments') return renderAdminOrnaments();
  if (S.adminTab === 'emotes') return renderAdminEmotes();
  if (S.adminTab === 'content') return renderAdminContent();
  if (S.adminTab === 'events') return renderAdminEvents();
  if (S.adminTab === 'achievements') return renderAdminAchievements();
  if (S.adminTab === 'users') return renderAdminUsers();
  if (S.adminTab === 'stats') return renderAdminStats();
  if (S.adminTab === 'tournament') return renderAdminTournament();
  if (S.adminTab === 'story') return renderAdminStory();
  if (S.adminTab === 'ranking') return renderAdminRanking();
  if (S.adminTab === 'bugs') return renderAdminBugs();
  if (S.adminTab === 'sandbox') return renderAdminSandbox();
  if (S.adminTab === 'equilibrium') return renderEquilibrium();
  if (S.adminTab === 'schedule') return renderAdminSchedule();
  if (S.adminTab === 'levels') return renderAdminLevels();
  return renderAdminCards();
}

/* ======================================================
   Écran de fin de combat animé : crédits et poussière qui défilent, barre
   d'XP qui se remplit (fanfare à chaque niveau), défis du jour qui se cochent.
   Tout est calculé à partir du temps écoulé depuis le début : si l'écran est
   redessiné pendant l'animation, elle reprend exactement où elle en était.
   ====================================================== */
const xpNeedFor = lvl => 100 + (lvl - 1) * 40; // même formule que le serveur
function resultSnapshot(p) {
  if (!p || !p.progress) return null;
  const pr = p.progress;
  return { credits: p.credits || 0, dust: p.dust || 0, level: pr.level || 1, xp: pr.xp || 0, xpNext: pr.xpNext || xpNeedFor(pr.level || 1),
    next: (pr.next || []).slice(), daily: (pr.daily || []).map(d => ({ id: d.id, text: d.text, target: d.target, progress: d.progress, done: !!d.done, reward: d.reward || {} })) };
}
function buildResultAnim(a, b) {
  if (!a || !b) return null;
  const dc = b.credits - a.credits, dd = b.dust - a.dust;
  let gained = 0;
  if (b.level === a.level) gained = Math.max(0, b.xp - a.xp);
  else if (b.level > a.level) { gained = a.xpNext - a.xp; for (let l = a.level + 1; l < b.level; l++) gained += xpNeedFor(l); gained += b.xp; }
  const sameDay = a.daily.length === b.daily.length && a.daily.every((d, i) => b.daily[i] && b.daily[i].id === d.id);
  const dailyMoves = sameDay ? b.daily.map((d, i) => ({ i, from: a.daily[i].progress, to: d.progress, done: d.done && !a.daily[i].done })).filter(x => x.to !== x.from || x.done) : [];
  if (!dc && !dd && !gained && !dailyMoves.length && b.level === a.level) return null;
  let T = 650;
  const anim = { a, b, dc, dd, gained, events: [], segs: [], dailies: [], levelUps: [] };
  if (dc || dd) { anim.wallet = { start: T, dur: 1100 }; T += 1200; }
  if (gained || b.level !== a.level) {
    anim.xpStart = T;
    const ups = Math.min(5, Math.max(0, b.level - a.level));
    let pct = a.xp / a.xpNext, lvl = a.level;
    for (let k = 0; k < ups; k++) {
      anim.segs.push({ start: T, dur: k === 0 ? 750 : 450, from: pct, to: 1, level: lvl });
      T += k === 0 ? 750 : 450;
      lvl++;
      const nx = (a.next || []).find(n => n.level === lvl);
      anim.levelUps.push({ at: T, level: lvl, reward: nx ? nx.reward : '' });
      anim.events.push({ at: T, sfx: 'levelUp' });
      T += 1300; pct = 0;
    }
    if (b.level > a.level + 5) { lvl = b.level; }
    const toPct = b.level === lvl ? b.xp / b.xpNext : 1;
    anim.segs.push({ start: T, dur: 650, from: pct, to: toPct, level: lvl });
    T += 750;
  }
  dailyMoves.forEach(m => {
    anim.dailies.push(Object.assign({ start: T, dur: 600 }, m));
    if (m.done) { anim.events.push({ at: T + 600, sfx: 'dailyDone' }); T += 450; }
    T += 700;
  });
  anim.total = T;
  return anim;
}
const easeOut = x => 1 - Math.pow(1 - Math.max(0, Math.min(1, x)), 3);
function resultElapsed(anim) {
  if (OPTS.anim === 'reduced') return Infinity;
  return Date.now() - (anim.t0 || Date.now());
}
function renderResultPanel(anim) {
  const t = resultElapsed(anim);
  const a = anim.a, b = anim.b;
  const lerp = (from, to, start, dur) => Math.round(from + (to - from) * easeOut((t - start) / dur));
  // Porte-monnaie
  let wallet = '';
  if (anim.wallet) {
    const w = anim.wallet;
    const cur = (from, to) => lerp(from, to, w.start, w.dur);
    const pill = (cls, ic, from, to) => to === from ? '' : `<span class="mr-cur ${cls} ${t >= w.start ? 'on' : ''}">${ic} <b>${cur(from, to)}</b><em class="${to > from ? 'up' : 'down'}">${to > from ? '+' : ''}${to - from}</em></span>`;
    wallet = `<div class="mr-wallet">${pill('cr', icon('icon.credits', '🪙'), a.credits, b.credits)}${pill('du', icon('icon.dust', '✧'), a.dust, b.dust)}</div><div class="mr-caption">Tous tes gains : combat, succès, défis et niveaux</div>`;
  }
  // Barre d'XP
  let xp = '';
  if (anim.segs.length) {
    let seg = anim.segs[0];
    for (const sg of anim.segs) if (t >= sg.start) seg = sg;
    const pct = t < anim.segs[0].start ? anim.segs[0].from : seg.from + (seg.to - seg.from) * easeOut((t - seg.start) / seg.dur);
    const shownLevel = anim.levelUps.filter(u => t >= u.at).length ? anim.levelUps.filter(u => t >= u.at).slice(-1)[0].level : a.level;
    const xpShown = lerp(0, anim.gained, anim.xpStart, Math.max(1, (anim.segs.slice(-1)[0].start + anim.segs.slice(-1)[0].dur) - anim.xpStart));
    const filling = t >= anim.xpStart && t < anim.segs.slice(-1)[0].start + anim.segs.slice(-1)[0].dur;
    xp = `<div class="mr-xp ${filling ? 'filling' : ''}">
      <div class="mr-lvl">Niveau <b>${shownLevel}</b></div>
      <div class="mr-bar"><i style="width:${Math.round(Math.min(1, Math.max(0, pct)) * 1000) / 10}%"></i></div>
      <div class="mr-xpgain">${t >= anim.xpStart ? `+${xpShown} XP` : ''}</div>
    </div>`;
  }
  // Passage de niveau : bannière + confettis pendant ~1,3 s, puis une ligne qui reste
  const live = anim.levelUps.filter(u => t >= u.at && t < u.at + 1300).slice(-1)[0];
  let burst = '';
  if (live) {
    const k = (t - live.at) / 1300;
    const op = k < 0.12 ? k / 0.12 : k > 0.8 ? (1 - k) / 0.2 : 1;
    const sc = 0.6 + 0.4 * easeOut(k * 4);
    const parts = Array.from({ length: 18 }, (_, i) => {
      const ang = i / 18 * Math.PI * 2, r = 30 + 150 * easeOut(k * 1.4);
      const col = ['#ffe27a', '#ff9ad8', '#8fd8ff', '#9dffb0'][i % 4];
      return `<i style="transform:translate(${Math.cos(ang) * r}px,${Math.sin(ang) * r * 0.7 + 40 * k * k}px) rotate(${i * 40 + k * 300}deg);opacity:${Math.max(0, 1 - k)};background:${col}"></i>`;
    }).join('');
    burst = `<div class="mr-levelup" style="opacity:${Math.max(0, Math.min(1, op)).toFixed(2)};transform:translate(-50%,-50%) scale(${sc.toFixed(3)})">
      <span class="mr-confetti">${parts}</span>
      <div class="mr-lu-title">NIVEAU ${live.level} !</div>${live.reward ? `<div class="mr-lu-reward">Récompense : ${esc(live.reward)}</div>` : ''}</div>`;
  }
  const doneUps = anim.levelUps.filter(u => t >= u.at + 1300);
  const upsLine = doneUps.length ? `<div class="mr-ups">${doneUps.map(u => `<span>🎉 Niveau ${u.level}${u.reward ? ` · ${esc(u.reward)}` : ''}</span>`).join('')}</div>` : '';
  // Défis du jour
  let dailies = '';
  if (b.daily.length && (anim.dailies.length || t >= 0)) {
    dailies = `<div class="mr-dailies">${b.daily.map((d, i) => {
      const mv = anim.dailies.find(x => x.i === i);
      const from = mv ? mv.from : d.progress;
      const prog = mv ? lerp(from, mv.to, mv.start, mv.dur) : d.progress;
      const justDone = mv && mv.done && t >= mv.start + mv.dur;
      const wasDone = (a.daily[i] || {}).done;
      const done = wasDone || justDone;
      const active = mv && t >= mv.start && t < mv.start + mv.dur + 500;
      const rw = d.reward.credits ? `+${d.reward.credits} 🪙` : d.reward.xp ? `+${d.reward.xp} XP` : '';
      return `<div class="mr-daily ${done ? 'done' : ''} ${justDone ? 'just' : ''} ${active ? 'active' : ''}">
        <span class="mr-check">${done ? '✔' : ''}</span>
        <span class="mr-dtext">${esc(d.text)}</span>
        <span class="mr-dbar"><i style="width:${Math.round(Math.min(1, prog / d.target) * 100)}%"></i></span>
        <span class="mr-dcount">${Math.min(prog, d.target)}/${d.target}</span>
        <span class="mr-dreward">${rw}</span></div>`;
    }).join('')}</div>`;
  }
  const finished = t >= anim.total;
  return `<div class="mr-panel" onclick="App.skipResultAnim()" title="${finished ? '' : 'Clique pour tout afficher'}">${wallet}${xp}${upsLine}${dailies}${burst}</div>`;
}
/* Boucle d'animation : on ne redessine que le panneau (pas tout le plateau) */
function startResultAnim() {
  const mr = S.matchResultOverlay;
  if (!mr || !mr.anim) return;
  mr.anim.t0 = Date.now();
  mr.anim.played = {};
  let lastTick = 0;
  const step = () => {
    const cur = S.matchResultOverlay;
    if (!cur || cur.anim !== mr.anim) return;
    const t = resultElapsed(mr.anim);
    mr.anim.events.forEach((e, i) => {
      if (t >= e.at && !mr.anim.played[i]) {
        mr.anim.played[i] = true;
        if (t - e.at < 400) playGameSound(e.sfx, () => window.SFX && SFX[e.sfx] && SFX[e.sfx]());
        if (e.sfx === 'levelUp' && navigator.vibrate) { try { navigator.vibrate([40, 60, 80]); } catch (err) {} }
      }
    });
    // petit « tic » pendant que les compteurs défilent
    const w = mr.anim.wallet;
    if (w && t >= w.start && t < w.start + w.dur && Date.now() - lastTick > 90) { lastTick = Date.now(); playGameSound('coinTick', () => window.SFX && SFX.coinTick && SFX.coinTick()); }
    const host = document.querySelector('.mr-panel-wrap');
    if (host) host.innerHTML = renderResultPanel(mr.anim);
    if (t < mr.anim.total + 50) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

const DUEL_MODES = [['normal', '⚔️ Combat'], ['blitz', '⚡ Blitz'], ['brawl', '🥊 Bagarre'], ['draft', '🃏 Draft']];
const DUEL_HELP = { normal: 'Combat classique avec ton deck (compte pour le classement).', blitz: 'Tours de 20 s et 3 mana dès le départ, sans classement.',
  brawl: 'Avec la règle de la Bagarre de la semaine, sans classement.', draft: 'Chacun avec son deck de Draft terminé ; vos Drafts ne sont pas modifiés.' };
function duelModeChips() {
  const cur = S.duelMode || 'normal';
  return `<div class="duel-modes">${DUEL_MODES.map(([id, l]) => `<button class="${cur === id ? 'on' : ''}" onclick="App.setDuelMode('${id}')">${l}</button>`).join('')}</div>
    <p class="page-sub" style="margin:0 0 10px;">${DUEL_HELP[cur]}</p>`;
}
function renderDuelPicker() {
  const d = S.duelPicker; if (!d) return '';
  const label = (DUEL_MODES.find(x => x[0] === d.mode) || [])[1] || 'Combat';
  const friends = (S.friends || []).slice().sort((a, b) => (b.online - a.online) || a.pseudo.localeCompare(b.pseudo));
  return `<div class="emote-wheel-overlay" onclick="App.closeDuel()">
    <div class="panel duel-picker" onclick="event.stopPropagation()" role="dialog" aria-label="Défier un ami">
      <h3 style="margin-top:0;">👥 Défier un ami — ${label}</h3>
      <p class="page-sub" style="margin-top:0;">${DUEL_HELP[d.mode] || ''}</p>
      ${!S.friends ? skeletonRows(3) : friends.length === 0 ? '<div class="empty">Ajoute des amis dans Social → Joueurs pour pouvoir les défier.</div>' :
        `<div class="player-list">${friends.map(f => `<div class="player-row">
          <div style="display:flex;align-items:center;gap:10px;">${avatarHtml(f.pseudo, f.avatar, f.ornament, 'sm')}
            <div><b>${esc(f.pseudo)}</b><br><span style="font-size:12px;color:var(--muted);"><span class="online-dot ${f.online ? 'on' : ''}"></span>${f.inMatch ? 'en combat' : f.online ? 'en ligne' : 'hors ligne'}</span></div></div>
          <button class="btn small" ${f.online && !f.inMatch ? '' : 'disabled'} onclick="App.challengeFriend('${esc(f.slug)}', '${d.mode}')">Défier</button></div>`).join('')}</div>`}
      <div class="btn-row"><button class="btn ghost small" onclick="App.closeDuel()">Fermer</button></div>
    </div></div>`;
}

function renderOverlays() {
  let out = renderDuelPicker();
  if (S.matchResultOverlay) {
    const mr = S.matchResultOverlay;
    const label = mr.result === 'win' ? 'VICTOIRE' : mr.result === 'lose' ? 'DÉFAITE' : 'ÉGALITÉ';
    const rw = mr.rewards || {};
    const rewardLines = [];
    if (rw.vpDetail && rw.vpGain > 0) {
      const d = rw.vpDetail;
      const extras = [d.firstWin ? `+${d.firstWin} 1re victoire du jour` : '', d.streak ? `+${d.streak} série de ${d.streakCount}` : ''].filter(Boolean).join(', ');
      rewardLines.push(d.loss ? `+${rw.vpGain} points de classement (défaite jouée jusqu'au bout)` : `+${rw.vpGain} points de classement${extras ? ` (${extras})` : ''} · +20 ✧`);
    } else if (rw.isBlitz && !rw.isBot) { if (rw.won) rewardLines.push('⚡ Victoire Blitz : +10 ✧ (sans classement)'); }
    else if (rw.isDuel) { if (rw.won) rewardLines.push('🤝 Duel amical gagné : +10 ✧ (sans classement)'); }
    else if (rw.won && !rw.isBot && !rw.isTournament) rewardLines.push(`+${rw.vpGain || 0} points de classement · +20 ✧`);
    if (rw.survival) {
      const sv = rw.survival;
      if (sv.won) {
        rewardLines.push(`🏔️ Manche ${sv.round} gagnée ! Prochaine : manche ${sv.nextRound}, avec ${sv.hp} PV.`);
        if (sv.newRecord) rewardLines.push(`🏆 Nouveau record : ${sv.best} manche${sv.best > 1 ? 's' : ''} !`);
        if (sv.milestone) rewardLines.push(`🎁 Palier atteint : +${sv.milestone.credits} 🪙 · +${sv.milestone.dust} ✧`);
      } else rewardLines.push(`🏔️ Fin de la partie à la manche ${sv.round}. Record : ${sv.best} manche${sv.best > 1 ? 's' : ''}.`);
    }
    if (rw.puzzle) {
      const pz = rw.puzzle;
      if (!pz.won) rewardLines.push('🧩 Raté : il fallait gagner pendant ce tour. Réessaie autant que tu veux !');
      else if (pz.expired) rewardLines.push('🧩 Réussi… mais c\'était le puzzle d\'hier : un nouveau t\'attend.');
      else if (!pz.first) rewardLines.push('🧩 Réussi à nouveau ! (la récompense ne se gagne qu\'une fois par jour)');
      else {
        rewardLines.push(`🧩 Puzzle réussi ! Tu es le ${pz.rank === 1 ? '1er' : pz.rank + 'e'} joueur à le résoudre aujourd'hui.`);
        if (pz.reward) rewardLines.push(`🎁 +${pz.reward.credits} 🪙 · +${pz.reward.dust} ✧ · +${pz.reward.xp} XP${pz.reward.booster ? ' · 1 booster (série de ' + pz.streak + ' jours !)' : ''}`);
        else if (pz.revealed) rewardLines.push('<span class="tone-tag">Solution déjà vue : pas de récompense aujourd\'hui</span>');
        if (pz.streak > 1) rewardLines.push(`🔥 Série : ${pz.streak} jours de suite`);
      }
    }
    if (rw.brawl) {
      const br = rw.brawl;
      if (br.won && br.reward && br.reward.first) rewardLines.push(`🥊 1re victoire de la semaine : +${br.reward.booster} booster · +${br.reward.credits} 🪙`);
      else if (br.won && br.reward && br.reward.dust) rewardLines.push(`🥊 Victoire en Bagarre : +${br.reward.dust} ✧`);
      else if (br.won) rewardLines.push('🥊 Victoire en Bagarre !');
      if (br.won) rewardLines.push(`<span class="tone-tag">${br.wins} victoire${br.wins > 1 ? 's' : ''} cette semaine</span>`);
    }
    if (rw.draft) {
      const dr = rw.draft;
      rewardLines.push(`🃏 Draft : ${dr.wins} victoire${dr.wins > 1 ? 's' : ''} · ${dr.losses} défaite${dr.losses > 1 ? 's' : ''}${dr.over ? '' : ` (encore ${3 - dr.losses} vie${3 - dr.losses > 1 ? 's' : ''})`}`);
      if (dr.over && dr.rewards) {
        rewardLines.push(`🎁 Fin du Draft : ${draftRewardText(dr.rewards)}`);
        if (dr.newRecord) rewardLines.push(`🏆 Nouveau record : ${dr.best} victoire${dr.best > 1 ? 's' : ''} !`);
      }
    }
    if (rw.credits > 0) rewardLines.push(`+${rw.credits} ${icon('icon.credits', '🪙')} crédits`);
    else if (!rw.isBot && !rw.isBossFight && !rw.isTournament && !rw.isBlitz && rw.credits === 0) rewardLines.push(`<span class="tone-tag">Pas de crédits : partie trop courte ou abandonnée</span>`);
    if (rw.bonusBooster) rewardLines.push(`🎁 Booster bonus « ${esc(rw.bonusBooster.extensionName)} » obtenu !`);
    if (rw.isStory) {
      rewardLines.push(rw.story && rw.bossReward
        ? `📜 ${esc(rw.story.title)} — ${esc(rw.story.fightName || '')} vaincu (${rw.story.fightNumber}/${rw.story.fightCount})${rw.story.firstClear ? '' : ', combat rejoué'} : ${rw.bossReward.dust ? '+' + rw.bossReward.dust + ' ✧' : ''}${rw.bossReward.dust && rw.bossReward.credits ? ' · ' : ''}${rw.bossReward.credits ? '+' + rw.bossReward.credits + ' 🪙' : ''}`
        : 'Le boss résiste encore… Retente ta chance !');
    }
    if (rw.isBossFight) {
      rewardLines.push(rw.bossReward
        ? `👹 Boss vaincu : ${rw.bossReward.dust ? '+' + rw.bossReward.dust + ' ✧' : ''}${rw.bossReward.dust && rw.bossReward.credits ? ' · ' : ''}${rw.bossReward.credits ? '+' + rw.bossReward.credits + ' 🪙' : ''}`
        : `Retente ta chance contre le boss demain.`);
    }
    // Le rang est un objet { label, color, ... } : on compare et on affiche son libellé,
    // jamais l'objet lui-même (sinon « [object Object] » et un faux changement de rang
    // à chaque match, puisque deux objets identiques ne sont jamais === ).
    const rankLabelOf = r => (r && typeof r === 'object') ? r.label : r;
    const reportLink = mr.rewards && mr.rewards.deckReportId;
    const rankBeforeLabel = rankLabelOf(mr.rankBefore), rankAfterLabel = rankLabelOf(mr.rankAfter);
    const rankedUp = !!(rankBeforeLabel && rankAfterLabel && rankBeforeLabel !== rankAfterLabel);
    const rankColor = mr.rankAfter && typeof mr.rankAfter === 'object' && mr.rankAfter.color ? mr.rankAfter.color : '';
    // Les animations d'apparition ne se jouent qu'une fois : l'écran est redessiné
    // pendant qu'il est affiché (succès débloqué, notifications…) et sans ça
    // « VICTOIRE » et le panneau réapparaissaient à chaque fois.
    const settled = Date.now() - (mr.shownAt || 0) > 1100;
    out += `<div class="match-result-overlay ${mr.result} ${mr.anim ? 'has-panel' : ''} ${settled ? 'settled' : ''}" style="--mr-el:${Math.max(0, Date.now() - (mr.shownAt || Date.now()))}ms">
      <div class="match-result-text">${label}</div>
      ${rewardLines.length > 0 ? `<div class="match-result-rewards">${rewardLines.map(l => `<div>${l}</div>`).join('')}</div>` : ''}
      ${mr.anim ? `<div class="mr-panel-wrap">${renderResultPanel(mr.anim)}</div>` : ''}
      ${rankedUp ? `<div class="match-result-rank">Nouveau rang : <span style="${rankColor ? 'color:' + esc(rankColor) : ''}">${esc(rankAfterLabel)}</span> !</div>` : ''}
      <div class="match-result-actions">
        ${reportLink ? `<button class="btn ghost match-result-report" onclick="App.openReportAfterMatch('${esc(reportLink)}')">📊 Bilan du deck</button>` : ''}
        ${rw.puzzle && !rw.puzzle.won
          ? `<button class="btn match-result-next" onclick="App.puzzleRetry()">↺ Réessayer</button><button class="btn ghost match-result-quit" onclick="App.dismissMatchResult()">Retour au puzzle</button>`
          : rw.draft && !rw.draft.over
          ? `<button class="btn match-result-next" onclick="App.draftNext()">⚔️ Combat suivant</button><button class="btn ghost match-result-quit" onclick="App.dismissMatchResult()">Retour au Draft</button>`
          : rw.survival && rw.survival.won
          ? `<button class="btn match-result-next" onclick="App.survivalNext()">⚔️ Manche suivante</button><button class="btn ghost match-result-quit" onclick="App.dismissMatchResult()">Pause (retour à la Survie)</button>`
          : `<button class="btn match-result-quit" onclick="App.dismissMatchResult()">Quitter</button>`}
      </div>
    </div>`;
  }
  if (S.achievementToast) {
    out += `<div class="achievement-toast">
      <div class="achievement-toast-icon">${S.achievementToast.icon ? `<img src="${esc(S.achievementToast.icon)}" alt="">` : '🏅'}</div>
      <div><div class="achievement-toast-label">Succès débloqué</div><div class="achievement-toast-name">${esc(S.achievementToast.name)}</div></div>
    </div>`;
  }
  if (S.incomingChallenge) {
    out += `<div class="challenge-toast">
      <h4>Défi reçu !</h4>
      <div style="font-size:13px;color:var(--muted);margin-bottom:12px;"><b style="color:var(--text)">${esc(S.incomingChallenge.fromPseudo)}</b> te défie ${S.incomingChallenge.mode && S.incomingChallenge.mode !== 'normal' ? `en <b style="color:var(--text)">${esc(S.incomingChallenge.modeLabel || '')}</b>` : 'en combat'}.${S.incomingChallenge.mode === 'draft' ? '<br>Chacun joue avec son deck de Draft (ton Draft n\'est pas modifié).' : S.incomingChallenge.mode && S.incomingChallenge.mode !== 'normal' ? '<br>Duel amical : sans points de classement.' : ''}</div>
      <div class="btn-row" style="margin-top:0;">
        <button class="btn small" onclick="App.acceptChallenge()">Accepter</button>
        <button class="btn small ghost" onclick="App.declineChallenge()">Refuser</button>
      </div>
    </div>`;
  } else if (S.challengeNotice) {
    out += `<div class="challenge-toast"><div style="font-size:13.5px;">${esc(S.challengeNotice)}</div></div>`;
  }
  return out;
}

function captureFocus() {
  const app = document.getElementById('app');
  const active = document.activeElement;
  if (active && active.id && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA') && app && app.contains(active)) {
    return { id: active.id, start: active.selectionStart, end: active.selectionEnd };
  }
  return null;
}
function restoreFocus(saved) {
  if (!saved) return;
  const el = document.getElementById(saved.id);
  if (!el) return;
  el.focus();
  if (typeof el.setSelectionRange === 'function' && saved.start != null) {
    try { el.setSelectionRange(saved.start, saved.end); } catch (e) {}
  }
}

/* ---------------- Formulaire de carte : garder la saisie à travers un ré-affichage ----------------
   Certains réglages du formulaire (rareté, type, drop personnalisé,
   parallaxe) changent sa structure et imposent un ré-affichage complet, qui
   reconstruit tous les champs vides. Sans précaution, tout ce qui était déjà
   saisi (nom, coût, description, statistiques, fichiers choisis...) était
   perdu, et il fallait tout recommencer. On relève donc les valeurs de tous
   les champs du formulaire juste avant le ré-affichage, puis on les remet
   dans les champs recréés qui portent le même id. Les champs qui
   n'existent plus (ex. l'attaque d'un serviteur quand on passe à un sort)
   sont simplement ignorés. */
const CARD_FORM_STATE_DRIVEN = ['new-card-parallax']; // cochée d'après l'état, jamais recopiée
function captureCardForm() {
  const panel = document.getElementById('card-form-panel');
  if (!panel) return null;
  const saved = {};
  panel.querySelectorAll('input[id], select[id], textarea[id]').forEach(el => {
    if (CARD_FORM_STATE_DRIVEN.includes(el.id)) return;
    if (el.type === 'file') { if (el.files && el.files.length) saved[el.id] = { files: el.files }; }
    else if (el.type === 'checkbox' || el.type === 'radio') saved[el.id] = { checked: el.checked };
    else saved[el.id] = { value: el.value };
  });
  return saved;
}
function restoreCardForm(saved) {
  if (!saved) return;
  Object.keys(saved).forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    const v = saved[id];
    if (v.files) { try { el.files = v.files; } catch (e) { /* navigateur trop ancien : fichier à re-choisir */ } }
    else if ('checked' in v) el.checked = v.checked;
    else el.value = v.value;
  });
}
function renderKeepingCardForm() {
  const saved = captureCardForm();
  render();
  restoreCardForm(saved);
}

function render() {
  renderCore();
  try { syncChat(); } catch (e) {}
  try { checkNotices(); } catch (e) {}
  try { fitCombat(); } catch (e) {}
  syncWikiFrame();
  updateTurnTimer();
  syncMusic();
  drawTargetArrow();
}
/* ---------- Compteurs animés (crédits, poussière) ----------
   Quand la valeur change, le chiffre défile jusqu'à la nouvelle valeur avec un
   petit éclat (vert si on gagne, rouge si on dépense). Continue d'un rendu à l'autre. */
const COUNTERS = {};
function syncCounters() {
  if (typeof document === 'undefined') return;
  const els = document.querySelectorAll('[data-count]');
  const seen = {};
  els.forEach(el => { const k = el.dataset.count, v = Number(el.dataset.val); if (Number.isFinite(v)) seen[k] = v; });
  Object.keys(seen).forEach(k => {
    const c = COUNTERS[k], to = seen[k];
    if (!c) { COUNTERS[k] = { shown: to, to }; return; }
    if (c.to === to) return;
    c.from = c.shown; c.to = to; c.start = performance.now(); c.dir = to > c.from ? 'up' : 'down';
    if (!c.raf) c.raf = requestAnimationFrame(function tick(now) {
      const k2 = Math.min(1, (now - c.start) / 800), e = 1 - Math.pow(1 - k2, 3);
      c.shown = Math.round(c.from + (c.to - c.from) * e);
      document.querySelectorAll(`[data-count="${k}"]`).forEach(el => { el.textContent = c.shown.toLocaleString('fr-FR'); el.classList.add('count-anim', 'count-' + c.dir); });
      if (k2 < 1) c.raf = requestAnimationFrame(tick);
      else { c.raf = null; setTimeout(() => document.querySelectorAll(`[data-count="${k}"]`).forEach(el => el.classList.remove('count-anim', 'count-up', 'count-down')), 500); }
    });
  });
  // Pendant une animation, un nouveau rendu affiche la valeur intermédiaire (pas un saut)
  els.forEach(el => { const c = COUNTERS[el.dataset.count]; if (c && c.raf) el.textContent = c.shown.toLocaleString('fr-FR'); });
}
function renderCore() {
  const app = document.getElementById('app');
  applyDynamicMediaStyles();
  // On préserve le focus et la position du curseur d'un champ texte à travers le
  // re-rendu complet (celui-ci recrée tous les nœuds du DOM, y compris les champs
  // de saisie, ce qui ferait sinon perdre le focus à chaque frappe).
  const savedFocus = captureFocus();

  if (!S.profile) { app.innerHTML = renderGate(); restoreFocus(savedFocus); return; }

  // Mode plein écran pendant un combat en cours : pas de barre latérale, pas de distraction
  const inMatch = S.tab === 'combat' && S.queueStatus === 'in-match' && S.matchState;
  if (inMatch) {
    const boardOrMulligan = S.matchState.phase === 'mulligan' ? renderMulliganScreen() : renderBoardScreen();
    app.innerHTML = `<div class="fullscreen-combat">${boardOrMulligan}${renderCombatFeed()}</div>${renderFocusMenu()}${renderCardInfoModal()}${renderToasts()}${renderOverlays()}${renderEmoteWheel()}${renderCard3DModal()}${renderBugModal()}`;
    clearInterval(window.__tick);
    restoreFocus(savedFocus);
    // Mesuré après coup, une fois le plateau vraiment dans le DOM : ajuste
    // l'échelle pour que tout tienne sans molette, quelle que soit la taille
    // de la main ou de la fenêtre.
    requestAnimationFrame(fitCombatToViewport);
    return;
  }

  let body = '';
  // Téléphone : on arrive sur l'Accueil mobile
  if (phoneUI() && !S.__homeDone) { S.__homeDone = true; if (S.tab === 'collection') S.tab = 'accueil'; }
  if (S.spectate) body = renderSpectate();
  else if (S.tab === 'accueil') body = phoneUI() ? renderMobileHome() : renderHomePC();
  else if (S.tab === 'collection') body = renderCollection();
  else if (S.tab === 'codex') body = renderCodex();
  else if (S.tab === 'boosters') body = renderBoosters();
  else if (S.tab === 'deck') body = renderDeckBuilder();
  else if (S.tab === 'deckstats') body = renderDeckStats();
  else if (S.tab === 'tournoi') body = renderTournoi();
  else if (S.tab === 'histoire') body = renderStory();
  else if (S.tab === 'options') body = renderOptions();
  else if (S.tab === 'wiki') body = renderWiki();
  else if (S.tab === 'combat') body = renderCombat();
  else if (S.tab === 'survie') body = renderSurvie();
  else if (S.tab === 'draft') body = renderDraft();
  else if (S.tab === 'puzzle') body = renderPuzzle();
  else if (S.tab === 'bagarre') body = renderBrawl();
  else if (S.tab === 'classement') body = renderClassement();
  else if (S.tab === 'poussiere') body = renderPoussiere();
  else if (S.tab === 'boutique') body = renderBoutique();
  else if (S.tab === 'joueurs') body = renderJoueurs();
  else if (S.tab === 'echanges') body = renderEchanges();
  else if (S.tab === 'evenements') body = renderEvenements();
  else if (S.tab === 'achievements') body = renderAchievements();
  else if (S.tab === 'admin') body = renderAdmin();

  const grp = navGroupOf(S.tab);
  if (grp) { S.lastSubTab = S.lastSubTab || {}; S.lastSubTab[grp.key] = S.tab; body = renderSubTabs(grp) + body; }
  if (typeof document !== 'undefined') document.body.classList.toggle('phone-ui', phoneUI());
  app.innerHTML = `${renderSidebar()}<main${pageFadeAttr()}>${body}</main>${phoneUI() ? renderMobileNav() : ''}${renderToasts()}${renderBugModal()}${renderOverlays()}${renderEmoteWheel()}${renderCard3DModal()}${renderDeckImageModal()}${renderAvatarCrop()}`;
  try { syncCounters(); } catch (e) {}
  restoreFocus(savedFocus);

  clearInterval(window.__tick);
  if (S.tab === 'boosters' && !S.packAnim && !S.packStatus.ready) {
    window.__tick = setInterval(async () => {
      const el = document.getElementById('countdown');
      if (!el) { clearInterval(window.__tick); return; }
      S.packStatus.remainingMs -= 1000;
      if (S.packStatus.remainingMs <= 0) { S.packStatus = await api('/api/pack/status'); render(); return; }
      el.textContent = fmtCountdown(S.packStatus.remainingMs);
    }, 1000);
  }
}

boot();

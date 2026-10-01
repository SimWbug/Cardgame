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

async function upload(path, formData) {
  const res = await fetch(path, { method: 'POST', body: formData, credentials: 'same-origin' });
  let data = {};
  try { data = await res.json(); } catch (e) {}
  if (!res.ok) throw new Error(data.error || 'Envoi échoué.');
  return data;
}

function cardById(id) { return S.cardPool.find(c => c.id === id); }

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
  ghost.style.transform = `perspective(700px) rotateY(${tiltY}deg) rotateX(${-8 - lift * 14}deg) scale(${1.05 + lift * 0.18}) translateZ(0)`;

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
const FX_WINDUP = 220, FX_DASH = 130, FX_BACK = 340, FX_STAGGER = 380;
const FX_IMPACT = FX_WINDUP + FX_DASH, FX_TOTAL = FX_WINDUP + FX_DASH + FX_BACK;
let pendingCharge = null; // { attackerId, targetSel, startedAt } — charge lancée au clic, en attente de l'état serveur

function fxReducedMotion() { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }
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

function playCombatFx(anim) {
  if (!anim || typeof document === 'undefined') return;
  const board = document.querySelector('.board-screen.premium');
  if (!board) return;
  const reduce = fxReducedMotion();
  board.style.setProperty('--impact-delay', '0ms');

  // Poussière quand un serviteur arrive sur le plateau
  if (!reduce) anim.enterIds.forEach(id => {
    const el = fxMinionEl(id);
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
  anim.chargeDuration = Math.max(0, longest);

  // Coups sans charge (sorts, effets) : impact immédiat
  document.querySelectorAll('.minion.minion-dying').forEach(el => {
    if (handled.has(el)) return;
    const c = fxCenter(el);
    fxBurst(c.x, c.y, ['#c9b58a', '#8a6d3b', '#fff1c7'], 20, 130, 9);
  });
  if (!pairs.length && (anim.youHeroHit || anim.oppHeroHit)) fxShake(8);
}

/* Données d'une carte de ta main pendant un combat. On les prend dans l'état
   envoyé par le serveur (toujours à jour), et pas dans la liste des cartes
   chargée à l'ouverture de la page : une carte créée ou modifiée dans l'admin
   après ce chargement n'y figurait pas, et le clic/glisser était ignoré sans
   message — d'où le serviteur à 5 mana impossible à poser avec 7 mana. */
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

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

async function boot() {
  try { S.cardPool = (await api('/api/cards')).cards; ArcaneAudio.preloadSounds(S.cardPool); } catch (e) {}
  try { S.config = await api('/api/config'); } catch (e) {}
  try { S.extensions = (await api('/api/extensions')).extensions; } catch (e) {}
  try { S.settings = await api('/api/settings'); } catch (e) {}
  try { S.content = await api('/api/content'); } catch (e) {}
  try { const ev = await api('/api/events'); S.events = ev.events; S.bossAvailableToday = ev.bossAvailableToday; } catch (e) {}
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
  inner.style.transform = 'none';
  const contentHeight = inner.scrollHeight;
  const availableHeight = window.innerHeight - 36; // marge ~= le padding haut+bas de .fullscreen-combat
  const scale = computeCombatFitScale(contentHeight, availableHeight);
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
  connectSocket();
  S.tab = 'collection';
  render();
}

function connectSocket() {
  if (S.socket) S.socket.disconnect();
  S.socket = io();
  S.socket.on('queue:waiting', () => { S.queueStatus = 'waiting'; render(); });
  S.socket.on('queue:error', (p) => { alert(p.error); S.queueStatus = 'idle'; render(); });
  S.socket.on('match:state', async (state) => {
    const wasActive = S.matchState && S.matchState.status === 'active';
    const wasYourTurn = S.matchState && S.matchState.yourTurn;
    const isNewMatch = !S.matchState || S.matchState.id !== state.id;
    // Un défi accepté (ou un match trouvé) ouvre directement le plateau chez les deux joueurs
    if (isNewMatch) { S.matchResultOverlay = null; clearTimeout(window.__matchResultTimer); S.tab = 'combat'; S.viewedPlayer = null; }
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
      const rankBefore = S.profile ? S.profile.rank : null;
      if (state.rewards && state.rewards.achievementsUnlocked) handleUnlockedAchievements(state.rewards.achievementsUnlocked);
      try { S.profile = (await api('/api/me')).profile; } catch (e) {}
      S.matchResultOverlay = {
        result,
        rewards: state.rewards || null,
        rankBefore,
        rankAfter: S.profile ? S.profile.rank : null
      };
      clearTimeout(window.__matchResultTimer);
      // Après 5 s, retour automatique au menu (avant : l'écran de résultat se fermait
      // mais on restait bloqué sur le plateau terminé, sans rien à faire).
      window.__matchResultTimer = setTimeout(() => App.returnToMenuAfterMatch(), 5000);
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
  S.socket.on('challenge:incoming', (ch) => { S.incomingChallenge = ch; render(); });
  S.socket.on('challenge:sent', () => { S.challengeNotice = 'Défi envoyé — en attente de réponse.'; render(); setTimeout(() => { S.challengeNotice = null; render(); }, 4000); });
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
    S.tab = t; S.viewedPlayer = null;
    try {
      if (t === 'joueurs') S.playersList = (await api('/api/players')).players;
      if (t === 'echanges') S.trades = await api('/api/trade');
      if (t === 'deck') {
        if (!S.deckDraft) S.deckDraft = (S.profile.deck || []).slice();
        // Les cartes supprimées dans le panel admin sortent du brouillon de deck
        S.deckDraft = S.deckDraft.filter(id => cardById(id));
        S.savedDecks = (await api('/api/decks')).decks;
      }
      if (t === 'boosters') S.packStatus = await api('/api/pack/status');
      if (t === 'codex') S.codex = await api('/api/codex');
      if (t === 'poussiere') S.duplicates = (await api('/api/dust/duplicates')).duplicates;
      if (t === 'boutique') { S.shop = await api('/api/shop'); S.creditPacks = (await api('/api/credit-packs')).packs; }
      if (t === 'classement') S.leaderboard = await api('/api/leaderboard');
      if (t === 'combat') S.friends = (await api('/api/friends')).friends;
      if (t === 'evenements') {
        const ev = await api('/api/events'); S.events = ev.events; S.bossAvailableToday = ev.bossAvailableToday; S.casinoResult = null;
        try { S.blackjackState = (await api('/api/events/blackjack/state')).state; } catch (e) { S.blackjackState = null; }
      }
      if (t === 'achievements') { const r = await api('/api/achievements'); S.achievements = r.achievements; S.showcaseDraft = r.showcase.slice(); }
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
    const st = S.matchState;
    const wasBoss = !!(st && st.opponent && st.opponent.slug === 'boss');
    App.leaveMatch();
    App.goTab(wasBoss && S.events && S.events.tabEnabled ? 'evenements' : 'combat');
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
    if (row) row.style.display = value === 'buff_ally_and_heal' ? '' : 'none';
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
      S.cardPool = (await api('/api/cards')).cards;
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
    } else if (S.adminCardType === 'weapon') {
      payload.attack = document.getElementById('new-card-attack').value;
      payload.durability = document.getElementById('new-card-durability').value;
      payload.usesPerTurn = document.getElementById('new-card-usesperturn').value;
      payload.battlecryHeal = document.getElementById('new-card-bcheal').value;
    } else {
      payload.effectType = document.getElementById('new-card-effect').value;
      payload.value = document.getElementById('new-card-value').value;
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
      S.cardPool = (await api('/api/cards')).cards;
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
    const img = document.getElementById('new-ext-back');
    if (img.files && img.files[0]) fd.append('backImage', img.files[0]);
    try {
      await upload('/api/admin/extensions', fd);
      S.extensions = (await api('/api/extensions')).extensions;
      document.getElementById('new-ext-name').value = '';
      document.getElementById('new-ext-desc').value = '';
      img.value = '';
      alert('Extension créée !');
    } catch (e) { alert(e.message); }
    render();
  },
  async updateExtensionPrices(extId) {
    const credit = document.getElementById('ext-credit-' + extId).value;
    const dust = document.getElementById('ext-dust-' + extId).value;
    const dropEligible = document.getElementById('ext-drop-' + extId).checked;
    try {
      await fetch('/api/admin/extensions/' + extId, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify({ code: S.adminCodeTry, boosterCreditPrice: credit === '' ? null : credit, boosterDustPrice: dust === '' ? null : dust, matchDropEligible: dropEligible })
      }).then(async r => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || 'Échec.'); });
      S.extensions = (await api('/api/extensions')).extensions;
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
      S.extensions = (await api('/api/extensions')).extensions;
      S.cardPool = (await api('/api/cards')).cards;
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
      S.extensions = (await api('/api/extensions')).extensions;
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
      S.extensions = (await api('/api/extensions')).extensions;
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

  tryAdminLogin() { S.adminCodeTry = document.getElementById('admin-code').value; S.isAdmin = true; render(); },
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
    } else if (S.adminCardType === 'weapon') {
      fd.append('attack', document.getElementById('new-card-attack').value || '1');
      fd.append('durability', document.getElementById('new-card-durability').value || '1');
      fd.append('usesPerTurn', document.getElementById('new-card-usesperturn').value || '1');
      fd.append('battlecryHeal', document.getElementById('new-card-bcheal').value || '0');
    } else {
      const effectType = document.getElementById('new-card-effect').value;
      fd.append('effectType', effectType);
      fd.append('value', document.getElementById('new-card-value').value || '1');
      if (effectType === 'buff_ally_and_heal') {
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
      S.cardPool = (await api('/api/cards')).cards;
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
      S.cardPool = (await api('/api/cards')).cards;
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
      S.cardPool = (await api('/api/cards')).cards;
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
      S.cardPool = (await api('/api/cards')).cards;
    } catch (e) { alert(e.message); }
    render();
  },
  previewSound(url) {
    try {
      const a = new Audio(url); a.volume = 0.7;
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
      S.cardPool = (await api('/api/cards')).cards;
    } catch (e) {}
    render();
  },

  /* ---- Combat ---- */
  joinQueue() {
    if (!S.profile.deck || S.profile.deck.length !== DECK_SIZE) {
      alert(`Configure un deck de ${DECK_SIZE} cartes dans l'onglet Deck avant de combattre.`);
      return;
    }
    S.queueStatus = 'waiting'; S.socket.emit('queue:join'); render();
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
    if (!confirm('Abandonner ce combat ? Ton adversaire remportera la partie.')) return;
    S.socket.emit('action:forfeit');
  },
  challengeFriend(slug) { S.socket.emit('challenge:send', { toSlug: slug }); },
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
    if (card.type === 'minion' || card.type === 'weapon') { S.socket.emit('action:play', { cardId }); return; }
    // Effets sans cible : ils s'appliquent immédiatement
    if (['aoe_damage', 'aoe_heal', 'damage_all', 'buff_all_allies', 'board_wipe'].includes(card.effectType)) {
      if (card.effectType === 'board_wipe' && !confirm('Détruire tous les serviteurs en jeu, y compris les tiens ?')) return;
      S.socket.emit('action:play', { cardId }); return;
    }
    if (card.effectType === 'damage') { S.targetingSpell = { cardId, mode: 'damage' }; render(); return; }
    if (card.effectType === 'heal') { S.targetingSpell = { cardId, mode: 'heal' }; render(); return; }
    if (card.effectType === 'buff_attack' || card.effectType === 'buff_ally_and_heal') { S.targetingSpell = { cardId, mode: 'buff' }; render(); }
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
    cardDrag = {
      cardId, originEl, ghostEl: null,
      startX: e.clientX, startY: e.clientY,
      offsetX: e.clientX - rect.left, offsetY: e.clientY - rect.top,
      w: rect.width, h: rect.height, dragging: false
    };
    window.addEventListener('pointermove', onCardDragMove);
    window.addEventListener('pointerup', onCardDragEnd);
  },

  clickMyMinion(instanceId) {
    const ts = S.targetingSpell;
    if (ts && (ts.mode === 'buff' || ts.mode === 'heal' || ts.mode === 'damage')) {
      S.socket.emit('action:play', { cardId: ts.cardId, targetType: 'minion', targetId: instanceId });
      S.targetingSpell = null; render(); return;
    }
    if (!S.matchState.yourTurn) return;
    const m = S.matchState.you.board.find(x => x.instanceId === instanceId);
    if (!m || m.sickness || !m.canAttack) return;
    S.selectedAttacker = (S.selectedAttacker === instanceId) ? null : instanceId;
    render();
  },

  clickMyHero() {
    const ts = S.targetingSpell;
    if (ts && ts.mode === 'heal') {
      S.socket.emit('action:play', { cardId: ts.cardId, targetType: 'hero' });
      S.targetingSpell = null; render(); return;
    }
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
    if (ts && ts.mode === 'damage') {
      S.socket.emit('action:play', { cardId: ts.cardId, targetType: 'minion', targetId: instanceId });
      S.targetingSpell = null; render(); return;
    }
    if (S.selectedAttacker) {
      const attackerId = S.selectedAttacker;
      S.socket.emit('action:attack', { attackerId, targetType: 'minion', targetId: instanceId });
      S.selectedAttacker = null;
      if (!startOptimisticCharge(attackerId, `.minion[data-iid="${CSS.escape(instanceId)}"]`)) render();
    }
  },

  clickEnemyHero() {
    const ts = S.targetingSpell;
    if (ts && ts.mode === 'damage') {
      S.socket.emit('action:play', { cardId: ts.cardId, targetType: 'hero' });
      S.targetingSpell = null; render(); return;
    }
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
    const card = cardById(cardId);
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

  cancelTargeting() { S.targetingSpell = null; S.selectedAttacker = null; render(); },
  endTurn() { S.socket.emit('action:endTurn'); }
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
  const cardWidth = 172;
  if (count <= 1) return `position:absolute;left:50%;bottom:0;transform-origin:50% 120%;--fan-x:${(-cardWidth / 2).toFixed(1)}px;--fan-y:0px;--fan-angle:0deg;transform:translateX(var(--fan-x)) translateY(var(--fan-y)) rotate(var(--fan-angle));z-index:100;`;
  const mid = (count - 1) / 2;
  const offset = index - mid; // négatif = à gauche du centre, positif = à droite
  const spacing = Math.min(cardWidth * 0.6, 460 / (count - 1));
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
  return `<div class="card-power" style="font-size:${fs}px;">${c.value == null || c.effectType === 'board_wipe' ? '☠' : c.value}</div>`;
}

/* Illustration d'une carte en main : l'image de la carte, ou à défaut un
   fond coloré selon le type avec une icône, pour que la carte garde sa
   forme (cadre + illustration + bandeau de nom) même sans image. */
function handCardArt(c) {
  if (c.image) return `<div class="hand-card-art"><img src="${esc(c.image)}" alt=""></div>`;
  const glyph = c.type === 'minion' ? '⚔' : c.type === 'weapon' ? '🪓' : '✦';
  return `<div class="hand-card-art no-img"><span>${glyph}</span></div>`;
}

function renderCardTile(card, opts) {
  if (!card) return ''; // carte supprimée par un admin : on ne l'affiche pas plutôt que de planter
  opts = opts || {};
  const r = RARITIES[card.rarity] || RARITIES.commun;
  const clickAttr = opts.onClick ? `onclick="${opts.onClick}"` : '';
  const kws = [];
  if (card.taunt) kws.push('Provocation');
  if (card.charge) kws.push('Charge');
  if (card.armor) kws.push(card.armor + ' armure');
  if (card.type === 'weapon' && card.usesPerTurn > 1) kws.push(card.usesPerTurn + '×/tour');
  if (card.battlecryHeal) kws.push((card.type === 'weapon' ? 'Équip. ' : 'Cri : ') + '+' + card.battlecryHeal + ' PV');
  const effectLabels = {
    damage: 'DÉGÂTS', heal: 'SOIN', buff_attack: 'BONUS ATQ',
    aoe_damage: 'DÉGÂTS ZONE (ennemis)', aoe_heal: 'SOIN ZONE (alliés)',
    damage_all: 'DÉGÂTS À TOUS', buff_all_allies: 'BONUS ATQ (équipe)',
    board_wipe: 'DESTRUCTION TOTALE', buff_ally_and_heal: 'BONUS ATQ + SOIN'
  };
  const statLine = card.type === 'minion'
    ? `<div class="minion-stats" style="margin-top:2px;"><span class="atk">${card.attack} ATQ</span><span class="hp">${card.health} PV</span></div>`
    : card.type === 'weapon'
      ? `<div class="minion-stats" style="margin-top:2px;"><span class="atk">${card.attack} ATQ</span><span class="hp weapon-durability">🛡 ${card.durability}</span></div>`
      : card.effectType === 'board_wipe'
        ? `<div class="card-power" style="font-size:13px;">☠ <small>${effectLabels.board_wipe}</small></div>`
        : `<div class="card-power">${card.value}${card.value2 ? ' / +' + card.value2 : ''} <small>${effectLabels[card.effectType] || 'EFFET'}</small></div>`;
  return `
  <div class="card rar-${esc(card.rarity)} ${opts.selected ? 'selected' : ''}" style="--rarity:${r.color}" ${clickAttr}>
    <button class="btn3d-badge" onclick="event.stopPropagation();App.open3DView('${card.id}')" title="Voir en 3D">${icon('icon.view3d', '🧊')}</button>
    <div class="card-cost">${card.cost}</div>
    ${cardArt(card)}
    <div class="card-type">${cardTypeLabel(card.type)}${kws.length ? ' · ' + kws.join(', ') : ''}</div>
    <div class="card-name">${esc(card.name)}</div>
    ${statLine}
    <div class="card-rarity">${r.label}</div>
    ${opts.showDesc !== false ? `<div class="card-desc">${esc(card.desc || '')}</div>` : ''}
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
  collection: { title: () => t('nav.collectionGroup', 'Collection'), tabs: [
    ['deck', () => t('nav.deck', 'Deck')], ['codex', () => t('nav.codex', 'Codex')],
    ['poussiere', () => t('nav.poussiere', 'Désenchantement')], ['achievements', () => t('nav.achievements', 'Succès')]] },
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

function renderSidebar() {
  // Menu regroupé : « Collection » rassemble Deck, Codex, Désenchantement et
  // Succès ; « Social » rassemble Joueurs et Échanges. Les identifiants d'onglet
  // internes ne changent pas (liens, chargements et tests restent valables).
  const items = [
    ['collection', icon('icon.profil', '👤'), t('nav.profil', 'Mon profil')],
    ['group:collection', icon('icon.collectionGroup', '📚'), t('nav.collectionGroup', 'Collection')],
    ['boosters', icon('icon.boosters', '🎁'), t('nav.boosters', 'Boosters')],
    ['combat', icon('icon.combat', '⚔️'), t('nav.combat', 'Combat')],
    ['classement', icon('icon.classement', '🏆'), t('nav.classement', 'Classement')],
    ['boutique', icon('icon.boutique', '🛍️'), t('nav.boutique', 'Boutique')],
    ['group:social', icon('icon.social', '👥'), t('nav.social', 'Social')],
    ...(S.events && S.events.tabEnabled ? [['evenements', icon('icon.evenements', '🎉'), t('nav.evenements', 'Événements')]] : []),
    ['admin', icon('icon.admin', '🛠️'), t('nav.admin', 'Admin')]
  ];
  // Onglets rangés par ordre alphabétique (É trié comme E) ; Admin reste tout en bas
  const adminItem = items.filter(i => i[0] === 'admin');
  const sortedItems = items.filter(i => i[0] !== 'admin').sort((a, b) => String(a[2]).localeCompare(String(b[2]), 'fr', { sensitivity: 'base' })).concat(adminItem);
  items.length = 0; items.push(...sortedItems);
  const pending = (S.trades.received || []).filter(t => t.status === 'pending').length;
  const p = S.profile;
  return `
  <div class="sidebar">
    <div class="brand"><img src="${esc(logoUrl())}" alt="Clean Gang Decks" class="brand-logo"></div>
    ${items.map(([id, ic, label]) => {
      const group = id.startsWith('group:') ? NAV_GROUPS[id.slice(6)] : null;
      const active = group ? group.tabs.some(tb => tb[0] === S.tab) : S.tab === id;
      const target = group ? (group.tabs.some(tb => tb[0] === (S.lastSubTab || {})[id.slice(6)]) ? S.lastSubTab[id.slice(6)] : group.tabs[0][0]) : id;
      const badge = (id === 'group:social') && pending > 0 ? `<span class="badge">${pending}</span>` : '';
      return `
      <button class="nav-btn ${active ? 'active' : ''}" onclick="App.goTab('${target}')">
        <span>${ic}</span> ${label}
        ${badge}
      </button>`;
    }).join('')}
    <div class="sidebar-foot">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
        ${avatarHtml(p.pseudo, p.avatar, p.ornament, 'sm')}
        <div><b style="color:var(--text)">${esc(p.pseudo)}</b><br>${rankPill(p.rank)}</div>
      </div>
      <div class="credits-pill">${icon('icon.credits', '🪙')} ${p.credits} ${t('currency.credits', 'crédits')}</div>
      <div class="dust-pill">${icon('icon.dust', '✧')} ${p.dust} ${t('currency.dust', 'poussière')}</div>
      <span class="logout-link" onclick="App.logout()">${t('btn.logout', 'Se déconnecter')}</span>
    </div>
  </div>`;
}

function renderGate() {
  const mode = S.gateMode || 'login';
  return `
  <div class="gate-screen" style="width:100%;display:flex;align-items:center;justify-content:center;min-height:100vh;">
    <div class="gate">
      <img src="${esc(logoUrl())}" alt="Clean Gang Decks" class="gate-logo">
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
  if (!S.codex) return '<div class="empty">Chargement du codex…</div>';
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
      ${extensions.map(e => `<div class="gate-tab" style="flex:none;padding:9px 16px;${S.codexExt === e.id ? 'background:var(--accent);color:#fff;' : ''}" onclick="App.setCodexExt('${e.id}')">${esc(e.name)} (${e.discoveredCount}/${e.totalCards})</div>`).join('')}
    </div>
    ${activeExt ? `
    <div class="panel" style="margin-top:16px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
        <b>${esc(activeExt.name)}</b><span style="color:var(--accent);font-weight:700;">${activeExt.percent}%</span>
      </div>
      <div class="rank-bar"><div class="rank-bar-fill" style="width:${activeExt.percent}%"></div></div>
    </div>
    <div class="grid">
      ${activeExt.cards.map(c => c.discovered
        ? renderCardTile(c, { count: c.owned, showDesc: false, footer: c.owned === 0 ? '<div class="tone-tag" style="text-align:center;">Obtenue puis quittée</div>' : '' })
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
  return `
    <h1 class="page-title">${t('title.profil', 'Mon profil')}</h1>
    <div class="panel">
      <div style="display:flex;align-items:center;gap:18px;flex-wrap:wrap;">
        ${avatarHtml(p.pseudo, p.avatar, p.ornament)}
        <div style="flex:1;min-width:220px;">
          <div style="font-weight:700;font-size:17px;">${esc(p.pseudo)} ${rankPill(p.rank)}</div>
          <div style="color:var(--muted);font-size:13px;margin-top:4px;">
            ${p.seasonVP} points · ${p.seasonWins} victoires · ${p.seasonLosses} défaites cette saison
          </div>
          ${renderBioEditor(p)}
          <div class="rank-bar"><div class="rank-bar-fill" style="width:${progress}%"></div></div>
          <div style="color:var(--muted);font-size:12px;margin-top:5px;">
            ${next ? `Encore ${next.min - p.seasonVP} points pour atteindre ${next.label}.` : 'Rang maximum atteint.'}
          </div>
        </div>
        <div>
          <label>Changer d'avatar</label>
          <input type="file" accept="image/*" class="file-input" onchange="App.uploadAvatar(this)">
        </div>
      </div>
    </div>
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
    ${renderCardShowcaseEditor(owned)}
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
            <div class="pack-flip-front rar-${esc(card.rarity)}">
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
    <div class="panel">
      <h3 style="text-align:center;margin-top:0;">Cartes obtenues</h3>
      <div class="grid">${S.lastDrawn.map(c => renderCardTile(c, { showDesc: false })).join('')}</div>
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

function renderBoutique() {
  if (!S.shop) return '<div class="empty">Chargement de la boutique…</div>';
  const { ornaments, owned, equipped, dust, credits, emotes, ownedEmotes, boosters } = S.shop;
  const tab = S.shopTab || 'ornaments';
  const header = `
    <h1 class="page-title">${t('title.boutique', 'Boutique')}</h1>
    <p class="page-sub">${t('sub.boutique', "Personnalise ton avatar, tes provocations, et achète des boosters supplémentaires.")}</p>
    <div class="panel" style="display:flex;gap:12px;flex-wrap:wrap;">
      <span class="credits-pill" style="margin-top:0;">🪙 ${credits} crédits</span>
      <span class="dust-pill" style="margin-top:0;">✧ ${dust} poussière</span>
    </div>
    <div class="shop-tabs" style="max-width:460px;">
      <div class="shop-tab ${tab === 'ornaments' ? 'active' : ''}" onclick="App.setShopTab('ornaments')">Ornements</div>
      <div class="shop-tab ${tab === 'emotes' ? 'active' : ''}" onclick="App.setShopTab('emotes')">Provocations</div>
      <div class="shop-tab ${tab === 'boosters' ? 'active' : ''}" onclick="App.setShopTab('boosters')">Boosters</div>
      <div class="shop-tab ${tab === 'creditpacks' ? 'active' : ''}" onclick="App.setShopTab('creditpacks')">Crédits</div>
    </div>`;

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
      ${ornaments.map(o => {
        const isOwned = owned.includes(o.id);
        const isEquipped = equipped === o.id;
        return `<div class="shop-item ${isEquipped ? 'equipped' : ''}">
          ${avatarHtml(S.profile.pseudo, S.profile.avatar, o.id)}
          <div class="shop-name">${esc(o.name)}</div>
          <div class="shop-desc">${esc(o.desc)}</div>
          ${o.price > 0 ? `<div class="shop-price">✧ ${o.price}</div>` : '<div class="shop-price">Gratuit</div>'}
          ${isEquipped ? '<button class="btn small ghost" disabled>Équipé</button>' :
            isOwned ? `<button class="btn small" onclick="App.equipOrnament('${o.id}')">Équiper</button>` :
            `<button class="btn small" ${dust < o.price ? 'disabled' : ''} onclick="App.buyOrnament('${o.id}')">Acheter</button>`}
        </div>`;
      }).join('')}
    </div>`;
}

function renderClassement() {
  if (!S.leaderboard) return '<div class="empty">Chargement du classement…</div>';
  const { season, leaderboard, myPosition, rewards, history } = S.leaderboard;
  return `
    <h1 class="page-title">${t('title.classement', 'Classement mensuel')} — saison ${esc(season)}</h1>
    <p class="page-sub">Chaque victoire rapporte entre +10 et +29 points de victoire (tirage aléatoire). Le classement est remis à zéro chaque mois : le 1er reçoit ${rewards[0]} ✧, le 2e ${rewards[1]} ✧, le 3e ${rewards[2]} ✧.</p>
    ${myPosition ? `<div class="panel">Tu es actuellement <b>${myPosition}e</b> avec ${S.profile.seasonVP} points.</div>` : ''}
    ${leaderboard.length === 0 ? '<div class="empty">Aucune partie jouée cette saison.</div>' :
      leaderboard.map((e, i) => `
      <div class="lb-row ${e.slug === S.profile.slug ? 'me' : ''} p${i + 1}">
        <div class="lb-pos">${i + 1}</div>
        ${avatarHtml(e.pseudo, e.avatar, e.ornament, 'sm')}
        <div class="lb-name">${esc(e.pseudo)} ${rankPill(e.rank)}</div>
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

function renderDeckBuilder() {
  const draft = S.deckDraft || [];
  const counts = {};
  draft.forEach(id => { counts[id] = (counts[id] || 0) + 1; });
  const owned = ownedCardsList(S.profile.collection);
  const decks = S.savedDecks || [];
  return `
    <h1 class="page-title">${t('title.deck', 'Deck')} (${draft.length}/${DECK_SIZE})</h1>
    <p class="page-sub">${t('sub.deck', `Un deck de ${DECK_SIZE} cartes est requis pour combattre. Maximum 2 exemplaires par carte (1 pour les légendaires).`)}</p>
    <div class="panel">
      <h3 style="margin-top:0;">Mes decks (${decks.length}/12)</h3>
      ${decks.length === 0 ? '<div class="empty">Aucun deck enregistré pour l\'instant — construis un deck ci-dessous puis clique sur "Enregistrer sous...".</div>' :
        decks.map(d => {
          const isActive = d.id === S.profile.activeDeckId;
          return `<div class="row-card">
            <div class="info"><b>${esc(d.name)}</b> ${isActive ? '<span class="tag done">actif</span>' : ''}</div>
            <button class="btn small ${isActive ? 'ghost' : ''}" ${isActive ? 'disabled' : ''} onclick="App.activateSavedDeck('${d.id}')">Activer</button>
            <button class="btn small ghost" onclick="App.renameSavedDeck('${d.id}', ${JSON.stringify(d.name)})">Renommer</button>
            <button class="btn small danger" onclick="App.deleteSavedDeck('${d.id}', ${JSON.stringify(d.name)})">Supprimer</button>
          </div>`;
        }).join('')}
      <div class="btn-row"><button class="btn ghost small" onclick="App.saveDeckAs()">💾 Enregistrer le deck en cours sous un nom…</button></div>
    </div>
    <div class="panel">
      <div class="btn-row" style="margin-top:0;">
        <button class="btn" ${draft.length !== DECK_SIZE ? 'disabled' : ''} onclick="App.saveDeck()">Enregistrer comme deck actif</button>
        <button class="btn ghost" onclick="App.autoFillDeck()">Remplissage automatique</button>
      </div>
    </div>
    <h3>Deck en cours</h3>
    ${Object.keys(counts).length === 0 ? '<div class="empty">Clique sur des cartes de ta collection pour les ajouter.</div>' :
      `<div class="grid">${Object.keys(counts).filter(id => cardById(id)).map(id => renderCardTile(cardById(id), { count: counts[id], showDesc: false, onClick: `App.removeFromDeck('${id}')` })).join('')}</div>`}
    <h3>Ta collection</h3>
    ${owned.length === 0 ? '<div class="empty">Ouvre des boosters pour obtenir des cartes.</div>' :
      `<div class="grid">${owned.map(x => renderCardTile(x.card, { count: x.count, onClick: `App.addToDeck('${x.card.id}')` })).join('')}</div>`}
  `;
}

function renderCombat() {
  if (S.queueStatus === 'in-match' && S.matchState) return renderBoardScreen();

  const friends = S.friends || [];
  if (S.queueStatus === 'waiting') {
    return `<h1 class="page-title">Combat</h1>
    <div class="panel" style="text-align:center;">
      <div style="font-size:15px;font-weight:700;color:var(--accent);">Recherche d'un adversaire…</div>
      <p class="page-sub" style="margin:10px auto 0;">Ouvre le jeu dans une autre fenêtre (ou demande à un ami) pour te matcher.</p>
      <button class="btn ghost" onclick="App.leaveQueue()">Annuler</button>
    </div>`;
  }
  return `<h1 class="page-title">Combat</h1>
    <p class="page-sub">${t('sub.combat', "Affronte un joueur au hasard, ou défie directement un ami connecté. Chaque victoire rapporte entre +10 et +29 points de classement et 20 ✧.")}</p>
    <div class="panel" style="text-align:center;">
      <button class="btn" onclick="App.joinQueue()">Rechercher un adversaire</button>
    </div>
    <div class="panel">
      <h3 style="margin-top:0;">Défier un ami</h3>
      ${friends.length === 0 ? '<div class="empty">Ajoute des amis dans Social → Joueurs pour pouvoir les défier.</div>' :
        `<div class="player-list">${friends.map(f => `
          <div class="player-row">
            <div style="display:flex;align-items:center;gap:10px;">
              ${avatarHtml(f.pseudo, f.avatar, f.ornament, 'sm')}
              <div><b>${esc(f.pseudo)}</b> ${rankPill(f.rank)}<br>
                <span style="font-size:12px;color:var(--muted);"><span class="online-dot ${f.online ? 'on' : ''}"></span>${f.online ? 'en ligne' : 'hors ligne'}</span>
              </div>
            </div>
            <button class="btn small" ${f.online ? '' : 'disabled'} onclick="App.challengeFriend('${f.slug}')">Défier</button>
          </div>`).join('')}</div>`}
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
            <div class="hand-card rar-${esc(c.rarity)} type-${esc(c.type)}">
              <div class="card-cost">${c.cost}</div>
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
  const iWon = finished && st.winner === st.you.slug;
  const draw = finished && st.winner === null;

  let helper = '';
  if (!finished) {
    if (!st.yourTurn) helper = "Tour de l'adversaire…";
    else if (S.targetingSpell) {
      helper = S.targetingSpell.mode === 'damage' ? 'Choisis une cible pour ce sort de dégâts.'
        : S.targetingSpell.mode === 'heal' ? 'Choisis une cible amie à soigner (ton héros ou un de tes serviteurs).'
        : 'Choisis un de tes serviteurs à renforcer.';
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
    if (dying) cls.push('minion-dying');
    else if (anim.enterIds.has(m.instanceId)) cls.push('minion-enter');
    if (anim.hitIds.has(m.instanceId)) cls.push('minion-hit');
    if (anim.healIds.has(m.instanceId)) cls.push('minion-healed');
    if (anim.attackedIds.has(m.instanceId)) cls.push(mine ? 'minion-attack-fwd' : 'minion-attack-back');
    if (mine && !dying) {
      if (!m.sickness && m.canAttack && st.yourTurn) cls.push('can-attack');
      if (m.sickness) cls.push('sick');
      // A déjà attaqué ce tour-ci : une croix apparaît au survol
      if (!m.sickness && !m.canAttack && st.yourTurn) cls.push('exhausted');
      if (S.selectedAttacker === m.instanceId) cls.push('selected');
      if (S.targetingSpell && (S.targetingSpell.mode === 'buff' || S.targetingSpell.mode === 'heal' || S.targetingSpell.mode === 'damage')) cls.push('targetable');
    } else if (!dying) {
      if (S.selectedAttacker || (S.targetingSpell && S.targetingSpell.mode === 'damage')) cls.push('targetable');
    }
    const click = dying ? '' : (mine ? `App.clickMyMinion('${m.instanceId}')` : `App.clickEnemyMinion('${m.instanceId}')`);
    const fxTip = cardEffectSummary(Object.assign({}, m, { type: 'minion' }));
    const tip = (cls.includes('exhausted') ? `${m.name} — a déjà attaqué ce tour-ci` : (mine && m.sickness && !dying ? `${m.name} — vient d'arriver, pourra attaquer au prochain tour` : m.name))
      + (fxTip ? `\n${fxTip}` : '') + (m.armor ? `\nArmure restante : ${m.armor}` : '');
    return `<div class="${cls.join(' ')}" data-iid="${esc(m.instanceId)}" title="${esc(tip)}" onclick="${click}">
      <div class="minion-portrait-wrap">
        ${m.taunt ? '<div class="taunt-shield" title="Provocation"><svg viewBox="0 0 24 24"><path d="M12 1.5 4 4.5v6c0 5.2 3.4 9.6 8 11 4.6-1.4 8-5.8 8-11v-6L12 1.5z"/></svg></div>' : ''}
        <div class="minion-portrait">
          ${m.image ? `<img src="${esc(m.image)}" alt="">` : `<span class="minion-portrait-fallback">${esc((m.name || '?').slice(0, 1))}</span>`}
        </div>
        ${m.taunt ? '<div class="taunt-ring"></div>' : ''}
      </div>
      <div class="minion-name">${esc(m.name)}</div>
      <div class="atk-gem">${m.attack}</div>
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
        ${!finished ? `<button class="btn ghost small" onclick="App.forfeitMatch()">Abandonner</button>` : ''}
      </div>
      ${finished ? `<div class="result-banner ${draw ? '' : (iWon ? 'win' : 'lose')}">
        ${draw ? 'Égalité !' : (iWon ? 'Victoire !' : 'Défaite.')}
        ${st.rewards && st.rewards.won && !st.rewards.isBot ? ` +${st.rewards.vpGain} points de classement · +20 ✧` : ''}
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
          <div class="hero-name">${esc(st.opponent.pseudo)}</div>
          <div class="hero-sub">${st.opponent.handCount} en main · ${st.opponent.libraryCount} en pioche</div>
        </div>
        <div class="hero-center">
          ${weaponBadge(st.opponent.weapon)}
          <div class="hero-portrait-wrap ${anim.oppHeroAttacked ? 'hero-attack-back' : ''}" data-hero="opp" onclick="App.clickEnemyHero()">
            ${S.activeEmotes[st.opponent.slug] ? `<div class="emote-bubble from-opp">${esc(S.activeEmotes[st.opponent.slug].text)}</div>` : ''}
            ${st.opponent.slug === 'boss' && S.bossDialogueActive ? `<div class="emote-bubble from-opp boss-dialogue">${esc(S.bossDialogueActive)}</div>` : ''}
            ${avatarHtml(st.opponent.pseudo, st.opponent.avatar, st.opponent.ornament, '', oppTargetable ? 'targetable' : '')}
            <div class="hp-gem ${anim.oppHeroHit ? 'pulse' : ''}">${st.opponent.heroHealth}</div>
            ${floatersFor('opp-hero')}
          </div>
        </div>
        <div class="hero-mana">${manaCrystals(st.opponent.mana, st.opponent.maxMana)}<span class="mana-count">${st.opponent.mana}/${st.opponent.maxMana}</span></div>
      </div>

      <div class="arena-table">
        <div class="board-row">${st.opponent.board.length === 0 && oppDying.length === 0 ? '<span class="empty board-empty">Plateau adverse vide</span>' : st.opponent.board.map(m => minionTile(m, false, false)).join('') + oppDying.map(m => minionTile(m, false, true)).join('')}</div>

        <div class="board-divider"><span class="helper-text">${S.matchError ? `<span style="color:var(--bad);">${esc(S.matchError)}</span>` : esc(helper)}</span>
        ${(S.targetingSpell || S.selectedAttacker) ? `<button class="btn ghost small" onclick="App.cancelTargeting()">Annuler la sélection</button>` : ''}</div>

        <div class="board-row mine">${st.you.board.length === 0 && youDying.length === 0 ? '<span class="empty board-empty">Glisse une carte ici pour la jouer</span>' : st.you.board.map(m => minionTile(m, true, false)).join('') + youDying.map(m => minionTile(m, true, true)).join('')}</div>

        <button class="end-turn-wheel ${(!st.yourTurn || finished) ? 'disabled' : ''}" ${(!st.yourTurn || finished) ? 'disabled' : ''} onclick="App.endTurn()">
          <span>${st.yourTurn ? t('combat.endTurnReady', 'Fin du tour') : t('combat.endTurnWaiting', 'Tour adverse')}</span>
        </button>
      </div>

      <div class="hero-row ${anim.youHeroHit ? 'hero-hit' : ''} ${anim.youHeroHeal ? 'hero-heal' : ''}">
        <div class="hero-info">
          <div class="hero-name">${esc(st.you.pseudo)} (toi)</div>
          <div class="hero-sub">${st.you.libraryCount} cartes en pioche</div>
        </div>
        <div class="hero-center">
          ${weaponBadge(st.you.weapon)}
          <div class="hero-portrait-wrap ${S.selectedAttacker === 'hero' ? 'selected' : ''} ${myWeaponUsable ? 'weapon-ready' : ''} ${st.yourTurn && st.you.weapon && st.you.weapon.usesThisTurn >= st.you.weapon.usesPerTurn ? 'exhausted' : ''} ${anim.youHeroAttacked ? 'hero-attack-fwd' : ''}" data-hero="you" onclick="App.clickMyHero()" title="${myWeaponUsable ? 'Clique pour attaquer avec ton arme' : 'Clique pour envoyer une provocation'}">
            ${S.activeEmotes[st.you.slug] ? `<div class="emote-bubble from-me">${esc(S.activeEmotes[st.you.slug].text)}</div>` : ''}
            ${avatarHtml(st.you.pseudo, st.you.avatar, st.you.ornament, '', (myHeroTargetable ? 'targetable ' : '') + (finished ? '' : 'emote-ready'))}
            ${finished ? `<span class="emote-hint" onclick="event.stopPropagation();App.openEmoteWheel()">💬</span>` : ''}
            <div class="hp-gem ${anim.youHeroHit ? 'pulse' : ''}">${st.you.heroHealth}</div>
            ${floatersFor('you-hero')}
          </div>
        </div>
        <div class="hero-mana">${manaCrystals(st.you.mana, st.you.maxMana)}<span class="mana-count">${st.you.mana}/${st.you.maxMana}</span></div>
      </div>

      <div class="hand-row hand-fan">
        ${st.you.hand.map((c, i) => {
          const affordable = c.cost <= st.you.mana && st.yourTurn && !finished;
          const statLine = handStatLine(c, 15);
          return `<div class="hand-card rar-${esc(c.rarity)} type-${esc(c.type)} ${affordable ? '' : 'unaffordable'}" style="${handFanStyle(i, st.you.hand.length)}" ${affordable ? `onpointerdown="App.startCardDrag(event,'${c.id}')"` : ''}>
            <div class="card-cost">${c.cost}</div>
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
function feedThumb(ref) {
  if (!ref) return '';
  const rc = (RARITIES[ref.rarity] || {}).color || 'var(--line)';
  const img = ref.image && /^(\/|https?:)/.test(ref.image) ? ref.image : null;
  const initials = esc(String(ref.name || '?').trim().slice(0, 2).toUpperCase());
  return `<span class="feed-thumb ${ref.kind === 'hero' ? 'hero' : ''}" style="--rc:${rc}" title="${esc(ref.name || '')}">${img ? `<img src="${esc(img)}" alt="">` : `<b>${initials}</b>`}</span>`;
}
function feedBadge(amount, kind, died) {
  const cls = kind === 'heal' ? 'heal' : kind === 'buff' ? 'buff' : 'dmg';
  const txt = kind === 'heal' ? '+' + amount : kind === 'buff' ? '+' + amount + ' ATQ' : '-' + amount;
  return `${amount > 0 || kind !== 'dmg' ? `<span class="feed-badge ${cls}">${txt}</span>` : ''}${died ? '<span class="feed-skull" title="Détruit">💀</span>' : ''}`;
}
function feedWho(slug) {
  const st = S.matchState;
  if (!st) return '';
  return slug === st.you.slug ? 'Tu' : esc(st.opponent.pseudo);
}
function feedSentence(e) {
  const who = e.by === (S.matchState && S.matchState.you.slug) ? 'Tu' : (S.matchState ? S.matchState.opponent.pseudo : '');
  const tn = t => (t || []).map(x => `${x.name}${x.amount ? ` (${x.amount})` : ''}${x.died ? ' ☠' : ''}`).join(', ');
  switch (e.type) {
    case 'play': return `${who} ${who === 'Tu' ? 'joues' : 'joue'} ${e.card.name} (${cardTypeLabel(e.card.type)})`;
    case 'attack': return `${e.attacker.weapon ? e.attacker.name + ' (' + e.attacker.weapon + ')' : e.attacker.name} attaque ${e.target.name} : ${e.dmg} dégât(s)${e.back ? `, riposte ${e.back}` : ''}${e.targetDied ? `, ${e.target.name} est détruit` : ''}${e.attackerDied ? `, ${e.attacker.name} est détruit` : ''}`;
    case 'damage': return `${e.source.name} inflige des dégâts : ${tn(e.targets)}`;
    case 'heal': return `${e.source.name} soigne : ${tn(e.targets)}`;
    case 'buff': return `${e.source.name} renforce : ${tn(e.targets)}`;
    case 'destroy': return `${e.source.name} détruit tous les serviteurs`;
    case 'break': return `${e.name} se brise`;
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
  if (e.type === 'break') return wrap(`<span class="feed-arrow">🪓</span><div class="feed-text"><b>${esc(e.name)}</b> se brise</div>`);
  return '';
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
      <div style="display:flex;align-items:center;gap:16px;margin-bottom:8px;">
        ${avatarHtml(p.pseudo, p.avatar, p.ornament)}
        <div>
          <h1 class="page-title" style="margin:0;">${esc(p.pseudo)}</h1>
          <div style="margin-top:6px;">${rankPill(p.rank)} <span style="color:var(--muted);font-size:13px;margin-left:8px;">${p.seasonVP} pts · ${p.seasonWins}V / ${p.seasonLosses}D</span></div>
          ${p.bio ? `<p class="profile-bio">${esc(p.bio)}</p>` : ''}
        </div>
      </div>
      ${renderCardShowcaseView(p.cardShowcase)}
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
  board_wipe: 'Destruction totale', buff_ally_and_heal: 'Bonus ATQ + soin'
};
// Les sorts sont enregistrés avec le type « sort » : tout ce qui n'est ni serviteur ni arme est un sort
const isSpellCard = c => c.type !== 'minion' && c.type !== 'weapon';
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
  return `<div class="${cls}">${parts.length ? `<b class="card-fx">${esc(parts.join(' · '))}.</b>` : ''}${parts.length && desc ? ' ' : ''}${desc ? `<span class="card-flavor">${esc(desc)}</span>` : ''}</div>`;
}

function cardEffectSummary(c) {
  const parts = [];
  if (isSpellCard(c)) {
    const v = c.value, v2 = c.value2;
    const txt = {
      damage: `Inflige ${v} dégâts à une cible`, heal: `Rend ${v} PV à une cible`, buff_attack: `Donne +${v} ATQ à un de tes serviteurs`,
      aoe_damage: `Inflige ${v} dégâts à tous les serviteurs adverses`, aoe_heal: `Rend ${v} PV à ton héros et à tous tes serviteurs`,
      damage_all: `Inflige ${v} dégâts à tous les serviteurs des deux camps`, buff_all_allies: `Donne +${v} ATQ à tous tes serviteurs`,
      board_wipe: 'Détruit tous les serviteurs des deux camps', buff_ally_and_heal: `Donne +${v} ATQ à un de tes serviteurs et rend ${v2 || 0} PV à ton héros`
    }[c.effectType];
    parts.push(txt || `${EXPORT_EFFECT_LABELS[c.effectType] || c.effectType || 'Effet'}${v != null ? ' ' + v : ''}`);
  }
  if (c.taunt) parts.push('Provocation');
  if (c.charge) parts.push('Charge');
  if (c.armor) parts.push(`${c.armor} armure`);
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
    <input type="text" id="admin-code" placeholder="Code admin" />
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
  if (!st) return `<h1 class="page-title">Admin — Stats</h1>${renderAdminTabs()}<div class="panel"><div class="empty">Chargement des statistiques…</div></div>`;
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

function renderAdminTabs() {
  const tabs = [['cards', 'Cartes'], ['extensions', 'Extensions'], ['ornaments', 'Ornements'], ['emotes', 'Provocations'], ['content', 'Contenu'], ['events', 'Événements'], ['achievements', 'Succès'], ['users', 'Comptes'], ['stats', 'Stats']];
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
            ${extensions.map(e => `<option value="${e.id}" ${(editingCard ? editingCard.extensionId : 'base') === e.id ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}
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
        <div><label>Armure <span class="tone-tag">absorbe les dégâts avant les PV</span></label><input type="number" id="new-card-armor" placeholder="0" min="0" value="${editingCard ? (editingCard.armor || 0) : ''}" /></div>
        <div><label>Soin au cri de guerre <span class="tone-tag">en jouant la carte</span></label><input type="number" id="new-card-bcheal" placeholder="0" value="${editingCard ? (editingCard.battlecryHeal || 0) : ''}" /></div>
      </div>
      <div class="field-row" style="margin-bottom:14px;">
        <div><label><input type="checkbox" id="new-card-taunt" style="width:auto;margin-right:6px;" ${editingCard && editingCard.taunt ? 'checked' : ''}> Provocation</label></div>
        <div><label><input type="checkbox" id="new-card-charge" style="width:auto;margin-right:6px;" ${editingCard && editingCard.charge ? 'checked' : ''}> Charge</label></div>
      </div>` : isWeapon ? `
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
            ['board_wipe', 'Détruit tous les serviteurs en jeu'], ['buff_ally_and_heal', "Bonus d'attaque à un allié + soin du héros"]
          ].map(([v, label]) => `<option value="${v}" ${selectedSpellEffect === v ? 'selected' : ''}>${label}</option>`).join('')}
        </select></div>
        <div><label>Valeur principale</label><input type="number" id="new-card-value" placeholder="Ex : 4" value="${editingCard ? (editingCard.value != null ? editingCard.value : '') : ''}" /></div>
      </div>
      <div class="field-row" id="new-card-value2-row" style="${selectedSpellEffect === 'buff_ally_and_heal' ? '' : 'display:none;'}">
        <div><label>Soin du héros (pour l'effet combiné uniquement)</label><input type="number" id="new-card-value2" placeholder="Ex : 5" value="${editingCard && editingCard.value2 != null ? editingCard.value2 : ''}" /></div>
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
    <div class="grid">
      ${S.cardPool.map(c => {
        const pct = estimatedDropPercent(c.rarity, c.dropWeight || 1, S.cardPool.filter(x => x.id !== c.id));
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
        <button class="btn danger" style="position:absolute;top:8px;left:8px;padding:4px 8px;font-size:11px;z-index:2;" onclick="App.deleteCard('${c.id}')">✕</button>
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
      <h3 style="margin-top:0;">Booster bonus en fin de match</h3>
      <p class="page-sub" style="margin-bottom:14px;">Chance qu'un joueur reçoive un booster gratuit en gagnant un combat (jamais contre le bot). Le booster est tiré au hasard parmi les extensions cochées « éligible » ci-dessous.</p>
      <div class="field-row">
        <div style="max-width:200px;"><label>Probabilité (%)</label><input type="number" id="match-drop-chance" min="0" max="100" step="0.1" value="${dropChance}"></div>
      </div>
      <div class="btn-row" style="margin-top:0;"><button class="btn small" onclick="App.updateMatchDropChance()">Enregistrer</button></div>
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
            <h3 style="margin:0 0 4px;">${esc(e.name)} ${e.id === 'base' ? '<span class="tag">par défaut</span>' : ''} ${e.matchDropEligible ? '<span class="tag done">éligible au drop</span>' : ''}</h3>
            <p style="color:var(--muted);font-size:13px;margin:0 0 10px;">${esc(e.description || '')}</p>
            <div class="field-row">
              <div><label>Prix crédits</label><input type="number" id="ext-credit-${e.id}" value="${e.boosterCreditPrice != null ? e.boosterCreditPrice : ''}" placeholder="Non vendu"></div>
              <div><label>Prix poussière</label><input type="number" id="ext-dust-${e.id}" value="${e.boosterDustPrice != null ? e.boosterDustPrice : ''}" placeholder="Non vendu"></div>
            </div>
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin-bottom:10px;">
              <input type="checkbox" id="ext-drop-${e.id}" style="width:auto;" ${e.matchDropEligible ? 'checked' : ''}> Éligible au booster bonus de fin de match
            </label>
            <div class="btn-row" style="margin-top:0;">
              <button class="btn small" onclick="App.updateExtensionPrices('${e.id}')">Mettre à jour les prix et l'éligibilité</button>
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
          <button class="btn small danger" onclick="App.deleteCreditPack('${p.id}', ${JSON.stringify(p.name)})">Supprimer</button>
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
  ['turnStart', 'Début de tour'], ['victory', 'Victoire'], ['defeat', 'Défaite'], ['cardPlayDefault', 'Pose de carte (sans son personnalisé sur la carte elle-même)']
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
        <div class="btn-row" style="margin-top:0;"><button class="btn small" onclick="App.saveContentStrings(${JSON.stringify(group.keys.map(k => k[0]))})">Enregistrer</button></div>
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
              <button class="btn small danger" onclick="App.deleteAchievement('${a.id}', ${JSON.stringify(a.name)})">Supprimer</button>
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
            <button class="btn small danger" onclick="App.adminRemoveCard('${esc(u.slug)}', '${esc(x.card.id)}', 'all', ${JSON.stringify(x.card.name).replace(/"/g, '&quot;')})" title="Retirer toutes les copies">Retirer</button>
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
    ${!S.adminUsers ? '<div class="empty">Chargement…</div>' : users.length === 0 ? '<div class="empty">Aucun compte trouvé.</div>' :
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
            <button class="btn small ghost" onclick="App.resetUserPassword('${u.slug}', ${JSON.stringify(u.pseudo)})">Réinitialiser le mot de passe</button>
            <button class="btn small ghost" onclick="App.grantStarterDeck('${u.slug}', ${JSON.stringify(u.pseudo)})">Offrir un deck de départ</button>
            <input type="number" id="credits-delta-${u.slug}" placeholder="± crédits 🪙" class="dust-delta-input">
            <button class="btn small" onclick="App.adjustUserCreditsCustom('${u.slug}')">Appliquer</button>
            <input type="number" id="dust-delta-${u.slug}" placeholder="± poussière ✧" class="dust-delta-input">
            <button class="btn small" onclick="App.adjustUserDustCustom('${u.slug}')">Appliquer</button>
            <button class="btn small danger" onclick="App.deleteUserAccount('${u.slug}', ${JSON.stringify(u.pseudo)})">Supprimer</button>
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
  return renderAdminCards();
}

function renderOverlays() {
  let out = '';
  if (S.matchResultOverlay) {
    const mr = S.matchResultOverlay;
    const label = mr.result === 'win' ? 'VICTOIRE' : mr.result === 'lose' ? 'DÉFAITE' : 'ÉGALITÉ';
    const rw = mr.rewards || {};
    const rewardLines = [];
    if (rw.won && !rw.isBot) rewardLines.push(`+${rw.vpGain || 0} points de classement · +20 ✧`);
    if (rw.bonusBooster) rewardLines.push(`🎁 Booster bonus « ${esc(rw.bonusBooster.extensionName)} » obtenu !`);
    if (rw.isBossFight) {
      rewardLines.push(rw.bossReward
        ? `👹 Boss vaincu : ${rw.bossReward.dust ? '+' + rw.bossReward.dust + ' ✧' : ''}${rw.bossReward.dust && rw.bossReward.credits ? ' · ' : ''}${rw.bossReward.credits ? '+' + rw.bossReward.credits + ' 🪙' : ''}`
        : `Retente ta chance contre le boss demain.`);
    }
    // Le rang est un objet { label, color, ... } : on compare et on affiche son libellé,
    // jamais l'objet lui-même (sinon « [object Object] » et un faux changement de rang
    // à chaque match, puisque deux objets identiques ne sont jamais === ).
    const rankLabelOf = r => (r && typeof r === 'object') ? r.label : r;
    const rankBeforeLabel = rankLabelOf(mr.rankBefore), rankAfterLabel = rankLabelOf(mr.rankAfter);
    const rankedUp = !!(rankBeforeLabel && rankAfterLabel && rankBeforeLabel !== rankAfterLabel);
    const rankColor = mr.rankAfter && typeof mr.rankAfter === 'object' && mr.rankAfter.color ? mr.rankAfter.color : '';
    out += `<div class="match-result-overlay ${mr.result}">
      <div class="match-result-text">${label}</div>
      ${rewardLines.length > 0 ? `<div class="match-result-rewards">${rewardLines.map(l => `<div>${l}</div>`).join('')}</div>` : ''}
      ${rankedUp ? `<div class="match-result-rank">Nouveau rang : <span style="${rankColor ? 'color:' + esc(rankColor) : ''}">${esc(rankAfterLabel)}</span> !</div>` : ''}
      <button class="btn match-result-quit" onclick="App.dismissMatchResult()">Quitter</button>
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
      <div style="font-size:13px;color:var(--muted);margin-bottom:12px;"><b style="color:var(--text)">${esc(S.incomingChallenge.fromPseudo)}</b> te défie en combat.</div>
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
    app.innerHTML = `<div class="fullscreen-combat">${boardOrMulligan}${renderCombatFeed()}</div>${renderOverlays()}${renderEmoteWheel()}${renderCard3DModal()}`;
    clearInterval(window.__tick);
    restoreFocus(savedFocus);
    // Mesuré après coup, une fois le plateau vraiment dans le DOM : ajuste
    // l'échelle pour que tout tienne sans molette, quelle que soit la taille
    // de la main ou de la fenêtre.
    requestAnimationFrame(fitCombatToViewport);
    return;
  }

  let body = '';
  if (S.tab === 'collection') body = renderCollection();
  else if (S.tab === 'codex') body = renderCodex();
  else if (S.tab === 'boosters') body = renderBoosters();
  else if (S.tab === 'deck') body = renderDeckBuilder();
  else if (S.tab === 'combat') body = renderCombat();
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
  app.innerHTML = `${renderSidebar()}<main>${body}</main>${renderOverlays()}${renderEmoteWheel()}${renderCard3DModal()}`;
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

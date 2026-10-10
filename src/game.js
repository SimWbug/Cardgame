/* Moteur de combat façon Hearthstone :
   deck de 30, mana croissant, plateau de 7, mal de l'invocation,
   Provocation (taunt), Charge, cris de guerre de soin,
   sorts de dégâts / soin / buff, dégâts de zone et soins de zone. */
const { MAX_BOARD, MAX_HAND, STARTING_HERO_HP, STARTING_HAND, MAX_MANA } = require('./cards');

function uid() { return 'm-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function drawCardRaw(state) {
  if (state.library.length === 0) return;
  const cardId = state.library.shift();
  if (state.hand.length < MAX_HAND) state.hand.push(cardId);
}

/* Dégâts au héros : son ARMURE (points de bouclier) absorbe d'abord, point
   par point, puis le reste retire des PV. Renvoie les PV réellement perdus. */
function damageHero(p, amount) {
  amount = Math.max(0, Math.round(Number(amount) || 0));
  const absorbed = Math.min(p.heroArmor || 0, amount);
  p.heroArmor = (p.heroArmor || 0) - absorbed;
  p.heroHealth -= amount - absorbed;
  // Plus bas niveau de PV atteint pendant la partie (succès secrets)
  p.minHp = Math.min(p.minHp == null ? p.heroHealth : p.minHp, p.heroHealth);
  return amount - absorbed;
}
/* Donne de l'armure au héros (effet « Armure » d'une carte) */
function gainArmor(match, p, amount, source) {
  const n = Math.max(0, Math.round(Number(amount) || 0));
  if (!n) return 0;
  p.heroArmor = (p.heroArmor || 0) + n;
  match.log.push(`${p.pseudo} gagne ${n} point${n > 1 ? 's' : ''} d'armure.`);
  pushEvent(match, { type: 'armor', by: p.slug, source, targets: [Object.assign(refHero(p), { amount: n })] });
  return n;
}

function drawWithFatigue(state, match) {
  if (state.library.length === 0) {
    state.fatigue = (state.fatigue || 0) + 1;
    damageHero(state, state.fatigue);
    match.log.push(`${state.pseudo} subit ${state.fatigue} dégâts de fatigue (plus de cartes).`);
    return;
  }
  const cardId = state.library.shift();
  if (state.hand.length < MAX_HAND) state.hand.push(cardId);
  else match.log.push(`${state.pseudo} pioche une carte en trop et la brûle (main pleine).`);
}

/* Pioche n cartes (effet de sort ou cri de guerre). Paquet vide : fatigue,
   comme une pioche normale ; main pleine : la carte est brûlée. */
function drawCards(state, match, n) {
  const count = Math.max(1, Math.min(10, Math.round(Number(n) || 1)));
  for (let i = 0; i < count; i++) drawWithFatigue(state, match);
  return count;
}

/* Effets de sort qui demandent de choisir une cible (aussi utilisés comme cri de guerre) */
const TRAP_EFFECT_TYPES = ['sleep', 'destroy', 'damage', 'draw', 'armor', 'summon', 'silence'];
const TARGETED_EFFECTS = ['damage', 'heal', 'buff_attack', 'buff_ally_and_heal', 'modify_stats', 'sleep', 'destroy', 'silence',
  'give_shield', 'give_windfury', 'give_stealth', 'give_taunt', 'give_deathrattle'];
const KEYWORD_NAMES = { give_shield: 'Bouclier', give_windfury: 'Furie', give_stealth: 'Camouflage', give_taunt: 'Provocation', give_deathrattle: "Râle d'agonie" };

function removeDeadMinions(state) {
  const dead = state.board.filter(m => m.health <= 0);
  state.board = state.board.filter(m => m.health > 0);
  // Les serviteurs avec Râle d'agonie déclenchent leur effet juste après
  dead.filter(m => m.drEffect).forEach(m => { (state.pendingDeathrattles = state.pendingDeathrattles || []).push(m); });
}

/* Râle d'agonie : effet de sort déclenché à la mort du serviteur, pour son
   propriétaire. Un effet qui demande une cible en prend une au hasard parmi
   les cibles valables. Un Râle peut en déclencher d'autres (boucle bornée). */
function randomTargetFor(effect, caster, opp, rng) {
  const pick = list => list.length ? list[Math.floor(rng() * list.length)] : null;
  const visibleEnemies = opp.board.filter(m => !m.stealth);
  if (effect === 'damage') {
    const choices = visibleEnemies.map(m => ({ targetType: 'minion', targetId: m.instanceId })).concat([{ targetType: 'hero' }]);
    return pick(choices);
  }
  if (effect === 'heal') return { targetType: 'hero' };
  if (['buff_attack', 'buff_ally_and_heal', 'give_shield', 'give_windfury', 'give_stealth', 'give_taunt', 'give_deathrattle'].includes(effect)) {
    const m = pick(caster.board); return m ? { targetType: 'minion', targetId: m.instanceId } : null;
  }
  if (['sleep', 'destroy', 'modify_stats', 'silence'].includes(effect)) {
    const m = pick(visibleEnemies); return m ? { targetType: 'minion', targetId: m.instanceId } : null;
  }
  return {};
}
/* Effets de cri de guerre d'une carte : le principal + jusqu'à 2 effets en plus */
function bcEffectsOf(card) {
  return [
    { effectType: card.bcEffect, value: card.bcValue, value2: card.bcValue2 },
    { effectType: card.bc2Effect, value: card.bc2Value, value2: card.bc2Value2 },
    { effectType: card.bc3Effect, value: card.bc3Value, value2: card.bc3Value2 }
  ].filter(e => e.effectType);
}
/* Qui un effet à cible peut viser : un allié, ou n'importe quel serviteur/héros */
const TARGET_SIDE = { heal: 'ally', buff_attack: 'ally', buff_ally_and_heal: 'ally', give_shield: 'ally', give_windfury: 'ally', give_stealth: 'ally',
  give_taunt: 'ally', give_deathrattle: 'ally', damage: 'any', modify_stats: 'any', sleep: 'minion', destroy: 'minion', silence: 'minion' };
function reusableTarget(effect, opts, caster, opp) {
  if (!opts || !opts.targetType) return null;
  const side = TARGET_SIDE[effect];
  if (opts.targetType === 'minion') {
    const mine = caster.board.some(m => m.instanceId === opts.targetId);
    const theirs = opp.board.some(m => m.instanceId === opts.targetId);
    if (side === 'ally' && mine) return opts;
    if ((side === 'any' || side === 'minion') && (mine || theirs)) return opts;
    return null;
  }
  if (opts.targetType === 'hero' && (effect === 'damage')) return opts;
  if (opts.targetType === 'hero' && effect === 'heal') return opts; // ton héros
  return null;
}


/* ======================================================
   INVOCATION, PIÈGES, AURAS
   ====================================================== */
const MAX_TRAPS = 3;
/* Le serveur indique quelles cartes sont dans une extension cachée */
let isHiddenCard = () => false;
function setHiddenCardCheck(fn) { if (typeof fn === 'function') isHiddenCard = fn; }
/* Invocation : fait apparaître des jetons (petits serviteurs) chez « side ».
   Les caractéristiques viennent de la carte source : tokenName, tokenAttack, tokenHealth. */
function summonTokens(match, side, source, count) {
  const n = Math.max(1, Math.min(MAX_BOARD, Math.round(Number(count) || 1)));
  const made = [];
  for (let i = 0; i < n && side.board.length < MAX_BOARD; i++) {
    const tk = {
      instanceId: 'tk-' + Math.random().toString(36).slice(2, 10), cardId: source.id, token: true,
      name: source.tokenName || 'Jeton', image: source.tokenImage || source.image || null, rarity: 'commun',
      attack: Math.max(0, Math.round(Number(source.tokenAttack) || 1)), health: Math.max(1, Math.round(Number(source.tokenHealth) || 1)),
      armor: 0, taunt: !!source.tokenTaunt, charge: false, attacksLeft: 1, canAttack: false, sickness: true
    };
    tk.maxHealth = tk.health; tk.baseAttack = tk.attack; tk.baseHealth = tk.health;
    side.board.push(tk);
    made.push(refMinion(tk, side));
  }
  if (made.length) {
    match.log.push(`${source.name} invoque ${made.length} × ${made[0].name}.`);
    pushEvent(match, { type: 'summon', by: side.slug, source: refCard(source, side), targets: made });
  }
  return made.length;
}

/* Auras : chaque serviteur avec auraAttack donne +X ATQ à ses alliés
   (tous les autres, ou seulement ses voisins). Recalculé après chaque action :
   on retire l'ancien bonus d'aura puis on applique le nouveau. */
function recomputeAuras(match) {
  match.players.forEach(p => {
    p.board.forEach(m => {
      if (m.auraBonus) { m.attack = Math.max(0, m.attack - m.auraBonus); m.auraBonus = 0; }
      if (m.rageBonus) { m.attack = Math.max(0, m.attack - m.rageBonus); m.rageBonus = 0; }
    });
    // Rage : bonus d'ATQ tant que le serviteur est blessé (PV sous son maximum)
    p.board.forEach(m => {
      const r = Math.round(Number(m.rage) || 0);
      if (r > 0 && m.health > 0 && m.health < (m.maxHealth || m.health)) { m.attack += r; m.rageBonus = r; }
    });
    p.board.forEach((src, i) => {
      const amt = Math.round(Number(src.auraAttack) || 0);
      if (!amt || src.health <= 0) return;
      p.board.forEach((m, j) => {
        if (m === src) return;
        if (src.auraScope === 'adjacent' && Math.abs(i - j) !== 1) return;
        m.attack += amt; m.auraBonus = (m.auraBonus || 0) + amt;
      });
    });
    // Suivi pour les succès secrets : plateau le plus rempli, plus gros serviteur
    p.maxBoard = Math.max(p.maxBoard || 0, p.board.length);
    p.board.forEach(m => { if (m.attack > (p.maxMinionAtk || 0)) p.maxMinionAtk = m.attack; });
  });
}

/* Pièges : sorts posés face cachée. Ils se déclenchent quand l'adversaire fait
   l'action prévue (trapTrigger) et appliquent leur effet (trapEffect) au
   serviteur qui l'a déclenché, ou de façon générale (pioche, armure, invocation…). */
const TRAP_TRIGGERS = { enemy_attack: 'quand un ennemi attaque', enemy_minion: "quand l'adversaire pose un serviteur", enemy_spell: "quand l'adversaire lance un sort" };
function fireTrap(match, owner, trigger, culprit, culpritSide) {
  const idx = (owner.traps || []).findIndex(t => t.trapTrigger === trigger);
  if (idx < 0) return null;
  const trap = owner.traps.splice(idx, 1)[0];
  const opp = match.players.find(x => x !== owner);
  match.log.push(`Piège ! ${trap.name} se déclenche ${TRAP_TRIGGERS[trigger] || ''}.`);
  pushEvent(match, { type: 'trap', by: owner.slug, source: refCard(trap, owner), trigger, target: culprit ? refMinion(culprit, culpritSide) : null });
  const fx = Object.assign({}, trap, { effectType: trap.trapEffect, value: trap.trapValue, value2: trap.trapValue2 });
  let opts = {};
  if (TARGETED_EFFECTS.includes(fx.effectType)) {
    if (culprit && ['sleep', 'destroy', 'damage', 'modify_stats', 'silence'].includes(fx.effectType)) opts = { targetType: 'minion', targetId: culprit.instanceId };
    else if (fx.effectType === 'damage') opts = { targetType: 'hero' };
    else opts = randomTargetFor(fx.effectType, owner, opp, match.rng || Math.random) || null;
  }
  if (opts) applySpell(match, owner, opp, fx, opts);
  return trap;
}

/* Combo : quand un serviteur et son partenaire (comboPartnerId) sont sur le
   même plateau, la carte comboSpawnId apparaît (une seule fois par paire). */
function checkCombos(match) {
  const pool = match.__pool || [];
  match.__combos = match.__combos || {};
  match.players.forEach(p => {
    p.board.slice().forEach(m => {
      if (!m.comboPartnerId || !m.comboSpawnId) return;
      const partner = p.board.find(x => x !== m && x.cardId === m.comboPartnerId && x.health > 0);
      if (!partner || m.health <= 0) return;
      const key = [m.instanceId, partner.instanceId].sort().join('|');
      if (match.__combos[key]) return;
      match.__combos[key] = true;
      const spawn = pool.find(c => c.id === m.comboSpawnId);
      if (!spawn || p.board.length >= MAX_BOARD) return;
      const made = createMinionFrom(spawn);
      p.board.push(made);
      match.log.push(`Combo ! ${m.name} + ${partner.name} : ${spawn.name} apparaît.`);
      pushEvent(match, { type: 'combo', by: p.slug, source: refMinion(m, p), partner: refMinion(partner, p), spawned: refMinion(made, p) });
    });
  });
}

function processDeathrattles(match) {
  const rng = match.rng || Math.random;
  for (let guard = 0; guard < 20; guard++) {
    let any = false;
    match.players.forEach((owner, idx) => {
      const queue = owner.pendingDeathrattles || [];
      owner.pendingDeathrattles = [];
      queue.forEach(m => {
        any = true;
        const opp = match.players[1 - idx];
        const fx = { id: m.cardId, name: m.name, image: m.image, rarity: m.rarity, type: 'minion', effectType: m.drEffect, value: m.drValue, value2: m.drValue2,
          tokenName: m.tokenName, tokenAttack: m.tokenAttack, tokenHealth: m.tokenHealth, randomPool: m.randomPool };
        const opts = TARGETED_EFFECTS.includes(m.drEffect) || /^give_/.test(m.drEffect) ? randomTargetFor(m.drEffect, owner, opp, rng) : {};
        match.log.push(`Râle d'agonie de ${m.name}.`);
        pushEvent(match, { type: 'deathrattle', by: owner.slug, source: refMinion(m, owner) });
        const seqBefore = match.evSeq || 0;
        if (opts) applySpell(match, owner, opp, fx, opts);
        // les effets produits par ce Râle d'agonie sont rattachés au serviteur mort (animation côté client)
        (match.events || []).forEach(e => { if (e.seq > seqBefore && !e.drFrom) { e.deathrattle = true; e.drFrom = m.instanceId; } });
      });
    });
    if (!any) break;
  }
  checkWin(match);
}

/* Applique des dégâts à un serviteur en consommant d'abord son armure.
   L'armure absorbe les dégâts point pour point, puis le reste va aux PV. */
function applyDamageToMinion(m, amount) {
  if (amount <= 0) return 0;
  if (m.shield) { m.shield = false; m.shieldPopped = true; return 0; } // Bouclier : ce coup est ignoré
  if (!m.armor) m.armor = 0;
  if (m.armor > 0) {
    const absorbed = Math.min(m.armor, amount);
    m.armor -= absorbed;
    amount -= absorbed;
  }
  if (amount > 0) m.health -= amount;
  return Math.max(0, amount); // PV réellement perdus (après armure)
}

/* ---------- Journal visuel : événements structurés ----------
   En plus des phrases de match.log, chaque action importante produit un
   événement lisible par l'interface : qui a joué quoi, qui a frappé qui,
   combien de dégâts ou de soins, qui est mort. */
function refMinion(m, owner) { return { kind: 'minion', name: m.name, image: m.image || null, rarity: m.rarity || null, owner: owner.slug, id: m.instanceId, cardId: m.cardId, attack: m.attack, health: m.health }; }
function refHero(p) { return { kind: 'hero', name: p.pseudo, image: p.avatar || null, owner: p.slug, weaponCardId: p.heroWeapon ? p.heroWeapon.cardId : null }; }
function refCard(card, owner) {
  if (!card) return null;
  return { kind: 'card', id: card.id, name: card.name, image: card.image || null, rarity: card.rarity || null, type: card.type, cost: card.cost, desc: card.desc || '',
    attack: card.attack, health: card.health, durability: card.durability, value: card.value, value2: card.value2, effectType: card.effectType,
    bcEffect: card.bcEffect, bcValue: card.bcValue, bcValue2: card.bcValue2, bc2Effect: card.bc2Effect, bc2Value: card.bc2Value, bc2Value2: card.bc2Value2, bc3Effect: card.bc3Effect, bc3Value: card.bc3Value, bc3Value2: card.bc3Value2, taunt: card.taunt, charge: card.charge,
    shield: card.shield, windfury: card.windfury, stealth: card.stealth, standing: card.standing, rage: card.rage, drEffect: card.drEffect, drValue: card.drValue, drValue2: card.drValue2, owner: owner.slug };
}
function pushEvent(match, e) {
  if (!match.events) match.events = [];
  match.evSeq = (match.evSeq || 0) + 1;
  match.events.push(Object.assign({ seq: match.evSeq, turn: match.turnNumber }, e));
  if (match.events.length > 1500) match.events.splice(0, match.events.length - 1500);
}

/* Une attaque consommée : Furie permet d'attaquer deux fois par tour ;
   attaquer fait sortir de Camouflage. */
function spendAttack(m) {
  m.attacksLeft = (m.attacksLeft == null ? 1 : m.attacksLeft) - 1;
  m.canAttack = m.attacksLeft > 0;
  m.stealth = false;
}

function playCard(match, cardPool, playerIndex, cardId, options) {
  const p = match.players[playerIndex];
  const card = cardPool.find(c => c.id === cardId);
  const boardBefore = p ? p.board.slice() : [];
  match.__pool = cardPool; // cartes du jeu (pour les effets « cartes au hasard » et les combos)
  const r = playCardInner(match, cardPool, playerIndex, cardId, options);
  if (r && r.ok) {
    const opp = match.players[1 - playerIndex];
    // Pièges adverses : serviteur posé / sort lancé
    if (card && card.type === 'minion') {
      const placed = p.board.find(m => !boardBefore.includes(m) && m.cardId === card.id);
      if (placed) fireTrap(match, opp, 'enemy_minion', placed, p);
    } else if (card && card.type !== 'weapon') fireTrap(match, opp, 'enemy_spell', null, null);
    processDeathrattles(match);
    checkCombos(match);
    recomputeAuras(match);
  }
  return r;
}
function attack(match, playerIndex, attackerId, targetType, targetId) {
  // Piège adverse « quand un ennemi attaque » : il frappe l'attaquant AVANT le coup.
  // S'il l'endort ou le détruit, l'attaque n'a pas lieu.
  if (match.status === 'active' && match.turn === playerIndex && attackerId !== 'hero') {
    const p = match.players[playerIndex], opp = match.players[1 - playerIndex];
    const atk = p.board.find(m => m.instanceId === attackerId);
    if (atk && atk.canAttack && !atk.sickness && !atk.asleep && atk.attack > 0 && (opp.traps || []).some(t => t.trapTrigger === 'enemy_attack')) {
      fireTrap(match, opp, 'enemy_attack', atk, p);
      processDeathrattles(match);
      recomputeAuras(match);
      if (match.status !== 'active') return { ok: true, trapped: true };
      if (!p.board.includes(atk) || atk.asleep) { spendAttack(atk); return { ok: true, trapped: true }; }
    }
  }
  const r = attackInner(match, playerIndex, attackerId, targetType, targetId);
  if (r && r.ok) { processDeathrattles(match); checkCombos(match); recomputeAuras(match); }
  return r;
}

/* Mana de départ en plus (Blitz : 3 cristaux dès le 1er tour ; Survie : le bot
   en gagne avec les manches). match.manaBonus = [joueur 0, joueur 1]. */
function manaBonusOf(match, i) {
  const b = match.manaBonus;
  return Math.max(0, Math.min(MAX_MANA - 1, Math.round(Number(Array.isArray(b) ? b[i] : b) || 0)));
}

function hasTaunt(state) {
  return state.board.some(m => m.taunt && m.health > 0 && !m.stealth);
}

function createMatch(id, playerAInfo, playerBInfo) {
  const players = [playerAInfo, playerBInfo].map(info => {
    const library = shuffle(info.deck);
    const state = {
      slug: info.slug, pseudo: info.pseudo, title: info.title || null,
      avatar: info.avatar || null, ornament: info.ornament || 'none',
      library, hand: [], board: [], heroWeapon: null, deckList: (info.deck || []).slice(),
      heroHealth: STARTING_HERO_HP, heroArmor: 0, mana: 0, maxMana: 0, fatigue: 0
    };
    for (let i = 0; i < STARTING_HAND; i++) drawCardRaw(state);
    return state;
  });
  return {
    id, players, turn: 0, turnNumber: 1, status: 'active', winner: null,
    phase: 'mulligan', mulliganDone: [false, false],
    log: [`La partie commence : ${players[0].pseudo} contre ${players[1].pseudo}. Choisissez votre main de départ.`]
  };
}

/* Un joueur valide sa main de départ : les cartes de cardIdsToReplace
   retournent dans sa pioche (mélangée à nouveau) et sont remplacées par
   autant de nouvelles cartes. Une fois les deux joueurs prêts, le premier
   tour démarre normalement. */
function submitMulligan(match, playerIndex, cardIdsToReplace) {
  if (match.phase !== 'mulligan') return { error: 'La sélection de main est déjà terminée.' };
  if (match.mulliganDone[playerIndex]) return { error: 'Tu as déjà validé ta main.' };
  const p = match.players[playerIndex];
  const toReplace = Array.isArray(cardIdsToReplace) ? cardIdsToReplace.slice(0, p.hand.length) : [];

  let actuallyRemoved = 0;
  toReplace.forEach(cardId => {
    const idx = p.hand.indexOf(cardId);
    if (idx === -1) return; // carte déjà retirée ou invalide : on l'ignore simplement
    p.hand.splice(idx, 1);
    p.library.push(cardId);
    actuallyRemoved++;
  });
  if (actuallyRemoved > 0) {
    p.library = shuffle(p.library);
    for (let i = 0; i < actuallyRemoved; i++) drawCardRaw(p);
  }

  match.mulliganDone[playerIndex] = true;
  match.log.push(`${p.pseudo} a choisi sa main de départ.`);

  if (match.mulliganDone[0] && match.mulliganDone[1]) {
    match.phase = 'active';
    match.players[0].maxMana = 1 + manaBonusOf(match, 0);
    match.players[0].mana = match.players[0].maxMana;
    match.log.push(`${match.players[0].pseudo} commence la partie.`);
    pushEvent(match, { type: 'turn', by: match.players[0].slug, name: match.players[0].pseudo, mana: 1 });
  }
  return { ok: true };
}

function startTurn(match) {
  const p = match.players[match.turn];
  p.maxMana = Math.min(Math.max(p.maxMana + 1, 1 + manaBonusOf(match, match.turn)), MAX_MANA);
  p.mana = p.maxMana;
  p.board.forEach(m => {
    m.sickness = false;
    // Endormissement : le serviteur passe ce tour-ci sans pouvoir attaquer
    if (m.asleepTurns > 0) { m.asleep = true; m.canAttack = false; m.asleepTurns -= 1; }
    else { m.asleep = false; m.canAttack = true; }
    m.attacksLeft = m.windfury ? 2 : 1;
    standingTick(match, p, m);
  });
  if (p.heroWeapon) p.heroWeapon.usesThisTurn = 0;
  drawWithFatigue(p, match);
  match.log.push(`Tour ${match.turnNumber} — c'est au tour de ${p.pseudo} (${p.mana} mana).`);
  pushEvent(match, { type: 'turn', by: p.slug, name: p.pseudo, mana: p.mana });
}

/* Silence : retire tous les effets d'un serviteur — mots-clés (Provocation,
   Bouclier, Furie, Camouflage, Toujours debout, Rage, Daltonisme), aura, Râle
   d'agonie, combo, armure, endormissement — et ramène son ATQ et ses PV max à
   ceux de sa carte (les bonus reçus disparaissent, les dégâts subis restent). */
function silenceMinion(match, m) {
  if (m.auraBonus) { m.attack = Math.max(0, m.attack - m.auraBonus); m.auraBonus = 0; }
  if (m.rageBonus) { m.attack = Math.max(0, m.attack - m.rageBonus); m.rageBonus = 0; }
  const card = !m.token && match.__pool ? match.__pool.find(c => c.id === m.cardId) : null;
  const baseAtk = m.baseAttack != null ? m.baseAttack : card ? card.attack : m.attack;
  const baseHp = m.baseHealth != null ? m.baseHealth : card ? card.health : m.maxHealth;
  m.attack = Math.max(0, Math.round(Number(baseAtk) || 0));
  m.maxHealth = Math.max(1, Math.round(Number(baseHp) || 1));
  m.health = Math.min(m.health, m.maxHealth);
  m.taunt = false; m.shield = false; m.stealth = false; m.colorblind = false;
  if (m.windfury) { m.windfury = false; m.attacksLeft = Math.min(m.attacksLeft || 0, 1); }
  m.standing = false; m.standTurns = 0; m.standLevel = 0;
  m.rage = 0; m.auraAttack = 0; m.armor = 0;
  m.drEffect = null; m.drValue = null; m.drValue2 = null;
  m.comboPartnerId = null; m.comboSpawnId = null;
  if (m.asleep || m.asleepTurns) { m.asleep = false; m.asleepTurns = 0; m.canAttack = !m.sickness && (m.attacksLeft || 0) > 0; }
  m.silenced = true;
}

/* « Toujours debout » : un serviteur qui reste en vie gagne un niveau tous
   les 2 tours (+1 ATQ / +1 PV), jusqu'au niveau STANDING_MAX. */
const STANDING_EVERY = 2, STANDING_MAX = 3;
function standingTick(match, owner, m) {
  if (!m.standing || m.health <= 0) return;
  m.standTurns = (m.standTurns || 0) + 1;
  if (m.standTurns % STANDING_EVERY !== 0 || (m.standLevel || 0) >= STANDING_MAX) return;
  m.standLevel = (m.standLevel || 0) + 1;
  m.attack += 1; m.health += 1; m.maxHealth = (m.maxHealth || m.health - 1) + 1;
  match.log.push(`${m.name} est toujours debout : niveau ${m.standLevel} (+1/+1).`);
  pushEvent(match, { type: 'levelup', by: owner.slug, source: refMinion(m, owner), level: m.standLevel });
}

function applySpell(match, caster, opponent, card, options) {
  // Camouflage : un sort ne peut pas viser un serviteur ennemi camouflé
  if (options && options.targetId) {
    const hidden = opponent.board.find(m => m.instanceId === options.targetId && m.stealth);
    if (hidden) return { error: 'Ce serviteur est camouflé : il ne peut pas être ciblé.' };
  }
  options = options || {};
  const et = card.effectType;

  if (et === 'damage') {
    if (options.targetType === 'minion') {
      // Un sort de dégâts peut viser un serviteur de l'un ou l'autre camp
      let target = opponent.board.find(m => m.instanceId === options.targetId);
      let side = opponent;
      if (!target) { target = caster.board.find(m => m.instanceId === options.targetId); side = caster; }
      if (!target) return { error: 'Cible introuvable.' };
      const ref = refMinion(target, side);
      const dealt = applyDamageToMinion(target, card.value);
      match.log.push(`${card.name} inflige ${card.value} dégâts à ${target.name}.`);
      pushEvent(match, { type: 'damage', by: caster.slug, source: refCard(card, caster), targets: [Object.assign(ref, { amount: dealt, died: target.health <= 0 })] });
      removeDeadMinions(side);
    } else if (options.targetType === 'ownHero') {
      damageHero(caster, card.value);
      match.log.push(`${card.name} inflige ${card.value} dégâts à ${caster.pseudo}.`);
      pushEvent(match, { type: 'damage', by: caster.slug, source: refCard(card, caster), targets: [Object.assign(refHero(caster), { amount: card.value })] });
    } else {
      damageHero(opponent, card.value);
      match.log.push(`${card.name} inflige ${card.value} dégâts à ${opponent.pseudo}.`);
      pushEvent(match, { type: 'damage', by: caster.slug, source: refCard(card, caster), targets: [Object.assign(refHero(opponent), { amount: card.value })] });
    }

  } else if (et === 'heal') {
    if (options.targetType === 'minion') {
      const target = caster.board.find(m => m.instanceId === options.targetId);
      if (!target) return { error: 'Cible amie introuvable.' };
      const before = target.health;
      target.health = Math.min(target.health + card.value, target.maxHealth);
      match.log.push(`${card.name} rend ${card.value} PV à ${target.name}.`);
      pushEvent(match, { type: 'heal', by: caster.slug, source: refCard(card, caster), targets: [Object.assign(refMinion(target, caster), { amount: target.health - before })] });
    } else {
      const before = caster.heroHealth;
      caster.heroHealth = healedHp(caster, card.value);
      match.log.push(`${card.name} rend ${card.value} PV à ${caster.pseudo}.`);
      pushEvent(match, { type: 'heal', by: caster.slug, source: refCard(card, caster), targets: [Object.assign(refHero(caster), { amount: caster.heroHealth - before })] });
    }

  } else if (et === 'buff_attack') {
    const target = caster.board.find(m => m.instanceId === options.targetId);
    if (!target) return { error: 'Choisis un de tes serviteurs.' };
    target.attack += card.value;
    match.log.push(`${target.name} gagne +${card.value} ATQ.`);
    pushEvent(match, { type: 'buff', by: caster.slug, source: refCard(card, caster), targets: [Object.assign(refMinion(target, caster), { amount: card.value })] });

  } else if (et === 'aoe_damage') {
    const hits = opponent.board.map(m => { const ref = refMinion(m, opponent); const d = applyDamageToMinion(m, card.value); return Object.assign(ref, { amount: d, died: m.health <= 0 }); });
    match.log.push(`${card.name} inflige ${card.value} dégâts à tous les serviteurs de ${opponent.pseudo}.`);
    pushEvent(match, { type: 'damage', by: caster.slug, source: refCard(card, caster), targets: hits, area: true });
    removeDeadMinions(opponent);

  } else if (et === 'aoe_heal') {
    const heals = caster.board.map(m => { const b0 = m.health; m.health = Math.min(m.health + card.value, m.maxHealth); return Object.assign(refMinion(m, caster), { amount: m.health - b0 }); });
    const hb = caster.heroHealth;
    caster.heroHealth = healedHp(caster, card.value);
    heals.push(Object.assign(refHero(caster), { amount: caster.heroHealth - hb }));
    pushEvent(match, { type: 'heal', by: caster.slug, source: refCard(card, caster), targets: heals, area: true });
    match.log.push(`${card.name} rend ${card.value} PV à ${caster.pseudo} et à ses serviteurs.`);

  } else if (et === 'board_wipe') {
    // Détruit tous les serviteurs des deux camps, sans tenir compte de l'armure
    const killed = caster.board.map(m => Object.assign(refMinion(m, caster), { died: true }))
      .concat(opponent.board.map(m => Object.assign(refMinion(m, opponent), { died: true })));
    caster.board = [];
    opponent.board = [];
    pushEvent(match, { type: 'destroy', by: caster.slug, source: refCard(card, caster), targets: killed, area: true });
    match.log.push(`${card.name} détruit tous les serviteurs en jeu.`);

  } else if (et === 'damage_all') {
    // Inflige des dégâts à TOUS les serviteurs, des deux camps (armure prise en compte)
    const hitAll = caster.board.map(m => [m, caster]).concat(opponent.board.map(m => [m, opponent])).map(([m, side]) => {
      const ref = refMinion(m, side); const d = applyDamageToMinion(m, card.value); return Object.assign(ref, { amount: d, died: m.health <= 0 });
    });
    pushEvent(match, { type: 'damage', by: caster.slug, source: refCard(card, caster), targets: hitAll, area: true });
    match.log.push(`${card.name} inflige ${card.value} dégâts à tous les serviteurs en jeu.`);
    removeDeadMinions(caster);
    removeDeadMinions(opponent);

  } else if (et === 'buff_all_allies') {
    // Renforce tous VOS serviteurs (pas ceux de l'adversaire)
    caster.board.forEach(m => { m.attack += card.value; });
    pushEvent(match, { type: 'buff', by: caster.slug, source: refCard(card, caster), targets: caster.board.map(m => Object.assign(refMinion(m, caster), { amount: card.value })), area: true });
    match.log.push(`${card.name} donne +${card.value} ATQ à tous les serviteurs de ${caster.pseudo}.`);

  } else if (et === 'buff_ally_and_heal') {
    // Renforce un allié choisi ET soigne le héros lanceur en même temps
    const target = caster.board.find(m => m.instanceId === options.targetId);
    if (!target) return { error: 'Choisis un de tes serviteurs.' };
    target.attack += card.value;
    const healAmount = card.value2 || 0;
    const hb2 = caster.heroHealth;
    caster.heroHealth = healedHp(caster, healAmount);
    pushEvent(match, { type: 'buff', by: caster.slug, source: refCard(card, caster), targets: [Object.assign(refMinion(target, caster), { amount: card.value })] });
    if (caster.heroHealth > hb2) pushEvent(match, { type: 'heal', by: caster.slug, source: refCard(card, caster), targets: [Object.assign(refHero(caster), { amount: caster.heroHealth - hb2 })] });
    match.log.push(`${card.name} donne +${card.value} ATQ à ${target.name} et rend ${healAmount} PV à ${caster.pseudo}.`);

  } else if (et === 'random_cards') {
    // Donne N cartes au hasard, tirées dans la liste choisie par l'admin
    // (randomPool) ou, à défaut, parmi toutes les cartes jouables du jeu.
    const pool = match.__pool || [];
    const list = (card.randomPool && card.randomPool.length ? card.randomPool.map(id => pool.find(c => c.id === id)).filter(Boolean)
      : pool.filter(c => !c.unobtainable && !isHiddenCard(c)));
    const n = Math.max(1, Math.min(5, Math.round(Number(card.value) || 2)));
    const rng = match.rng || Math.random;
    const given = [];
    for (let i = 0; i < n && list.length; i++) {
      const c = list[Math.floor(rng() * list.length)];
      if (caster.hand.length < MAX_HAND) { caster.hand.push(c.id); given.push(c); }
    }
    match.log.push(`${card.name} donne ${given.length} carte${given.length > 1 ? 's' : ''} à ${caster.pseudo}.`);
    pushEvent(match, { type: 'gift', by: caster.slug, source: refCard(card, caster), cards: given.map(c => ({ id: c.id, name: c.name, image: c.image || null, rarity: c.rarity, cost: c.cost, type: c.type })) });

  } else if (et === 'summon') {
    if (caster.board.length >= MAX_BOARD) return { error: 'Ton plateau est plein (7 max).' };
    summonTokens(match, caster, card, card.value);

  } else if (et === 'trap') {
    // Le piège est posé face cachée : l'adversaire voit seulement qu'il y en a un
    caster.traps = caster.traps || [];
    if (caster.traps.length >= MAX_TRAPS) return { error: `Tu as déjà ${MAX_TRAPS} pièges en place.` };
    caster.traps.push({ id: card.id, name: card.name, image: card.image, rarity: card.rarity, cost: card.cost, type: card.type,
      trapTrigger: card.trapTrigger || 'enemy_attack', trapEffect: card.trapEffect || 'sleep', trapValue: card.trapValue, trapValue2: card.trapValue2,
      tokenName: card.tokenName, tokenAttack: card.tokenAttack, tokenHealth: card.tokenHealth });
    match.log.push(`${caster.pseudo} pose un piège.`);
    pushEvent(match, { type: 'trapSet', by: caster.slug, source: refCard(card, caster) });

  } else if (/^give_/.test(et)) {
    // Donne un mot-clé à un de tes serviteurs (Bouclier, Furie, Camouflage, Provocation, Râle d'agonie)
    const target = caster.board.find(m => m.instanceId === options.targetId);
    if (!target) return { error: 'Choisis un de tes serviteurs.' };
    if (et === 'give_shield') target.shield = true;
    if (et === 'give_stealth') target.stealth = true;
    if (et === 'give_taunt') target.taunt = true;
    if (et === 'give_windfury' && !target.windfury) {
      target.windfury = true;
      // Pendant ton tour, il gagne tout de suite une attaque de plus
      if (match.players[match.turn] === caster && !target.sickness && !target.asleep) {
        target.attacksLeft = (target.attacksLeft == null ? 1 : target.attacksLeft) + 1;
        target.canAttack = target.attacksLeft > 0;
      }
    }
    if (et === 'give_deathrattle') {
      if (!card.drEffect) return { error: "Ce sort n'a pas de Râle d'agonie à donner." };
      target.drEffect = card.drEffect; target.drValue = card.drValue; target.drValue2 = card.drValue2;
    }
    match.log.push(`${card.name} donne ${KEYWORD_NAMES[et]} à ${target.name}.`);
    pushEvent(match, { type: 'grant', by: caster.slug, source: refCard(card, caster), keyword: KEYWORD_NAMES[et],
      targets: [refMinion(target, caster)] });

  } else if (et === 'destroy') {
    // Détruire une cible : le serviteur choisi (allié ou ennemi) est détruit,
    // quels que soient ses PV et son armure.
    let target = opponent.board.find(m => m.instanceId === options.targetId), side = opponent;
    if (!target) { target = caster.board.find(m => m.instanceId === options.targetId); side = caster; }
    if (!target) return { error: 'Choisis un serviteur à détruire.' };
    const ref = refMinion(target, side);
    target.health = 0;
    removeDeadMinions(side);
    match.log.push(`${card.name} détruit ${target.name}.`);
    pushEvent(match, { type: 'destroy', by: caster.slug, source: refCard(card, caster), targets: [Object.assign(ref, { died: true })] });

  } else if (et === 'silence') {
    // Silence : le serviteur ciblé (allié ou ennemi) perd tous ses effets
    let target = opponent.board.find(m => m.instanceId === options.targetId), side = opponent;
    if (!target) { target = caster.board.find(m => m.instanceId === options.targetId); side = caster; }
    if (!target) return { error: 'Choisis un serviteur à réduire au silence.' };
    silenceMinion(match, target);
    match.log.push(`${card.name} réduit ${target.name} au silence.`);
    pushEvent(match, { type: 'silence', by: caster.slug, source: refCard(card, caster), targets: [refMinion(target, side)] });
  } else if (et === 'sleep') {
    // Endormissement : le serviteur ciblé (allié ou ennemi) ne peut pas attaquer
    // pendant N de SES tours. Endormi pendant le tour de son propriétaire, ce
    // tour-ci compte déjà comme le premier.
    let target = opponent.board.find(m => m.instanceId === options.targetId), side = opponent;
    if (!target) { target = caster.board.find(m => m.instanceId === options.targetId); side = caster; }
    if (!target) return { error: 'Choisis un serviteur à endormir.' };
    const n = Math.max(1, Math.min(5, Math.round(Number(card.value) || 1)));
    const ownersTurn = match.players[match.turn] === side;
    target.asleep = true;
    target.canAttack = false;
    target.asleepTurns = Math.max(target.asleepTurns || 0, ownersTurn ? n - 1 : n);
    match.log.push(`${card.name} endort ${target.name} pendant ${n} tour${n > 1 ? 's' : ''}.`);
    pushEvent(match, { type: 'sleep', by: caster.slug, source: refCard(card, caster), targets: [Object.assign(refMinion(target, side), { turns: n })] });

  } else if (et === 'armor') {
    gainArmor(match, caster, card.value, refCard(card, caster));

  } else if (et === 'draw') {
    const n = drawCards(caster, match, card.value);
    match.log.push(`${card.name} : ${caster.pseudo} pioche ${n} carte${n > 1 ? 's' : ''}.`);
    pushEvent(match, { type: 'draw', by: caster.slug, source: refCard(card, caster), amount: n });

  } else if (et === 'modify_stats') {
    // Deux effets en un sur le même serviteur (allié ou ennemi) : un changement
    // d'ATQ (value) ET un changement de PV (value2), chacun positif ou négatif.
    // Ex. : -1 PV et +2 ATQ, ou -1 ATQ et +3 PV. L'ATQ ne descend pas sous 0 ;
    // des PV qui tombent à 0 détruisent le serviteur.
    let target = caster.board.find(m => m.instanceId === options.targetId), side = caster;
    if (!target) { target = opponent.board.find(m => m.instanceId === options.targetId); side = opponent; }
    if (!target) return { error: 'Choisis un serviteur.' };
    const dAtk = Math.round(Number(card.value) || 0), dHp = Math.round(Number(card.value2) || 0);
    const ref = refMinion(target, side);
    const atkBefore = target.attack;
    target.attack = Math.max(0, target.attack + dAtk);
    if (dHp > 0) { target.health += dHp; target.maxHealth += dHp; }
    else if (dHp < 0) { target.health += dHp; target.maxHealth = Math.max(1, target.maxHealth + dHp); }
    match.log.push(`${card.name} modifie ${target.name} : ${dAtk >= 0 ? '+' : ''}${dAtk} ATQ, ${dHp >= 0 ? '+' : ''}${dHp} PV.`);
    pushEvent(match, { type: 'modify', by: caster.slug, source: refCard(card, caster),
      targets: [Object.assign(ref, { atk: target.attack - atkBefore, hp: dHp, died: target.health <= 0 })] });
    removeDeadMinions(side);

  } else if (et) {
    return { error: 'Effet de sort inconnu.' };
  }
  return { ok: true };
}

function checkWin(match) {
  if (match.status !== 'active') return;
  const [a, b] = match.players;
  if (a.heroHealth <= 0 && b.heroHealth <= 0) {
    match.status = 'finished'; match.winner = null; match.log.push('Égalité !');
  } else if (a.heroHealth <= 0) {
    match.status = 'finished'; match.winner = b.slug; match.log.push(`${b.pseudo} remporte la partie !`);
  } else if (b.heroHealth <= 0) {
    match.status = 'finished'; match.winner = a.slug; match.log.push(`${a.pseudo} remporte la partie !`);
  }
}

/* Un serviteur sur le plateau à partir de sa carte */
function createMinionFrom(card) {
  return {
      instanceId: uid(), cardId: card.id, name: card.name, image: card.image || null,
      rarity: card.rarity,
      attack: card.attack, health: card.health, maxHealth: card.health,
      armor: 0, // l'armure d'une carte est donnée au héros (voir plus bas), pas au serviteur
      taunt: !!card.taunt, charge: !!card.charge,
      colorblind: !!card.colorblind, colorblindChance: Math.max(1, Math.min(100, Math.round(Number(card.colorblindChance) || 50))),
      shield: !!card.shield, windfury: !!card.windfury, stealth: !!card.stealth,
      standing: !!card.standing, standTurns: 0, standLevel: 0,
      rage: Math.max(0, Math.round(Number(card.rage) || 0)), rageBonus: 0,
      baseAttack: card.attack, baseHealth: card.health,
      auraAttack: Math.round(Number(card.auraAttack) || 0), auraScope: card.auraScope === 'adjacent' ? 'adjacent' : 'others',
      tokenName: card.tokenName, tokenAttack: card.tokenAttack, tokenHealth: card.tokenHealth, randomPool: card.randomPool,
      comboPartnerId: card.comboPartnerId || null, comboSpawnId: card.comboSpawnId || null,
      drEffect: card.drEffect || null, drValue: card.drValue, drValue2: card.drValue2,
      attacksLeft: card.windfury ? 2 : 1,
      canAttack: !!card.charge, sickness: !card.charge
    };
}

/* Soin du héros : plafonné à ses PV de départ (30, ou plus en Survie / Bagarre),
   et un soin ne fait jamais BAISSER les PV d'un héros qui en a plus que ce plafond. */
function heroMaxHp(p) { return Math.max(STARTING_HERO_HP, Number(p.heroMaxHealth) || 0); }
function healedHp(p, amount) { return Math.max(p.heroHealth, Math.min(p.heroHealth + (Number(amount) || 0), heroMaxHp(p))); }
/* Coût réel d'une carte (Bagarre « tout coûte 1 de moins » : match.costMod = -1) */
function costOf(match, card) { return Math.max(0, (Number(card && card.cost) || 0) + (Number(match && match.costMod) || 0)); }

function playCardInner(match, cardPool, playerIndex, cardId, options) {
  if (match.status !== 'active') return { error: 'Partie terminée.' };
  if (match.phase === 'mulligan') return { error: 'Valide d\'abord ta main de départ.' };
  if (match.turn !== playerIndex) return { error: "Ce n'est pas ton tour." };
  const p = match.players[playerIndex];
  const opp = match.players[1 - playerIndex];
  const idx = p.hand.indexOf(cardId);
  if (idx === -1) return { error: "Cette carte n'est pas dans ta main." };
  const card = cardPool.find(c => c.id === cardId);
  if (!card) return { error: 'Carte inconnue.' };
  const cost = costOf(match, card);
  if (p.mana < cost) return { error: 'Mana insuffisant.' };

  if (card.type === 'minion') {
    if (p.board.length >= MAX_BOARD) return { error: 'Ton plateau est plein (7 max).' };
    // Cri de guerre : un effet de sort (piocher, soigner un allié, infliger des
    // dégâts…) qui se déclenche quand le serviteur est posé. Il s'applique AVANT
    // l'arrivée du serviteur, qui ne peut donc pas se cibler lui-même. Un effet
    // à cible sans cible choisie ne se déclenche pas (le serviteur est posé quand même).
    let bcEvents = [];
    // Cri de guerre : jusqu'à 3 effets cumulés (ex. endormir un ennemi + piocher).
    // Le premier effet à cible reçoit la cible choisie par le joueur ; les autres
    // effets à cible la réutilisent si elle leur convient, sinon visent au hasard.
    const bcList = bcEffectsOf(card);
    if (bcList.length) {
      const opts = options || {};
      const rng = match.rng || Math.random;
      const primary = bcList.find(e => TARGETED_EFFECTS.includes(e.effectType));
      if (primary && opts.targetId) {
        const ok = TARGET_SIDE[primary.effectType] === 'ally' ? p.board.some(m => m.instanceId === opts.targetId) : true;
        if (!ok) return { error: 'Cette cible ne convient pas à ce cri de guerre.' };
      }
      const evBefore = (match.events || []).length;
      p.hand.splice(idx, 1); // la carte quitte la main avant les effets (utile pour la pioche)
      let applied = 0;
      for (const e of bcList) {
        const fx = { id: card.id, name: card.name, image: card.image, rarity: card.rarity, type: 'minion', cost: card.cost,
          effectType: e.effectType, value: e.value, value2: e.value2, tokenName: card.tokenName, tokenAttack: card.tokenAttack, tokenHealth: card.tokenHealth, randomPool: card.randomPool };
        let o = {};
        if (TARGETED_EFFECTS.includes(e.effectType)) {
          if (e === primary) { if (!opts.targetType) continue; o = opts; } // sans cible choisie, cet effet ne se déclenche pas
          else o = reusableTarget(e.effectType, opts, p, opp) || randomTargetFor(e.effectType, p, opp, rng);
          if (!o) continue;
        }
        const r = applySpell(match, p, opp, fx, o);
        if (r && r.error) {
          if (e === primary) { (match.events || []).splice(evBefore); p.hand.splice(idx, 0, card.id); return r; }
          continue;
        }
        applied++;
      }
      p.hand.splice(idx, 0, card.id);
      bcEvents = (match.events || []).splice(evBefore);
      if (applied) match.log.push(`Cri de guerre de ${card.name}.`);
    }
    p.mana -= cost;
    p.hand.splice(p.hand.indexOf(card.id), 1);
    p.board.push(createMinionFrom(card));
    match.log.push(`${p.pseudo} invoque ${card.name}.`);
    pushEvent(match, { type: 'play', by: p.slug, card: refCard(card, p) });
    bcEvents.forEach(e => { match.evSeq++; e.seq = match.evSeq; e.battlecry = true; match.events.push(e); });
    if (card.armor) gainArmor(match, p, card.armor, refCard(card, p));
    if (card.battlecryHeal) {
      p.heroHealth = healedHp(p, card.battlecryHeal);
      match.log.push(`Cri de guerre : ${p.pseudo} récupère ${card.battlecryHeal} PV.`);
      pushEvent(match, { type: 'heal', by: p.slug, source: refCard(card, p), targets: [Object.assign(refHero(p), { amount: card.battlecryHeal })] });
    }
  } else if (card.type === 'weapon') {
    // Équiper une nouvelle arme détruit l'ancienne (pas d'empilement), comme dans Hearthstone
    p.mana -= cost;
    p.hand.splice(idx, 1);
    if (p.heroWeapon) match.log.push(`${p.heroWeapon.name} est rangée pour laisser place à ${card.name}.`);
    p.heroWeapon = {
      cardId: card.id, name: card.name, image: card.image || null, rarity: card.rarity,
      attack: Math.max(0, Number(card.attack) || 0),
      durability: Math.max(1, Number(card.durability) || 1),
      maxDurability: Math.max(1, Number(card.durability) || 1),
      usesPerTurn: Math.max(1, Number(card.usesPerTurn) || 1),
      usesThisTurn: 0
    };
    match.log.push(`${p.pseudo} équipe ${card.name} (${p.heroWeapon.attack} ATQ, ${p.heroWeapon.durability} utilisation(s)).`);
    pushEvent(match, { type: 'play', by: p.slug, card: refCard(card, p) });
    if (card.battlecryHeal) {
      p.heroHealth = healedHp(p, card.battlecryHeal);
      match.log.push(`${card.name} rend ${card.battlecryHeal} PV à ${p.pseudo} en s'équipant.`);
      pushEvent(match, { type: 'heal', by: p.slug, source: refCard(card, p), targets: [Object.assign(refHero(p), { amount: card.battlecryHeal })] });
    }
  } else {
    // On valide le sort AVANT de dépenser le mana, pour ne pas perdre la carte sur une cible invalide
    const evBefore = (match.events || []).length;
    const leavesFirst = card.effectType === 'draw'; // ne prend pas une place dans la main pendant la pioche
    if (leavesFirst) p.hand.splice(idx, 1);
    const trial = applySpell(match, p, opp, card, options || {});
    if (!(trial && trial.error)) {
      // l'événement « joue » doit précéder ceux de l'effet du sort dans le journal
      if (!match.events) match.events = [];
      const effects = match.events.splice(evBefore);
      pushEvent(match, { type: 'play', by: p.slug, card: refCard(card, p) });
      effects.forEach(e => { match.evSeq++; e.seq = match.evSeq; match.events.push(e); });
    }
    if (trial && trial.error) { if (leavesFirst) p.hand.splice(idx, 0, card.id); return trial; }
    p.mana -= cost;
    if (!leavesFirst) p.hand.splice(idx, 1);
    match.log.push(`${p.pseudo} lance ${card.name}.`);
  }
  checkWin(match);
  return { ok: true };
}

function attackInner(match, playerIndex, attackerInstanceId, targetType, targetId) {
  if (match.status !== 'active') return { error: 'Partie terminée.' };
  if (match.phase === 'mulligan') return { error: 'Valide d\'abord ta main de départ.' };
  if (match.turn !== playerIndex) return { error: "Ce n'est pas ton tour." };
  const p = match.players[playerIndex];
  const opp = match.players[1 - playerIndex];

  const isHeroAttack = attackerInstanceId === 'hero';
  let attacker = null, attackPower = 0;
  if (isHeroAttack) {
    const w = p.heroWeapon;
    if (!w) return { error: "Tu n'as pas d'arme équipée." };
    if (w.durability <= 0) return { error: 'Cette arme est brisée.' };
    if (w.usesThisTurn >= w.usesPerTurn) return { error: 'Cette arme a déjà été utilisée ce tour-ci.' };
    if (w.attack <= 0) return { error: 'Cette arme ne peut pas attaquer (0 ATQ).' };
    attackPower = w.attack;
  } else {
    attacker = p.board.find(m => m.instanceId === attackerInstanceId);
    if (!attacker) return { error: 'Attaquant introuvable.' };
    if (attacker.sickness) return { error: "Ce serviteur vient d'être invoqué, il ne peut pas encore attaquer." };
    if (attacker.asleep) return { error: 'Ce serviteur est endormi : il ne peut pas attaquer ce tour-ci.' };
    if (!attacker.canAttack) return { error: 'Ce serviteur a déjà attaqué ce tour-ci.' };
    if (attacker.attack <= 0) return { error: 'Ce serviteur ne peut pas attaquer (0 ATQ).' };
    attackPower = attacker.attack;
  }

  // Camouflage : un serviteur camouflé ne peut pas être visé par une attaque
  if (targetType !== 'hero') {
    const tgt = opp.board.find(m => m.instanceId === targetId);
    if (tgt && tgt.stealth) return { error: 'Ce serviteur est camouflé : il ne peut pas être ciblé.' };
  }
  // Règle de Provocation : s'il y a un serviteur avec Provocation en face, il faut le viser
  const tauntUp = hasTaunt(opp);
  if (tauntUp) {
    if (targetType === 'hero') return { error: 'Tu dois d\'abord attaquer un serviteur avec Provocation.' };
    const target = opp.board.find(m => m.instanceId === targetId);
    if (target && !target.taunt) return { error: 'Tu dois d\'abord attaquer un serviteur avec Provocation.' };
  }

  const attackerLabel = isHeroAttack ? `${p.pseudo} (${p.heroWeapon.name})` : attacker.name;
  const attackerRef = isHeroAttack ? Object.assign(refHero(p), { weapon: p.heroWeapon.name }) : refMinion(attacker, p);

  // Daltonisme : le serviteur a X % de chances de se tromper de cible et de
  // frapper au hasard n'importe quel personnage — un ennemi, un allié, ou
  // même son propre héros. La cible tirée au sort ignore la Provocation.
  if (!isHeroAttack && attacker.colorblind) {
    const rng = match.rng || Math.random;
    if (rng() * 100 < (attacker.colorblindChance || 50)) {
      const pool = [{ kind: 'heroOpp' }, { kind: 'heroOwn' }]
        .concat(opp.board.map(m => ({ kind: 'oppMinion', m })))
        .concat(p.board.filter(m => m !== attacker).map(m => ({ kind: 'ownMinion', m })));
      const pick = pool[Math.floor(rng() * pool.length)];
      const pickedRef = pick.kind === 'heroOpp' ? refHero(opp) : pick.kind === 'heroOwn' ? refHero(p) : refMinion(pick.m, pick.kind === 'oppMinion' ? opp : p);
      match.log.push(`Daltonisme ! ${attacker.name} se trompe de cible et frappe ${pickedRef.name}.`);
      pushEvent(match, { type: 'colorblind', by: p.slug, attacker: attackerRef, target: pickedRef });
      if (pick.kind === 'heroOpp') { targetType = 'hero'; }
      else if (pick.kind === 'oppMinion') { targetType = 'minion'; targetId = pick.m.instanceId; }
      else if (pick.kind === 'heroOwn') {
        damageHero(p, attackPower);
        match.log.push(`${attacker.name} frappe son propre héros pour ${attackPower}.`);
        pushEvent(match, { type: 'attack', by: p.slug, attacker: attackerRef, target: refHero(p), dmg: attackPower, back: 0, targetDied: p.heroHealth <= 0, attackerDied: false, colorblind: true });
        spendAttack(attacker);
        checkWin(match);
        return { ok: true, colorblind: true };
      } else {
        const target = pick.m;
        const dealt = applyDamageToMinion(target, attackPower);
        const back = applyDamageToMinion(attacker, target.attack);
        match.log.push(`${attacker.name} affronte son allié ${target.name} (${attackPower} contre ${target.attack}).`);
        pushEvent(match, { type: 'attack', by: p.slug, attacker: attackerRef, target: pickedRef, dmg: dealt, back,
          targetDied: target.health <= 0, attackerDied: attacker.health <= 0, colorblind: true });
        spendAttack(attacker);
        removeDeadMinions(p);
        checkWin(match);
        return { ok: true, colorblind: true };
      }
    }
  }

  if (targetType === 'hero') {
    damageHero(opp, attackPower);
    match.log.push(`${attackerLabel} attaque ${opp.pseudo} pour ${attackPower}.`);
    pushEvent(match, { type: 'attack', by: p.slug, attacker: attackerRef, target: refHero(opp), dmg: attackPower, back: 0, targetDied: opp.heroHealth <= 0, attackerDied: false });
  } else {
    const target = opp.board.find(m => m.instanceId === targetId);
    if (!target) return { error: 'Cible introuvable.' };
    const targetRef = refMinion(target, opp);
    const dealt = applyDamageToMinion(target, attackPower);
    let back;
    if (isHeroAttack) {
      // Un héros qui attaque un serviteur encaisse sa riposte directement (pas d'armure de héros)
      back = Math.max(0, target.attack);
      damageHero(p, target.attack);
    } else {
      back = applyDamageToMinion(attacker, target.attack);
    }
    match.log.push(`${attackerLabel} affronte ${target.name} (${attackPower} contre ${target.attack}).`);
    pushEvent(match, { type: 'attack', by: p.slug, attacker: attackerRef, target: targetRef, dmg: dealt, back,
      targetDied: target.health <= 0, attackerDied: isHeroAttack ? p.heroHealth <= 0 : attacker.health <= 0 });
    removeDeadMinions(opp);
    removeDeadMinions(p);
  }

  if (isHeroAttack) {
    p.heroWeapon.usesThisTurn++;
    p.heroWeapon.durability--;
    if (p.heroWeapon.durability <= 0) {
      match.log.push(`${p.heroWeapon.name} se brise et est rangée.`);
      pushEvent(match, { type: 'break', by: p.slug, name: p.heroWeapon.name });
      p.heroWeapon = null;
    }
  } else {
    spendAttack(attacker);
  }
  checkWin(match);
  return { ok: true };
}

function endTurn(match) {
  if (match.status !== 'active') return { error: 'Partie terminée.' };
  if (match.phase === 'mulligan') return { error: 'Valide d\'abord ta main de départ.' };
  match.turn = 1 - match.turn;
  match.turnNumber++;
  startTurn(match);
  recomputeAuras(match);
  checkWin(match);
  return { ok: true };
}

function redactStateFor(match, cardPool, playerIndex) {
  const me = match.players[playerIndex];
  const opp = match.players[1 - playerIndex];
  return {
    id: match.id, status: match.status, winner: match.winner, forfeitBy: match.forfeitBy || null,
    phase: match.phase, yourMulliganDone: match.mulliganDone ? match.mulliganDone[playerIndex] : true,
    opponentMulliganDone: match.mulliganDone ? match.mulliganDone[1 - playerIndex] : true,
    turnNumber: match.turnNumber, yourTurn: match.phase === 'active' && match.turn === playerIndex,
    log: match.log.slice(-30),
    events: (match.events || []).slice(-40),
    you: {
      slug: me.slug, pseudo: me.pseudo, avatar: me.avatar, ornament: me.ornament, title: me.title || null,
      heroHealth: me.heroHealth, heroArmor: me.heroArmor || 0, mana: me.mana, maxMana: me.maxMana, weapon: me.heroWeapon,
      hand: me.hand.map(id => cardPool.find(c => c.id === id)).filter(Boolean).map(c => match.costMod ? Object.assign({}, c, { cost: costOf(match, c), baseCost: c.cost }) : c),
      board: me.board, libraryCount: me.library.length,
      traps: (me.traps || []).map(t => ({ id: t.id, name: t.name, trapTrigger: t.trapTrigger, trapEffect: t.trapEffect, trapValue: t.trapValue }))
    },
    opponent: {
      slug: opp.slug, pseudo: opp.pseudo, avatar: opp.avatar, ornament: opp.ornament, title: opp.title || null,
      heroHealth: opp.heroHealth, heroArmor: opp.heroArmor || 0, mana: opp.mana, maxMana: opp.maxMana, weapon: opp.heroWeapon,
      handCount: opp.hand.length, board: opp.board, libraryCount: opp.library.length,
      hasTaunt: hasTaunt(opp), trapCount: (opp.traps || []).length
    }
  };
}

module.exports = { costOf, heroMaxHp, STANDING_EVERY, STANDING_MAX, silenceMinion,
  createMinionFrom, recomputeAuras, setHiddenCardCheck, TARGETED_EFFECTS, TRAP_EFFECT_TYPES, TRAP_TRIGGERS, bcEffectsOf, createMatch, submitMulligan, startTurn, playCard, attack, endTurn, checkWin, redactStateFor, hasTaunt };

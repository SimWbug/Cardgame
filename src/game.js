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

function drawWithFatigue(state, match) {
  if (state.library.length === 0) {
    state.fatigue = (state.fatigue || 0) + 1;
    state.heroHealth -= state.fatigue;
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
const TARGETED_EFFECTS = ['damage', 'heal', 'buff_attack', 'buff_ally_and_heal', 'modify_stats'];

function removeDeadMinions(state) {
  state.board = state.board.filter(m => m.health > 0);
}

/* Applique des dégâts à un serviteur en consommant d'abord son armure.
   L'armure absorbe les dégâts point pour point, puis le reste va aux PV. */
function applyDamageToMinion(m, amount) {
  if (amount <= 0) return 0;
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
function refMinion(m, owner) { return { kind: 'minion', name: m.name, image: m.image || null, rarity: m.rarity || null, owner: owner.slug, id: m.instanceId }; }
function refHero(p) { return { kind: 'hero', name: p.pseudo, image: p.avatar || null, owner: p.slug }; }
function refCard(card, owner) {
  return { kind: 'card', id: card.id, name: card.name, image: card.image || null, rarity: card.rarity || null, type: card.type, cost: card.cost, desc: card.desc || '',
    attack: card.attack, health: card.health, durability: card.durability, value: card.value, value2: card.value2, effectType: card.effectType,
    bcEffect: card.bcEffect, bcValue: card.bcValue, bcValue2: card.bcValue2, taunt: card.taunt, charge: card.charge, owner: owner.slug };
}
function pushEvent(match, e) {
  if (!match.events) match.events = [];
  match.evSeq = (match.evSeq || 0) + 1;
  match.events.push(Object.assign({ seq: match.evSeq, turn: match.turnNumber }, e));
  if (match.events.length > 80) match.events.splice(0, match.events.length - 80);
}

function hasTaunt(state) {
  return state.board.some(m => m.taunt && m.health > 0);
}

function createMatch(id, playerAInfo, playerBInfo) {
  const players = [playerAInfo, playerBInfo].map(info => {
    const library = shuffle(info.deck);
    const state = {
      slug: info.slug, pseudo: info.pseudo,
      avatar: info.avatar || null, ornament: info.ornament || 'none',
      library, hand: [], board: [], heroWeapon: null,
      heroHealth: STARTING_HERO_HP, mana: 0, maxMana: 0, fatigue: 0
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
    match.players[0].maxMana = 1;
    match.players[0].mana = 1;
    match.log.push(`${match.players[0].pseudo} commence la partie.`);
    pushEvent(match, { type: 'turn', by: match.players[0].slug, name: match.players[0].pseudo, mana: 1 });
  }
  return { ok: true };
}

function startTurn(match) {
  const p = match.players[match.turn];
  p.maxMana = Math.min(p.maxMana + 1, MAX_MANA);
  p.mana = p.maxMana;
  p.board.forEach(m => { m.canAttack = true; m.sickness = false; });
  if (p.heroWeapon) p.heroWeapon.usesThisTurn = 0;
  drawWithFatigue(p, match);
  match.log.push(`Tour ${match.turnNumber} — c'est au tour de ${p.pseudo} (${p.mana} mana).`);
  pushEvent(match, { type: 'turn', by: p.slug, name: p.pseudo, mana: p.mana });
}

function applySpell(match, caster, opponent, card, options) {
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
      caster.heroHealth -= card.value;
      match.log.push(`${card.name} inflige ${card.value} dégâts à ${caster.pseudo}.`);
      pushEvent(match, { type: 'damage', by: caster.slug, source: refCard(card, caster), targets: [Object.assign(refHero(caster), { amount: card.value })] });
    } else {
      opponent.heroHealth -= card.value;
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
      caster.heroHealth = Math.min(caster.heroHealth + card.value, STARTING_HERO_HP);
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
    caster.heroHealth = Math.min(caster.heroHealth + card.value, STARTING_HERO_HP);
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
    caster.heroHealth = Math.min(caster.heroHealth + healAmount, STARTING_HERO_HP);
    pushEvent(match, { type: 'buff', by: caster.slug, source: refCard(card, caster), targets: [Object.assign(refMinion(target, caster), { amount: card.value })] });
    if (caster.heroHealth > hb2) pushEvent(match, { type: 'heal', by: caster.slug, source: refCard(card, caster), targets: [Object.assign(refHero(caster), { amount: caster.heroHealth - hb2 })] });
    match.log.push(`${card.name} donne +${card.value} ATQ à ${target.name} et rend ${healAmount} PV à ${caster.pseudo}.`);

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

function playCard(match, cardPool, playerIndex, cardId, options) {
  if (match.status !== 'active') return { error: 'Partie terminée.' };
  if (match.phase === 'mulligan') return { error: 'Valide d\'abord ta main de départ.' };
  if (match.turn !== playerIndex) return { error: "Ce n'est pas ton tour." };
  const p = match.players[playerIndex];
  const opp = match.players[1 - playerIndex];
  const idx = p.hand.indexOf(cardId);
  if (idx === -1) return { error: "Cette carte n'est pas dans ta main." };
  const card = cardPool.find(c => c.id === cardId);
  if (!card) return { error: 'Carte inconnue.' };
  if (p.mana < card.cost) return { error: 'Mana insuffisant.' };

  if (card.type === 'minion') {
    if (p.board.length >= MAX_BOARD) return { error: 'Ton plateau est plein (7 max).' };
    // Cri de guerre : un effet de sort (piocher, soigner un allié, infliger des
    // dégâts…) qui se déclenche quand le serviteur est posé. Il s'applique AVANT
    // l'arrivée du serviteur, qui ne peut donc pas se cibler lui-même. Un effet
    // à cible sans cible choisie ne se déclenche pas (le serviteur est posé quand même).
    let bcEvents = [];
    if (card.bcEffect) {
      const opts = options || {};
      const targeted = TARGETED_EFFECTS.includes(card.bcEffect);
      if (!targeted || opts.targetType) {
        const fx = { id: card.id, name: card.name, image: card.image, rarity: card.rarity, type: 'minion', cost: card.cost,
          effectType: card.bcEffect, value: card.bcValue, value2: card.bcValue2 };
        const evBefore = (match.events || []).length;
        p.hand.splice(idx, 1); // la carte quitte la main avant l'effet (utile pour la pioche)
        const r = applySpell(match, p, opp, fx, opts);
        if (r && r.error) { p.hand.splice(idx, 0, card.id); return r; }
        p.hand.splice(idx, 0, card.id);
        bcEvents = (match.events || []).splice(evBefore);
        match.log.push(`Cri de guerre de ${card.name}.`);
      }
    }
    p.mana -= card.cost;
    p.hand.splice(p.hand.indexOf(card.id), 1);
    p.board.push({
      instanceId: uid(), cardId: card.id, name: card.name, image: card.image || null,
      rarity: card.rarity,
      attack: card.attack, health: card.health, maxHealth: card.health,
      armor: Math.max(0, Number(card.armor) || 0),
      taunt: !!card.taunt, charge: !!card.charge,
      colorblind: !!card.colorblind, colorblindChance: Math.max(1, Math.min(100, Math.round(Number(card.colorblindChance) || 50))),
      canAttack: !!card.charge, sickness: !card.charge
    });
    match.log.push(`${p.pseudo} invoque ${card.name}.`);
    pushEvent(match, { type: 'play', by: p.slug, card: refCard(card, p) });
    bcEvents.forEach(e => { match.evSeq++; e.seq = match.evSeq; e.battlecry = true; match.events.push(e); });
    if (card.battlecryHeal) {
      p.heroHealth = Math.min(p.heroHealth + card.battlecryHeal, STARTING_HERO_HP);
      match.log.push(`Cri de guerre : ${p.pseudo} récupère ${card.battlecryHeal} PV.`);
      pushEvent(match, { type: 'heal', by: p.slug, source: refCard(card, p), targets: [Object.assign(refHero(p), { amount: card.battlecryHeal })] });
    }
  } else if (card.type === 'weapon') {
    // Équiper une nouvelle arme détruit l'ancienne (pas d'empilement), comme dans Hearthstone
    p.mana -= card.cost;
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
      p.heroHealth = Math.min(p.heroHealth + card.battlecryHeal, STARTING_HERO_HP);
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
    p.mana -= card.cost;
    if (!leavesFirst) p.hand.splice(idx, 1);
    match.log.push(`${p.pseudo} lance ${card.name}.`);
  }
  checkWin(match);
  return { ok: true };
}

function attack(match, playerIndex, attackerInstanceId, targetType, targetId) {
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
    if (!attacker.canAttack) return { error: 'Ce serviteur a déjà attaqué ce tour-ci.' };
    if (attacker.attack <= 0) return { error: 'Ce serviteur ne peut pas attaquer (0 ATQ).' };
    attackPower = attacker.attack;
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
        p.heroHealth -= attackPower;
        match.log.push(`${attacker.name} frappe son propre héros pour ${attackPower}.`);
        pushEvent(match, { type: 'attack', by: p.slug, attacker: attackerRef, target: refHero(p), dmg: attackPower, back: 0, targetDied: p.heroHealth <= 0, attackerDied: false, colorblind: true });
        attacker.canAttack = false;
        checkWin(match);
        return { ok: true, colorblind: true };
      } else {
        const target = pick.m;
        const dealt = applyDamageToMinion(target, attackPower);
        const back = applyDamageToMinion(attacker, target.attack);
        match.log.push(`${attacker.name} affronte son allié ${target.name} (${attackPower} contre ${target.attack}).`);
        pushEvent(match, { type: 'attack', by: p.slug, attacker: attackerRef, target: pickedRef, dmg: dealt, back,
          targetDied: target.health <= 0, attackerDied: attacker.health <= 0, colorblind: true });
        attacker.canAttack = false;
        removeDeadMinions(p);
        checkWin(match);
        return { ok: true, colorblind: true };
      }
    }
  }

  if (targetType === 'hero') {
    opp.heroHealth -= attackPower;
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
      p.heroHealth -= target.attack;
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
    attacker.canAttack = false;
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
  checkWin(match);
  return { ok: true };
}

function redactStateFor(match, cardPool, playerIndex) {
  const me = match.players[playerIndex];
  const opp = match.players[1 - playerIndex];
  return {
    id: match.id, status: match.status, winner: match.winner,
    phase: match.phase, yourMulliganDone: match.mulliganDone ? match.mulliganDone[playerIndex] : true,
    opponentMulliganDone: match.mulliganDone ? match.mulliganDone[1 - playerIndex] : true,
    turnNumber: match.turnNumber, yourTurn: match.phase === 'active' && match.turn === playerIndex,
    log: match.log.slice(-30),
    events: (match.events || []).slice(-40),
    you: {
      slug: me.slug, pseudo: me.pseudo, avatar: me.avatar, ornament: me.ornament,
      heroHealth: me.heroHealth, mana: me.mana, maxMana: me.maxMana, weapon: me.heroWeapon,
      hand: me.hand.map(id => cardPool.find(c => c.id === id)).filter(Boolean),
      board: me.board, libraryCount: me.library.length
    },
    opponent: {
      slug: opp.slug, pseudo: opp.pseudo, avatar: opp.avatar, ornament: opp.ornament,
      heroHealth: opp.heroHealth, mana: opp.mana, maxMana: opp.maxMana, weapon: opp.heroWeapon,
      handCount: opp.hand.length, board: opp.board, libraryCount: opp.library.length,
      hasTaunt: hasTaunt(opp)
    }
  };
}

module.exports = {
  TARGETED_EFFECTS, createMatch, submitMulligan, startTurn, playCard, attack, endTurn, checkWin, redactStateFor, hasTaunt };

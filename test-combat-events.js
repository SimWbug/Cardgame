/* Journal de combat visuel : le moteur produit des événements exacts
   (qui frappe qui, combien, qui meurt) et le bot joue étape par étape. */
const assert = require('assert');
const game = require('./src/game');
const bot = require('./src/bot');
const { SEED_CARDS } = require('./src/cards');

const minion = SEED_CARDS.find(c => c.type === 'minion' && c.attack >= 2 && !c.charge);
const deck = Array(30).fill(minion.id);
const m = game.createMatch('ev', { slug: 'a', pseudo: 'A', deck }, { slug: 'b', pseudo: 'B', deck });
if (m.phase === 'mulligan') { game.submitMulligan(m, 0, []); game.submitMulligan(m, 1, []); }
// Pose directe de deux serviteurs pour un échange contrôlé
const mk = (id, atk, hp) => ({ instanceId: id, cardId: minion.id, name: 'M' + id, attack: atk, health: hp, maxHealth: hp, armor: 0, taunt: false, charge: false, canAttack: true, sickness: false });
const me = m.players[m.turn], opp = m.players[1 - m.turn];
me.board.push(mk('x', 3, 5)); opp.board.push(mk('y', 2, 3));
const r = game.attack(m, m.turn, 'x', 'minion', 'y');
assert.ok(r.ok);
const e = m.events[m.events.length - 1];
assert.strictEqual(e.type, 'attack');
assert.strictEqual(e.attacker.id, 'x'); assert.strictEqual(e.target.id, 'y');
assert.strictEqual(e.dmg, 3); assert.strictEqual(e.back, 2);
assert.strictEqual(e.targetDied, true); assert.strictEqual(e.attackerDied, false);
console.log('✅ Une attaque produit un événement exact (attaquant, cible, dégâts, riposte, mort).');

const plays = m.events.filter(x => x.type === 'turn');
assert.ok(plays.length >= 1, 'un événement « tour » au début de chaque tour');
const st = game.redactStateFor(m, SEED_CARDS, 0);
assert.ok(Array.isArray(st.events) && st.events.length > 0, 'les événements sont envoyés aux joueurs');
console.log('✅ Les événements de tour sont présents et transmis dans l\'état.');

// Bot pas à pas : chaque action est une étape distincte
const m2 = game.createMatch('bot', { slug: 'h', pseudo: 'H', deck }, { slug: 'bot', pseudo: 'Bot', deck });
if (m2.phase === 'mulligan') { game.submitMulligan(m2, 0, []); game.submitMulligan(m2, 1, []); }
for (let i = 0; i < 8 && m2.status === 'active'; i++) {
  if (m2.turn === 0) { game.endTurn(m2); continue; }
  const before = m2.events.length;
  const it = bot.botTurnSteps(m2, SEED_CARDS);
  let steps = 0, r2;
  while (!(r2 = it.next()).done) { steps++; assert.ok(['play', 'attack'].includes(r2.value)); }
  if (steps > 1) { console.log(`✅ Le bot a joué son tour en ${steps} étapes visibles.`); break; }
}
console.log('\n✅ Journal de combat et tour du bot validés.');

// ---------- Daltonisme : la cible peut changer au hasard ----------
{
  const m3 = game.createMatch('cb', { slug: 'a', pseudo: 'A', deck }, { slug: 'b', pseudo: 'B', deck });
  if (m3.phase === 'mulligan') { game.submitMulligan(m3, 0, []); game.submitMulligan(m3, 1, []); }
  const me3 = m3.players[m3.turn], op3 = m3.players[1 - m3.turn];
  const cb = Object.assign(mk('cb', 4, 6), { colorblind: true, colorblindChance: 100 });
  me3.board.push(cb, mk('ally', 1, 9)); op3.board.push(mk('foe', 1, 9));
  const seq = [0.0, 0.99]; // 1er tirage : déclenche ; 2e : choisit le dernier de la liste (l'allié)
  m3.rng = () => seq.shift();
  const hp0 = me3.heroHealth;
  assert.ok(game.attack(m3, m3.turn, 'cb', 'hero', null).ok);
  const ev = m3.events.filter(x => x.type === 'colorblind').pop();
  assert.ok(ev, 'événement Daltonisme');
  assert.strictEqual(ev.target.id, 'ally', 'la cible tirée au sort est un allié');
  assert.strictEqual(me3.board.find(x => x.instanceId === 'ally').health, 5, "l'allié encaisse les 4 dégâts");
  assert.strictEqual(me3.heroHealth, hp0, 'le héros n\'est pas touché ici');
  console.log('✅ Daltonisme : le serviteur peut frapper un allié tiré au sort.');
  // Chance de 1 % jamais déclenchée avec un tirage haut : attaque normale
  const m4 = game.createMatch('cb2', { slug: 'a', pseudo: 'A', deck }, { slug: 'b', pseudo: 'B', deck });
  if (m4.phase === 'mulligan') { game.submitMulligan(m4, 0, []); game.submitMulligan(m4, 1, []); }
  const me4 = m4.players[m4.turn], op4 = m4.players[1 - m4.turn];
  me4.board.push(Object.assign(mk('cb', 3, 3), { colorblind: true, colorblindChance: 1 }));
  m4.rng = () => 0.5;
  const ohp = op4.heroHealth;
  assert.ok(game.attack(m4, m4.turn, 'cb', 'hero', null).ok);
  assert.strictEqual(op4.heroHealth, ohp - 3, 'sans déclenchement, la cible choisie est frappée');
  console.log('✅ Daltonisme : sans déclenchement, l\'attaque vise bien la cible choisie.');
}

// ---------- Deux effets en un : modifier l'ATQ et les PV ----------
{
  const spell = { id: 'mod', name: 'Mutation', type: 'sort', cost: 1, effectType: 'modify_stats', value: 2, value2: -1, rarity: 'rare' };
  const pool2 = SEED_CARDS.concat([spell]);
  const m5 = game.createMatch('mod', { slug: 'a', pseudo: 'A', deck }, { slug: 'b', pseudo: 'B', deck });
  if (m5.phase === 'mulligan') { game.submitMulligan(m5, 0, []); game.submitMulligan(m5, 1, []); }
  const me5 = m5.players[m5.turn];
  me5.board.push(mk('t', 3, 4)); me5.hand.push('mod'); me5.mana = 5;
  assert.ok(game.playCard(m5, pool2, m5.turn, 'mod', { targetType: 'minion', targetId: 't' }).ok);
  const t = me5.board.find(x => x.instanceId === 't');
  assert.strictEqual(t.attack, 5); assert.strictEqual(t.health, 3);
  const ev = m5.events.filter(x => x.type === 'modify').pop();
  assert.ok(ev && ev.targets[0].atk === 2 && ev.targets[0].hp === -1);
  console.log("✅ Un sort peut retirer des PV et donner de l'ATQ en même temps (+2 ATQ, -1 PV).");
  const spell2 = Object.assign({}, spell, { id: 'mod2', value: -1, value2: 3 });
  me5.hand.push('mod2');
  assert.ok(game.playCard(m5, pool2.concat([spell2]), m5.turn, 'mod2', { targetType: 'minion', targetId: 't' }).ok);
  assert.strictEqual(t.attack, 4); assert.strictEqual(t.health, 6); assert.strictEqual(t.maxHealth, 6);
  console.log("✅ …ou retirer de l'ATQ et donner des PV (-1 ATQ, +3 PV).");
  const kill = Object.assign({}, spell, { id: 'mod3', value: 0, value2: -10 });
  me5.hand.push('mod3');
  assert.ok(game.playCard(m5, pool2.concat([kill]), m5.turn, 'mod3', { targetType: 'minion', targetId: 't' }).ok);
  assert.ok(!me5.board.find(x => x.instanceId === 't'), 'des PV à 0 détruisent le serviteur');
  console.log('✅ Des PV qui tombent à 0 détruisent le serviteur.');
}

// ---------- Pioche (sort) et cris de guerre à effet de sort (serviteurs) ----------
{
  const drawSpell = { id: 'pioche2', name: 'Inspiration', type: 'sort', cost: 1, effectType: 'draw', value: 2, rarity: 'commun' };
  const healer = { id: 'soigneur', name: 'Soigneuse', type: 'minion', cost: 1, attack: 1, health: 1, rarity: 'rare', bcEffect: 'heal', bcValue: 1 };
  const scholar = { id: 'erudit', name: 'Érudit', type: 'minion', cost: 1, attack: 1, health: 1, rarity: 'commun', bcEffect: 'draw', bcValue: 1 };
  const pool3 = SEED_CARDS.concat([drawSpell, healer, scholar]);
  const m6 = game.createMatch('draw', { slug: 'a', pseudo: 'A', deck }, { slug: 'b', pseudo: 'B', deck });
  if (m6.phase === 'mulligan') { game.submitMulligan(m6, 0, []); game.submitMulligan(m6, 1, []); }
  const me6 = m6.players[m6.turn]; me6.mana = 10;
  me6.hand.push('pioche2');
  const h0 = me6.hand.length, lib0 = me6.library.length;
  assert.ok(game.playCard(m6, pool3, m6.turn, 'pioche2', {}).ok);
  assert.strictEqual(me6.hand.length, h0 - 1 + 2, 'le sort quitte la main et 2 cartes arrivent');
  assert.strictEqual(me6.library.length, lib0 - 2);
  assert.ok(m6.events.some(e => e.type === 'draw' && e.amount === 2));
  console.log('✅ Un sort de pioche fait piocher le nombre de cartes choisi.');
  me6.hand.push('erudit');
  const h1 = me6.hand.length;
  assert.ok(game.playCard(m6, pool3, m6.turn, 'erudit', {}).ok);
  assert.strictEqual(me6.hand.length, h1 - 1 + 1, 'cri de guerre : pioche 1 carte');
  assert.ok(me6.board.some(x => x.cardId === 'erudit'));
  console.log('✅ Un serviteur peut piocher une carte en arrivant sur le plateau.');
  const ally = mk('allie', 2, 5); ally.health = 3; me6.board.push(ally);
  me6.hand.push('soigneur');
  assert.ok(game.playCard(m6, pool3, m6.turn, 'soigneur', { targetType: 'minion', targetId: 'allie' }).ok);
  assert.strictEqual(ally.health, 4, 'cri de guerre : +1 PV à un allié');
  const order = m6.events.slice(-2).map(e => e.type);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(order)), ['play', 'heal'], 'le journal montre la pose puis l\'effet');
  console.log('✅ Un serviteur peut donner un point de vie à un allié en arrivant.');
  me6.hand.push('soigneur');
  assert.ok(game.playCard(m6, pool3, m6.turn, 'soigneur', {}).ok, 'sans cible choisie, le serviteur est posé sans effet');
  console.log('✅ Cri de guerre sans cible : le serviteur est posé quand même.');
}

// ---------- Armure du héros : points de bouclier perdus avant les PV ----------
{
  const tank = { id: 'gardien', name: 'Gardien', type: 'minion', cost: 1, attack: 1, health: 3, rarity: 'rare', armor: 4 };
  const shield = { id: 'bouclier', name: 'Bouclier', type: 'sort', cost: 1, effectType: 'armor', value: 3, rarity: 'commun' };
  const pool4 = SEED_CARDS.concat([tank, shield]);
  const m7 = game.createMatch('armor', { slug: 'a', pseudo: 'A', deck }, { slug: 'b', pseudo: 'B', deck });
  if (m7.phase === 'mulligan') { game.submitMulligan(m7, 0, []); game.submitMulligan(m7, 1, []); }
  const me7 = m7.players[m7.turn], op7 = m7.players[1 - m7.turn]; me7.mana = 10;
  me7.hand.push('gardien', 'bouclier');
  assert.ok(game.playCard(m7, pool4, m7.turn, 'gardien', {}).ok);
  assert.strictEqual(me7.heroArmor, 4, "l'armure de la carte va au héros");
  assert.strictEqual(me7.board.find(x => x.cardId === 'gardien').armor, 0, "le serviteur lui-même n'a pas d'armure");
  assert.ok(game.playCard(m7, pool4, m7.turn, 'bouclier', {}).ok);
  assert.strictEqual(me7.heroArmor, 7, "un sort d'armure s'ajoute");
  const st7 = game.redactStateFor(m7, pool4, m7.turn);
  assert.strictEqual(st7.you.heroArmor, 7); assert.strictEqual(game.redactStateFor(m7, pool4, 1 - m7.turn).opponent.heroArmor, 7);
  game.endTurn(m7);
  op7.board.push(mk('brute', 9, 9));
  const hp = me7.heroHealth;
  assert.ok(game.attack(m7, m7.turn, 'brute', 'hero', null).ok);
  assert.strictEqual(me7.heroArmor, 0, "l'armure absorbe d'abord");
  assert.strictEqual(me7.heroHealth, hp - 2, 'puis le reste retire des PV (9 dégâts - 7 armure = 2)');
  console.log("✅ L'armure va au héros, s'affiche des deux côtés et absorbe les dégâts avant les PV.");
}

// ---------- Endormissement : le serviteur ne peut plus attaquer pendant N tours ----------
{
  const sleepy = { id: 'berceuse', name: 'Berceuse', type: 'sort', cost: 1, effectType: 'sleep', value: 1, rarity: 'rare' };
  const sleepy2 = Object.assign({}, sleepy, { id: 'berceuse2', value: 2 });
  const sandman = { id: 'marchand', name: 'Marchand de sable', type: 'minion', cost: 1, attack: 1, health: 1, rarity: 'epique', bcEffect: 'sleep', bcValue: 1 };
  const pool5 = SEED_CARDS.concat([sleepy, sleepy2, sandman]);
  const m8 = game.createMatch('sleep', { slug: 'a', pseudo: 'A', deck }, { slug: 'b', pseudo: 'B', deck });
  if (m8.phase === 'mulligan') { game.submitMulligan(m8, 0, []); game.submitMulligan(m8, 1, []); }
  const A = m8.turn, me8 = m8.players[A], op8 = m8.players[1 - A]; me8.mana = 10;
  op8.board.push(mk('ogre', 5, 5));
  me8.hand.push('berceuse');
  assert.ok(game.playCard(m8, pool5, A, 'berceuse', { targetType: 'minion', targetId: 'ogre' }).ok);
  game.endTurn(m8); // tour de l'adversaire : l'ogre dort
  const r = game.attack(m8, 1 - A, 'ogre', 'hero', null);
  assert.ok(r.error && r.error.includes('endormi'), "un serviteur endormi ne peut pas attaquer");
  game.endTurn(m8); game.endTurn(m8); // son tour suivant : réveillé
  assert.ok(game.attack(m8, 1 - A, 'ogre', 'hero', null).ok, 'il se réveille au tour suivant');
  console.log('✅ Endormissement (sort) : le serviteur ennemi perd son prochain tour d\'attaque, puis se réveille.');
  // 2 tours
  game.endTurn(m8); // à nous
  const me = m8.players[m8.turn]; me.mana = 10; me.hand.push('berceuse2');
  const ogre = op8.board[0]; ogre.canAttack = true;
  assert.ok(game.playCard(m8, pool5, m8.turn, 'berceuse2', { targetType: 'minion', targetId: 'ogre' }).ok);
  game.endTurn(m8); assert.ok(game.attack(m8, m8.turn, 'ogre', 'hero', null).error, 'tour 1 : endormi');
  game.endTurn(m8); game.endTurn(m8); assert.ok(game.attack(m8, m8.turn, 'ogre', 'hero', null).error, 'tour 2 : encore endormi');
  game.endTurn(m8); game.endTurn(m8); assert.ok(game.attack(m8, m8.turn, 'ogre', 'hero', null).ok, 'tour 3 : réveillé');
  console.log('✅ Endormissement de 2 tours : deux tours sans attaquer, réveil au troisième.');
  // Serviteur avec cri de guerre « endormir »
  game.endTurn(m8);
  const me2 = m8.players[m8.turn]; me2.mana = 10; me2.hand.push('marchand');
  op8.board[0].asleep = false; op8.board[0].asleepTurns = 0;
  assert.ok(game.playCard(m8, pool5, m8.turn, 'marchand', { targetType: 'minion', targetId: 'ogre' }).ok);
  assert.ok(op8.board[0].asleep, 'le cri de guerre endort la cible');
  assert.ok(m8.events.some(e => e.type === 'sleep' && e.battlecry), 'le journal montre l\'endormissement');
  console.log('✅ Un serviteur peut endormir une cible en arrivant (cri de guerre).');
}

// ---------- Détruire une cible (sort et cri de guerre) ----------
{
  const kill = { id: 'assassinat', name: 'Assassinat', type: 'sort', cost: 1, effectType: 'destroy', rarity: 'epique' };
  const killer = { id: 'bourreau', name: 'Bourreau', type: 'minion', cost: 1, attack: 2, health: 2, rarity: 'legendaire', bcEffect: 'destroy' };
  const pool6 = SEED_CARDS.concat([kill, killer]);
  const m9 = game.createMatch('kill', { slug: 'a', pseudo: 'A', deck }, { slug: 'b', pseudo: 'B', deck });
  if (m9.phase === 'mulligan') { game.submitMulligan(m9, 0, []); game.submitMulligan(m9, 1, []); }
  const me9 = m9.players[m9.turn], op9 = m9.players[1 - m9.turn]; me9.mana = 10;
  op9.board.push(Object.assign(mk('titan', 9, 30), { armor: 10 }), mk('rat', 1, 1));
  me9.hand.push('assassinat', 'bourreau');
  assert.ok(game.playCard(m9, pool6, m9.turn, 'assassinat', { targetType: 'minion', targetId: 'titan' }).ok);
  assert.ok(!op9.board.find(x => x.instanceId === 'titan'), 'détruit quels que soient ses PV et son armure');
  assert.ok(op9.board.find(x => x.instanceId === 'rat'), 'seule la cible choisie est détruite');
  const ev = m9.events.filter(e => e.type === 'destroy').pop();
  assert.ok(ev && !ev.area && ev.targets[0].id === 'titan' && ev.targets[0].died);
  console.log('✅ Un sort détruit précisément le serviteur choisi.');
  assert.ok(game.playCard(m9, pool6, m9.turn, 'bourreau', { targetType: 'minion', targetId: 'rat' }).ok);
  assert.strictEqual(op9.board.length, 0); assert.ok(me9.board.some(x => x.cardId === 'bourreau'));
  console.log('✅ Un serviteur peut détruire une cible en arrivant (cri de guerre).');
}

// ---------- Bouclier, Furie, Camouflage, Râle d'agonie et sorts qui les donnent ----------
{
  const fresh = () => {
    const mm = game.createMatch('kw' + Math.random(), { slug: 'a', pseudo: 'A', deck }, { slug: 'b', pseudo: 'B', deck });
    game.submitMulligan(mm, 0, []); game.submitMulligan(mm, 1, []);
    return mm;
  };
  // Bouclier
  let g = fresh(); let me = g.players[g.turn], op = g.players[1 - g.turn];
  me.board.push(mk('x', 3, 5)); op.board.push(Object.assign(mk('bulle', 2, 2), { shield: true }));
  assert.ok(game.attack(g, g.turn, 'x', 'minion', 'bulle').ok);
  let bulle = op.board.find(m => m.instanceId === 'bulle');
  assert.ok(bulle && bulle.health === 2 && !bulle.shield, 'le Bouclier absorbe le premier coup puis disparaît');
  console.log('✅ Bouclier : le premier coup est ignoré.');
  // Furie
  g = fresh(); me = g.players[g.turn];
  me.board.push(Object.assign(mk('furie', 2, 5), { windfury: true, attacksLeft: 2 }));
  assert.ok(game.attack(g, g.turn, 'furie', 'hero', null).ok);
  assert.ok(game.attack(g, g.turn, 'furie', 'hero', null).ok, 'Furie : deuxième attaque');
  assert.ok(game.attack(g, g.turn, 'furie', 'hero', null).error, 'pas de troisième');
  console.log('✅ Furie : deux attaques par tour.');
  // Camouflage
  g = fresh(); me = g.players[g.turn]; op = g.players[1 - g.turn];
  me.board.push(mk('x', 3, 5)); op.board.push(Object.assign(mk('ombre', 2, 2), { stealth: true, taunt: true }));
  assert.ok(game.attack(g, g.turn, 'x', 'minion', 'ombre').error.includes('camouflé'), 'un serviteur camouflé ne peut pas être attaqué');
  assert.ok(game.attack(g, g.turn, 'x', 'hero', null).ok, "une Provocation camouflée n'oblige pas à l'attaquer");
  console.log('✅ Camouflage : impossible à cibler, et sa Provocation ne bloque pas.');
  // Râle d'agonie
  g = fresh(); me = g.players[g.turn]; op = g.players[1 - g.turn];
  me.board.push(mk('x', 5, 9)); op.board.push(Object.assign(mk('kami', 1, 1), { drEffect: 'damage', drValue: 4 }));
  g.rng = () => 0.99; // cible au hasard : le héros (dernier choix)
  const hp0 = me.heroHealth;
  assert.ok(game.attack(g, g.turn, 'x', 'minion', 'kami').ok);
  assert.ok(g.events.some(e => e.type === 'deathrattle'), "le journal annonce le Râle d'agonie");
  assert.strictEqual(me.heroHealth, hp0 - 4, "à sa mort, il inflige 4 dégâts (au héros adverse tiré au sort)");
  console.log("✅ Râle d'agonie : l'effet se déclenche à la mort du serviteur.");
  // Sorts qui donnent ces effets
  const gifts = ['give_shield', 'give_windfury', 'give_stealth', 'give_taunt'].map((et, i) => ({ id: 'don' + i, name: 'Don ' + i, type: 'sort', cost: 0, effectType: et, rarity: 'commun' }));
  const giveDr = { id: 'don-dr', name: 'Dernier souffle', type: 'sort', cost: 0, effectType: 'give_deathrattle', drEffect: 'draw', drValue: 2, rarity: 'rare' };
  const pool7 = SEED_CARDS.concat(gifts, [giveDr]);
  g = fresh(); me = g.players[g.turn]; me.mana = 10;
  me.board.push(mk('y', 2, 2));
  gifts.concat([giveDr]).forEach(c => { me.hand.push(c.id); assert.ok(game.playCard(g, pool7, g.turn, c.id, { targetType: 'minion', targetId: 'y' }).ok, c.effectType); });
  const y = me.board.find(m => m.instanceId === 'y');
  assert.ok(y.shield && y.windfury && y.stealth && y.taunt && y.drEffect === 'draw');
  assert.strictEqual(y.attacksLeft, 2, 'Furie donnée pendant le tour : une attaque de plus tout de suite');
  console.log('✅ Des sorts peuvent donner Bouclier, Furie, Camouflage, Provocation et un Râle d\'agonie.');
}

// ---------- Cri de guerre à effets cumulés (ex. Furie + endormir un ennemi + piocher) ----------
{
  const combo = { id: 'combo', name: 'Marchand de rêves', type: 'minion', cost: 1, attack: 2, health: 2, rarity: 'epique', windfury: true,
    bcEffect: 'sleep', bcValue: 1, bc2Effect: 'draw', bc2Value: 1, bc3Effect: 'damage', bc3Value: 2 };
  const pool8 = SEED_CARDS.concat([combo]);
  const g = game.createMatch('combo', { slug: 'a', pseudo: 'A', deck }, { slug: 'b', pseudo: 'B', deck });
  game.submitMulligan(g, 0, []); game.submitMulligan(g, 1, []);
  const me = g.players[g.turn], op = g.players[1 - g.turn]; me.mana = 10;
  op.board.push(mk('cible', 3, 5));
  me.hand.push('combo');
  const h = me.hand.length;
  assert.ok(game.playCard(g, pool8, g.turn, 'combo', { targetType: 'minion', targetId: 'cible' }).ok);
  const cible = op.board.find(m => m.instanceId === 'cible');
  assert.ok(cible.asleep, 'effet 1 : la cible choisie est endormie');
  assert.strictEqual(me.hand.length, h - 1 + 1, 'effet 2 : une carte piochée');
  assert.strictEqual(cible.health, 3, 'effet 3 : les dégâts réutilisent la même cible');
  const placed = me.board.find(m => m.cardId === 'combo');
  assert.ok(placed.windfury && placed.attacksLeft === 2, 'et le serviteur garde sa Furie');
  console.log('✅ Cri de guerre cumulé : Furie + endormir + piocher + dégâts sur la même cible.');
}

// ---------- Invocation, pièges, auras ----------
{
  const summon = { id: 'appel', name: 'Appel de la rue', type: 'sort', cost: 1, effectType: 'summon', value: 2, tokenName: 'Petite frappe', tokenAttack: 1, tokenHealth: 1, rarity: 'commun' };
  const caller = { id: 'chef', name: 'Chef de bande', type: 'minion', cost: 1, attack: 2, health: 2, rarity: 'rare', bcEffect: 'summon', bcValue: 1, tokenName: 'Recrue', tokenAttack: 2, tokenHealth: 1 };
  const banner = { id: 'banniere', name: 'Porte-drapeau', type: 'minion', cost: 1, attack: 1, health: 3, rarity: 'rare', auraAttack: 1, auraScope: 'others' };
  const trap = { id: 'piege', name: 'Piège à loup', type: 'sort', cost: 1, effectType: 'trap', trapTrigger: 'enemy_attack', trapEffect: 'sleep', trapValue: 1, rarity: 'rare' };
  const trap2 = { id: 'embuscade', name: 'Embuscade', type: 'sort', cost: 1, effectType: 'trap', trapTrigger: 'enemy_minion', trapEffect: 'damage', trapValue: 2, rarity: 'rare' };
  const pool9 = SEED_CARDS.concat([summon, caller, banner, trap, trap2]);
  const g = game.createMatch('mech', { slug: 'a', pseudo: 'A', deck }, { slug: 'b', pseudo: 'B', deck });
  game.submitMulligan(g, 0, []); game.submitMulligan(g, 1, []);
  const A = g.turn, me = g.players[A], op = g.players[1 - A]; me.mana = 10;
  me.hand.push('appel', 'chef', 'banniere', 'piege');
  assert.ok(game.playCard(g, pool9, A, 'appel', {}).ok);
  assert.strictEqual(me.board.filter(m => m.name === 'Petite frappe').length, 2, 'sort : 2 jetons invoqués');
  assert.ok(game.playCard(g, pool9, A, 'chef', {}).ok);
  assert.ok(me.board.some(m => m.name === 'Recrue' && m.attack === 2), 'cri de guerre : un jeton 2/1');
  console.log('✅ Invocation : un sort et un cri de guerre font apparaître des jetons.');
  const frappe = me.board.find(m => m.name === 'Petite frappe');
  assert.ok(game.playCard(g, pool9, A, 'banniere', {}).ok);
  assert.strictEqual(frappe.attack, 2, 'aura : +1 ATQ aux autres serviteurs');
  assert.strictEqual(me.board.find(m => m.cardId === 'banniere').attack, 1, "l'aura ne se donne pas à elle-même");
  me.board.find(m => m.cardId === 'banniere').health = 0;
  game.endTurn(g); // la bannière morte disparaît : l'aura s'en va
  me.board = me.board.filter(m => m.health > 0);
  game.endTurn(g);
  assert.strictEqual(frappe.attack, 1, "l'aura disparaît avec le serviteur");
  console.log("✅ Aura : +1 ATQ aux alliés tant que le serviteur est en vie.");
  // Piège : quand un ennemi attaque, il est endormi et l'attaque n'a pas lieu
  me.mana = 10; me.hand.push('piege');
  assert.ok(game.playCard(g, pool9, g.turn, 'piege', {}).ok);
  assert.strictEqual(game.redactStateFor(g, pool9, 1 - g.turn).opponent.trapCount, 1, "l'adversaire voit seulement qu'il y a un piège");
  game.endTurn(g);
  const brute = mk('brute', 5, 5); g.players[g.turn].board.push(brute);
  const hp = me.heroHealth;
  assert.ok(game.attack(g, g.turn, 'brute', 'hero', null).ok);
  assert.ok(brute.asleep && me.heroHealth === hp, "piège : l'attaquant est endormi et ne frappe pas");
  assert.ok(g.events.some(e => e.type === 'trap'));
  console.log("✅ Piège : posé face cachée, il endort l'ennemi qui attaque.");
  // Piège « quand l'adversaire pose un serviteur »
  game.endTurn(g); me.mana = 10; me.hand.push('embuscade');
  assert.ok(game.playCard(g, pool9, g.turn, 'embuscade', {}).ok);
  game.endTurn(g);
  const foe = g.players[g.turn]; foe.mana = 10; foe.hand.push('banniere');
  assert.ok(game.playCard(g, pool9, g.turn, 'banniere', {}).ok);
  assert.strictEqual(foe.board.find(m => m.cardId === 'banniere').health, 1, 'embuscade : 2 dégâts au serviteur posé');
  console.log("✅ Piège : il frappe le serviteur que l'adversaire vient de poser.");
}

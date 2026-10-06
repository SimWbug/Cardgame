/* ======================================================
   Puzzle du jour
   Une situation de combat fixe, la même pour tout le monde : il faut gagner
   pendant ce tour-ci. Le puzzle est fabriqué automatiquement chaque jour à
   partir des cartes du jeu, puis RÉSOLU par le serveur (recherche de toutes
   les suites d'actions possibles) : les PV de l'adversaire sont réglés sur le
   maximum de dégâts atteignable, donc il existe toujours une solution, et
   attaquer bêtement la tête ne suffit pas.
   ====================================================== */
const game = require('./game');
const { readJSON, writeJSON } = require('./store');

const FILE = 'puzzles.json';
const KEEP_DAYS = 14;
const NODE_BUDGET = 40000;
const REWARD = { credits: 50, dust: 25, xp: 40 };
const STREAK_BOOSTER_EVERY = 7; // un booster tous les 7 jours de suite

// Effets sans hasard ni pioche : le puzzle doit avoir une solution sûre
const SPELL_OK = ['damage', 'buff_attack', 'aoe_damage', 'damage_all', 'buff_all_allies', 'buff_ally_and_heal', 'modify_stats',
  'sleep', 'destroy', 'silence', 'give_windfury', 'give_taunt', 'give_shield', 'give_stealth', 'summon'];
const BC_OK = ['damage', 'buff_attack', 'aoe_damage', 'damage_all', 'buff_all_allies', 'buff_ally_and_heal', 'modify_stats',
  'sleep', 'destroy', 'silence', 'give_windfury', 'give_taunt', 'give_shield', 'give_stealth', 'summon', 'armor', 'heal'];

function dayKey(now) { return new Date(now || Date.now()).toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' }); }
function seeded(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  let a = h >>> 0;
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/* Cartes utilisables dans un puzzle (aucun effet au hasard, pas de pioche, pas de piège) */
function puzzleCards(pool) {
  const minionOk = c => c.type === 'minion' && !c.colorblind && !c.comboPartnerId && !c.drEffect && !c.bc2Effect && !c.bc3Effect &&
    !c.randomPool && (!c.bcEffect || BC_OK.includes(c.bcEffect)) && Number(c.attack) >= 0 && Number(c.health) > 0;
  const spellOk = c => c.type !== 'minion' && c.type !== 'weapon' && SPELL_OK.includes(c.effectType);
  const weaponOk = c => c.type === 'weapon' && Number(c.attack) > 0;
  return {
    minions: pool.filter(minionOk),
    spells: pool.filter(spellOk),
    weapons: pool.filter(weaponOk)
  };
}

/* ---------- Mise en place d'une situation dans un combat ---------- */
function readyMinion(card, extra) {
  const m = game.createMinionFrom(card);
  Object.assign(m, { canAttack: true, sickness: false, attacksLeft: card.windfury ? 2 : 1 }, extra || {});
  return m;
}
/* sit = { myBoard:[{cardId}], oppBoard:[{cardId, taunt}], hand:[ids], mana, oppHp, myHp } */
function install(match, sit, pool) {
  const byId = id => pool.find(c => c.id === id);
  game.submitMulligan(match, 0, []); game.submitMulligan(match, 1, []);
  match.turn = 0; match.turnNumber = 1;
  const me = match.players[0], foe = match.players[1];
  me.hand = sit.hand.filter(byId).slice();
  me.library = []; foe.library = []; foe.hand = [];
  me.board = sit.myBoard.map(x => byId(x.cardId)).filter(Boolean).map(c => readyMinion(c));
  foe.board = sit.oppBoard.filter(x => byId(x.cardId)).map(x => readyMinion(byId(x.cardId), x.taunt ? { taunt: true } : {}));
  me.maxMana = sit.mana; me.mana = sit.mana;
  me.heroHealth = sit.myHp || 30; foe.heroHealth = sit.oppHp; foe.heroMaxHealth = Math.max(30, sit.oppHp);
  me.heroArmor = 0; foe.heroArmor = 0; me.heroWeapon = null; foe.heroWeapon = null;
  me.traps = []; foe.traps = [];
  game.recomputeAuras(match);
}
function freshMatch(sit, pool, hp) {
  const info = (slug) => ({ slug, pseudo: slug, deck: [] });
  const m = game.createMatch('puzzle-solve', info('joueur'), info('adversaire'));
  install(m, Object.assign({}, sit, { oppHp: hp }), pool);
  m.log = []; m.events = []; m.evSeq = 0;
  m.rng = () => 0.5;
  return m;
}

/* ---------- Résolution : dégâts maximum infligeables ce tour-ci ---------- */
function clone(m) {
  const c = JSON.parse(JSON.stringify(m, (k, v) => (k === '__pool' || k === 'log' || k === 'events' ? undefined : v)));
  c.log = []; c.events = []; c.rng = () => 0.5;
  return c;
}
function stateKey(m) {
  const mini = b => b.map(x => [x.cardId, x.attack, x.health, x.attacksLeft, x.canAttack ? 1 : 0, x.shield ? 1 : 0, x.taunt ? 1 : 0, x.stealth ? 1 : 0, x.asleep ? 1 : 0, x.windfury ? 1 : 0, x.silenced ? 1 : 0]);
  const [a, b] = m.players;
  return JSON.stringify([a.hand.slice().sort(), a.mana, mini(a.board), a.heroWeapon && [a.heroWeapon.attack, a.heroWeapon.durability, a.heroWeapon.usesThisTurn], a.heroHealth, b.heroHealth, mini(b.board)]);
}
function actionsFor(m, pool) {
  const me = m.players[0], foe = m.players[1];
  const out = [];
  const allTargets = [{}, { targetType: 'hero' }]
    .concat(foe.board.map(x => ({ targetType: 'minion', targetId: x.instanceId })))
    .concat(me.board.map(x => ({ targetType: 'minion', targetId: x.instanceId })));
  [...new Set(me.hand)].forEach(id => {
    const c = pool.find(x => x.id === id);
    if (!c || game.costOf(m, c) > me.mana) return;
    if (c.type === 'weapon') { out.push({ kind: 'play', cardId: id, opt: {} }); return; }
    const targeted = c.type === 'minion' ? (c.bcEffect && game.TARGETED_EFFECTS.includes(c.bcEffect)) : game.TARGETED_EFFECTS.includes(c.effectType);
    (targeted ? allTargets : [{}]).forEach(opt => out.push({ kind: 'play', cardId: id, opt }));
  });
  me.board.forEach(a => {
    if (!a.canAttack || a.sickness || a.asleep || a.attack <= 0) return;
    out.push({ kind: 'attack', attackerId: a.instanceId, targetType: 'hero' });
    foe.board.forEach(t => out.push({ kind: 'attack', attackerId: a.instanceId, targetType: 'minion', targetId: t.instanceId }));
  });
  const w = me.heroWeapon;
  if (w && w.durability > 0 && w.usesThisTurn < w.usesPerTurn && w.attack > 0) {
    out.push({ kind: 'attack', attackerId: 'hero', targetType: 'hero' });
    foe.board.forEach(t => out.push({ kind: 'attack', attackerId: 'hero', targetType: 'minion', targetId: t.instanceId }));
  }
  return out;
}
function doAction(m, pool, a) {
  return a.kind === 'play' ? game.playCard(m, pool, 0, a.cardId, a.opt) : game.attack(m, 0, a.attackerId, a.targetType, a.targetId);
}
/* Renvoie { best: PV adverses les plus bas atteignables, line: actions, nodes } */
function solve(start, pool, budget) {
  const seen = new Set();
  let nodes = 0, best = start.players[1].heroHealth, line = [];
  const path = [];
  (function dfs(m) {
    if (nodes++ > (budget || NODE_BUDGET)) return;
    const hp = m.players[1].heroHealth;
    if (hp < best || (hp === best && path.length < line.length)) { best = hp; line = path.slice(); }
    if (m.status !== 'active' || m.players[0].heroHealth <= 0) return;
    const key = stateKey(m);
    if (seen.has(key)) return;
    seen.add(key);
    for (const a of actionsFor(m, pool)) {
      const c = clone(m);
      const r = doAction(c, pool, a);
      if (!r || r.error) continue;
      if (c.players[0].heroHealth <= 0) continue; // on ne se tue pas soi-même
      path.push(Object.assign({}, a, { snap: describeTarget(m, a) }));
      dfs(c);
      path.pop();
      if (nodes > (budget || NODE_BUDGET)) return;
    }
  })(start);
  return { best, line, nodes, exhausted: nodes <= (budget || NODE_BUDGET) };
}
function describeTarget(m, a) {
  const me = m.players[0], foe = m.players[1];
  const find = id => {
    let i = me.board.findIndex(y => y.instanceId === id);
    if (i >= 0) return { name: me.board[i].name, mine: true, idx: i };
    i = foe.board.findIndex(y => y.instanceId === id);
    return i >= 0 ? { name: foe.board[i].name, mine: false, idx: i } : null;
  };
  const tId = a.kind === 'play' ? (a.opt && a.opt.targetType === 'minion' ? a.opt.targetId : null) : (a.targetType === 'minion' ? a.targetId : null);
  const heroT = a.kind === 'play' ? (a.opt && a.opt.targetType === 'hero') : a.targetType === 'hero';
  return {
    attacker: a.kind === 'attack' ? (a.attackerId === 'hero' ? { name: 'ton arme', mine: true, weapon: true } : find(a.attackerId)) : null,
    target: tId ? find(tId) : heroT ? { name: 'le héros adverse', hero: true } : null
  };
}
function solutionText(line, pool) {
  return line.map(a => {
    const t = a.snap && a.snap.target;
    const tn = t ? (t.hero ? 'le héros adverse' : `${t.mine ? 'ton' : "l'ennemi"} ${t.name}`) : '';
    if (a.kind === 'play') { const c = pool.find(x => x.id === a.cardId); return `Joue ${c ? c.name : '?'}${tn ? ' sur ' + tn : ''}`; }
    return `${a.snap && a.snap.attacker ? (a.snap.attacker.weapon ? 'Ton arme' : a.snap.attacker.name) : '?'} attaque ${tn || '?'}`;
  });
}
/* Dégâts en attaquant simplement la tête avec tout ce qui peut attaquer, sans jouer de carte */
function naiveDamage(start, pool) {
  const m = clone(start), hp0 = m.players[1].heroHealth;
  m.players[0].board.slice().forEach(a => { for (let i = 0; i < 2; i++) game.attack(m, 0, a.instanceId, 'hero'); });
  return hp0 - m.players[1].heroHealth;
}

/* ---------- Fabrication du puzzle du jour ---------- */
const BIG_HP = 200;
function generate(pool, key, opts) {
  opts = opts || {};
  const P = puzzleCards(pool);
  if (P.minions.length < 4) return null;
  const rng = seeded('puzzle:' + key);
  const pick = list => list[Math.floor(rng() * list.length)];
  const deadline = Date.now() + (opts.ms || 6000); // jamais plus de quelques secondes de calcul
  for (let attempt = 0; attempt < (opts.attempts || 60) && Date.now() < deadline; attempt++) {
    const myN = 2 + Math.floor(rng() * 3), oppN = 1 + Math.floor(rng() * 3), handN = 2 + Math.floor(rng() * 2);
    const sit = {
      myBoard: Array.from({ length: myN }, () => ({ cardId: pick(P.minions).id })),
      oppBoard: Array.from({ length: oppN }, (_, i) => ({ cardId: pick(P.minions).id, taunt: i === 0 && rng() < 0.75 })),
      hand: Array.from({ length: handN }, () => { const r = rng(); const list = r < 0.6 && P.spells.length ? P.spells : r < 0.75 && P.weapons.length ? P.weapons : P.minions; return pick(list).id; }),
      mana: 3 + Math.floor(rng() * 6),
      myHp: 5 + Math.floor(rng() * 20)
    };
    const start = freshMatch(sit, pool, BIG_HP);
    const res = solve(start, pool, NODE_BUDGET);
    if (!res.exhausted) continue; // trop de possibilités : on ne peut pas garantir la meilleure solution
    const dmg = BIG_HP - res.best;
    const naive = naiveDamage(start, pool);
    const usesCard = res.line.some(a => a.kind === 'play');
    if (dmg < 6 || dmg > 30 || dmg - naive < 2 || res.line.length < 3 || !usesCard) continue;
    sit.oppHp = dmg;
    // Vérification : la solution trouvée gagne bien avec ces PV
    const check = freshMatch(sit, pool, dmg);
    const ok = replayLine(check, res.line, pool);
    if (!ok) continue;
    return Object.assign(sit, { day: key, steps: res.line.length, solution: solutionText(res.line, pool), naive,
      difficulty: res.line.length >= 6 ? 3 : res.line.length >= 4 ? 2 : 1 });
  }
  return null;
}
/* Rejoue une solution sur un nouveau combat : les identifiants des serviteurs
   changent, on les retrouve par leur place sur le plateau (le moteur est déterministe ici). */
function replayLine(m, line, pool) {
  const idOf = ref => { if (!ref || ref.hero || ref.weapon) return undefined; const side = ref.mine ? m.players[0] : m.players[1]; const x = side.board[ref.idx]; return x ? x.instanceId : '?'; };
  for (const a of line) {
    const sn = a.snap || {};
    const b = a.kind === 'play'
      ? { kind: 'play', cardId: a.cardId, opt: a.opt.targetType === 'minion' ? { targetType: 'minion', targetId: idOf(sn.target) } : a.opt }
      : { kind: 'attack', attackerId: a.attackerId === 'hero' ? 'hero' : idOf(sn.attacker), targetType: a.targetType, targetId: a.targetType === 'minion' ? idOf(sn.target) : undefined };
    const r = doAction(m, pool, b);
    if (!r || r.error) return false;
    if (m.status === 'finished') return m.winner === m.players[0].slug;
  }
  return m.status === 'finished' && m.winner === m.players[0].slug;
}

/* ---------- Stockage : puzzle du jour, joueurs qui ont essayé / réussi ---------- */
let data = null;
function load() {
  if (data) return data;
  data = readJSON(FILE, null) || {};
  if (!data.days || typeof data.days !== 'object') data.days = {};
  return data;
}
function save() {
  const keys = Object.keys(data.days).sort().reverse();
  keys.slice(KEEP_DAYS).forEach(k => delete data.days[k]);
  writeJSON(FILE, data);
}
function _reset() { data = { days: {} }; }
/* Puzzle du jour (fabriqué au premier appel de la journée) */
function today(pool, now) {
  const d = load(), key = dayKey(now);
  const cur = d.days[key];
  // Pas encore de puzzle aujourd'hui (ou échec de fabrication il y a plus de 10 min) : on le fabrique
  if (!cur || (!cur.puzzle && Date.now() - (cur.triedAt || 0) > 10 * 60000)) {
    const pz = generate(pool, key);
    d.days[key] = { puzzle: pz, solvers: (cur && cur.solvers) || [], tried: (cur && cur.tried) || [], triedAt: Date.now() };
    save();
  }
  return d.days[key];
}
function regenerate(pool, now, salt) {
  const d = load(), key = dayKey(now);
  const pz = generate(pool, key + ':' + (salt || Date.now()));
  if (pz) pz.day = key;
  const prev = d.days[key] || {};
  d.days[key] = { puzzle: pz, solvers: prev.solvers || [], tried: prev.tried || [] };
  save();
  return d.days[key];
}
function markTried(slug, now) {
  const day = load().days[dayKey(now)];
  if (day && !day.tried.includes(slug)) { day.tried.push(slug); save(); }
}
function ensureUser(user) {
  const p = user.puzzle = user.puzzle && typeof user.puzzle === 'object' ? user.puzzle : {};
  if (typeof p.solved !== 'number') p.solved = 0;
  if (typeof p.streak !== 'number') p.streak = 0;
  return p;
}
function prevDay(key) { const d = new Date(key + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); }
/* Puzzle réussi : la récompense n'est donnée qu'à la première réussite du jour,
   et seulement si la solution n'a pas été dévoilée avant. */
function recordSolve(user, now) {
  const key = dayKey(now), p = ensureUser(user);
  const day = load().days[key];
  if (!day) return null;
  if (!day.tried.includes(user.slug)) day.tried.push(user.slug);
  const first = p.lastSolved !== key;
  if (!first) return { first: false, solvers: day.solvers.length };
  if (!day.solvers.includes(user.slug)) day.solvers.push(user.slug);
  save();
  const revealed = p.revealed === key;
  p.streak = p.lastSolved === prevDay(key) ? p.streak + 1 : 1;
  p.lastSolved = key; p.solved++;
  if (p.streak > (p.bestStreak || 0)) p.bestStreak = p.streak;
  const reward = revealed ? null : Object.assign({}, REWARD, { booster: p.streak % STREAK_BOOSTER_EVERY === 0 });
  return { first: true, reward, revealed, streak: p.streak, solvers: day.solvers.length, rank: day.solvers.length };
}
function view(user, pool, now) {
  const d = today(pool, now), p = ensureUser(user), key = dayKey(now);
  const pz = d.puzzle;
  const card = id => pool.find(c => c.id === id) || null;
  return {
    day: key, available: !!pz,
    puzzle: pz ? {
      myBoard: pz.myBoard.map(x => card(x.cardId)).filter(Boolean),
      oppBoard: pz.oppBoard.map(x => Object.assign({}, card(x.cardId), { taunt: x.taunt || (card(x.cardId) || {}).taunt })).filter(c => c.id),
      hand: pz.hand.map(card).filter(Boolean), mana: pz.mana, oppHp: pz.oppHp, myHp: pz.myHp, steps: pz.steps, difficulty: pz.difficulty
    } : null,
    solvedToday: p.lastSolved === key, revealed: p.revealed === key,
    solution: (p.lastSolved === key || p.revealed === key) && pz ? pz.solution : null,
    solvers: d.solvers.length, tried: d.tried.length,
    streak: p.lastSolved === key || p.lastSolved === prevDay(key) ? p.streak : 0, bestStreak: p.bestStreak || 0, solved: p.solved,
    reward: REWARD, streakBoosterEvery: STREAK_BOOSTER_EVERY
  };
}
function reveal(user, now) { ensureUser(user).revealed = dayKey(now); }

module.exports = { dayKey, puzzleCards, install, solve, generate, freshMatch, replayLine, naiveDamage, today, regenerate, markTried, recordSolve, view, reveal, ensureUser, REWARD, _reset };

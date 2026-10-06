/* Un seul combat à la fois par joueur, quel que soit le moyen de le lancer */
const assert = require('assert');
const mm = require('./src/matchmaking');
const { SEED_CARDS } = require('./src/cards');
const deck = Array(30).fill(SEED_CARDS.find(c => c.type === 'minion').id);
let n = 0;
const sock = () => { const s = { id: 's' + (++n), connected: true, data: {}, got: [], emit(ev, p) { this.got.push([ev, p]); } }; return s; };
const io = { emit() {} };
const info = slug => ({ slug, pseudo: slug.toUpperCase(), deck: deck.slice() });
const errors = s => s.got.filter(([ev]) => ev === 'queue:error').map(([, p]) => p.error);

// 1. Un combat contre le bot puis un deuxième : refusé
const a1 = sock();
const id1 = mm.startBotMatch(a1, info('alice'), { slug: 'bot', pseudo: 'Bot', deck }, SEED_CARDS, io, null, {});
assert.ok(id1);
const a2 = sock(); // autre onglet
const id2 = mm.startBotMatch(a2, info('alice'), { slug: 'bot', pseudo: 'Bot', deck }, SEED_CARDS, io, null, { blitz: true });
assert.strictEqual(id2, null, 'deuxième combat refusé');
assert.ok(errors(a2).length === 1, 'le joueur est prévenu');
assert.strictEqual(mm.getMatchForSocket(a1).matchId, id1, "le combat en cours reste dans son onglet");
console.log('✅ Un deuxième combat contre le bot est refusé (le combat en cours continue normalement).');

// 2. File d'attente : refusée pendant un combat
mm.joinQueue(sock(), info('alice'), SEED_CARDS, io, null, {});
const b1 = sock();
mm.joinQueue(b1, info('bob'), SEED_CARDS, io, null, {});
assert.ok(!b1.got.some(([ev, p]) => ev === 'match:state'), 'bob ne tombe pas sur alice, déjà en combat');
console.log("✅ Impossible d'entrer dans la file d'attente pendant un combat.");

// 3. Deux onglets du même joueur en file : jamais contre lui-même
const c1 = sock(), c2 = sock();
mm.leaveQueue(b1);
mm.joinQueue(c1, info('carl'), SEED_CARDS, io, null, {});
mm.joinQueue(c2, info('carl'), SEED_CARDS, io, null, {});
assert.ok(!mm.activeMatchOf('carl'), 'pas de combat contre soi-même');
console.log('✅ Deux onglets du même joueur en recherche ne se battent pas entre eux.');

// 4. Défis
const d = sock(); mm.registerOnline(d, 'dave'); mm.registerOnline(a1, 'alice');
assert.ok(mm.createChallenge(info('dave'), 'alice').error, "on ne peut pas défier quelqu'un en combat");
const e = sock(); mm.registerOnline(e, 'eve');
const ch = mm.createChallenge(info('alice'), 'eve');
assert.ok(ch.error, 'ni défier quand on est soi-même en combat');
console.log('✅ Défis refusés quand un des deux joueurs est déjà en combat.');

// 5. Fin du combat : on peut en relancer un
const entry = mm.getEntry(id1); entry.match.status = 'finished';
const id3 = mm.startBotMatch(a1, info('alice'), { slug: 'bot', pseudo: 'Bot', deck }, SEED_CARDS, io, null, {});
assert.ok(id3, 'nouveau combat possible une fois le précédent terminé');
console.log('✅ Une fois le combat terminé, un nouveau peut être lancé.');
console.log('\n✅ Un seul combat à la fois validé.');
process.exit(0);

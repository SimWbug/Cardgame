/* Stats du deck : bilan de combat, analyse de composition, suggestions de cartes */
const assert = require('assert');
const game = require('./src/game');
const ds = require('./src/deckstats');
const { SEED_CARDS } = require('./src/cards');

// --- Bilan d'un combat à partir du journal
const minion = SEED_CARDS.find(c => c.type === 'minion' && c.cost <= 2);
const deck = Array(30).fill(minion.id);
const m = game.createMatch('ds', { slug: 'a', pseudo: 'A', deck }, { slug: 'b', pseudo: 'B', deck });
game.submitMulligan(m, 0, []); game.submitMulligan(m, 1, []);
const me = m.players[0];
me.hand.push(minion.id);
assert.ok(game.playCard(m, SEED_CARDS, 0, minion.id, {}).ok);
const placed = me.board[me.board.length - 1];
placed.canAttack = true; placed.sickness = false;
assert.ok(game.attack(m, 0, placed.instanceId, 'hero', null).ok);
m.status = 'finished'; m.winner = 'a';
const rep = ds.analyzeMatch(m, 0, 'practice');
assert.strictEqual(rep.result, 'win'); assert.strictEqual(rep.mode, 'practice');
assert.strictEqual(rep.perCard[minion.id].played, 1);
assert.strictEqual(rep.perCard[minion.id].damage, minion.attack);
assert.ok(rep.manaAvailable >= 1 && rep.efficiency > 0);
assert.strictEqual(rep.deck.length, 30);
console.log('✅ Bilan de combat : cartes jouées, dégâts, mana utilisée et résultat.');

// --- Analyse de composition
const pool = [
  { id: 'cheap', name: 'Petit', type: 'minion', cost: 1, rarity: 'commun', attack: 1, health: 1 },
  { id: 'big', name: 'Gros', type: 'minion', cost: 8, rarity: 'commun', attack: 8, health: 8 },
  { id: 'zap', name: 'Éclair', type: 'sort', cost: 2, rarity: 'commun', effectType: 'damage', value: 3 },
  { id: 'think', name: 'Réflexion', type: 'sort', cost: 2, rarity: 'rare', effectType: 'draw', value: 2 },
  { id: 'wall', name: 'Mur', type: 'minion', cost: 2, rarity: 'commun', attack: 0, health: 6, taunt: true }
];
const heavy = Array(30).fill('big');
const an = ds.analyzeDeck(heavy, pool);
assert.strictEqual(an.avgCost, 8);
const keys = an.tips.map(t => t.key);
['expensive', 'early', 'removal', 'draw', 'taunt'].forEach(k => assert.ok(keys.includes(k), 'conseil attendu : ' + k));
console.log('✅ Analyse : un deck trop cher reçoit les bons conseils (coût, début de partie, élimination, pioche, Provocation).');

// --- Suggestions : depuis la collection, avec la raison
const sugg = ds.suggestCards(heavy, pool, { big: 30, cheap: 2, zap: 2, think: 1, wall: 2 }, an, { commun: 2, rare: 2, epique: 2, legendaire: 1 });
const ids = sugg.map(s => s.cardId);
['cheap', 'zap', 'think', 'wall'].forEach(id => assert.ok(ids.includes(id), 'suggestion attendue : ' + id));
assert.ok(sugg.every(s => s.reason && s.owned), 'chaque suggestion explique pourquoi et vient de la collection');
const notOwned = ds.suggestCards(heavy, pool, { big: 30 }, an, { commun: 2, rare: 2 });
assert.ok(notOwned.length && notOwned.every(s => !s.owned), 'sans la carte, elle est proposée « à obtenir »');
console.log('✅ Suggestions : cartes de la collection qui comblent les manques, sinon à obtenir.');

// --- Bilan cumulé
const agg = ds.aggregateReports([rep, Object.assign({}, rep, { result: 'loss', leftInHand: ['big'] })]);
assert.strictEqual(agg.games, 2); assert.strictEqual(agg.winRate, 50); assert.strictEqual(agg.stuck.big, 1);
console.log('✅ Bilan cumulé : taux de victoire, cartes efficaces, cartes coincées en main.');
console.log('\n✅ Stats du deck validées.');

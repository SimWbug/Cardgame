/* Carrière et titres */
const assert = require('assert');
const career = require('./src/career');
const u = { slug: 'a', pseudo: 'A', stats: { bossDefeats: 2 }, storyCleared: ['ch-1'] };
const rep = (result, mode, cards) => ({ result, mode, perCard: cards || { c1: { played: 2, damage: 5, kills: 1 } } });
['win', 'win', 'win', 'win', 'win', 'loss', 'win'].forEach(r => career.recordMatch(u, rep(r, 'pvp'), { slug: 'b', pseudo: 'B' }));
career.recordMatch(u, rep('win', 'practice'), { slug: 'bot', pseudo: 'Bot' });
const sm = career.summary(u, id => ({ id }));
assert.strictEqual(sm.games, 7, "l'entraînement ne compte pas"); assert.strictEqual(sm.bestStreak, 5); assert.strictEqual(sm.winRate, 86);
assert.strictEqual(sm.topCard.id, 'c1'); assert.strictEqual(sm.topCard.count, 14);
assert.strictEqual(sm.favoriteOpponent.pseudo, 'B'); assert.strictEqual(sm.favoriteOpponent.w, 6);
assert.ok(!Object.keys(u.career.opponents).includes('bot'), "le bot d'entraînement ne compte pas comme adversaire");
console.log('✅ Carrière : taux de victoire, plus longue série, carte la plus jouée, adversaire favori.');
const t = career.titlesFor(u, { storyCount: 3 }).map(x => x.id);
assert.ok(t.includes('debutant') && t.includes('inarretable') && t.includes('tueur-boss'));
assert.ok(!t.includes('veteran') && !t.includes('heros-ville'));
assert.ok(career.grantTitle(u, { name: "Champion d'automne", source: 'Tournoi' }));
assert.ok(!career.grantTitle(u, { name: "Champion d'automne" }), 'pas de doublon');
assert.ok(career.titlesFor(u, {}).some(x => x.name === "Champion d'automne"));
console.log('✅ Titres : débloqués par la carrière, offerts par un tournoi ou un succès.');
// Les combats contre le bot ne comptent pas
{
  const v = { slug: 'v', pseudo: 'V' };
  career.recordMatch(v, rep('win', 'bot'), { slug: 'bot', pseudo: 'Bot' });
  career.recordMatch(v, rep('win', 'practice'), { slug: 'bot', pseudo: 'Bot' });
  assert.strictEqual(career.summary(v, id => ({ id })).games, 0, 'bot et entraînement ignorés');
  career.recordMatch(v, rep('win', 'story'), { slug: 'b', pseudo: 'Boss' });
  career.recordMatch(v, rep('win', 'boss'), { slug: 'b', pseudo: 'Boss' });
  assert.strictEqual(career.summary(v, id => ({ id })).wins, 0, "l'Histoire et les boss ne comptent pas");
  career.recordMatch(v, rep('win', 'tournament'), { slug: 'b', pseudo: 'B' });
  assert.strictEqual(career.summary(v, id => ({ id })).wins, 1, 'le tournoi compte');
  assert.ok(career.countsForDailies('story') && !career.countsForDailies('bot'), 'défis du jour : Histoire oui, bot non');
  // Données déjà purgées du bot : on retire ensuite l'Histoire et les boss
  const mid = { slug: 'm', career: { botPurged: true, games: 9, wins: 6, losses: 3, bestStreak: 6, curStreak: 4, byMode: { story: { w: 4, l: 1 }, boss: { w: 1, l: 0 }, pvp: { w: 1, l: 2 } } } };
  career.ensureCareer(mid);
  assert.strictEqual(mid.career.games, 3); assert.strictEqual(mid.career.wins, 1); assert.ok(mid.career.bestStreak <= 1);
  assert.ok(!mid.career.byMode.story && mid.career.byMode.pvp);
  // Anciennes données : les victoires contre le bot sont retirées une fois
  const old = { slug: 'o', career: { games: 10, wins: 8, losses: 2, bestStreak: 8, curStreak: 3, byMode: { bot: { w: 6, l: 0 }, pvp: { w: 2, l: 2 } } } };
  career.ensureCareer(old);
  assert.strictEqual(old.career.games, 4); assert.strictEqual(old.career.wins, 2); assert.ok(old.career.bestStreak <= 2);
  console.log('✅ Seuls les combats contre de vrais joueurs comptent dans la carrière (bot, Histoire et boss retirés des anciennes stats).');
}
console.log('\n✅ Carrière et titres validés.');

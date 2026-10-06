/* Survie, Blitz, objectif communautaire, succès secrets, bannières */
const assert = require('assert');
const game = require('./src/game');
const survival = require('./src/survival');
const community = require('./src/community');
const secrets = require('./src/secrets');
const banners = require('./src/banners');
const { SEED_CARDS, COPY_LIMITS } = require('./src/cards');

// ---- Survie ----
{
  const u = { slug: 'u' };
  const r = survival.start(u, SEED_CARDS, COPY_LIMITS);
  assert.ok(r.ok); assert.strictEqual(u.survival.run.deck.length, 30);
  const counts = {}; u.survival.run.deck.forEach(id => counts[id] = (counts[id] || 0) + 1);
  u.survival.run.deck.forEach(id => { const c = SEED_CARDS.find(x => x.id === id); assert.ok(counts[id] <= (COPY_LIMITS[c.rarity] || 2), 'limites de copies'); });
  assert.ok(survival.start(u, SEED_CARDS, COPY_LIMITS).error, 'une seule partie à la fois');
  const deck = u.survival.run.deck.slice();
  let res = survival.recordResult(u, true, 12);
  assert.strictEqual(res.round, 1); assert.strictEqual(u.survival.run.round, 2); assert.strictEqual(u.survival.run.hp, 17, 'PV conservés + 5');
  assert.deepStrictEqual(u.survival.run.deck, deck, 'le deck ne change pas');
  for (let i = 0; i < 4; i++) res = survival.recordResult(u, true, 30);
  assert.strictEqual(u.survival.run.hp, 30, 'PV plafonnés'); assert.ok(res.milestone, 'récompense toutes les 5 manches');
  assert.strictEqual(u.survival.best, 5);
  const a = survival.roundConfig(1), b = survival.roundConfig(12);
  assert.ok(b.botHp > a.botHp && b.botArmor > a.botArmor && b.botMana > a.botMana && b.quality > a.quality, 'difficulté croissante');
  res = survival.recordResult(u, false, 0);
  assert.ok(res.over); assert.strictEqual(u.survival.run, null); assert.strictEqual(u.survival.best, 5);
  const others = [{ slug: 'x', pseudo: 'X', survival: { best: 7, bestAt: 2 } }, { slug: 'y', pseudo: 'Y', survival: { best: 7, bestAt: 1 } }, { slug: 'z', pseudo: 'Z', survival: { best: 2 } }, Object.assign(u, { pseudo: 'U' })];
  assert.deepStrictEqual(survival.leaderboard(others).map(x => x.slug), ['y', 'x', 'u'], 'top 3 (égalité : le premier arrivé)');
  console.log('✅ Survie : deck aléatoire figé, PV conservés, difficulté croissante, record et top 3.');
}

// ---- Blitz : 3 cristaux au départ ----
{
  const deck = Array(30).fill(SEED_CARDS.find(c => c.type === 'minion').id);
  const m = game.createMatch('bz', { slug: 'a', pseudo: 'A', deck }, { slug: 'b', pseudo: 'B', deck });
  m.manaBonus = [2, 2];
  game.submitMulligan(m, 0, []); game.submitMulligan(m, 1, []);
  assert.strictEqual(m.players[0].maxMana, 3);
  game.endTurn(m); assert.strictEqual(m.players[1].maxMana, 3);
  game.endTurn(m); assert.strictEqual(m.players[0].maxMana, 4);
  console.log('✅ Blitz : 3 cristaux de mana dès le premier tour, puis +1 par tour.');
}

// ---- Objectif communautaire ----
{
  community._reset();
  const d = community.ensureWeek(6, () => 0, Date.UTC(2026, 9, 7, 12));
  assert.strictEqual(d.weekKey, '2026-10-05', 'semaine commençant le lundi');
  const type = d.goal.type, target = d.goal.target;
  let r = community.contribute('a', { [type]: target - 1 });
  assert.deepStrictEqual(r.reward, []);
  r = community.contribute('b', { [type]: 1 });
  assert.deepStrictEqual(r.reward.sort(), ['a', 'b'], 'tous les participants récompensés');
  r = community.contribute('c', { [type]: 1 });
  assert.deepStrictEqual(r.reward, ['c'], 'un participant tardif est aussi récompensé');
  r = community.contribute('a', { [type]: 5 });
  assert.deepStrictEqual(r.reward, [], 'jamais deux fois');
  const d2 = community.ensureWeek(6, () => 0, Date.UTC(2026, 9, 13, 12));
  assert.strictEqual(d2.weekKey, '2026-10-12'); assert.notStrictEqual(d2.goal.type, type, 'nouvel objectif différent');
  assert.strictEqual(d2.history[0].completed, true);
  community._reset();
  console.log('✅ Objectif communautaire : tirage hebdomadaire, progression commune, récompense unique par joueur.');
}

// ---- Succès secrets ----
{
  assert.strictEqual(secrets.DEFS.length, 100);
  const u = { slug: 's', credits: 0, dust: 0 };
  const got = [];
  secrets.record(u, { won: 1, played: 1, win_hp1: 1, win_low_hp3: 1 }, (user, d) => { if (d.banner) banners.grant(user, d.banner); got.push(d.id); });
  assert.ok(got.includes('sec-win_hp1-1') && got.includes('sec-played-1'));
  assert.ok(u.ownedBanners.includes('fil-du-rasoir'), 'bannière offerte');
  assert.ok(u.credits > 0);
  const v = secrets.viewFor(u);
  assert.strictEqual(v.total, 100); assert.ok(v.unlocked.length === got.length);
  secrets.record(u, { kills_one_turn: 3 }); secrets.record(u, { kills_one_turn: 2 });
  assert.strictEqual(u.secretStats.kills_one_turn, 3, 'record conservé');
  // Analyse d'un combat : victoire à 1 PV, Silence sur son propre serviteur
  const deck = Array(30).fill(SEED_CARDS.find(c => c.type === 'minion').id);
  const m = game.createMatch('sx', { slug: 'a', pseudo: 'A', deck }, { slug: 'b', pseudo: 'B', deck });
  m.players[0].heroHealth = 1; m.players[0].minHp = 1; m.status = 'finished'; m.winner = 'a';
  m.events = [{ type: 'silence', by: 'a', turn: 3, targets: [{ kind: 'minion', owner: 'a' }] }, { type: 'play', by: 'a', turn: 3, card: { type: 'sort' } }];
  const f = secrets.analyzeMatch(m, 0, 'pvp', Date.UTC(2026, 9, 6, 12));
  assert.ok(f.win_hp1 && f.win_low_hp3 && f.win_comeback && f.silence_own && f.spells_played === 1 && !f.win_no_spell);
  console.log('✅ Succès secrets : 100 succès, cachés jusqu’au déblocage, récompenses et analyse des combats.');
}
console.log('\n✅ Nouveaux modes validés.');

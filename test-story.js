/* Mode Histoire : chapitres créés à partir des cartes, difficulté croissante, récompenses */
const assert = require('assert');
const story = require('./src/story');
const { SEED_CARDS, COPY_LIMITS } = require('./src/cards');
const r = story.generate(SEED_CARDS, 8);
assert.ok(r.ok);
const chs = story.get().chapters;
assert.ok(chs.length >= 3);
for (let i = 1; i < chs.length; i++) {
  assert.ok(chs[i].hp > chs[i - 1].hp, 'PV du boss en hausse à chaque chapitre');
  assert.ok(chs[i].quality >= chs[i - 1].quality, 'deck du boss de plus en plus fort');
  assert.ok(story.power(SEED_CARDS.find(c => c.id === chs[i].bossCardId)) >= story.power(SEED_CARDS.find(c => c.id === chs[i - 1].bossCardId)), 'boss de plus en plus puissants');
}
assert.ok(chs.every(c => c.intro.includes(c.bossName)), 'le lore cite le boss');
console.log(`✅ ${chs.length} chapitres créés à partir des cartes, difficulté croissante.`);
const deck = story.bossDeck(chs[chs.length - 1], SEED_CARDS, COPY_LIMITS);
assert.strictEqual(deck.length, 30); assert.ok(deck.includes(chs[chs.length - 1].bossCardId), 'le boss est dans son deck');
const counts = {}; deck.forEach(id => { counts[id] = (counts[id] || 0) + 1; });
assert.ok(Object.keys(counts).every(id => counts[id] <= (COPY_LIMITS[SEED_CARDS.find(c => c.id === id).rarity] || 2)), 'limites d\'exemplaires respectées');
console.log('✅ Deck du boss : 30 cartes, avec le boss, dans les règles.');
const full = story.rewardFor(chs[1], true), again = story.rewardFor(chs[1], false);
assert.ok((full.dust + full.credits) > (again.dust + again.credits) && (again.dust + again.credits) > 0);
console.log('✅ Récompense pleine à la première victoire, réduite ensuite.');
console.log('\n✅ Mode Histoire validé.');

// ---------- 3 combats par chapitre et chapitres ouverts petit à petit ----------
{
  story.generate(SEED_CARDS, 8);
  const chs2 = story.get().chapters;
  chs2.forEach(ch => {
    const fights = story.fightsOf(ch);
    assert.strictEqual(fights.length, 3, '3 combats par chapitre');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(fights.map(f => f.kind))), ['minion', 'minion', 'boss']);
    assert.ok(fights[0].hp < fights[1].hp && fights[1].hp < fights[2].hp, 'les PV montent : sbire 1 < sbire 2 < boss');
  });
  assert.ok(chs2[0].enabled && chs2.slice(1).every(c => !c.enabled), 'seul le premier chapitre est ouvert au départ');
  const rb = story.rewardFor(chs2[0], true, false), rm = story.rewardFor(chs2[0], true, true);
  assert.ok((rm.dust + rm.credits) > 0 && (rm.dust + rm.credits) < (rb.dust + rb.credits), 'un sbire rapporte moins que le boss');
  // l'admin ouvre le chapitre 2 et garde ses sbires
  const edited = chs2.map((c, i) => Object.assign({}, c, { enabled: i <= 1 }));
  story.setChapters(edited);
  assert.ok(story.get().chapters[1].enabled && !story.get().chapters[2].enabled);
  assert.strictEqual(story.fightsOf(story.get().chapters[1]).length, 3);
  console.log('✅ 3 combats par chapitre (2 sbires puis le boss), chapitres ouverts par l\'admin un par un.');
}

/* Mode Expédition : exploration procédurale en monde ouvert (cases + brouillard),
   difficulté croissante, boss aléatoires (jamais avant le 3e combat), butin aléatoire,
   retour avec « Arrêter l'exploration » (une défaite fait perdre la moitié du sac). */
const assert = require('assert');
const ex = require('./src/expedition');
const R = ['commun', 'rare', 'epique', 'legendaire'];
const pool = Array.from({ length: 60 }, (_, i) => ({ id: 'c' + i, name: 'Carte ' + i, cost: 1 + (i % 8), rarity: R[i % 10 < 6 ? 0 : i % 10 < 8 ? 1 : i % 10 < 9 ? 2 : 3] }));
const LIM = { commun: 2, rare: 2, epique: 2, legendaire: 1 };
const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/* ---------- Génération : chaque région est différente, tout est accessible ---------- */
const sigs = new Set();
for (let s = 1; s < 40; s++) {
  const w = ex.generateWorld(ex.rngFrom(s * 7919), 0);
  assert.strictEqual(w.map.length, ex.MAP_H); assert.strictEqual(w.map[0].length, ex.MAP_W);
  assert.strictEqual(w.map[w.y][w.x].k, 'start', 'le campement de départ est au centre');
  // toutes les cases non bloquées sont atteignables depuis le départ
  const seen = new Set([w.x + ',' + w.y]), q = [[w.x, w.y]];
  while (q.length) { const [x, y] = q.shift(); N4.forEach(([dx, dy]) => { const nx = x + dx, ny = y + dy; if (nx >= 0 && ny >= 0 && nx < ex.MAP_W && ny < ex.MAP_H && w.map[ny][nx].k !== 'block' && !seen.has(nx + ',' + ny)) { seen.add(nx + ',' + ny); q.push([nx, ny]); } }); }
  let open = 0, bosses = 0;
  w.map.forEach(row => row.forEach(t => { if (t.k !== 'block') open++; if (t.k === 'boss') bosses++; assert.ok(ex.BIOMES[t.b], 'biome connu'); }));
  assert.strictEqual(seen.size, open, 'aucune case enfermée');
  assert.ok(open > 60, 'une vraie région à explorer');
  assert.ok(bosses >= 1, 'au moins un repaire de boss');
  sigs.add(w.map.map(r => r.map(t => t.k[0] + t.b[0]).join('')).join('|'));
}
assert.ok(sigs.size >= 38, 'chaque départ génère une région différente');

/* ---------- Départ, brouillard, déplacements ---------- */
const u = { credits: 1000, stats: {}, resources: {} };
let r = ex.start(u, pool, LIM, { seed: 12345 });
assert.ok(r.ok && r.free, 'première entrée du jour gratuite');
assert.ok(ex.start(u, pool, LIM).error, 'une seule Expédition à la fois');
let run = u.expedition.run;
assert.strictEqual(run.deck.length, ex.START_DECK);
let v = ex.view(u, pool).run;
const hidden = v.map.flat().filter(t => !t.s).length;
assert.ok(hidden > ex.MAP_W * ex.MAP_H * 0.8, 'la carte est sous le brouillard au départ');
assert.ok(v.map.flat().filter(t => !t.s).every(t => t.k === undefined && t.b === undefined), 'rien ne fuite sous le brouillard');
assert.ok(ex.move(u, run.x + 2, run.y, pool, LIM).error, 'pas de saut de plusieurs cases');
assert.ok(ex.move(u, run.x + 1, run.y + 1, pool, LIM).error, 'pas de diagonale');
assert.ok(ex.stop(u).cancelled && u.expedition.run === null && ex.freeAvailable(u), 'annuler avant de bouger rend l\'entrée');

/* ---------- Une partie complète, en se dirigeant librement ---------- */
ex.start(u, pool, LIM, { seed: 4242 });
run = u.expedition.run;
let fights = 0, guard = 0, firstBossAt = null;
const resBefore = JSON.stringify(u.resources);
while (u.expedition.run && guard++ < 1500 && fights < 14) {
  const rn = u.expedition.run;
  if (rn.status === 'map') {
    // va vers une case voisine pas encore visitée si possible (sinon n'importe laquelle)
    const opts = N4.map(([dx, dy]) => [rn.x + dx, rn.y + dy]).filter(([x, y]) => x >= 0 && y >= 0 && x < ex.MAP_W && y < ex.MAP_H && rn.map[y][x].k !== 'block');
    const fresh = opts.filter(([x, y]) => !rn.map[y][x].v);
    const list = fresh.length ? fresh : opts;
    const [x, y] = list[(guard * 7) % list.length];
    assert.ok(ex.move(u, x, y, pool, LIM).ok); continue;
  }
  if (rn.status === 'fight') {
    if (rn.encounter.kind === 'boss' && firstBossAt === null) firstBossAt = rn.fightsWon;
    fights++;
    const res = ex.recordFight(u, true, rn.hp, pool, LIM);
    assert.ok(res && res.won); continue;
  }
  if (rn.status === 'reward') { ex.pickReward(u, rn.reward.cards[0] || null); continue; }
  if (rn.status === 'shop') { assert.ok(ex.shopAction(u, 'leave').ok); continue; }
  if (rn.status === 'camp') { assert.ok(ex.camp(u, 'rest').ok); continue; }
  if (rn.status === 'event') { const ch = ex.view(u, pool).run.event.choices; const e1 = ex.eventChoice(u, ch[ch.length - 1].id, pool, LIM); if (e1.error) ex.eventChoice(u, ch[0].id, pool, LIM); continue; }
  if (rn.status === 'riddle') { assert.ok(ex.riddleAnswer(u, 'skip').ok); continue; }
  if (rn.status === 'tavern') { assert.ok(ex.tavernAction(u, 'leave').ok); continue; }
  if (rn.status === 'notice') { assert.ok(ex.continueRun(u).ok); continue; }
}
run = u.expedition.run;
assert.ok(run && run.fightsWon >= 10, 'on peut enchaîner les combats sans fin');
assert.ok(firstBossAt === null || firstBossAt >= ex.BOSS_MIN_FIGHTS, 'jamais de boss avant le 3e combat');
assert.ok(run.explored >= 10, 'des cases explorées');
assert.ok(JSON.stringify(u.resources) !== resBefore, 'les ressources tombent pendant l\'exploration');

/* ---------- La difficulté grimpe avec la progression ---------- */
const enc = (rn, kind) => { rn.encounter = { kind, biome: 'foret', name: 'Loup gris', icon: '🐺' }; rn.status = 'fight'; return ex.fightConfig(rn); };
const save = { fw: run.fightsWon, reg: run.region, st: run.status, en: run.encounter };
run.fightsWon = 0; run.region = 0; const easy = enc(run, 'combat');
run.fightsWon = 12; const hard = enc(run, 'combat');
assert.ok(hard.fields.opponentHeroHealth > easy.fields.opponentHeroHealth && hard.quality > easy.quality && hard.deckSize >= easy.deckSize, 'les ennemis deviennent plus forts');
const elite = enc(run, 'elite'); assert.ok(elite.fields.opponentHeroHealth > hard.fields.opponentHeroHealth && elite.quality > hard.quality, 'les élites sont plus dures');
Object.assign(run, { fightsWon: save.fw, region: save.reg, status: save.st, encounter: save.en });

/* ---------- Repaire de boss scellé avant le 3e combat ---------- */
const u2 = { credits: 1000, stats: {}, resources: {} };
ex.start(u2, pool, LIM, { seed: 99 });
const r2 = u2.expedition.run;
Object.assign(r2.map[r2.y][r2.x + 1], { k: 'boss', d: 0, v: 0 });
ex.move(u2, r2.x + 1, r2.y, pool, LIM);
assert.ok(r2.status === 'notice' && /scellé/.test(r2.notice.text), 'repaire scellé tant qu\'on n\'a pas assez combattu');
ex.continueRun(u2);
r2.fightsWon = ex.BOSS_MIN_FIGHTS;
Object.assign(r2.map[r2.y][r2.x - 1], { k: 'boss', d: 0, v: 0 });
ex.move(u2, r2.x - 1, r2.y, pool, LIM);
assert.ok(r2.status === 'fight' && r2.encounter.kind === 'boss' && ex.BOSSES[r2.encounter.bossId], 'le boss attaque après 2 combats gagnés');
const bossRes = ex.recordFight(u2, true, 20, pool, LIM);
assert.ok(bossRes.bossName && bossRes.bag.boosters >= 1 && u2.expedition.bossKills[bossRes.bossId] === 1, 'boss vaincu : booster dans le sac, trophée');
assert.ok(bossRes.portal, 'un passage vers une nouvelle région s\'ouvre');
ex.pickReward(u2, null);
let portal = null; r2.map.forEach((row, y) => row.forEach((t, x) => { if (t.k === 'portal') portal = [x, y]; }));
assert.ok(portal, 'passage visible sur la carte');

/* ---------- Butin aléatoire ---------- */
const bags = new Set();
for (let s = 1; s <= 30; s++) {
  const w = { credits: 1000, stats: {}, resources: {} };
  ex.start(w, pool, LIM, { seed: s * 31 });
  const rn = w.expedition.run; rn.encounter = { kind: 'combat', biome: 'foret', name: 'Loup gris', icon: '🐺' }; rn.status = 'fight'; rn.moves = 1;
  const g = ex.recordFight(w, true, 20, pool, LIM);
  bags.add(JSON.stringify(g.bag) + JSON.stringify(g.loot) + g.gold);
}
assert.ok(bags.size >= 20, 'les récompenses sont aléatoires');

/* ---------- Retour : tout le sac / Défaite : la moitié ---------- */
const bag = Object.assign({}, run.bag);
assert.ok(bag.credits + bag.dust > 0, 'le sac se remplit');
const stopped = ex.stop(u);
assert.ok(stopped.over && !stopped.defeat && stopped.rewards.credits === bag.credits && stopped.rewards.dust === bag.dust && stopped.rewards.boosters === bag.boosters, 'retour : tout le sac est encaissé');
assert.strictEqual(u.expedition.run, null);
assert.ok(u.expedition.best >= 10, 'record : combats gagnés');
const c0 = u.credits;
ex.start(u, pool, LIM, { seed: 7 });
assert.strictEqual(u.credits, c0 - ex.ENTRY_PRICE, 'deuxième entrée du jour payante');
run = u.expedition.run;
run.bag = { credits: 101, dust: 50, boosters: 3 }; run.moves = 3;
run.encounter = { kind: 'combat', biome: 'foret', name: 'Loup gris', icon: '🐺' }; run.status = 'fight';
assert.ok(ex.stop(u).error, 'impossible de rentrer en plein combat');
const lost = ex.recordFight(u, false, 0, pool, LIM);
assert.ok(lost.over && lost.defeat && lost.rewards.credits === 50 && lost.rewards.dust === 25 && lost.rewards.boosters === 1, 'défaite : la moitié du sac est perdue');
/* ---------- Personnage d'exploration ---------- */
const px = { credits: 0, stats: {} };
assert.strictEqual(ex.explorerOf(px).id, 'nain', 'le nain par défaut');
assert.ok(ex.setExplorer(px, { id: 'dragon' }).error && ex.setExplorer(px, { color: 'red' }).error, 'choix inconnus refusés');
assert.ok(ex.setExplorer(px, { id: 'ninja', color: ex.EXPLORER_COLORS[3], name: '  <b>Kenji</b> le très très long nom  ' }).ok);
assert.deepStrictEqual(ex.explorerOf(px), { id: 'ninja', color: ex.EXPLORER_COLORS[3], name: 'bKenji/b le très trè' }, 'nom nettoyé et limité à 20 caractères');
assert.ok(ex.EXPLORERS.some(p => p.id === 'avatar'), 'on peut jouer avec son avatar');
assert.strictEqual(ex.view(px, pool).explorer.id, 'ninja');
console.log('✅ Expédition : régions procédurales sous brouillard, déplacement libre, difficulté croissante, boss aléatoires (pas avant le 3e combat), butin aléatoire, retour / défaite.');

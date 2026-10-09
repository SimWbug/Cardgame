/* Runes d'Expédition, Ascension, Bestiaire, Recrues de taverne, Énigmes, Météo des plateaux, Présence détaillée */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const DATA = path.join(__dirname, 'data');
fs.mkdirSync(DATA, { recursive: true });
const ex = require('./src/expedition');
const forge = require('./src/forge');
const boards = require('./src/boards');
const presence = require('./src/presence');
const R = ['commun', 'rare', 'epique', 'legendaire'];
const pool = Array.from({ length: 60 }, (_, i) => ({ id: 'c' + i, name: 'Carte ' + i, cost: 1 + (i % 8), rarity: R[i % 10 < 6 ? 0 : i % 10 < 8 ? 1 : i % 10 < 9 ? 2 : 3] }));
const LIM = { commun: 2, rare: 2, epique: 2, legendaire: 1 };

/* ---------- Runes ---------- */
const u = { slug: 'bob', credits: 5000, stats: {}, resources: { bois: 100, pierre: 100, metal: 100, cristal: 20 }, forge: { built: true } };
assert.ok(forge.forgeRune(u, 'inconnue').error, 'rune inconnue refusée');
const o = forge.forgeRune(u, 'vigueur', 1000, () => 0.1);
assert.ok(o.ok && o.order.kind === 'rune' && o.order.runeId === 'vigueur', 'rune forgée comme une commande');
assert.strictEqual(u.resources.pierre, 100 - 8, 'coût de la rune payé');
assert.ok(forge.takeRunes(u, ['vigueur']).error, 'rune pas encore récupérée = pas en stock');
forge.ensureRunes(u); u.runes = { vigueur: 1, fortune: 2, garde: 1, prospecteur: 1, eveil: 1, anciens: 1 };
assert.ok(forge.takeRunes(u, ['vigueur', 'fortune', 'garde']).error, '2 runes au plus');
const tk = forge.takeRunes(u, ['vigueur', 'fortune']);
assert.ok(tk.ok); tk.commit();
assert.deepStrictEqual([u.runes.vigueur, u.runes.fortune], [undefined, 1], 'runes consommées au départ');
let r = ex.start(u, pool, LIM, { seed: 777, runes: tk.runes });
assert.ok(r.ok);
let run = u.expedition.run;
assert.strictEqual(run.maxHp, ex.START_HP + 8, 'Rune de vigueur : +8 PV max');
assert.strictEqual(run.gold, 50 + 75, 'Rune de fortune : +75 or');
ex.abandon(u);
/* Aides : mettre un contenu sur la case voisine et y aller ; déclencher un combat */
function stepTo(user, k) {
  const rn = user.expedition.run;
  const nx = rn.x + 1 < ex.MAP_W ? rn.x + 1 : rn.x - 1;
  const t = rn.map[rn.y][nx]; t.k = k; t.d = 0; t.v = 0;
  return ex.move(user, nx, rn.y, pool, LIM);
}
function forceFight(rn, kind, name) {
  rn.encounter = kind === 'boss' ? { kind, biome: 'foret', bossId: 'foret', name: 'Ent ancien', icon: '🌳' } : { kind, biome: 'foret', name: name || 'Loup gris', icon: '🐺' };
  rn.status = 'fight'; rn.moves = rn.moves || 1;
}
// garde + éveil : armure et mana à chaque combat ; prospecteur : ressources doublées ; anciens : relique de départ
r = ex.start(u, pool, LIM, { seed: 778, runes: ['garde', 'eveil'] });
run = u.expedition.run;
forceFight(run, 'combat');
let cfg = ex.fightConfig(run);
assert.strictEqual(cfg.fields.playerArmor, 3, 'Rune de garde : 3 d\'armure');
assert.deepStrictEqual(cfg.fields.manaBonus, [1, 0], "Rune d'éveil : +1 mana");
run.relics.push('sablier', 'bouclier');
cfg = ex.fightConfig(run);
assert.deepStrictEqual([cfg.fields.manaBonus[0], cfg.fields.playerArmor], [2, 8], 'cumul runes + reliques');
run.runes = ['prospecteur'];
const res0 = u.resources.bois;
const got = ex.recordFight(u, true, 20, pool, LIM);
assert.ok(got.loot.bois >= 4 && got.loot.bois % 2 === 0 && u.resources.bois === res0 + got.loot.bois, 'Rune du prospecteur : récolte doublée');
u.expedition.run = null;
r = ex.start(u, pool, LIM, { seed: 779, runes: ['anciens'] });
assert.strictEqual(u.expedition.run.relics.length, 1, 'Rune des anciens : une relique au départ');
u.expedition.run = null;

/* ---------- Ascension ---------- */
assert.ok(ex.start(u, pool, LIM, { seed: 1, ascension: 1 }).error, 'Ascension 1 verrouillée au début');
r = ex.start(u, pool, LIM, { seed: 2, ascension: 0 });
// trois boss vaincus puis retour : Expédition réussie
run = u.expedition.run; run.fightsWon = 2;
for (let i = 0; i < 3; i++) { forceFight(run, 'boss'); assert.ok(ex.recordFight(u, true, run.maxHp, pool, LIM).won); ex.pickReward(u, null); }
const back = ex.stop(u);
assert.ok(back.victory && back.bosses === 3, 'retour avec 3 boss : expédition réussie');
assert.strictEqual(u.expedition.ascension, 1, 'réussite : Ascension 1 débloquée');
assert.strictEqual(back.rewards.title, 'Explorateur légendaire');
r = ex.start(u, pool, LIM, { seed: 3, ascension: 1 });
assert.ok(r.ok && u.expedition.run.asc === 1);
u.expedition.run = null;
u.expedition.ascension = 10;
r = ex.start(u, pool, LIM, { seed: 4, ascension: 10 });
run = u.expedition.run;
assert.strictEqual(run.maxHp, ex.START_HP - 5, 'Ascension 3+ : 5 PV max de moins');
run.fightsWon = 2; forceFight(run, 'combat');
cfg = ex.fightConfig(run);
const plain = Object.assign({}, run, { asc: 0 });
assert.strictEqual(cfg.fields.opponentHeroHealth, ex.fightConfig(plain).fields.opponentHeroHealth + 6, 'Ascension 1 et 6 : +6 PV aux ennemis');
assert.strictEqual(cfg.fields.opponentArmor, 3, 'Ascension 9 : armure ennemie');
forceFight(run, 'boss');
const bossAsc = ex.fightConfig(run), bossPlain = ex.fightConfig(Object.assign({}, run, { asc: 0 }));
assert.strictEqual(bossAsc.fields.opponentHeroHealth, bossPlain.fields.opponentHeroHealth + 8 + 6, 'Ascension 5 : boss +8 PV');
assert.ok(bossAsc.quality > bossPlain.quality, 'Ascension 10 : boss plus forts');
u.expedition.run = null;

/* ---------- Bestiaire ---------- */
const v0 = ex.view(u, pool);
assert.strictEqual(v0.bestiary.length, 3 * (4 + 2 + 1), '21 créatures au bestiaire');
assert.ok(v0.bestiary.find(b => b.name === 'Ent ancien').beaten >= 3, 'boss vaincu noté');
assert.ok(ex.enemyInfo('Salamandre').lore && ex.enemyInfo('Salamandre').act === 'volcan');
const u2 = { slug: 'zed', credits: 1000, stats: {} };
ex.start(u2, pool, LIM, { seed: 50 });
const rn2 = u2.expedition.run; forceFight(rn2, 'combat', 'Salamandre');
const vf = ex.view(u2, pool).run.foe;
assert.ok(vf && vf.name === 'Salamandre' && !vf.lore && vf.met === 0, 'ennemi inconnu : pas encore de description');
const lost = ex.recordFight(u2, false, 0, pool, LIM);
assert.ok(lost.newFoe && lost.foe === vf.name, 'nouvel ennemi signalé');
assert.strictEqual(u2.expedition.bestiary[vf.name].met, 1);

/* ---------- Énigmes ---------- */
for (const rd of ex.RIDDLES) assert.ok(rd.options.length >= 3 && new Set(rd.options).size === rd.options.length, 'énigme ' + rd.id);
ex.start(u2, pool, LIM, { seed: 51 });
let run3 = u2.expedition.run;
assert.ok(stepTo(u2, 'riddle').ok && run3.status === 'riddle');
let vr = ex.view(u2, pool).run.riddle;
const def = ex.RIDDLES.find(x => x.id === run3.riddle.id);
assert.ok(vr && vr.text === def.text && !('answer' in vr), "l'énigme est envoyée sans la réponse");
const goodIdx = vr.options.indexOf(def.options[0]);
const g0 = run3.gold;
assert.ok(ex.riddleAnswer(u2, 'x').error, 'réponse inconnue refusée');
assert.ok(ex.riddleAnswer(u2, goodIdx).correct && run3.gold > g0 && run3.status === 'notice', 'bonne réponse : or');
ex.continueRun(u2);
// mauvaise réponse
stepTo(u2, 'riddle');
vr = ex.view(u2, pool).run.riddle;
const def2 = ex.RIDDLES.find(x => x.id === run3.riddle.id);
assert.notStrictEqual(def2.id, def.id, 'pas deux fois la même énigme');
const hp0 = run3.hp;
const bad = vr.options.findIndex(o2 => o2 !== def2.options[0]);
assert.ok(!ex.riddleAnswer(u2, bad).correct && run3.hp < hp0, 'mauvaise réponse : PV perdus');
ex.continueRun(u2);

/* ---------- Taverne (recrues) ---------- */
stepTo(u2, 'tavern');
assert.strictEqual(run3.status, 'tavern');
assert.ok(run3.tavern.cards.length === 3 && run3.tavern.cards.every(c => ['epique', 'legendaire'].includes(pool.find(p => p.id === c.id).rarity)), 'recrues épiques ou légendaires');
run3.gold = 1000;
const rec = run3.tavern.cards[0];
assert.ok(ex.tavernAction(u2, 'hire', rec.id).ok && run3.recruits.includes(rec.id));
assert.ok(ex.tavernAction(u2, 'hire', rec.id).error, 'une recrue ne s\'engage qu\'une fois');
assert.ok(ex.fightDeck(run3).includes(rec.id) && !run3.deck.includes(rec.id), 'la recrue combat avec toi, hors du deck retirable');
run3.recruits = ['a', 'b', 'c'];
assert.ok(ex.tavernAction(u2, 'hire', run3.tavern.cards[1].id).error, '3 recrues au plus');
assert.ok(ex.tavernAction(u2, 'leave').ok && run3.status === 'map');

/* ---------- Météo des plateaux ---------- */
boards._reset();
const added = boards.add({ name: 'Test météo', image: '/x.png', weather: 'neige', weatherIntensity: 3 });
assert.ok(added.ok && added.board.weather === 'neige' && added.board.weatherIntensity === 3);
boards.update(added.board.id, { weather: 'tornade' });
assert.strictEqual(boards.byId(added.board.id).weather, 'none', 'météo inconnue refusée');
boards.update(added.board.id, { weather: 'braises', weatherIntensity: 9 });
assert.deepStrictEqual([boards.byId(added.board.id).weather, boards.byId(added.board.id).weatherIntensity], ['braises', 3]);
boards.setClassic({ weather: 'pluie', weatherIntensity: 1 });
boards._reset();
const cat = boards.catalog();
assert.deepStrictEqual([cat[0].weather, cat[0].weatherIntensity], ['pluie', 1], 'météo du plateau classique gardée');
assert.strictEqual(cat.find(b => b.id === added.board.id).weather, 'braises');
boards.remove(added.board.id); boards.setClassic({ weather: 'none' });
const wjs = fs.readFileSync(path.join(__dirname, 'public/weather.js'), 'utf8');
['pluie', 'neige', 'braises', 'lucioles', 'feuilles', 'petales', 'brume'].forEach(k => { assert.ok(wjs.includes(k + ':'), 'animation ' + k); assert.ok(boards.WEATHERS[k]); });

/* ---------- Présence détaillée ---------- */
assert.strictEqual(presence.compute('a', { online: false }), null, 'hors ligne');
assert.strictEqual(presence.compute('a', { online: true, tab: 'forge' }).text, 'À la forge');
assert.strictEqual(presence.compute('a', { online: true, tab: '<script>' }).text, 'En ligne', 'onglet inconnu ignoré');
assert.strictEqual(presence.cleanTab('admin'), null, "l'onglet admin n'est pas montré");
assert.strictEqual(presence.compute('a', { online: true, tab: 'forge', visible: false }).text, 'Absent');
const xp = presence.compute('a', { online: true, tab: 'expedition', user: { expedition: { run: { regionName: 'les Pics Gelés', fightsWon: 4, asc: 2 } } } });
assert.strictEqual(xp.text, 'En Expédition · les Pics Gelés, 4 combats gagnés · Ascension 2');
const fight = presence.compute('a', { online: true, tab: 'combat', matchEntry: { expedition: { region: 2, level: 7 }, match: { players: [{ slug: 'a' }, { slug: 'bot', pseudo: '🐉 Dragon de lave' }] } } });
assert.ok(fight.busy && fight.text === 'En Expédition · région 2, danger 7' && fight.sub === 'contre Dragon de lave', 'combat d\'Expédition détaillé');
assert.strictEqual(presence.compute('a', { online: true, matchEntry: { match: { players: [{ slug: 'a', pseudo: 'A' }, { slug: 'b', pseudo: 'Bob' }] } } }).sub, 'contre Bob');
assert.strictEqual(presence.compute('a', { online: true, spectating: { a: 'Ann', b: 'Bob' } }).sub, 'Ann contre Bob');
assert.strictEqual(presence.compute('a', { online: true, queued: true }).text, 'Cherche un adversaire');
assert.ok(presence.same({ a: 1 }, { a: 1 }) && !presence.same({ a: 1 }, null));

/* ---------- Forge fermée pendant l'Expédition ---------- */
const srvF = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
['/api/forge/build', '/api/forge/booster', '/api/forge/cosmetic', '/api/forge/rune', '/api/forge/claim', '/api/forge/quest'].forEach(route => {
  const i = srvF.indexOf("app.post('" + route + "'");
  assert.ok(i > 0 && srvF.slice(i, i + 400).includes('forgeClosed(u, res)'), 'forge fermée en exploration : ' + route);
});
assert.ok(srvF.includes("case 'stop'") && srvF.includes('exploring: exploringNow(u)'), "bouton « Arrêter l'exploration » et état de la forge");
/* ---------- Câblage serveur / client ---------- */
const srv = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, 'public/app.js'), 'utf8');
['/api/forge/rune', "case 'riddle'", "case 'tavern'", 'expedition.fightDeck(run)', 'forge.takeRunes(u, b.runes)', "socket.on('activity'", "'presence:update'", '/api/admin/boards/classic'].forEach(k => assert.ok(srv.includes(k), 'serveur : ' + k));
['renderBestiary', 'renderAscensionPicker', 'renderRunePicker', 'renderForgeRunes', 'boardWeatherHost', 'syncWeather', 'presenceLine', "S.socket.emit('activity'"].forEach(k => assert.ok(app.includes(k), 'client : ' + k));
assert.ok(fs.readFileSync(path.join(__dirname, 'public/index.html'), 'utf8').includes('/weather.js'));
/* ---------- Forgeron en 3D (modèle .glb) ---------- */
const glb = fs.readFileSync(path.join(__dirname, 'public/models/forgeron.glb'));
assert.strictEqual(glb.toString('ascii', 0, 4), 'glTF', 'modèle du forgeron au format .glb');
const gj = JSON.parse(glb.toString('utf8', 20, 20 + glb.readUInt32LE(12)));
['upperarm.r', 'upperarm.l', 'lowerarm.r', 'lowerarm.l', 'head', 'spine', 'handslot.r', 'handslot.l'].forEach(n => assert.ok(gj.nodes.some(x => x.name === n), 'os ' + n));
assert.ok(gj.images && gj.images[0].bufferView !== undefined, 'texture intégrée au modèle');
const f3d = fs.readFileSync(path.join(__dirname, 'public/forge3d.js'), 'utf8');
const anv = fs.readFileSync(path.join(__dirname, 'public/models/enclume.glb'));
assert.strictEqual(anv.toString('ascii', 0, 4), 'glTF', "modèle de l'enclume au format .glb");
assert.ok(f3d.includes("'/models/enclume.glb'") && f3d.includes('loadAnvil()'));
const four = fs.readFileSync(path.join(__dirname, 'public/models/four.glb'));
assert.strictEqual(four.toString('ascii', 0, 4), 'glTF', 'modèle du four au format .glb');
assert.ok(f3d.includes("'/models/four.glb'") && f3d.includes('loadFurnace()'));
const batObj = fs.readFileSync(path.join(__dirname, 'public/models/batiment-forge.obj'), 'utf8');
['Wall_Cube', 'Roof_Cube', 'Ground_Cylinder', 'Anvil_Cube', 'Furnace_Cube'].forEach(n => assert.ok(batObj.includes('o ' + n), 'bâtiment : ' + n));
assert.ok(fs.existsSync(path.join(__dirname, 'public/models/batiment-forge-sol.png')), 'texture du sol du bâtiment');
assert.ok(f3d.includes("from 'three/addons/loaders/OBJLoader.js'") && f3d.includes("'/models/batiment-forge.obj'") && f3d.includes('loadBuilding()'));
const pan = fs.readFileSync(path.join(__dirname, 'public/models/panneau.glb'));
assert.strictEqual(pan.toString('ascii', 0, 4), 'glTF', 'modèle du panneau au format .glb');
assert.ok(f3d.includes("'/models/panneau.glb'") && f3d.includes('loadSign()') && f3d.includes('FrieDev'), 'panneau chargé, auteur crédité (CC BY 4.0)');
assert.ok(f3d.includes('function updateWalk') && f3d.includes("state === 'ready' ? 1 : 0"), 'le forgeron vient devant pour brandir le booster, puis retourne à son enclume');
const drinkFbx = fs.readFileSync(path.join(__dirname, 'public/models/forgeron-boire.fbx'));
assert.strictEqual(drinkFbx.toString('ascii', 0, 18), 'Kaydara FBX Binary', 'animation « boire » au format FBX binaire');
assert.ok(f3d.includes("'/models/forgeron-boire.fbx'") && f3d.includes('function applyDrink') && f3d.includes('AnimationMixer'), 'animation du café jouée sur le forgeron');
const cupFbx = fs.readFileSync(path.join(__dirname, 'public/models/tasse-cafe.fbx'));
assert.strictEqual(cupFbx.toString('ascii', 0, 18), 'Kaydara FBX Binary', 'gobelet de café au format FBX binaire');
assert.ok(f3d.includes("from 'three/addons/loaders/FBXLoader.js'") && f3d.includes("'/models/tasse-cafe.fbx'") && fs.existsSync(path.join(__dirname, 'node_modules/three/examples/jsm/libs/fflate.module.js')));
assert.ok(f3d.includes("from 'three/addons/loaders/GLTFLoader.js'") && f3d.includes("'/models/forgeron.glb'"));
assert.ok(fs.readFileSync(path.join(__dirname, 'public/index.html'), 'utf8').includes('"three/addons/": "/vendor/three-addons/"'));
assert.ok(srv.includes("app.use('/vendor/three-addons'") && fs.existsSync(path.join(__dirname, 'node_modules/three/examples/jsm/loaders/GLTFLoader.js')));
console.log('✅ Runes, Ascension, Bestiaire, énigmes, taverne, météo des plateaux et présence détaillée validés.');

/* ======================================================
   Mode Expédition : une exploration procédurale, presque un monde ouvert
   - À chaque départ, une nouvelle région est générée (carte en cases, sous un
     brouillard) : forêts, plaines, montagnes, marais et volcans, avec des combats,
     des élites, des trésors, des gisements de ressources, des marchands, des
     tavernes, des feux de camp, des énigmes et des repaires de boss.
   - Le joueur avance case par case dans la direction qu'il veut ; le brouillard
     se lève autour de lui. Chaque combat gagné rend les suivants plus durs.
   - Les boss sont aléatoires (repaires et boss errants), jamais avant le 3e combat.
     Un boss vaincu ouvre un passage vers une nouvelle région.
   - L'Expédition est sans fin : on rentre avec « Arrêter l'exploration » pour
     encaisser le sac (crédits, poussière, boosters). Une défaite fait perdre la
     moitié du sac. Les ressources (bois, pierre, métal, cristal) sont toujours gardées.
   - Pendant une Expédition, la Forge est fermée (le forgeron t'accompagne).
   Entrée gratuite une fois par jour (heure de Paris), ensuite en crédits.
   ====================================================== */


const ACTS = [
  { id: 'foret', name: 'Forêt des Murmures', icon: '🌲', boss: { name: 'Ent ancien', icon: '🌳', hp: 35, quality: 0.55,
    lore: "Le plus vieil arbre de la forêt. On dit qu'il a vu naître les montagnes, et qu'il n'aime pas qu'on marche sur ses racines." } },
  { id: 'mines', name: 'Mines profondes', icon: '⛏️', boss: { name: 'Golem de cristal', icon: '💎', hp: 45, quality: 0.72,
    lore: "Assemblé par les anciens mineurs pour garder le filon le plus pur. Ses maîtres sont partis depuis longtemps ; lui monte toujours la garde." } },
  { id: 'volcan', name: 'Cœur du Volcan', icon: '🌋', boss: { name: 'Dragon de lave', icon: '🐉', hp: 55, quality: 0.9,
    lore: "Il dort sur un trésor fondu depuis des siècles. Chaque aventurier qui le réveille rend son sommeil un peu plus léger." } }
];
/* Bestiaire : les ennemis de chaque acte (le nom sert d'identifiant) */
const ENEMIES = {
  foret: {
    combat: [
      { name: 'Loup gris', icon: '🐺', lore: 'Il chasse en meute, mais celui-ci a été chassé de la sienne. Il a faim, et il est vexé.' },
      { name: 'Bandit des bois', icon: '🏹', lore: 'Ancien bûcheron reconverti. Il réclame un péage pour un chemin qui ne lui appartient pas.' },
      { name: 'Araignée géante', icon: '🕷️', lore: 'Huit pattes, huit yeux, et une toile tendue entre deux chênes. Ne regarde pas en haut.' },
      { name: 'Champignon furieux', icon: '🍄', lore: "Personne ne sait ce qui l'a mis en colère. Ses spores, elles, ne sont pas contagieuses… en principe." }
    ],
    elite: [
      { name: 'Sorcière des marais', icon: '🧙‍♀️', lore: 'Elle échange des potions contre des souvenirs. Ceux qui refusent finissent en grenouilles.' },
      { name: 'Ours-garou', icon: '🐻', lore: 'Aimable bûcheron le jour. La nuit, il ne se souvient plus de ton nom, ni du sien.' }
    ]
  },
  mines: {
    combat: [
      { name: 'Gobelin mineur', icon: '👺', lore: 'Il creuse vingt heures par jour et se plaint les quatre autres.' },
      { name: 'Chauve-souris des cavernes', icon: '🦇', lore: "Elle voit avec ses oreilles. Malheureusement pour toi, elle t'entend très bien." },
      { name: 'Squelette de mineur', icon: '💀', lore: "Il n'a jamais fini son dernier quart de travail, et il compte bien le terminer." },
      { name: 'Taupe cuirassée', icon: '🦔', lore: 'Sa carapace a émoussé plus de pioches que la roche elle-même.' }
    ],
    elite: [
      { name: 'Contremaître gobelin', icon: '👹', lore: "Il a un sifflet, un fouet, et un avis sur tout. Surtout sur ta façon de te battre." },
      { name: 'Golem de pierre', icon: '🗿', lore: 'Le petit frère du Golem de cristal. Moins brillant, mais tout aussi têtu.' }
    ]
  },
  volcan: {
    combat: [
      { name: 'Diablotin de feu', icon: '😈', lore: 'Il rit de tout, surtout quand quelque chose brûle.' },
      { name: 'Salamandre', icon: '🦎', lore: 'Elle se baigne dans la lave comme d\'autres dans un lac en été.' },
      { name: 'Cultiste des flammes', icon: '🔥', lore: "Il prie le Dragon chaque soir. Le Dragon ne l'a jamais remarqué." },
      { name: 'Élémentaire de braise', icon: '🌋', lore: 'Un tas de charbons qui a décidé de se lever un beau matin.' }
    ],
    elite: [
      { name: 'Chevalier de magma', icon: '🤺', lore: "Son armure a fondu sur lui il y a cent ans. Il ne l'enlève plus." },
      { name: 'Prêtresse des cendres', icon: '🧝‍♀️', lore: 'Elle lit l\'avenir dans les cendres. Dans les tiennes, de préférence.' }
    ]
  }
};
function enemyInfo(name) {
  for (const act of ACTS) {
    if (act.boss.name === name) return { name, icon: act.boss.icon, lore: act.boss.lore, act: act.id, type: 'boss' };
    for (const type of ['combat', 'elite']) { const e = ENEMIES[act.id][type].find(x => x.name === name); if (e) return Object.assign({ act: act.id, type }, e); }
  }
  return null;
}
/* Ascension : après une victoire, le niveau suivant se débloque (règles cumulées) */
const ASCENSION = [
  null,
  { icon: '❤️', text: 'Les ennemis ont 3 PV de plus.' },
  { icon: '💀', text: 'Les élites jouent mieux.' },
  { icon: '💔', text: 'Tu pars avec 5 PV max de moins.' },
  { icon: '🏪', text: 'Le marchand et la taverne sont 20 % plus chers.' },
  { icon: '👑', text: 'Les boss ont 8 PV de plus.' },
  { icon: '❤️', text: 'Les ennemis ont encore 3 PV de plus.' },
  { icon: '🪙', text: "Tu gagnes 25 % d'or en moins." },
  { icon: '🔥', text: 'Les feux de camp soignent moins (20 % au lieu de 30 %).' },
  { icon: '🛡️', text: "Les ennemis commencent chaque combat avec 3 d'armure." },
  { icon: '🐉', text: 'Les boss jouent leurs meilleures cartes.' }
];
const MAX_ASCENSION = ASCENSION.length - 1;
const ascAt = (run, n) => (run.asc || 0) >= n;
/* Runes forgées à la Forge (voir src/forge.js) : effets pendant toute l'Expédition */
const runeOn = (run, id) => (run.runes || []).includes(id);
/* Énigmes et coffres à combinaison : une bonne réponse rapporte, une mauvaise fait mal.
   La bonne réponse est toujours la première de la liste (l'ordre affiché est mélangé). */
const RIDDLES = [
  { id: 'eponge', kind: 'enigme', text: "Je suis pleine de trous, et pourtant je retiens l'eau. Qui suis-je ?", options: ['Une éponge', 'Un filet de pêche', 'Une passoire'] },
  { id: 'trou', kind: 'enigme', text: "Plus on m'enlève de terre, plus je deviens grand. Qui suis-je ?", options: ['Un trou', 'Une montagne', 'Une ombre'] },
  { id: 'peigne', kind: 'enigme', text: "J'ai des dents, mais je ne mords jamais. Qui suis-je ?", options: ['Un peigne', 'Un requin', 'Une horloge'] },
  { id: 'riviere', kind: 'enigme', text: "Je cours sans jambes, j'ai un lit mais je ne dors jamais. Qui suis-je ?", options: ['Une rivière', 'Le vent', 'Un cheval'] },
  { id: 'echo', kind: 'enigme', text: "Je réponds à tout le monde sans avoir de bouche, et je répète toujours le dernier mot. Qui suis-je ?", options: ["L'écho", 'Un fantôme', 'Une cloche'] },
  { id: 'serviette', kind: 'enigme', text: 'Plus je sèche, plus je suis mouillée. Qui suis-je ?', options: ['Une serviette', 'Une flaque', 'Un nuage'] },
  { id: 'oeuf', kind: 'enigme', text: "Il faut me casser avant de pouvoir m'utiliser. Qui suis-je ?", options: ['Un œuf', 'Une pierre', 'Une clé'] },
  { id: 'escalier', kind: 'enigme', text: 'Je monte et je descends sans jamais bouger. Qui suis-je ?', options: ['Un escalier', 'Un ascenseur', 'Une vague'] },
  { id: 'carte', kind: 'enigme', text: "J'ai des villes sans maisons, des forêts sans arbres et des rivières sans eau. Qui suis-je ?", options: ['Une carte', 'Un rêve', 'Un désert'] },
  { id: 'pas', kind: 'enigme', text: "Plus tu en fais, plus tu en laisses derrière toi. Que sont-ils ?", options: ['Des pas', 'Des cartes', 'Des pièces'] },
  { id: 'araignee', kind: 'coffre', text: "Gravé sur le coffre : « Le premier chiffre est le nombre de pattes d'une araignée. Le deuxième en est la moitié. Le dernier est leur différence. »", options: ['844', '848', '484', '824'] },
  { id: 'suite', kind: 'coffre', text: "Gravé sur le coffre : « Trois chiffres qui se suivent, du plus petit au plus grand. Leur somme fait 12. »", options: ['345', '456', '234', '444'] },
  { id: 'formes', kind: 'coffre', text: "Gravé sur le coffre : « Les côtés d'un triangle, puis ceux d'un carré, puis leur somme. »", options: ['347', '346', '437', '341'] },
  { id: 'de', kind: 'coffre', text: "Gravé sur le coffre : « Sur un dé, le chiffre caché sous le 2, puis sous le 6, puis sous le 4. »", options: ['513', '315', '534', '451'] }
];
const RECRUIT_PRICE = { epique: 70, legendaire: 120 };
const MAX_RECRUITS = 3;
const START_HP = 30;
const START_DECK = 15;
const MAX_DECK = 30;
const ENTRY_PRICE = 120;
const CARD_PRICE = { commun: 40, rare: 70, epique: 120, legendaire: 200 };
const RELIC_PRICE = 150, REMOVE_PRICE = 75, HEAL_PRICE = 40, HEAL_AMOUNT = 10;
const RELICS = {
  coeur: { icon: '❤️', name: 'Cœur de géant', desc: '+8 PV max (et 8 PV rendus).' },
  sablier: { icon: '⏳', name: 'Sablier ancien', desc: 'Tu commences chaque combat avec 1 mana de plus.' },
  bourse: { icon: '💰', name: 'Bourse sans fond', desc: '+50 % d\'or gagné.' },
  potion: { icon: '🧪', name: 'Potion éternelle', desc: 'Rend 4 PV après chaque combat gagné.' },
  oeil: { icon: '👁️', name: 'Œil du collectionneur', desc: '4 cartes proposées au lieu de 3 après un combat.' },
  membre: { icon: '🎫', name: 'Carte de membre', desc: '-25 % chez le marchand.' },
  bouclier: { icon: '🛡️', name: 'Bouclier de chêne', desc: 'Ton héros commence chaque combat avec 5 d\'armure.' },
  dague: { icon: '🗡️', name: 'Dague empoisonnée', desc: 'L\'ennemi commence chaque combat avec 5 PV de moins.' },
  fer: { icon: '🍀', name: 'Fer à cheval', desc: 'Les cartes proposées sont plus souvent rares.' }
};
const EVENTS = {
  fontaine: { icon: '⛲', title: 'Fontaine mystérieuse', text: 'Une eau scintillante coule d\'une vieille fontaine.',
    choices: [{ id: 'boire', label: 'Boire (+10 PV)' }, { id: 'gourde', label: 'Remplir ta gourde et la revendre (+40 or)' }] },
  louche: { icon: '🕵️', title: 'Marchand louche', text: '« Une relique contre un peu de ton sang ? »',
    choices: [{ id: 'payer', label: 'Accepter (−7 PV, relique au hasard)' }, { id: 'partir', label: 'Refuser et partir' }] },
  autel: { icon: '🗿', title: 'Autel oublié', text: 'L\'autel réclame une offrande.',
    choices: [{ id: 'offrir', label: 'Offrir une carte au hasard de ton deck (reçois une carte rare ou mieux)' }, { id: 'partir', label: 'Passer ton chemin' }] },
  coffre: { icon: '🧰', title: 'Coffre piégé ?', text: 'Un coffre trône au milieu de la salle. Il a l\'air un peu trop facile.',
    choices: [{ id: 'ouvrir', label: 'L\'ouvrir (1 chance sur 2 : 90 or, sinon −6 PV)' }, { id: 'partir', label: 'Ne pas y toucher' }] },
  mendiant: { icon: '🧙', title: 'Vieil ermite', text: '« Quelques pièces, et je t\'apprends à mieux encaisser. »',
    choices: [{ id: 'donner', label: 'Donner 30 or (+5 PV max)' }, { id: 'partir', label: 'Partir' }] }
};

/* Ressources récoltées (bois, pierre, métal, cristal) : données au joueur tout de suite,
   elles restent acquises même si l'Expédition finit mal. Elles servent à la Forge. */
const LOOT = {
  combat: { bois: [2, 4], pierre: [1, 3], metal: [1, 1, 0.35] },
  elite: { bois: [3, 5], pierre: [2, 4], metal: [2, 3], cristal: [1, 1, 0.4] },
  boss: { bois: [5, 5], pierre: [5, 5], metal: [5, 5], cristal: [3, 3] },
  treasure: { bois: [3, 5], pierre: [2, 3], metal: [1, 2], cristal: [1, 1, 0.15] }
};
function rollLoot(rng, kind) {
  const out = {};
  Object.entries(LOOT[kind] || {}).forEach(([k, [a, b, chance]]) => {
    if (chance !== undefined && rng() >= chance) return;
    out[k] = a + Math.floor(rng() * (b - a + 1));
  });
  return out;
}
function giveLoot(user, run, gains) {
  if (!user.resources || typeof user.resources !== 'object') user.resources = {};
  run.loot = run.loot || {};
  const mult = runeOn(run, 'prospecteur') ? 2 : 1; // Rune du prospecteur : récolte doublée
  const out = {};
  Object.entries(gains || {}).forEach(([k, n]) => { if (!n) return; n *= mult; out[k] = n; user.resources[k] = (Number(user.resources[k]) || 0) + n; run.loot[k] = (run.loot[k] || 0) + n; });
  return out;
}
function dayKey(now) { return new Date(now || Date.now()).toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' }); }
function rngFrom(seed) { let x = seed >>> 0 || 1; return () => { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; }; }
const pick = (arr, rng) => arr[Math.floor(rng() * arr.length)];
function ensure(user) {
  const e = user.expedition = user.expedition && typeof user.expedition === 'object' ? user.expedition : {};
  if (typeof e.best !== 'number') e.best = 0;
  if (typeof e.runs !== 'number') e.runs = 0;
  if (typeof e.wins !== 'number') e.wins = 0;
  if (e.run === undefined) e.run = null;
  if (!e.bossKills || typeof e.bossKills !== 'object') e.bossKills = {};
  if (!Array.isArray(e.relicsFound)) e.relicsFound = [];
  if (!e.bestiary || typeof e.bestiary !== 'object') e.bestiary = {};
  if (typeof e.ascension !== 'number') e.ascension = 0;
  if (typeof e.bestAscension !== 'number') e.bestAscension = -1;
  // Passage à l'exploration en monde ouvert : une ancienne Expédition (en étages) en cours est arrêtée
  // et son entrée rendue ; le record (en étages) repart de zéro (il compte maintenant les combats gagnés).
  if (e.v !== 2) {
    if (e.run && !e.run.bag) { if (e.run.paid) user.credits = (user.credits || 0) + e.run.paid; else e.freeDay = null; e.run = null; }
    e.best = 0; e.v = 2;
  }
  return e;
}
/* Personnage d'exploration (apparence du pion sur la carte) : choisi par le joueur */
const EXPLORERS = [
  { id: 'nain', icon: '🧔', name: 'Nain forgeron' }, { id: 'mage', icon: '🧙', name: 'Mage errant' }, { id: 'elfe', icon: '🧝', name: 'Elfe des bois' },
  { id: 'ninja', icon: '🥷', name: 'Ninja' }, { id: 'aventurier', icon: '🤠', name: 'Aventurier' }, { id: 'chevalier', icon: '💂', name: 'Chevalier' },
  { id: 'vampire', icon: '🧛', name: 'Vampire' }, { id: 'sirene', icon: '🧜', name: 'Sirène' }, { id: 'robot', icon: '🤖', name: 'Robot' },
  { id: 'astronaute', icon: '🧑‍🚀', name: 'Astronaute' }, { id: 'renard', icon: '🦊', name: 'Renard rusé' }, { id: 'chat', icon: '🐱', name: 'Chat curieux' },
  { id: 'grenouille', icon: '🐸', name: 'Grenouille' }, { id: 'pingouin', icon: '🐧', name: 'Pingouin' }, { id: 'fantome', icon: '👻', name: 'Fantôme' },
  { id: 'avatar', icon: '🖼️', name: 'Ton avatar' }
];
const EXPLORER_COLORS = ['#ffd36a', '#ff7a45', '#ff5c8a', '#b07cff', '#5aa8ff', '#3fd1c4', '#6fdc6a', '#ffffff'];
function explorerOf(user) {
  const e = ensure(user);
  const x = e.explorer && typeof e.explorer === 'object' ? e.explorer : {};
  return { id: EXPLORERS.some(p => p.id === x.id) ? x.id : 'nain', color: EXPLORER_COLORS.includes(x.color) ? x.color : EXPLORER_COLORS[0], name: typeof x.name === 'string' ? x.name : '' };
}
function setExplorer(user, b) {
  b = b || {};
  const cur = explorerOf(user);
  if (b.id !== undefined) { if (!EXPLORERS.some(p => p.id === b.id)) return { error: 'Personnage inconnu.' }; cur.id = b.id; }
  if (b.color !== undefined) { if (!EXPLORER_COLORS.includes(b.color)) return { error: 'Couleur inconnue.' }; cur.color = b.color; }
  if (b.name !== undefined) cur.name = String(b.name).replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 20);
  ensure(user).explorer = cur;
  return { ok: true, explorer: cur };
}
function freeAvailable(user, now) { return ensure(user).freeDay !== dayKey(now); }
/* ---------- Le monde ---------- */
const MAP_W = 15, MAP_H = 11;
const BOSS_MIN_FIGHTS = 2; // pas de boss avant le 3e combat
const BIOMES = {
  foret: { name: 'Forêt', icon: '🌲', deco: ['🌲', '🌳', '🌲', '🍄'], enemies: 'foret', res: { bois: [3, 6], pierre: [0, 2] } },
  plaine: { name: 'Plaine', icon: '🌾', deco: ['🌾', '🌼', '🌾', '🪨'], enemies: 'foret', res: { bois: [2, 4], pierre: [1, 3] } },
  marais: { name: 'Marais', icon: '🪷', deco: ['🪷', '🌿', '🐸', '🌫️'], enemies: 'foret', res: { bois: [2, 5], cristal: [0, 1] } },
  montagne: { name: 'Montagnes', icon: '⛰️', deco: ['⛰️', '🪨', '⛏️', '🏔️'], enemies: 'mines', res: { pierre: [3, 6], metal: [1, 3], cristal: [0, 1] } },
  volcan: { name: 'Terres volcaniques', icon: '🌋', deco: ['🌋', '🔥', '🪨', '💀'], enemies: 'volcan', res: { metal: [2, 4], cristal: [1, 2] } }
};
const BIOME_KEYS = Object.keys(BIOMES);
/* Contenu des cases (k) */
const NODE_TYPES = {
  empty: { icon: '', name: 'Terrain' }, start: { icon: '🏕️', name: 'Campement de départ' },
  combat: { icon: '⚔️', name: 'Combat' }, elite: { icon: '💀', name: 'Élite' }, boss: { icon: '👑', name: 'Repaire de boss' },
  shop: { icon: '🏪', name: 'Marchand' }, treasure: { icon: '🎁', name: 'Trésor' }, camp: { icon: '🔥', name: 'Feu de camp' },
  event: { icon: '❓', name: 'Inconnu' }, riddle: { icon: '🧩', name: 'Énigme' }, tavern: { icon: '🍺', name: 'Taverne' },
  ore: { icon: '⛏️', name: 'Gisement' }, portal: { icon: '🌀', name: 'Passage vers une nouvelle région' },
  block: { icon: '', name: 'Infranchissable' }
};
const BLOCK_DECO = { foret: '🌳', plaine: '🪨', marais: '🌊', montagne: '🏔️', volcan: '🌋' };
const REGION_NAMES = {
  foret: ['les Bois Murmurants', 'la Sylve Profonde', 'la Forêt des Lucioles'], plaine: ['les Prés Dorés', 'la Lande Venteuse', 'les Champs Oubliés'],
  marais: ['les Marais Brumeux', 'les Tourbières', "l'Étang aux Grenouilles"], montagne: ['les Pics Gelés', 'les Mines Abandonnées', 'le Col du Nain'],
  volcan: ['les Cendres Rouges', 'la Faille Ardente', 'le Cœur du Volcan']
};
const BOSSES = { foret: ACTS[0].boss, mines: ACTS[1].boss, volcan: ACTS[2].boss };
const BOSS_FOR_BIOME = { foret: 'foret', plaine: 'foret', marais: 'foret', montagne: 'mines', volcan: 'volcan' };

const inside = (x, y) => x >= 0 && y >= 0 && x < MAP_W && y < MAP_H;
const tileAt = (run, x, y) => inside(x, y) ? run.map[y][x] : null;
const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/* Nouvelle région : biomes (zones autour de quelques germes), obstacles, contenu des cases */
function generateWorld(rng, region) {
  const seeds = [];
  const nSeeds = 4 + Math.floor(rng() * 3);
  for (let i = 0; i < nSeeds; i++) {
    // plus on s'enfonce (région), plus les biomes durs (montagne, volcan) sont fréquents
    const hard = rng() < Math.min(0.75, 0.25 + region * 0.15);
    const b = hard ? pick(['montagne', 'volcan', 'marais'], rng) : pick(['foret', 'plaine', 'foret', 'marais'], rng);
    seeds.push({ x: Math.floor(rng() * MAP_W), y: Math.floor(rng() * MAP_H), b });
  }
  const sx = Math.floor(MAP_W / 2), sy = Math.floor(MAP_H / 2);
  const map = [];
  for (let y = 0; y < MAP_H; y++) {
    const row = [];
    for (let x = 0; x < MAP_W; x++) {
      let best = seeds[0], bd = 1e9;
      seeds.forEach(s => { const d = Math.hypot(s.x - x, (s.y - y) * 1.2) + rng() * 0.9; if (d < bd) { bd = d; best = s; } });
      row.push({ b: best.b, k: 'empty', d: 0, s: 0 });
    }
    map.push(row);
  }
  // Obstacles (lacs, rochers, grands arbres) loin du départ
  for (let y = 0; y < MAP_H; y++) for (let x = 0; x < MAP_W; x++) {
    if (Math.abs(x - sx) + Math.abs(y - sy) > 1 && rng() < 0.12) map[y][x].k = 'block';
  }
  // Cases accessibles depuis le départ ; les autres deviennent infranchissables
  const seen = new Set([sx + ',' + sy]), queue = [[sx, sy]], reach = [];
  while (queue.length) {
    const [x, y] = queue.shift(); reach.push([x, y]);
    N4.forEach(([dx, dy]) => { const nx = x + dx, ny = y + dy, key = nx + ',' + ny; if (inside(nx, ny) && !seen.has(key) && map[ny][nx].k !== 'block') { seen.add(key); queue.push([nx, ny]); } });
  }
  for (let y = 0; y < MAP_H; y++) for (let x = 0; x < MAP_W; x++) if (!seen.has(x + ',' + y)) map[y][x].k = 'block';
  const dist = (x, y) => Math.abs(x - sx) + Math.abs(y - sy);
  const free = reach.filter(([x, y]) => dist(x, y) > 0);
  const takeFree = (filter) => { const c = free.filter(([x, y]) => map[y][x].k === 'empty' && (!filter || filter(x, y))); return c.length ? pick(c, rng) : null; };
  // Incontournables : 2 repaires de boss loin du départ, un marchand, un feu de camp, une taverne
  for (let i = 0; i < 2; i++) { const p = takeFree((x, y) => dist(x, y) >= 6); if (p) map[p[1]][p[0]].k = 'boss'; }
  [['shop', 3], ['camp', 3], ['tavern', 4]].forEach(([k, dmin]) => { const p = takeFree((x, y) => dist(x, y) >= dmin); if (p) map[p[1]][p[0]].k = k; });
  // Le reste, au hasard (plus de dangers loin du départ)
  free.forEach(([x, y]) => {
    const t = map[y][x];
    if (t.k !== 'empty') return;
    const d = dist(x, y), r = rng();
    if (d <= 1) { if (r < 0.25) t.k = 'treasure'; return; }
    const elite = d >= 4 ? 0.06 : 0;
    t.k = r < 0.2 ? 'combat' : r < 0.2 + elite ? 'elite' : r < 0.28 + elite ? 'treasure' : r < 0.36 + elite ? 'ore'
      : r < 0.4 + elite ? 'event' : r < 0.43 + elite ? 'riddle' : r < 0.45 + elite ? 'camp' : r < 0.465 + elite ? 'shop' : 'empty';
  });
  map[sy][sx].k = 'start'; map[sy][sx].d = 1;
  const biome = map[sy][sx].b;
  return { map, x: sx, y: sy, name: pick(REGION_NAMES[biome] || ['une contrée inconnue'], rng), biome };
}
/* Le brouillard se lève autour d'une case (8 voisines) */
function reveal(run, x, y, radius) {
  const r = radius || 1;
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) { const t = tileAt(run, x + dx, y + dy); if (t) t.s = 1; }
}
/* Niveau de danger : un combat gagné = +1 ; chaque nouvelle région ajoute aussi un peu */
function level(run) { return (run.fightsWon || 0) + (run.region || 0); }
function absFloor(run) { return level(run); } // utilisé par le tirage de rareté des cartes
function newRegion(run, rng) {
  const w = generateWorld(rng, run.region || 0);
  run.map = w.map; run.x = w.x; run.y = w.y; run.regionName = w.name; run.regionBiome = w.biome;
  reveal(run, run.x, run.y, 1);
}


/* Rareté d'une carte proposée selon l'étage, l'élite et la relique Fer à cheval */
function rollRarity(rng, floor, elite, lucky) {
  const bonus = floor * 0.012 + (elite ? 0.15 : 0) + (lucky ? 0.12 : 0);
  const r = rng();
  if (r < 0.02 + bonus * 0.35) return 'legendaire';
  if (r < 0.1 + bonus * 0.8) return 'epique';
  if (r < 0.38 + bonus) return 'rare';
  return 'commun';
}
function offerCards(run, pool, limits, rng, count, opts) {
  opts = opts || {};
  const inDeck = {};
  run.deck.forEach(id => { inDeck[id] = (inDeck[id] || 0) + 1; });
  const out = [];
  for (let tries = 0; out.length < count && tries < 80; tries++) {
    const rar = opts.minRare && tries < 40 ? (rng() < 0.75 ? 'rare' : rng() < 0.8 ? 'epique' : 'legendaire') : rollRarity(rng, absFloor(run), opts.elite, run.relics.includes('fer'));
    let cands = pool.filter(c => c.rarity === rar && !out.includes(c.id) && (inDeck[c.id] || 0) < ((limits && limits[c.rarity]) || 2));
    if (!cands.length) cands = pool.filter(c => !out.includes(c.id) && (inDeck[c.id] || 0) < ((limits && limits[c.rarity]) || 2));
    if (!cands.length) break;
    out.push(pick(cands, rng).id);
  }
  return out;
}
function starterDeck(pool, limits, rng) {
  const commons = pool.filter(c => c.rarity === 'commun'), rares = pool.filter(c => c.rarity === 'rare');
  const deck = [], count = {};
  const add = c => { if (!c || (count[c.id] || 0) >= ((limits && limits[c.rarity]) || 2)) return false; deck.push(c.id); count[c.id] = (count[c.id] || 0) + 1; return true; };
  for (let i = 0; deck.length < 3 && i < 200 && rares.length; i++) add(pick(rares, rng));
  for (let i = 0; deck.length < START_DECK && i < 500 && commons.length; i++) add(pick(commons, rng));
  for (let i = 0; deck.length < START_DECK && i < 500; i++) add(pick(pool, rng));
  return deck;
}

function rngOf(run) { run.step = (run.step || 0) + 1; return rngFrom((run.seed * 31 + run.step * 7919) % 2147483647); }
function goldGain(run, base) { return Math.round(base * (run.relics.includes('bourse') ? 1.5 : 1) * (ascAt(run, 7) ? 0.75 : 1)); }
function grantRelic(run, rng, id) {
  const left = Object.keys(RELICS).filter(r => !run.relics.includes(r));
  const relic = id && left.includes(id) ? id : left.length ? pick(left, rng || Math.random) : null;
  if (!relic) return null;
  run.relics.push(relic);
  if (relic === 'coeur') { run.maxHp += 8; run.hp = Math.min(run.maxHp, run.hp + 8); }
  return relic;
}
function price(run, base) { return Math.round(base * (run.relics.includes('membre') ? 0.75 : 1) * (ascAt(run, 4) ? 1.2 : 1)); }
function start(user, pool, limits, opts) {
  opts = opts || {};
  const e = ensure(user);
  if (e.run) return { error: 'Tu as déjà une Expédition en cours.' };
  if (pool.length < 10) return { error: 'Pas assez de cartes dans le jeu pour une Expédition.' };
  const asc = Math.max(0, Math.min(MAX_ASCENSION, Math.round(Number(opts.ascension) || 0)));
  if (asc > e.ascension) return { error: `Le niveau d'Ascension ${asc} n'est pas encore débloqué.` };
  const runes = Array.isArray(opts.runes) ? opts.runes.slice(0, 2) : [];
  const free = freeAvailable(user, opts.now);
  if (!free && (user.credits || 0) < ENTRY_PRICE) return { error: `L'entrée coûte ${ENTRY_PRICE} crédits (il t'en manque ${ENTRY_PRICE - (user.credits || 0)}). Reviens demain pour l'entrée gratuite !` };
  if (free) e.freeDay = dayKey(opts.now);
  else { user.credits -= ENTRY_PRICE; if (user.stats) user.stats.creditsSpent = (user.stats.creditsSpent || 0) + ENTRY_PRICE; }
  const seed = opts.seed || Math.floor(Math.random() * 2147483647) + 1;
  const rng = rngFrom(seed);
  const maxHp = START_HP - (asc >= 3 ? 5 : 0) + (runes.includes('vigueur') ? 8 : 0);
  e.run = {
    seed, step: 0, region: 0, hp: maxHp, maxHp, gold: 50 + (runes.includes('fortune') ? 75 : 0),
    deck: starterDeck(pool, limits, rng), relics: [], status: 'map', fightsWon: 0, elitesWon: 0, bossesWon: 0, explored: 0, moves: 0,
    asc, runes, recruits: [], bag: { credits: 0, dust: 0, boosters: 0 }, encounter: null,
    reward: null, shop: null, event: null, riddle: null, tavern: null, notice: null, startedAt: Date.now(), paid: free ? 0 : ENTRY_PRICE
  };
  newRegion(e.run, rng);
  if (runes.includes('anciens')) grantRelic(e.run, rng);
  return { ok: true, free };
}
/* Butin dans le sac (crédits, poussière, boosters) : encaissé au retour, moitié perdue en cas de défaite */
function bagAdd(run, gains) {
  const m = 1 + 0.15 * (run.asc || 0); // l'Ascension augmente les gains
  const out = {};
  ['credits', 'dust'].forEach(k => { if (gains[k]) { out[k] = Math.round(gains[k] * m); run.bag[k] += out[k]; } });
  if (gains.boosters) { out.boosters = gains.boosters; run.bag.boosters += gains.boosters; }
  return out;
}
/* Butin aléatoire : la taille dépend du type de rencontre et du niveau de danger */
function rollBag(rng, kind, lv) {
  const g = {};
  const r = rng();
  if (kind === 'boss') return { credits: 110 + Math.floor(rng() * 60) + lv * 6, dust: 50 + Math.floor(rng() * 30) + lv * 3, boosters: 1 + (rng() < 0.35 ? 1 : 0) };
  if (kind === 'elite') { g.credits = 35 + Math.floor(rng() * 40) + lv * 4; g.dust = 15 + Math.floor(rng() * 20) + lv * 2; if (rng() < 0.3) g.boosters = 1; return g; }
  if (kind === 'treasure') { if (r < 0.45) g.credits = 25 + Math.floor(rng() * 35) + lv * 3; else if (r < 0.85) g.dust = 15 + Math.floor(rng() * 20) + lv * 2; else g.boosters = 1; return g; }
  // combat ordinaire
  if (r < 0.55) g.credits = 12 + Math.floor(rng() * 20) + lv * 3; else if (r < 0.9) g.dust = 6 + Math.floor(rng() * 12) + lv * 2; else g.boosters = 1;
  return g;
}
/* Ressources d'un gisement : selon le biome */
function rollOre(rng, biome, lv) {
  const out = {};
  Object.entries((BIOMES[biome] || BIOMES.plaine).res).forEach(([k, [a, b]]) => { const n = a + Math.floor(rng() * (b - a + 1)) + (lv >= 6 ? 1 : 0); if (n > 0) out[k] = n; });
  return out;
}
/* Prépare un combat sur la case (ennemi tiré selon le biome) */
function setEncounter(run, kind, biome, rng, extra) {
  const set = ENEMIES[(BIOMES[biome] || BIOMES.foret).enemies] || ENEMIES.foret;
  if (kind === 'boss') {
    const id = (extra && extra.bossId) || (rng() < 0.5 ? BOSS_FOR_BIOME[biome] : pick(Object.keys(BOSSES), rng));
    const b = BOSSES[id];
    run.encounter = { kind, biome, bossId: id, name: b.name, icon: b.icon, roaming: !!(extra && extra.roaming) };
  } else {
    const foe = pick(set[kind === 'elite' ? 'elite' : 'combat'], rng);
    run.encounter = { kind, biome, name: foe.name, icon: foe.icon, ambush: !!(extra && extra.ambush) };
  }
  run.status = 'fight';
}
/* Se déplacer d'une case (haut, bas, gauche, droite) */
function move(user, tx, ty, pool, limits) {
  const run = ensure(user).run;
  if (!run) return { error: 'Aucune Expédition en cours.' };
  if (run.status !== 'map') return { error: "Termine d'abord ce qui se passe ici." };
  const x = Math.round(Number(tx)), y = Math.round(Number(ty));
  if (!inside(x, y) || Math.abs(x - run.x) + Math.abs(y - run.y) !== 1) return { error: 'Tu ne peux aller que sur une case voisine.' };
  const t = run.map[y][x];
  if (t.k === 'block') return { error: 'Impossible de passer par là.' };
  const rng = rngOf(run);
  const fresh = !t.v;
  run.x = x; run.y = y; t.v = 1; run.moves++;
  reveal(run, x, y, 1);
  run.notice = null;
  if (fresh) run.explored++;
  const lv = level(run);
  if (t.d) {
    // case déjà faite : parfois une embuscade sur le chemin
    if (fresh && rng() < Math.min(0.2, 0.06 + lv * 0.01)) setEncounter(run, 'combat', t.b, rng, { ambush: true });
    return { ok: true, fresh, type: t.k };
  }
  const k = t.k;
  if (k === 'empty') {
    t.d = 1;
    if (rng() < Math.min(0.22, 0.07 + lv * 0.012)) setEncounter(run, 'combat', t.b, rng, { ambush: true });
  } else if (k === 'combat' || k === 'elite') {
    // à partir du 3e combat, un boss errant peut surgir à la place
    if (run.fightsWon >= BOSS_MIN_FIGHTS && rng() < Math.min(0.15, 0.05 + run.fightsWon * 0.008)) setEncounter(run, 'boss', t.b, rng, { roaming: true });
    else setEncounter(run, k, t.b, rng);
  } else if (k === 'boss') {
    if (run.fightsWon < BOSS_MIN_FIGHTS) {
      run.notice = { icon: '🔒', text: `Le repaire est scellé par une magie ancienne. Gagne encore ${BOSS_MIN_FIGHTS - run.fightsWon} combat${BOSS_MIN_FIGHTS - run.fightsWon > 1 ? 's' : ''} pour pouvoir y entrer.` };
      run.status = 'notice';
    } else setEncounter(run, 'boss', t.b, rng);
  } else if (k === 'treasure') {
    t.d = 1;
    const gold = goldGain(run, 25 + Math.floor(rng() * 30) + lv * 2);
    run.gold += gold;
    const bag = bagAdd(run, rollBag(rng, 'treasure', lv));
    const relic = rng() < 0.3 ? grantRelic(run, rng) : null;
    const loot = giveLoot(user, run, rollLoot(rng, 'treasure'));
    run.notice = { icon: '🎁', text: `Un coffre ! +${gold} or${relic ? ` et la relique « ${RELICS[relic].name} »` : ''}.`, relic, loot, bag };
    run.status = 'notice';
  } else if (k === 'ore') {
    t.d = 1;
    const loot = giveLoot(user, run, rollOre(rng, t.b, lv));
    run.notice = { icon: '⛏️', text: `Tu exploites un gisement (${(BIOMES[t.b] || {}).name || ''}).`, loot };
    run.status = 'notice';
  } else if (k === 'shop') {
    t.d = 1; // un marchand ne reste qu'une fois
    const cards = offerCards(run, pool, limits, rng, 5).map(id => { const c = pool.find(p => p.id === id); return { id, price: price(run, CARD_PRICE[c.rarity] || 60), sold: false }; });
    const left = Object.keys(RELICS).filter(r => !run.relics.includes(r));
    run.shop = { cards, relic: left.length ? { id: pick(left, rng), price: price(run, RELIC_PRICE), sold: false } : null,
      removePrice: price(run, REMOVE_PRICE), removed: false, healPrice: price(run, HEAL_PRICE) };
    run.status = 'shop';
  } else if (k === 'camp') { t.d = 1; run.status = 'camp'; }
  else if (k === 'event') { t.d = 1; run.event = pick(Object.keys(EVENTS), rng); run.status = 'event'; }
  else if (k === 'riddle') {
    t.d = 1;
    const seen = run.riddlesSeen || [];
    let left = RIDDLES.filter(r => !seen.includes(r.id));
    if (!left.length) left = RIDDLES;
    const rd = pick(left, rng);
    run.riddlesSeen = seen.concat(rd.id);
    const order = rd.options.map((_, i) => i);
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    run.riddle = { id: rd.id, order };
    run.status = 'riddle';
  } else if (k === 'tavern') {
    t.d = 1;
    const strong = pool.filter(c => c.rarity === 'epique' || c.rarity === 'legendaire');
    const src = strong.length >= 3 ? strong : pool;
    const ids = [];
    for (let i = 0; ids.length < 3 && i < 60; i++) { const c = pick(src, rng); if (!ids.includes(c.id)) ids.push(c.id); }
    run.tavern = { cards: ids.map(id => { const c = pool.find(p => p.id === id); return { id, price: price(run, RECRUIT_PRICE[c.rarity] || 50), hired: false }; }) };
    run.status = 'tavern';
  } else if (k === 'portal') {
    run.region = (run.region || 0) + 1;
    const heal = Math.min(run.maxHp - run.hp, 10);
    run.hp += heal;
    newRegion(run, rng);
    run.notice = { icon: '🌀', text: `Tu franchis le passage et arrives dans ${run.regionName} (région ${run.region + 1}). +${heal} PV. Les ennemis y sont plus coriaces.`, region: true };
    run.status = 'notice';
  } else { t.d = 1; }
  return { ok: true, fresh, type: k };
}
/* Après un boss : un passage vers une nouvelle région s'ouvre non loin */
function openPortal(run, rng) {
  const cands = [];
  for (let y = 0; y < MAP_H; y++) for (let x = 0; x < MAP_W; x++) {
    const t = run.map[y][x], d = Math.abs(x - run.x) + Math.abs(y - run.y);
    if (t.k !== 'block' && t.k !== 'boss' && t.k !== 'start' && d >= 1 && d <= 3) cands.push([x, y]);
  }
  if (!cands.length) return null;
  const [x, y] = pick(cands, rng);
  const t = run.map[y][x]; t.k = 'portal'; t.d = 0; t.s = 1;
  return { x, y };
}

/* Fin d'un combat de l'Expédition */
function recordFight(user, won, endHp, pool, limits, now) {
  const e = ensure(user), run = e.run;
  if (!run || run.status !== 'fight' || !run.encounter) return null;
  const enc = run.encounter, t = run.map[run.y][run.x];
  const be = e.bestiary[enc.name] = e.bestiary[enc.name] || { met: 0, beaten: 0 };
  be.met++; if (won) be.beaten++;
  const base = { type: enc.kind, foe: enc.name, foeIcon: enc.icon, newFoe: be.met === 1, level: level(run) + 1 };
  if (!won) {
    run.hp = 0;
    return Object.assign(base, { won: false }, finish(e, 'defeat', now));
  }
  run.fightsWon++;
  if (enc.kind === 'elite') run.elitesWon++;
  t.d = 1;
  run.encounter = null;
  run.hp = Math.max(1, Math.min(run.maxHp, Number(endHp) || 1));
  if (run.relics.includes('potion')) run.hp = Math.min(run.maxHp, run.hp + 4);
  const rng = rngOf(run), lv = level(run);
  const kind = enc.kind;
  const gold = goldGain(run, kind === 'boss' ? 60 + Math.floor(rng() * 31) : kind === 'elite' ? 30 + Math.floor(rng() * 21) : 12 + Math.floor(rng() * 12) + lv);
  run.gold += gold;
  const bag = bagAdd(run, rollBag(rng, kind, lv));
  const lootKind = kind === 'boss' ? 'boss' : kind === 'elite' ? 'elite' : 'combat';
  const loot = giveLoot(user, run, rollLoot(rng, lootKind));
  let relic = null, portal = null;
  if (kind === 'elite' || kind === 'boss') relic = grantRelic(run, rng);
  if (kind === 'boss') {
    run.bossesWon++;
    e.bossKills[enc.bossId] = (e.bossKills[enc.bossId] || 0) + 1;
    const heal = Math.min(run.maxHp - run.hp, 12); run.hp += heal;
    portal = openPortal(run, rng);
  }
  const n = run.relics.includes('oeil') ? 4 : 3;
  run.reward = { cards: deckCount(run) < MAX_DECK ? offerCards(run, pool, limits, rng, n, { elite: kind !== 'combat' }) : [], gold, relic, loot, bag, portal: !!portal };
  run.status = 'reward';
  return Object.assign(base, { won: true, gold, relic, loot, bag, hp: run.hp, maxHp: run.maxHp, bossName: kind === 'boss' ? enc.name : null, bossId: enc.bossId || null, bosses: run.bossesWon, portal: !!portal });
}
/* Fin de l'Expédition : « retour » (on encaisse tout le sac) ou « defeat » (moitié du sac) */
function finish(e, how, now) {
  const run = e.run;
  const defeat = how === 'defeat';
  const half = n => defeat ? Math.floor(n / 2) : n;
  const rewards = { credits: half(run.bag.credits), dust: half(run.bag.dust), boosters: half(run.bag.boosters), title: null };
  const asc = run.asc || 0;
  const success = !defeat && run.bossesWon >= 3; // expédition réussie : 3 boss vaincus et retour sain et sauf
  if (success) rewards.title = asc >= MAX_ASCENSION ? "Légende de l'Ascension" : 'Explorateur légendaire';
  run.relics.forEach(r => { if (!e.relicsFound.includes(r)) e.relicsFound.push(r); });
  let newRecord = false, ascensionUnlocked = null;
  if (run.fightsWon > e.best) { e.best = run.fightsWon; newRecord = true; }
  if (success) {
    if (asc > e.bestAscension) e.bestAscension = asc;
    if (asc >= e.ascension && asc < MAX_ASCENSION) { e.ascension = asc + 1; ascensionUnlocked = asc + 1; }
  }
  e.runs++; if (success) e.wins++;
  e.last = { victory: success, how, fights: run.fightsWon, bosses: run.bossesWon, regions: (run.region || 0) + 1, explored: run.explored, asc, relics: run.relics.slice(), loot: run.loot || {}, bag: run.bag, rewards, at: now || Date.now() };
  e.run = null;
  return { over: true, how, victory: success, defeat, fights: run.fightsWon, bosses: run.bossesWon, regions: (run.region || 0) + 1, explored: run.explored, asc,
    rewards, lostHalf: defeat, bag: run.bag, newRecord, best: e.best, loot: run.loot || {}, ascensionUnlocked };
}
/* « Arrêter l'exploration » : retour avec tout le sac (impossible au milieu d'un combat) */
function stop(user, now) {
  const e = ensure(user), run = e.run;
  if (!run) return { error: 'Aucune Expédition en cours.' };
  if (run.status === 'fight') return { error: 'Un ennemi te barre la route : il faut combattre avant de pouvoir rentrer.' };
  if (!run.moves) { // rien commencé : entrée rendue
    if (run.paid) user.credits = (user.credits || 0) + run.paid; else e.freeDay = null;
    e.run = null;
    return { ok: true, refunded: run.paid || 0, rewards: null, cancelled: true };
  }
  return Object.assign({ ok: true }, finish(e, 'retour', now));
}
const abandon = stop;

/* Combat : réglages selon la rencontre, le niveau de danger et les reliques */
function fightConfig(run) {
  const enc = run.encounter || { kind: 'combat', name: 'Ennemi', icon: '⚔️', biome: 'foret' };
  const lv = level(run), kind = enc.kind;
  let quality, botHp, deckSize;
  if (kind === 'boss') {
    const b = BOSSES[enc.bossId] || BOSSES.foret;
    quality = Math.min(0.98, b.quality - 0.15 + lv * 0.025 + (ascAt(run, 10) ? 0.1 : 0));
    botHp = b.hp - 8 + Math.round(lv * 2.2) + (ascAt(run, 5) ? 8 : 0);
    deckSize = 30;
  } else {
    quality = Math.min(0.95, 0.06 + lv * 0.045 + (kind === 'elite' ? 0.18 + (ascAt(run, 2) ? 0.1 : 0) : 0));
    botHp = Math.round(16 + lv * 2.2) + (kind === 'elite' ? 10 : 0);
    deckSize = Math.min(30, 15 + lv);
  }
  botHp += (ascAt(run, 1) ? 3 : 0) + (ascAt(run, 6) ? 3 : 0);
  const fields = {
    expedition: { level: lv + 1, region: (run.region || 0) + 1, type: kind, name: kind === 'boss' ? enc.name : NODE_TYPES[kind] ? NODE_TYPES[kind].name : 'Combat', foe: enc.name, biome: enc.biome, asc: run.asc || 0 },
    playerHeroHealth: run.hp, playerMaxHealth: run.maxHp,
    opponentHeroHealth: Math.max(5, botHp - (run.relics.includes('dague') ? 5 : 0))
  };
  const mana = (run.relics.includes('sablier') ? 1 : 0) + (runeOn(run, 'eveil') ? 1 : 0);
  if (mana) fields.manaBonus = [mana, 0];
  const armor = (run.relics.includes('bouclier') ? 5 : 0) + (runeOn(run, 'garde') ? 3 : 0);
  if (armor) fields.playerArmor = armor;
  if (ascAt(run, 9)) fields.opponentArmor = 3;
  return { type: kind, quality, deckSize, botName: enc.name, botIcon: enc.icon, fields };
}

/* Carte vue par le joueur : le contenu des cases n'est visible que sous le brouillard levé */
function mapView(run) {
  return run.map.map(row => row.map(t => t.s ? { b: t.b, k: t.k, d: t.d ? 1 : 0, v: t.v ? 1 : 0, s: 1 } : { s: 0 }));
}
function view(user, pool, now) {
  const e = ensure(user), run = e.run;
  return {
    free: freeAvailable(user, now), entryPrice: ENTRY_PRICE, best: e.best, runs: e.runs, wins: e.wins, last: e.last || null,
    relicsInfo: RELICS, nodeTypes: NODE_TYPES, biomes: BIOMES, blockDeco: BLOCK_DECO, bosses: BOSSES, bossMinFights: BOSS_MIN_FIGHTS, mapW: MAP_W, mapH: MAP_H,
    explorer: explorerOf(user), explorers: EXPLORERS, explorerColors: EXPLORER_COLORS,
    acts: ACTS, bossKills: e.bossKills, relicsFound: e.relicsFound,
    maxRecruits: MAX_RECRUITS, ascension: e.ascension, bestAscension: e.bestAscension, ascensionInfo: ASCENSION, maxAscension: MAX_ASCENSION,
    bestiary: bestiaryView(e),
    run: run ? {
      region: run.region || 0, regionName: run.regionName, level: level(run) + 1, x: run.x, y: run.y, map: mapView(run),
      hp: run.hp, maxHp: run.maxHp, gold: run.gold, status: run.status, relics: run.relics, bag: run.bag,
      deck: run.deck.slice(), fightsWon: run.fightsWon, elitesWon: run.elitesWon, bossesWon: run.bossesWon, explored: run.explored, moves: run.moves,
      reward: run.reward ? { cards: run.reward.cards, gold: run.reward.gold, relic: run.reward.relic, loot: run.reward.loot || {}, bag: run.reward.bag || {}, portal: !!run.reward.portal } : null, loot: run.loot || {},
      shop: run.shop, event: run.event ? Object.assign({ id: run.event }, EVENTS[run.event]) : null, notice: run.notice,
      foe: run.status === 'fight' && run.encounter ? (() => { const c = fightConfig(run), b = e.bestiary[c.botName]; return { name: c.botName, icon: c.botIcon, kind: run.encounter.kind, ambush: !!run.encounter.ambush, roaming: !!run.encounter.roaming, met: b ? b.met : 0, beaten: b ? b.beaten : 0, lore: b && b.met ? (enemyInfo(c.botName) || {}).lore || null : null, hp: c.fields.opponentHeroHealth }; })() : null,
      asc: run.asc || 0, runes: run.runes || [], recruits: (run.recruits || []).slice(), tavern: run.tavern || null,
      riddle: run.riddle ? (() => { const rd = RIDDLES.find(r => r.id === run.riddle.id); return rd ? { kind: rd.kind, text: rd.text, options: run.riddle.order.map(k => rd.options[k]) } : null; })() : null
    } : null
  };
}

function continueRun(user) {
  const run = ensure(user).run;
  if (!run) return { error: 'Aucune Expédition en cours.' };
  if (run.status !== 'notice') return { error: 'Rien à valider.' };
  run.status = 'map'; run.notice = null;
  return { ok: true };
}

function pickReward(user, cardId) {
  const run = ensure(user).run;
  if (!run || run.status !== 'reward') return { error: 'Aucune récompense à choisir.' };
  if (cardId) {
    if (!run.reward.cards.includes(cardId)) return { error: 'Cette carte ne fait pas partie du choix.' };
    if (deckCount(run) >= MAX_DECK) return { error: `Ton deck est plein (${MAX_DECK} cartes).` };
    run.deck.push(cardId);
  }
  run.reward = null; run.status = 'map';
  return { ok: true };
}

function shopAction(user, action, cardId) {
  const run = ensure(user).run;
  if (!run || run.status !== 'shop' || !run.shop) return { error: "Tu n'es pas chez le marchand." };
  const sh = run.shop;
  const pay = p => { if (run.gold < p) return false; run.gold -= p; return true; };
  if (action === 'leave') { run.shop = null; run.status = 'map'; return { ok: true }; }
  if (action === 'buy-card') {
    const it = sh.cards.find(c => c.id === cardId && !c.sold);
    if (!it) return { error: 'Carte introuvable.' };
    if (deckCount(run) >= MAX_DECK) return { error: `Ton deck est plein (${MAX_DECK} cartes).` };
    if (!pay(it.price)) return { error: "Pas assez d'or." };
    it.sold = true; run.deck.push(it.id);
    return { ok: true };
  }
  if (action === 'buy-relic') {
    if (!sh.relic || sh.relic.sold) return { error: 'Plus de relique à vendre.' };
    if (!pay(sh.relic.price)) return { error: "Pas assez d'or." };
    sh.relic.sold = true; grantRelic(run, null, sh.relic.id);
    return { ok: true };
  }
  if (action === 'remove') {
    if (sh.removed) return { error: 'Le marchand ne retire qu\'une carte par visite.' };
    const i = run.deck.indexOf(cardId);
    if (i < 0) return { error: 'Carte absente de ton deck.' };
    if (run.deck.length <= 10) return { error: 'Ton deck doit garder au moins 10 cartes.' };
    if (!pay(sh.removePrice)) return { error: "Pas assez d'or." };
    run.deck.splice(i, 1); sh.removed = true;
    return { ok: true };
  }
  if (action === 'heal') {
    if (run.hp >= run.maxHp) return { error: 'Tu as déjà tous tes PV.' };
    if (!pay(sh.healPrice)) return { error: "Pas assez d'or." };
    run.hp = Math.min(run.maxHp, run.hp + HEAL_AMOUNT);
    return { ok: true };
  }
  return { error: 'Action inconnue.' };
}
function camp(user, choice, cardId) {
  const run = ensure(user).run;
  if (!run || run.status !== 'camp') return { error: "Tu n'es pas au feu de camp." };
  if (choice === 'rest') run.hp = Math.min(run.maxHp, run.hp + Math.round(run.maxHp * (ascAt(run, 8) ? 0.2 : 0.3)));
  else if (choice === 'remove') {
    const i = run.deck.indexOf(cardId);
    if (i < 0) return { error: 'Choisis une carte de ton deck.' };
    if (run.deck.length <= 10) return { error: 'Ton deck doit garder au moins 10 cartes.' };
    run.deck.splice(i, 1);
  } else return { error: 'Choix inconnu.' };
  run.status = 'map';
  return { ok: true };
}
function eventChoice(user, choice, pool, limits) {
  const run = ensure(user).run;
  if (!run || run.status !== 'event' || !EVENTS[run.event]) return { error: "Il n'y a pas d'événement ici." };
  const ev = EVENTS[run.event];
  if (!ev.choices.some(c => c.id === choice)) return { error: 'Choix inconnu.' };
  const rng = rngOf(run);
  let text = 'Tu poursuis ta route.', relic = null;
  if (choice === 'boire') { const h = Math.min(10, run.maxHp - run.hp); run.hp += h; text = `L'eau te soigne : +${h} PV.`; }
  else if (choice === 'gourde') { const g = goldGain(run, 40); run.gold += g; text = `Tu revends ta gourde : +${g} or.`; }
  else if (choice === 'payer') {
    if (run.hp <= 7) return { error: 'Tu n\'as pas assez de PV pour ça.' };
    run.hp -= 7; relic = grantRelic(run, rng); text = relic ? `−7 PV… mais tu obtiens « ${RELICS[relic].name} » !` : '−7 PV… et il n\'avait plus rien à vendre !';
  } else if (choice === 'offrir') {
    if (run.deck.length <= 10) return { error: 'Ton deck doit garder au moins 10 cartes.' };
    const gone = run.deck.splice(Math.floor(rng() * run.deck.length), 1)[0];
    const got = offerCards(run, pool, limits, rng, 1, { minRare: true })[0];
    if (got) run.deck.push(got);
    const nm = id => (pool.find(c => c.id === id) || {}).name || '?';
    text = `L'autel prend « ${nm(gone)} »${got ? ` et te donne « ${nm(got)} »` : ''}.`;
  } else if (choice === 'ouvrir') {
    if (rng() < 0.5) { const g = goldGain(run, 90); run.gold += g; giveLoot(user, run, { metal: 2 }); text = `Le coffre contenait ${g} or et 2 métal !`; }
    else { run.hp = Math.max(1, run.hp - 6); text = 'C\'était un piège ! −6 PV.'; }
  } else if (choice === 'donner') {
    if (run.gold < 30) return { error: "Pas assez d'or." };
    run.gold -= 30; run.maxHp += 5; run.hp += 5; text = 'L\'ermite t\'enseigne sa technique : +5 PV max.';
  }
  run.event = null;
  run.notice = { icon: ev.icon, text, relic };
  run.status = 'notice';
  return { ok: true };
}

/* Deck utilisé en combat : le deck de l'Expédition + les recrues de la taverne */
function deckCount(run) { return run.deck.length + (run.recruits || []).length; }
function fightDeck(run) { return run.deck.concat((run.recruits || []).slice()); }

/* Énigme : réponse = index de l'option affichée (ou « skip ») */
function riddleAnswer(user, answer) {
  const run = ensure(user).run;
  if (!run || run.status !== 'riddle' || !run.riddle) return { error: "Il n'y a pas d'énigme ici." };
  const rd = RIDDLES.find(r => r.id === run.riddle.id);
  if (!rd) { run.riddle = null; run.status = 'map'; return { ok: true }; }
  const good = rd.options[0];
  let text, relic = null, loot = null, correct = false;
  if (answer === 'skip') text = rd.kind === 'coffre' ? 'Tu laisses le coffre tranquille.' : 'Tu passes ton chemin sans répondre.';
  else {
    const shown = run.riddle.order.map(k => rd.options[k]);
    const chosen = shown[Number(answer)];
    if (answer === null || answer === '' || chosen === undefined) return { error: 'Réponse inconnue.' };
    const rng = rngOf(run);
    correct = chosen === good;
    if (correct) {
      const g = goldGain(run, rd.kind === 'coffre' ? 60 + Math.floor(rng() * 31) : 35 + Math.floor(rng() * 31));
      run.gold += g;
      loot = giveLoot(user, run, rd.kind === 'coffre' ? { cristal: 1, metal: 2 } : (rng() < 0.5 ? { cristal: 1 } : { metal: 2 }));
      if (rd.kind === 'coffre' && rng() < 0.25) relic = grantRelic(run, rng);
      text = rd.kind === 'coffre' ? `Clic ! Le coffre s'ouvre : ${g} or${relic ? ` et la relique « ${RELICS[relic].name} »` : ''} !` : `« Bien répondu », murmure une voix. Tu reçois ${g} or.`;
    } else {
      const dmg = rd.kind === 'coffre' ? 5 : 4;
      run.hp = Math.max(1, run.hp - dmg);
      text = rd.kind === 'coffre' ? `Mauvais code ! Une fléchette jaillit du coffre : −${dmg} PV. (C'était ${good}.)` : `Faux ! La salle tremble et une pierre te tombe dessus : −${dmg} PV. (La réponse était « ${good} ».)`;
    }
  }
  run.riddle = null;
  run.notice = { icon: correct ? (rd.kind === 'coffre' ? '🔓' : '🧩') : answer === 'skip' ? '🚶' : '💥', text, relic, loot };
  run.status = 'notice';
  return { ok: true, correct };
}
/* Taverne : engager des recrues (cartes fortes prêtées jusqu'à la fin de l'Expédition) */
function tavernAction(user, action, cardId) {
  const run = ensure(user).run;
  if (!run || run.status !== 'tavern' || !run.tavern) return { error: "Tu n'es pas à la taverne." };
  if (action === 'leave') { run.tavern = null; run.status = 'map'; return { ok: true }; }
  if (action !== 'hire') return { error: 'Action inconnue.' };
  const it = run.tavern.cards.find(c => c.id === cardId && !c.hired);
  if (!it) return { error: 'Recrue introuvable.' };
  run.recruits = run.recruits || [];
  if (run.recruits.length >= MAX_RECRUITS) return { error: `Tu as déjà ${MAX_RECRUITS} recrues : c'est le maximum.` };
  if (run.deck.length + run.recruits.length >= MAX_DECK) return { error: `Ton deck est plein (${MAX_DECK} cartes).` };
  if (run.gold < it.price) return { error: "Pas assez d'or." };
  run.gold -= it.price; it.hired = true; run.recruits.push(it.id);
  return { ok: true };
}

/* Bestiaire : tous les ennemis, avec ce que le joueur en sait */
function bestiaryView(e) {
  const out = [];
  ACTS.forEach(act => {
    ['combat', 'elite'].forEach(type => ENEMIES[act.id][type].forEach(x => out.push(Object.assign({ act: act.id, type }, x))));
    out.push({ act: act.id, type: 'boss', name: act.boss.name, icon: act.boss.icon, lore: act.boss.lore });
  });
  return out.map(x => { const b = e.bestiary[x.name] || { met: 0, beaten: 0 }; return Object.assign(x, { met: b.met, beaten: b.beaten }); });
}

module.exports = { EXPLORERS, EXPLORER_COLORS, explorerOf, setExplorer, ENEMIES, enemyInfo, ASCENSION, MAX_ASCENSION, RIDDLES, RECRUIT_PRICE, MAX_RECRUITS, riddleAnswer, tavernAction, fightDeck, bestiaryView, ACTS, BOSSES, BIOMES, NODE_TYPES,
  MAP_W, MAP_H, BOSS_MIN_FIGHTS, START_HP, START_DECK, MAX_DECK, ENTRY_PRICE, RELICS, EVENTS, ensure, freeAvailable, generateWorld, level, start, move, continueRun, recordFight,
  pickReward, shopAction, camp, eventChoice, stop, abandon, finish, fightConfig, view, rngFrom, dayKey };

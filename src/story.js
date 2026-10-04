/* ======================================================
   Mode Histoire (solo) : une suite de chapitres, chacun avec un boss tiré
   des cartes du jeu, un texte de lore, et une difficulté qui monte
   (PV et armure du boss, qualité de son deck). Chaque victoire rapporte de
   la poussière ou des crédits ; la première victoire d'un chapitre rapporte
   le plein, les suivantes une partie seulement.
   Les chapitres se modifient dans Admin → Histoire.
   ====================================================== */
const { readJSON, writeJSON } = require('./store');
const REPLAY_SHARE = 0.3; // part de la récompense pour un chapitre déjà gagné

let data = readJSON('story.json', null);
if (!data || !Array.isArray(data.chapters)) data = { chapters: [] };
function save() { writeJSON('story.json', data); }
function get() { return data; }

const RARITY_POWER = { commun: 0, rare: 1, epique: 2, legendaire: 4 };
const power = c => (Number(c.attack) || 0) + (Number(c.health) || 0) + (Number(c.cost) || 0) * 0.6 + (RARITY_POWER[c.rarity] || 0) * 2
  + (c.taunt ? 1 : 0) + (c.charge ? 1 : 0) + (c.shield ? 1.5 : 0) + (c.windfury ? 1.5 : 0);

/* Trame du récit : les ruelles du Clean Gang, de la petite frappe au chef
   suprême. {boss} est remplacé par le nom de la carte choisie comme boss. */
const LORE = [
  { title: 'Les ruelles', intro: "Tout commence dans les ruelles du quartier. {boss} rackette les nouveaux venus et se prend pour le roi du coin. Montre-lui que le Clean Gang ne se laisse pas impressionner.", victory: "{boss} détale sans demander son reste. Dans les ruelles, on commence à murmurer ton nom." },
  { title: 'Le marché noir', intro: "Sous les arcades, {boss} tient le marché noir des cartes rares. Il paraît qu'il garde un deck taillé pour écraser les curieux.", victory: "Le marché noir change de main. Les marchands te saluent désormais d'un signe de tête." },
  { title: 'Les docks', intro: "Les docks appartiennent à {boss}. Les cargaisons de boosters y disparaissent la nuit, et personne n'ose poser de questions.", victory: "Les cargaisons reprennent leur route. Les dockers retrouvent le sommeil." },
  { title: 'La tour de garde', intro: "{boss} veille sur la tour de garde, au-dessus de la ville. Personne ne l'a jamais vu perdre une partie.", victory: "La tour de garde est tombée. D'en haut, tu aperçois le palais du chef du gang rival." },
  { title: 'Les égouts', intro: "Pour atteindre le palais, il faut passer par les égouts. {boss} y règne dans l'ombre, entouré de ses fidèles.", victory: "Tu ressors des égouts couvert de boue… mais vainqueur." },
  { title: 'Le casino interdit', intro: "{boss} dirige le casino interdit. Ici, chaque partie se joue à quitte ou double, et la maison gagne toujours. Jusqu'à aujourd'hui.", victory: "La banque saute. Les jetons du casino pleuvent sur la table." },
  { title: 'La garde rapprochée', intro: "Dernier rempart avant le trône : {boss}, garde du corps du chef rival, n'a jamais laissé passer personne.", victory: "La garde rapprochée s'incline. La salle du trône est à toi." },
  { title: 'Le trône', intro: "{boss} t'attend sur le trône de la ville. C'est le combat final : celui qui gagne dirige les rues.", victory: "Tu es le nouveau maître de la ville. Le Clean Gang règne sur les rues, et ton nom entre dans la légende." }
];

/* Construit les chapitres à partir des cartes du jeu : les boss sont les
   serviteurs les plus puissants, du moins fort au plus fort. */
function generate(pool, count) {
  const minions = pool.filter(c => c.type === 'minion').sort((a, b) => power(a) - power(b));
  if (!minions.length) return { error: "Il faut au moins un serviteur dans le jeu pour créer l'histoire." };
  const n = Math.max(1, Math.min(count || 8, LORE.length, minions.length));
  // On répartit les boss sur toute l'échelle de puissance, en finissant par le plus fort
  const picks = [];
  for (let i = 0; i < n; i++) {
    const at = n === 1 ? minions.length - 1 : Math.round((minions.length - 1) * (0.25 + 0.75 * i / (n - 1)));
    let c = minions[at];
    let k = at; while (picks.includes(c) && k > 0) c = minions[--k];
    picks.push(c);
  }
  data.chapters = picks.map((boss, i) => {
    const lore = LORE[Math.round(i * (LORE.length - 1) / Math.max(1, n - 1))];
    const fill = t => t.replace(/\{boss\}/g, boss.name);
    return {
      id: 'ch-' + (i + 1), title: lore.title, intro: fill(lore.intro), victory: fill(lore.victory),
      bossCardId: boss.id, bossName: boss.name,
      hp: 20 + i * 5, armor: i >= 3 ? (i - 2) * 3 : 0, quality: n === 1 ? 0.5 : i / (n - 1),
      reward: i % 2 === 0 ? { dust: 30 + i * 15, credits: 0 } : { dust: 0, credits: 40 + i * 20 }
    };
  });
  save();
  return { ok: true, chapters: data.chapters };
}

/* Deck du boss : 30 cartes, de plus en plus fortes selon le chapitre, avec le
   boss lui-même dedans (1 exemplaire si légendaire, 2 sinon). */
function bossDeck(chapter, pool, limits, rng) {
  rng = rng || Math.random;
  const sorted = pool.slice().sort((a, b) => power(b) - power(a));
  const take = Math.max(10, Math.round(sorted.length * (1 - 0.7 * (chapter.quality || 0))));
  const candidates = sorted.slice(0, take);
  const deck = [], count = {};
  const add = c => { const lim = limits[c.rarity] || 2; if ((count[c.id] || 0) < lim) { deck.push(c.id); count[c.id] = (count[c.id] || 0) + 1; return true; } return false; };
  const boss = pool.find(c => c.id === chapter.bossCardId);
  if (boss) { add(boss); add(boss); }
  let guard = 0;
  while (deck.length < 30 && guard++ < 2000) {
    const src = guard < 1000 ? candidates : sorted;
    add(src[Math.floor(rng() * src.length)]);
  }
  return deck;
}

function rewardFor(chapter, firstClear) {
  const r = chapter.reward || {};
  const k = firstClear ? 1 : REPLAY_SHARE;
  return { dust: Math.round((r.dust || 0) * k), credits: Math.round((r.credits || 0) * k) };
}
function setChapters(chapters) {
  if (!Array.isArray(chapters)) return { error: 'Format invalide.' };
  data.chapters = chapters.map((c, i) => ({
    id: c.id || 'ch-' + (i + 1), title: String(c.title || `Chapitre ${i + 1}`).slice(0, 80),
    intro: String(c.intro || '').slice(0, 1200), victory: String(c.victory || '').slice(0, 800),
    bossCardId: c.bossCardId, bossName: String(c.bossName || '').slice(0, 60),
    hp: Math.max(5, Math.min(200, Math.round(Number(c.hp) || 30))), armor: Math.max(0, Math.min(100, Math.round(Number(c.armor) || 0))),
    quality: Math.max(0, Math.min(1, Number(c.quality) || 0)),
    reward: { dust: Math.max(0, Math.round(Number((c.reward || {}).dust) || 0)), credits: Math.max(0, Math.round(Number((c.reward || {}).credits) || 0)) }
  }));
  save();
  return { ok: true };
}
module.exports = { get, generate, bossDeck, rewardFor, setChapters, power };

/* Pool de cartes de base, économie (poussière), rangs et constantes de jeu. */

// Drop légendaire à 3% comme demandé
const RARITY_WEIGHTS = { commun: 60, rare: 25, epique: 12, legendaire: 3 };
const COPY_LIMITS = { commun: 2, rare: 2, epique: 2, legendaire: 1 };

// Valeur en poussière quand on désenchante un exemplaire en trop
const DUST_VALUES = { commun: 1, rare: 2, epique: 10, legendaire: 250 };

const DECK_SIZE = 30;
// Poids de tirage par défaut d'une carte À L'INTÉRIEUR de sa rareté.
// 1 = équivalent aux autres cartes de la même rareté. Le taux global de la
// rareté (RARITY_WEIGHTS) n'est pas affecté : seule la répartition à
// l'intérieur du palier change.
const DEFAULT_DROP_WEIGHT = 1;
const MIN_DROP_WEIGHT = 0.05;
const MAX_DROP_WEIGHT = 20;
const MAX_BOARD = 7;
const MAX_HAND = 10;
const STARTING_HERO_HP = 30;
const STARTING_HAND = 4;
const MAX_MANA = 10;

// Points de victoire aléatoires entre +10 et +29 par combat gagné
const VP_MIN = 10;
const VP_MAX = 29;

// Rangs par paliers de points de victoire cumulés
const RANKS = [
  { key: 'bronze',   label: 'Bronze',   min: 0,    color: '#c98a5b' },
  { key: 'argent',   label: 'Argent',   min: 300,  color: '#c9ccd6' },
  { key: 'or',       label: 'Or',       min: 800,  color: '#e8b13d' },
  { key: 'diamant',  label: 'Diamant',  min: 1600, color: '#5fd8ff' },
  { key: 'maitre',   label: 'Maître',   min: 3000, color: '#c46bff' }
];

function rankFor(vp) {
  let current = RANKS[0];
  for (const r of RANKS) if (vp >= r.min) current = r;
  return current;
}

function nextRankFor(vp) {
  return RANKS.find(r => vp < r.min) || null;
}

// Récompenses de fin de mois (en poussière)
const MONTHLY_REWARDS = [500, 250, 100];

/* Ornements d'avatar achetables en boutique (en poussière).
   Prix calés sur les revenus réels : ~20 ✧ par victoire, quelques ✧ par
   désenchantement, et 500/250/100 ✧ pour le podium mensuel. */
const ORNAMENTS = [
  { id: 'none',      name: 'Aucun',              price: 0,   css: 'orn-none',      desc: 'Pas de cadre.' },
  { id: 'bronze',    name: 'Cercle de Bronze',   price: 60,  css: 'orn-bronze',    desc: 'Un anneau de cuivre patiné.' },
  { id: 'argent',    name: 'Anneau d\'Argent',   price: 150, css: 'orn-argent',    desc: 'Un liseré clair et net.' },
  { id: 'or',        name: 'Couronne Dorée',     price: 320, css: 'orn-or',        desc: 'Un cadre doré qui capte la lumière.' },
  { id: 'arcane',    name: 'Halo Arcanique',     price: 600, css: 'orn-arcane',    desc: 'Une aura violette en rotation lente.' },
  { id: 'braise',    name: 'Couronne de Braise', price: 900, css: 'orn-braise',    desc: 'Des braises qui pulsent doucement.' },
  { id: 'prisme',    name: 'Prisme du Maître',   price: 1500, css: 'orn-prisme',   desc: 'Un prisme changeant, réservé aux plus obstinés.' }
];


/* Provocations (emotes) affichées en combat en cliquant sur son avatar.
   Les gratuites sont données à la création du compte ; les autres s'achètent
   en poussière dans la boutique. La roue en jeu contient 6 emplacements. */
const EMOTE_WHEEL_SIZE = 6;
const EMOTE_COOLDOWN_MS = 3000;

const SEED_EMOTES = [
  // --- Gratuites (débloquées d'office) ---
  { id: 'salut',      text: 'Salut !',                          price: 0,   tone: 'neutre' },
  { id: 'bienjoue',   text: 'Bien joué !',                      price: 0,   tone: 'amical' },
  { id: 'oups',       text: 'Oups...',                          price: 0,   tone: 'neutre' },
  { id: 'merci',      text: 'Merci !',                          price: 0,   tone: 'amical' },
  { id: 'menace',     text: 'Prépare-toi.',                     price: 0,   tone: 'neutre' },
  { id: 'gg',         text: 'GG !',                             price: 0,   tone: 'amical' },
  // --- Achetables ---
  { id: 'ez',         text: 'ez',                               price: 80,  tone: 'piquant' },
  { id: 'cestout',    text: "C'est tout ce que tu peux faire ?", price: 120, tone: 'piquant' },
  { id: 'jattends',   text: "J'attends...",                     price: 100, tone: 'piquant' },
  { id: 'serieux',    text: 'Sérieusement ?',                   price: 100, tone: 'piquant' },
  { id: 'chance',     text: 'Belle chance.',                    price: 140, tone: 'piquant' },
  { id: 'dodo',       text: 'Tu dors ?',                        price: 140, tone: 'piquant' },
  { id: 'trembler',   text: 'Tu trembles déjà.',                price: 180, tone: 'piquant' },
  { id: 'calcule',    text: 'Tout était calculé.',              price: 180, tone: 'fier' },
  { id: 'inevitable', text: "C'était inévitable.",              price: 220, tone: 'fier' },
  { id: 'respect',    text: 'Respect, adversaire.',             price: 90,  tone: 'amical' },
  { id: 'revanche',   text: 'On remet ça ?',                    price: 90,  tone: 'amical' },
  { id: 'legende',    text: 'Une légende est née.',             price: 300, tone: 'fier' }
];

/* Les provocations gratuites et la roue par défaut se calculent sur le pool
   courant (les admins peuvent en ajouter), avec repli sur la graine. */
function freeEmotesFrom(pool) {
  return (pool || SEED_EMOTES).filter(e => e.price === 0).map(e => e.id);
}
function defaultWheelFrom(pool) {
  const free = freeEmotesFrom(pool);
  const wheel = free.slice(0, EMOTE_WHEEL_SIZE);
  // Si trop peu de gratuites, on complète avec les moins chères pour garder 6 emplacements
  if (wheel.length < EMOTE_WHEEL_SIZE) {
    (pool || SEED_EMOTES).slice().sort((a, b) => a.price - b.price).forEach(e => {
      if (wheel.length < EMOTE_WHEEL_SIZE && !wheel.includes(e.id)) wheel.push(e.id);
    });
  }
  return wheel;
}

const SEED_CARDS = [
  { id: 'seed-01', name: 'Éclaireuse des Cendres', type: 'minion', rarity: 'commun', cost: 1, attack: 1, health: 2, desc: 'Une survivante rapide des terres brûlées.', extensionId: 'base' },
  { id: 'seed-02', name: 'Novice du Sanctuaire', type: 'minion', rarity: 'commun', cost: 1, attack: 1, health: 1, desc: 'Encore jeune, déjà dévoué.', extensionId: 'base' },
  { id: 'seed-03', name: 'Garde du Rempart', type: 'minion', rarity: 'commun', cost: 2, attack: 2, health: 3, taunt: true, desc: 'Provocation. Ne recule jamais devant une brèche.', extensionId: 'base' },
  { id: 'seed-04', name: 'Chasseur de Brume', type: 'minion', rarity: 'commun', cost: 2, attack: 3, health: 1, desc: 'Traque ses proies dans le brouillard.', extensionId: 'base' },
  { id: 'seed-05', name: 'Archère Voilée', type: 'minion', rarity: 'commun', cost: 2, attack: 2, health: 2, desc: 'Ne rate jamais sa cible.', extensionId: 'base' },
  { id: 'seed-06', name: 'Brute des Docks', type: 'minion', rarity: 'commun', cost: 3, attack: 4, health: 2, desc: 'Règle ses comptes à coups de crochet.', extensionId: 'base' },
  { id: 'seed-07', name: 'Lame du Crépuscule', type: 'minion', rarity: 'rare', cost: 3, attack: 3, health: 3, charge: true, desc: 'Charge. Frappe entre chien et loup.', extensionId: 'base' },
  { id: 'seed-08', name: 'Oracle des Marées', type: 'minion', rarity: 'rare', cost: 3, attack: 2, health: 4, battlecryHeal: 3, desc: "Cri de guerre : rend 3 PV à votre héros.", extensionId: 'base' },
  { id: 'seed-09', name: 'Émissaire Silencieux', type: 'minion', rarity: 'commun', cost: 4, attack: 3, health: 4, desc: 'Ne parle jamais, agit toujours.', extensionId: 'base' },
  { id: 'seed-10', name: 'Sentinelle de Fer', type: 'minion', rarity: 'rare', cost: 4, attack: 3, health: 6, taunt: true, desc: 'Provocation. Un rempart à elle seule.', extensionId: 'base' },
  { id: 'seed-11', name: 'Frère de Guerre', type: 'minion', rarity: 'epique', cost: 4, attack: 4, health: 4, desc: 'Ne combat jamais seul.', extensionId: 'base' },
  { id: 'seed-12', name: 'Reine des Corbeaux', type: 'minion', rarity: 'epique', cost: 5, attack: 4, health: 5, desc: 'Commande aux ailes noires du ciel.', extensionId: 'base' },
  { id: 'seed-13', name: 'Colosse de Granit', type: 'minion', rarity: 'rare', cost: 5, attack: 4, health: 7, taunt: true, desc: 'Provocation. Rien ne le fait tomber.', extensionId: 'base' },
  { id: 'seed-14', name: 'Titan de Basalte', type: 'minion', rarity: 'epique', cost: 6, attack: 6, health: 6, desc: 'Taillé dans la roche des volcans éteints.', extensionId: 'base' },
  { id: 'seed-15', name: 'Gardien du Vide', type: 'minion', rarity: 'legendaire', cost: 7, attack: 6, health: 9, taunt: true, desc: 'Provocation. Ce qu il regarde cesse d exister.', extensionId: 'base' },
  { id: 'seed-16', name: "Dévoreur d'Étoiles", type: 'minion', rarity: 'legendaire', cost: 8, attack: 8, health: 8, charge: true, desc: "Charge. On raconte qu'il a éteint un soleil.", extensionId: 'base' },
  { id: 'seed-17', name: 'Éclat Mineur', type: 'sort', rarity: 'commun', cost: 1, effectType: 'damage', value: 2, desc: 'Inflige 2 dégâts à une cible.', extensionId: 'base' },
  { id: 'seed-18', name: 'Flamme Vive', type: 'sort', rarity: 'commun', cost: 3, effectType: 'damage', value: 3, desc: 'Inflige 3 dégâts à une cible.', extensionId: 'base' },
  { id: 'seed-19', name: 'Poussée Arcanique', type: 'sort', rarity: 'rare', cost: 3, effectType: 'damage', value: 4, desc: 'Inflige 4 dégâts à une cible.', extensionId: 'base' },
  { id: 'seed-20', name: 'Rituel Interdit', type: 'sort', rarity: 'epique', cost: 5, effectType: 'damage', value: 6, desc: 'Inflige 6 dégâts à une cible.', extensionId: 'base' },
  { id: 'seed-21', name: 'Bandage de Fortune', type: 'sort', rarity: 'commun', cost: 2, effectType: 'heal', value: 4, desc: 'Rend 4 PV à une cible amie.', extensionId: 'base' },
  { id: 'seed-22', name: 'Murmure Ancestral', type: 'sort', rarity: 'epique', cost: 4, effectType: 'heal', value: 8, desc: 'Rend 8 PV à une cible amie.', extensionId: 'base' },
  { id: 'seed-23', name: 'Voile des Ombres', type: 'sort', rarity: 'rare', cost: 2, effectType: 'buff_attack', value: 2, desc: "Donne +2 ATQ à un serviteur ami.", extensionId: 'base' },
  { id: 'seed-24', name: 'Couronne du Premier Roi', type: 'sort', rarity: 'legendaire', cost: 7, effectType: 'buff_attack', value: 5, desc: "Donne +5 ATQ à un serviteur ami.", extensionId: 'base' },
  { id: 'seed-25', name: 'Vague Purificatrice', type: 'sort', rarity: 'rare', cost: 4, effectType: 'aoe_damage', value: 2, desc: 'Inflige 2 dégâts à tous les serviteurs ennemis.', extensionId: 'base' },
  { id: 'seed-26', name: 'Prière du Sanctuaire', type: 'sort', rarity: 'rare', cost: 3, effectType: 'aoe_heal', value: 3, desc: 'Rend 3 PV à tous vos serviteurs et à votre héros.', extensionId: 'base' }
];

// Deck de départ garanti jouable : 30 cartes (respecte les limites de copies)
function buildStarterCollection() {
  const collection = {};
  const deck = [];
  const pool = SEED_CARDS.filter(c => c.rarity !== 'legendaire');
  let i = 0;
  while (deck.length < DECK_SIZE) {
    const card = pool[i % pool.length];
    const limit = COPY_LIMITS[card.rarity];
    const owned = collection[card.id] || 0;
    if (owned < limit) {
      collection[card.id] = owned + 1;
      deck.push(card.id);
    }
    i++;
    if (i > 500) break;
  }
  return { collection, deck };
}

module.exports = {
  SEED_CARDS, RARITY_WEIGHTS, COPY_LIMITS, DUST_VALUES, DECK_SIZE, MAX_BOARD, MAX_HAND,
  STARTING_HERO_HP, STARTING_HAND, MAX_MANA, VP_MIN, VP_MAX, RANKS, rankFor, nextRankFor,
  MONTHLY_REWARDS, ORNAMENTS, buildStarterCollection,
  DEFAULT_DROP_WEIGHT, MIN_DROP_WEIGHT, MAX_DROP_WEIGHT,
  SEED_EMOTES, EMOTE_WHEEL_SIZE, EMOTE_COOLDOWN_MS, freeEmotesFrom, defaultWheelFrom
};

/* ----------------------------------------------------------------------
   Registre de contenu personnalisable : tous les textes, icônes, médias
   (logo, fond de plateau) et sons de jeu que l'admin peut modifier depuis
   le panel Admin → Contenu, sans toucher au code.

   Chaque catégorie a une liste de clés CONNUES avec une valeur par défaut.
   Le serveur ne garde en mémoire que les clés reconnues (une clé inconnue
   envoyée par erreur est ignorée plutôt que silencieusement acceptée) et
   fusionne toujours les valeurs par défaut avec les remplacements — pas
   besoin que le client connaisse lui-même les valeurs par défaut.
   ---------------------------------------------------------------------- */

const DEFAULT_STRINGS = {
  'nav.collection': 'Collection', 'nav.codex': 'Codex', 'nav.boosters': 'Boosters',
  'nav.deck': 'Deck', 'nav.combat': 'Combat', 'nav.classement': 'Classement',
  'nav.poussiere': 'Désenchantement', 'nav.boutique': 'Boutique', 'nav.joueurs': 'Joueurs',
  'nav.echanges': 'Échanges', 'nav.admin': 'Admin', 'nav.evenements': 'Événements', 'nav.achievements': 'Succès',

  'title.collection': 'Ta collection', 'title.codex': 'Codex', 'title.boosters': 'Boosters',
  'title.deck': 'Deck', 'title.classement': 'Classement mensuel', 'title.poussiere': 'Désenchantement',
  'title.boutique': 'Boutique', 'title.joueurs': 'Joueurs', 'title.echanges': 'Échanges',

  'combat.endTurnReady': 'Fin du tour', 'combat.endTurnWaiting': 'Tour adverse',
  'combat.mulliganTitle': 'Choisis ta main de départ',
  'combat.mulliganConfirm': 'Valider ma main',

  'currency.credits': 'crédits', 'currency.dust': 'poussière',

  'empty.collection': "Ta collection est vide — direction l'onglet Boosters !",
  'empty.players': "Aucun joueur trouvé.",
  'empty.trades': "Rien pour l'instant.",

  'gate.title': 'Clean Gang Decks',
  'gate.tagline': 'Un jeu de cartes à collectionner entre amis.',

  'sub.codex': "Toutes les cartes que tu as un jour obtenues restent dans ton codex, même si tu les as échangées ou désenchantées depuis.",
  'sub.poussiere': "Les exemplaires en trop (au-delà de la limite jouable) peuvent être transformés en poussière : commun 1, rare 2, épique 10, légendaire 250. La poussière sert à acheter des ornements dans la boutique.",
  'sub.boutique': "Personnalise ton avatar, tes provocations, et achète des boosters supplémentaires.",
  'sub.joueurs': "Consulte les collections, ajoute des amis, propose des échanges et lance des défis.",
  'sub.echanges': "Les propositions se lancent depuis la fiche d'un joueur (onglet Joueurs).",
  'sub.combat': "Affronte un joueur au hasard, ou défie directement un ami connecté. Chaque victoire rapporte entre +10 et +29 points de classement et 20 ✧.",
  'sub.deck': "Un deck de 30 cartes est requis pour combattre. Maximum 2 exemplaires par carte (1 pour les légendaires).",

  'cardtype.minion': 'Serviteur', 'cardtype.weapon': 'Arme', 'cardtype.spell': 'Sort',

  'btn.logout': 'Se déconnecter', 'btn.addFriend': '+ Ajouter en ami', 'btn.challenge': 'Défier en combat'
};

const DEFAULT_ICONS = {
  'icon.collection': '📚', 'icon.codex': '📖', 'icon.boosters': '🎁', 'icon.deck': '📝',
  'icon.combat': '⚔️', 'icon.classement': '🏆', 'icon.poussiere': '✧', 'icon.boutique': '🛍️',
  'icon.joueurs': '👥', 'icon.echanges': '🔁', 'icon.admin': '🛠️', 'icon.evenements': '🎉', 'icon.achievements': '🏅',
  'icon.credits': '🪙', 'icon.dust': '✧', 'icon.view3d': '🧊'
};

const SFX_KEYS = ['attackHit', 'packOpen', 'cardReveal', 'turnStart', 'victory', 'defeat', 'cardPlayDefault',
  // Un son de révélation par rareté (pack opening). S'il n'est pas personnalisé,
  // on retombe sur « cardReveal », puis sur le son synthétisé de la rareté.
  'cardReveal_commun', 'cardReveal_rare', 'cardReveal_epique', 'cardReveal_legendaire'];
const MEDIA_KEYS = ['logo', 'boardBackground', 'gateBackground', 'sidebarBackground', 'panelTexture'];

/* Fiche technique de chaque image d'interface personnalisable : où elle sert,
   et la taille en pixels recommandée pour un rendu net sans déformation.
   Purement informatif (rien n'empêche d'uploader une autre taille — l'image
   sera simplement recadrée/étirée par le CSS), affiché dans le panel admin
   pour que l'image fournie tombe juste du premier coup. */
const MEDIA_SPECS = {
  logo: { label: 'Logo', recommendedSize: '256×256 px', description: "Sidebar et écran de connexion. Fond transparent recommandé (PNG)." },
  boardBackground: { label: 'Fond du plateau de combat', recommendedSize: '1600×1000 px', description: "Derrière le plateau, plein écran pendant un combat." },
  gateBackground: { label: "Fond de l'écran de connexion", recommendedSize: '1920×1080 px', description: "Toute la page derrière le formulaire de connexion." },
  sidebarBackground: { label: 'Fond du menu latéral', recommendedSize: '300×1200 px', description: "Texture verticale derrière les boutons du menu." },
  panelTexture: { label: 'Texture des panneaux', recommendedSize: '512×512 px', description: "Motif répété en fond de chaque encadré (panel) de l'application." }
};

function mergeKnown(defaults, overrides) {
  const out = Object.assign({}, defaults);
  if (overrides && typeof overrides === 'object') {
    Object.keys(overrides).forEach(k => {
      if (Object.prototype.hasOwnProperty.call(defaults, k) && typeof overrides[k] === 'string' && overrides[k].trim() !== '') {
        out[k] = overrides[k];
      }
    });
  }
  return out;
}

module.exports = { DEFAULT_STRINGS, DEFAULT_ICONS, SFX_KEYS, MEDIA_KEYS, MEDIA_SPECS, mergeKnown };

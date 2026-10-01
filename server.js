const express = require('express');
const session = require('express-session');
const http = require('http');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');

const db = require('./src/db');
const { slugify, hashPassword, verifyPassword, requireAuth } = require('./src/auth');
const {
  RARITY_WEIGHTS, COPY_LIMITS, DUST_VALUES, DECK_SIZE,
  RANKS, rankFor, nextRankFor, MONTHLY_REWARDS, buildStarterCollection,
  EMOTE_WHEEL_SIZE, EMOTE_COOLDOWN_MS, freeEmotesFrom, defaultWheelFrom,
  DEFAULT_DROP_WEIGHT, MIN_DROP_WEIGHT, MAX_DROP_WEIGHT
} = require('./src/cards');
const game = require('./src/game');
const mm = require('./src/matchmaking');
const bot = require('./src/bot');
const { DEFAULT_STRINGS, DEFAULT_ICONS, SFX_KEYS, MEDIA_KEYS, mergeKnown } = require('./src/content');
const achievementsEngine = require('./src/achievements');
const blackjack = require('./src/blackjack');
const ranking = require('./src/ranking');

const PORT = process.env.PORT || 3000;
const ADMIN_CODE = process.env.ADMIN_CODE || 'admin123';
const PACK_COOLDOWN_MS = 10 * 60 * 1000;

const app = express();
app.use(express.json());
app.use(express.static('public'));
// three.js est servi tel quel depuis node_modules (pas de duplication du fichier,
// pas de dépendance à un CDN externe : le jeu reste jouable hors-ligne une fois installé).
app.use('/vendor/three', express.static(path.join(__dirname, 'node_modules', 'three', 'build')));

const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || 'arcane-ledger-dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 }
});
app.use(sessionMiddleware);

const server = http.createServer(app);
const io = new Server(server);
io.engine.use(sessionMiddleware);

/* ---------- Upload d'images (cartes + avatars) ---------- */
const UPLOAD_ROOT = path.join(__dirname, 'public', 'uploads');
fs.mkdirSync(path.join(UPLOAD_ROOT, 'cards'), { recursive: true });
fs.mkdirSync(path.join(UPLOAD_ROOT, 'avatars'), { recursive: true });
fs.mkdirSync(path.join(UPLOAD_ROOT, 'sounds'), { recursive: true });
fs.mkdirSync(path.join(UPLOAD_ROOT, 'branding'), { recursive: true });

function makeUploader(subdir) {
  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(UPLOAD_ROOT, subdir)),
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname) || '.png').toLowerCase();
      cb(null, uuidv4().slice(0, 12) + ext);
    }
  });
  return multer({
    storage,
    limits: { fileSize: 3 * 1024 * 1024 }, // 3 Mo max
    fileFilter: (req, file, cb) => {
      const ok = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.mimetype);
      cb(ok ? null : new Error('Format non supporté (PNG, JPG, WEBP ou GIF uniquement).'), ok);
    }
  });
}
/* Uploader audio séparé : formats et taille différents des images. */
function makeAudioUploader(subdir) {
  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(UPLOAD_ROOT, subdir)),
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname) || '.mp3').toLowerCase();
      cb(null, uuidv4().slice(0, 12) + ext);
    }
  });
  return multer({
    storage,
    limits: { fileSize: 2 * 1024 * 1024 }, // 2 Mo : un son de carte doit rester court
    fileFilter: (req, file, cb) => {
      const ok = ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/webm', 'audio/mp4', 'audio/aac'].includes(file.mimetype);
      cb(ok ? null : new Error('Format audio non supporté (MP3, WAV, OGG, WEBP audio, M4A ou AAC).'), ok);
    }
  });
}

const uploadCardImage = makeUploader('cards');
const uploadCardSound = makeAudioUploader('sounds');
const uploadAvatar = makeUploader('avatars');
const uploadBrandingImage = makeUploader('branding');
const uploadBrandingSound = makeAudioUploader('branding');

/* ---------- Helpers profil ---------- */
/* Retire d'un profil les cartes SUPPRIMÉES VOLONTAIREMENT par l'admin (registre
   deleted-cards.json) : collection, deck actif, decks enregistrés, cartes
   découvertes. Une carte simplement introuvable (fichier de cartes abîmé, volume
   Docker mal monté...) n'est jamais retirée : elle est seulement ignorée à
   l'affichage. Renvoie true si quelque chose a été nettoyé. */
function purgeDeletedCards(user, deletedIds) {
  const gone = new Set(deletedIds || db.getDeletedCardIds());
  if (gone.size === 0) return false;
  let changed = false;
  const keep = id => !gone.has(id);
  if (user.collection && typeof user.collection === 'object') {
    Object.keys(user.collection).forEach(id => { if (!keep(id)) { delete user.collection[id]; changed = true; } });
  }
  if (Array.isArray(user.deck)) {
    const clean = user.deck.filter(keep);
    if (clean.length !== user.deck.length) { user.deck = clean; changed = true; }
  }
  if (Array.isArray(user.savedDecks)) {
    user.savedDecks.forEach(d => {
      const clean = (d.cardIds || []).filter(keep);
      if (clean.length !== (d.cardIds || []).length) { d.cardIds = clean; changed = true; }
    });
  }
  if (Array.isArray(user.discoveredCards)) {
    const clean = user.discoveredCards.filter(keep);
    if (clean.length !== user.discoveredCards.length) { user.discoveredCards = clean; changed = true; }
  }
  return changed;
}

/* Cartes présentes chez les joueurs mais absentes du pool : ce sont les cartes
   supprimées AVANT l'existence du registre (ou une anomalie). */
function findOrphanCardIds() {
  const orphan = new Set();
  const check = id => { if (id && !db.cardById(id)) orphan.add(id); };
  db.allUsers().forEach(u => {
    Object.keys(u.collection || {}).forEach(check);
    (u.deck || []).forEach(check);
    (u.savedDecks || []).forEach(d => (d.cardIds || []).forEach(check));
  });
  return [...orphan];
}

function ensureProfileFields(user) {
  if (user.dust === undefined) user.dust = 0;
  purgeDeletedCards(user);
  if (user.avatar === undefined) user.avatar = null;
  if (user.ornament === undefined) user.ornament = 'none';
  if (!Array.isArray(user.ownedOrnaments)) user.ownedOrnaments = ['none'];
  if (!Array.isArray(user.savedDecks)) user.savedDecks = [];
  if (user.activeDeckId === undefined) user.activeDeckId = null;
  if (user.lastBossFight === undefined) user.lastBossFight = null;
  if (!Array.isArray(user.boosterInventory)) user.boosterInventory = [];
  if (!Array.isArray(user.achievementShowcase)) user.achievementShowcase = [];
  // Vitrine de cartes du profil : 3 emplacements (null = vide). Une carte qui
  // n'est plus dans la collection (échangée, désenchantée) quitte la vitrine.
  if (!Array.isArray(user.cardShowcase)) user.cardShowcase = [null, null, null];
  user.cardShowcase = [0, 1, 2].map(i => {
    const id = user.cardShowcase[i];
    return id && db.cardById(id) && user.collection && (user.collection[id] || 0) > 0 ? id : null;
  });
  achievementsEngine.ensureStatsFields(user);
  if (!Array.isArray(user.discoveredCards)) user.discoveredCards = Object.keys(user.collection || {});
  if (user.seasonVP === undefined) user.seasonVP = 0;
  if (user.seasonWins === undefined) user.seasonWins = 0;
  if (user.seasonLosses === undefined) user.seasonLosses = 0;
  if (user.lifetimeWins === undefined) user.lifetimeWins = 0;
  if (user.lifetimeLosses === undefined) user.lifetimeLosses = 0;
  const pool = db.getEmotePool();
  const free = freeEmotesFrom(pool);
  if (!Array.isArray(user.ownedEmotes)) user.ownedEmotes = free.slice();
  // Toute provocation gratuite reste acquise, y compris celles ajoutées après coup par un admin
  free.forEach(id => { if (!user.ownedEmotes.includes(id)) user.ownedEmotes.push(id); });
  // On purge les provocations supprimées du pool par un admin
  user.ownedEmotes = user.ownedEmotes.filter(id => pool.some(e => e.id === id));
  if (!Array.isArray(user.emoteWheel)) user.emoteWheel = [];
  user.emoteWheel = user.emoteWheel.filter(id => user.ownedEmotes.includes(id));
  if (user.emoteWheel.length !== EMOTE_WHEEL_SIZE) {
    const fallback = defaultWheelFrom(pool).filter(id => user.ownedEmotes.includes(id));
    fallback.forEach(id => { if (user.emoteWheel.length < EMOTE_WHEEL_SIZE && !user.emoteWheel.includes(id)) user.emoteWheel.push(id); });
    user.ownedEmotes.forEach(id => { if (user.emoteWheel.length < EMOTE_WHEEL_SIZE && !user.emoteWheel.includes(id)) user.emoteWheel.push(id); });
  }
  return user;
}

function markDiscovered(user, cardIds) {
  if (!Array.isArray(user.discoveredCards)) user.discoveredCards = [];
  cardIds.forEach(id => { if (!user.discoveredCards.includes(id)) user.discoveredCards.push(id); });
}

/* Point d'entrée unique pour vérifier/débloquer les succès après une action
   qui pourrait en satisfaire un (jouer une carte, gagner, dépenser, etc.).
   N'écrit PAS le user sur disque : l'appelant doit toujours faire son propre
   db.updateUser juste après (comme pour n'importe quelle autre modification
   de profil), pour ne modifier le disque qu'une seule fois par action. */
function awardAchievements(user) {
  achievementsEngine.ensureStatsFields(user);
  return achievementsEngine.checkAchievements(user, db.getAchievements(), { cardPool: db.getCardPool() });
}

/* Enregistre qu'un rang vient d'être atteint (pour le succès "reach_rank"),
   sans jamais retirer un rang déjà enregistré. */
function trackRankReached(user) {
  achievementsEngine.ensureStatsFields(user);
  const rank = rankFor(user.seasonVP);
  if (!user.stats.ranksReached.includes(rank)) user.stats.ranksReached.push(rank);
}

function decorateProfile(user) {
  const pub = db.publicUser(ensureProfileFields(user));
  pub.rank = rankFor(pub.seasonVP);
  pub.nextRank = nextRankFor(pub.seasonVP);
  return pub;
}

// Clôture de saison au démarrage, puis vérifiée à chaque heure
ranking.closeSeasonIfNeeded(db);
setInterval(() => ranking.closeSeasonIfNeeded(db), 60 * 60 * 1000);

/* ---------- Auth ---------- */
app.post('/api/register', async (req, res) => {
  const { pseudo, password } = req.body || {};
  if (!pseudo || pseudo.trim().length < 2) return res.status(400).json({ error: 'Pseudo trop court (2 caractères minimum).' });
  if (!password || password.length < 4) return res.status(400).json({ error: 'Mot de passe trop court (4 caractères minimum).' });
  const slug = slugify(pseudo);
  if (!slug) return res.status(400).json({ error: 'Pseudo invalide.' });
  if (db.getUser(slug)) return res.status(409).json({ error: 'Ce pseudo est déjà pris.' });

  const passHash = await hashPassword(password);
  // Nouveau compte : ni deck ni collection de départ — tout s'obtient en jouant
  // (boosters gratuits, achetés en boutique, ou échangés avec d'autres joueurs).
  const profile = ensureProfileFields({
    slug, pseudo: pseudo.trim(), passHash,
    credits: 100, dust: 0, lastPack: 0, collection: {}, deck: [],
    friends: [], avatar: null, ornament: 'none', ownedOrnaments: ['none'],
    ownedEmotes: freeEmotesFrom(db.getEmotePool()).slice(), emoteWheel: defaultWheelFrom(db.getEmotePool()).slice(),
    discoveredCards: [],
    seasonVP: 0, seasonWins: 0, seasonLosses: 0, lifetimeWins: 0, lifetimeLosses: 0,
    createdAt: Date.now()
  });
  db.createUser(profile);
  req.session.userSlug = slug;
  res.json({ ok: true, profile: decorateProfile(profile) });
});

app.post('/api/login', async (req, res) => {
  const { pseudo, password } = req.body || {};
  const slug = slugify(pseudo || '');
  const user = db.getUser(slug);
  if (!user) return res.status(401).json({ error: 'Aucun compte avec ce pseudo.' });
  const ok = await verifyPassword(password || '', user.passHash);
  if (!ok) return res.status(401).json({ error: 'Mot de passe incorrect.' });
  req.session.userSlug = slug;
  db.updateUser(slug, ensureProfileFields(user));
  res.json({ ok: true, profile: decorateProfile(user) });
});

app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));

app.get('/api/me', requireAuth, (req, res) => {
  const user = db.getUser(req.session.userSlug);
  if (!user) return res.status(404).json({ error: 'Compte introuvable.' });
  res.json({ profile: decorateProfile(user) });
});

/* ---------- Avatar ---------- */
app.post('/api/me/avatar', requireAuth, (req, res) => {
  uploadAvatar.single('image')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'Aucune image reçue.' });
    const user = db.getUser(req.session.userSlug);
    user.avatar = '/uploads/avatars/' + req.file.filename;
    db.updateUser(user.slug, user);
    res.json({ ok: true, avatar: user.avatar });
  });
});

/* Description de profil : 150 caractères maximum, une seule ligne de texte
   simple (retours à la ligne et caractères de contrôle retirés). */
const BIO_MAX = 150;
function cleanBio(raw) {
  return Array.from(String(raw || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, BIO_MAX).join('');
}
app.post('/api/me/bio', requireAuth, (req, res) => {
  const user = db.getUser(req.session.userSlug);
  if (!user) return res.status(404).json({ error: 'Compte introuvable.' });
  user.bio = cleanBio((req.body || {}).bio);
  db.updateUser(user.slug, user);
  res.json({ ok: true, bio: user.bio });
});

/* ---------- Admin : gestion des comptes ---------- */
app.post('/api/admin/users', (req, res) => {
  const b = req.body || {};
  if (b.code !== ADMIN_CODE) return res.status(403).json({ error: 'Code admin incorrect.' });
  const users = db.allUsers().map(ensureProfileFields).map(u => ({
    slug: u.slug, pseudo: u.pseudo, credits: u.credits, dust: u.dust,
    seasonVP: u.seasonVP, seasonWins: u.seasonWins, seasonLosses: u.seasonLosses,
    lifetimeWins: u.lifetimeWins, lifetimeLosses: u.lifetimeLosses,
    rank: rankFor(u.seasonVP), online: mm.isOnline(u.slug),
    collectionCount: Object.values(u.collection || {}).reduce((a, x) => a + x, 0),
    createdAt: u.createdAt || null
  })).sort((a, b2) => (b2.createdAt || 0) - (a.createdAt || 0));
  res.json({ users });
});

app.post('/api/admin/users/:slug/collection', (req, res) => {
  if ((req.body || {}).code !== ADMIN_CODE) return res.status(403).json({ error: 'Code admin incorrect.' });
  const u = db.getUser(req.params.slug);
  if (!u) return res.status(404).json({ error: 'Compte introuvable.' });
  res.json({ pseudo: u.pseudo, slug: u.slug, collection: u.collection, deck: u.deck });
});

app.post('/api/admin/users/:slug/reset-password', async (req, res) => {
  const b = req.body || {};
  if (b.code !== ADMIN_CODE) return res.status(403).json({ error: 'Code admin incorrect.' });
  const u = db.getUser(req.params.slug);
  if (!u) return res.status(404).json({ error: 'Compte introuvable.' });
  const newPassword = (b.newPassword || '').trim();
  if (newPassword.length < 4) return res.status(400).json({ error: 'Mot de passe trop court (4 caractères minimum).' });
  u.passHash = await hashPassword(newPassword);
  db.updateUser(u.slug, u);
  res.json({ ok: true });
});

app.post('/api/admin/users/:slug/dust', (req, res) => {
  const b = req.body || {};
  if (b.code !== ADMIN_CODE) return res.status(403).json({ error: 'Code admin incorrect.' });
  const u = ensureProfileFields(db.getUser(req.params.slug));
  if (!u) return res.status(404).json({ error: 'Compte introuvable.' });
  const delta = Number(b.delta);
  if (!Number.isFinite(delta)) return res.status(400).json({ error: 'Valeur invalide.' });
  u.dust = Math.max(0, u.dust + delta);
  db.updateUser(u.slug, u);
  res.json({ ok: true, dust: u.dust });
});

app.post('/api/admin/users/:slug/grant-card', (req, res) => {
  const b = req.body || {};
  if (b.code !== ADMIN_CODE) return res.status(403).json({ error: 'Code admin incorrect.' });
  const u = ensureProfileFields(db.getUser(req.params.slug));
  if (!u) return res.status(404).json({ error: 'Compte introuvable.' });
  const card = db.cardById(b.cardId);
  if (!card) return res.status(404).json({ error: 'Carte introuvable.' });
  const quantity = Math.max(1, Math.round(Number(b.quantity) || 1));
  u.collection[card.id] = (u.collection[card.id] || 0) + quantity;
  markDiscovered(u, [card.id]);
  db.updateUser(u.slug, u);
  res.json({ ok: true, collection: u.collection });
});

/* Retire des exemplaires d'une carte de la collection d'un joueur. Si le
   joueur en a moins qu'avant dans ses decks, les exemplaires en trop sont
   retirés de son deck actif et de ses decks enregistrés (sinon il garderait
   un deck avec des cartes qu'il ne possède plus). */
app.post('/api/admin/users/:slug/remove-card', (req, res) => {
  const b = req.body || {};
  if (b.code !== ADMIN_CODE) return res.status(403).json({ error: 'Code admin incorrect.' });
  const u = ensureProfileFields(db.getUser(req.params.slug));
  if (!u) return res.status(404).json({ error: 'Compte introuvable.' });
  const owned = (u.collection || {})[b.cardId] || 0;
  if (!owned) return res.status(404).json({ error: 'Ce joueur ne possède pas cette carte.' });
  const quantity = b.all ? owned : Math.max(1, Math.round(Number(b.quantity) || 1));
  const left = Math.max(0, owned - quantity);
  if (left === 0) delete u.collection[b.cardId]; else u.collection[b.cardId] = left;
  const trim = list => {
    let seen = 0;
    return (list || []).filter(id => id !== b.cardId || ++seen <= left);
  };
  u.deck = trim(u.deck);
  (u.savedDecks || []).forEach(d => { d.cardIds = trim(d.cardIds); });
  ensureProfileFields(u); // la vitrine du profil se met à jour d'elle-même
  db.updateUser(u.slug, u);
  res.json({ ok: true, collection: u.collection, deck: u.deck });
});

app.post('/api/admin/users/:slug/credits', (req, res) => {
  const b = req.body || {};
  if (b.code !== ADMIN_CODE) return res.status(403).json({ error: 'Code admin incorrect.' });
  const u = ensureProfileFields(db.getUser(req.params.slug));
  if (!u) return res.status(404).json({ error: 'Compte introuvable.' });
  const delta = Number(b.delta);
  if (!Number.isFinite(delta)) return res.status(400).json({ error: 'Valeur invalide.' });
  u.credits = Math.max(0, u.credits + delta);
  db.updateUser(u.slug, u);
  res.json({ ok: true, credits: u.credits });
});

app.post('/api/admin/users/:slug/grant-starter', (req, res) => {
  const b = req.body || {};
  if (b.code !== ADMIN_CODE) return res.status(403).json({ error: 'Code admin incorrect.' });
  const u = ensureProfileFields(db.getUser(req.params.slug));
  if (!u) return res.status(404).json({ error: 'Compte introuvable.' });
  // Utile pour débloquer un joueur perdu qui ne sait pas comment obtenir ses premières
  // cartes : on ajoute un lot de cartes de base à sa collection (sans jamais retirer
  // ce qu'il possède déjà) et on lui donne un deck de 30 cartes prêt à jouer.
  const { collection, deck } = buildStarterCollection();
  Object.keys(collection).forEach(id => { u.collection[id] = (u.collection[id] || 0) + collection[id]; });
  u.deck = deck;
  markDiscovered(u, Object.keys(collection));
  db.updateUser(u.slug, u);
  res.json({ ok: true, profile: decorateProfile(u) });
});

app.post('/api/admin/users/:slug/delete', (req, res) => {
  const b = req.body || {};
  if (b.code !== ADMIN_CODE) return res.status(403).json({ error: 'Code admin incorrect.' });
  const u = db.getUser(req.params.slug);
  if (!u) return res.status(404).json({ error: 'Compte introuvable.' });
  if (b.confirmPseudo !== u.pseudo) return res.status(400).json({ error: 'Le pseudo de confirmation ne correspond pas.' });
  // On retire aussi le compte des listes d'amis des autres joueurs
  db.allUsers().forEach(other => {
    if (other.slug !== u.slug && Array.isArray(other.friends) && other.friends.includes(u.slug)) {
      other.friends = other.friends.filter(s => s !== u.slug);
      db.updateUser(other.slug, other);
    }
  });
  const sock = mm.socketFor(u.slug);
  if (sock) sock.disconnect(true);
  db.deleteUser(u.slug);
  res.json({ ok: true });
});

/* ---------- Extensions (sets de boosters) ---------- */
app.get('/api/content', (req, res) => {
  const overrides = db.getContentOverrides();
  const media = {};
  MEDIA_KEYS.forEach(k => { media[k] = overrides.media[k] || null; });
  res.json({
    strings: mergeKnown(DEFAULT_STRINGS, overrides.strings),
    icons: mergeKnown(DEFAULT_ICONS, overrides.icons),
    media,
    sfx: Object.assign({}, overrides.sfx) // clé -> url, seulement les remplacements existants (sinon : synthèse par défaut côté client)
  });
});

app.patch('/api/admin/content', (req, res) => {
  const b = req.body || {};
  if (b.code !== ADMIN_CODE) return res.status(403).json({ error: 'Code admin incorrect.' });
  const patch = {};
  if (b.strings && typeof b.strings === 'object') patch.strings = b.strings;
  if (b.icons && typeof b.icons === 'object') patch.icons = b.icons;
  db.updateContentOverrides(patch);
  res.json({ ok: true });
});

app.post('/api/admin/content/media/:key', (req, res) => {
  uploadBrandingImage.single('image')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    const b = req.body || {};
    if (b.code !== ADMIN_CODE) return res.status(403).json({ error: 'Code admin incorrect.' });
    if (!MEDIA_KEYS.includes(req.params.key)) return res.status(400).json({ error: 'Média inconnu.' });
    if (!req.file) return res.status(400).json({ error: 'Aucune image reçue.' });
    const url = '/uploads/branding/' + req.file.filename;
    db.updateContentOverrides({ media: { [req.params.key]: url } });
    res.json({ ok: true, url });
  });
});

app.delete('/api/admin/content/media/:key', (req, res) => {
  if ((req.body || {}).code !== ADMIN_CODE) return res.status(403).json({ error: 'Code admin incorrect.' });
  db.resetContentKey('media', req.params.key);
  res.json({ ok: true });
});

app.post('/api/admin/content/sfx/:key', (req, res) => {
  uploadBrandingSound.single('sound')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    const b = req.body || {};
    if (b.code !== ADMIN_CODE) return res.status(403).json({ error: 'Code admin incorrect.' });
    if (!SFX_KEYS.includes(req.params.key)) return res.status(400).json({ error: 'Son inconnu.' });
    if (!req.file) return res.status(400).json({ error: 'Aucun fichier audio reçu.' });
    const url = '/uploads/branding/' + req.file.filename;
    db.updateContentOverrides({ sfx: { [req.params.key]: url } });
    res.json({ ok: true, url });
  });
});

app.delete('/api/admin/content/sfx/:key', (req, res) => {
  if ((req.body || {}).code !== ADMIN_CODE) return res.status(403).json({ error: 'Code admin incorrect.' });
  db.resetContentKey('sfx', req.params.key);
  res.json({ ok: true });
});

/* Une "période d'activation" (dates de début/fin, optionnelles) vient s'ajouter
   à l'interrupteur manuel de l'admin : les deux doivent être satisfaits pour
   qu'un mini-jeu soit réellement actif. Sans dates, seul l'interrupteur compte
   (comportement inchangé). */
function isEventActive(cfg) {
  if (!cfg.enabled) return false;
  const now = new Date();
  if (cfg.startDate && now < new Date(cfg.startDate + 'T00:00:00')) return false;
  if (cfg.endDate && now > new Date(cfg.endDate + 'T23:59:59')) return false;
  return true;
}
function daysRemaining(cfg) {
  if (!cfg.endDate) return null;
  const diffMs = new Date(cfg.endDate + 'T23:59:59') - new Date();
  return diffMs <= 0 ? 0 : Math.ceil(diffMs / 86400000);
}

/* Vitrine de cartes : jusqu'à 3 cartes choisies dans sa propre collection */
app.post('/api/me/card-showcase', requireAuth, (req, res) => {
  const user = ensureProfileFields(db.getUser(req.session.userSlug));
  const raw = Array.isArray((req.body || {}).cardIds) ? req.body.cardIds : [];
  if (raw.length > 3) return res.status(400).json({ error: 'Maximum 3 cartes dans la vitrine.' });
  const ids = [0, 1, 2].map(i => raw[i] || null);
  const chosen = ids.filter(Boolean);
  if (new Set(chosen).size !== chosen.length) return res.status(400).json({ error: 'Une même carte ne peut être exposée qu\'une fois.' });
  const bad = chosen.find(id => !db.cardById(id) || !((user.collection || {})[id] > 0));
  if (bad) return res.status(400).json({ error: 'Tu ne peux exposer que des cartes de ta collection.' });
  user.cardShowcase = ids;
  db.updateUser(user.slug, user);
  res.json({ ok: true, cardShowcase: user.cardShowcase });
});

app.post('/api/me/showcase', requireAuth, (req, res) => {
  const user = ensureProfileFields(db.getUser(req.session.userSlug));
  const ids = Array.isArray((req.body || {}).achievementIds) ? req.body.achievementIds : [];
  if (ids.length > 5) return res.status(400).json({ error: 'Maximum 5 succès dans la vitrine.' });
  const unlockedIds = new Set(user.achievementsUnlocked.map(a => a.id));
  const invalid = ids.find(id => !unlockedIds.has(id));
  if (invalid) return res.status(400).json({ error: 'Tu ne peux mettre en vitrine que des succès déjà débloqués.' });
  user.achievementShowcase = ids;
  db.updateUser(user.slug, user);
  res.json({ ok: true, showcase: user.achievementShowcase });
});

app.get('/api/achievements', requireAuth, (req, res) => {
  const user = ensureProfileFields(db.getUser(req.session.userSlug));
  const defs = db.getAchievements();
  const unlockedIds = new Set(user.achievementsUnlocked.map(a => a.id));
  const ctx = { cardPool: db.getCardPool() };
  const list = defs.map(def => ({
    id: def.id, name: def.name, description: def.description, icon: def.icon || null,
    rewardCredits: def.rewardCredits || 0, rewardDust: def.rewardDust || 0,
    condition: def.condition,
    unlocked: unlockedIds.has(def.id),
    unlockedAt: unlockedIds.has(def.id) ? user.achievementsUnlocked.find(a => a.id === def.id).unlockedAt : null,
    progress: unlockedIds.has(def.id) ? 1 : achievementsEngine.progressFor(user, def.condition, ctx)
  }));
  res.json({ achievements: list, showcase: user.achievementShowcase });
});

app.get('/api/admin/achievements', (req, res) => {
  if ((req.query || {}).code !== ADMIN_CODE) return res.status(403).json({ error: 'Code admin incorrect.' });
  res.json({ achievements: db.getAchievements(), conditionTypes: achievementsEngine.CONDITION_TYPES });
});

app.post('/api/admin/achievements', (req, res) => {
  const b = req.body || {};
  if (b.code !== ADMIN_CODE) return res.status(403).json({ error: 'Code admin incorrect.' });
  const name = String(b.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Le nom du succès ne peut pas être vide.' });
  const condType = b.condition && b.condition.type;
  if (!condType || !achievementsEngine.CONDITION_TYPES[condType]) return res.status(400).json({ error: 'Type de condition inconnu.' });
  const target = Math.max(1, Number(b.condition.target) || 1);
  const achievement = {
    id: 'ach-' + uuidv4().slice(0, 8), name, description: String(b.description || '').trim(), icon: null,
    rewardCredits: Math.max(0, Number(b.rewardCredits) || 0), rewardDust: Math.max(0, Number(b.rewardDust) || 0),
    condition: { type: condType, param: b.condition.param || null, target },
    createdAt: Date.now()
  };
  db.addAchievement(achievement);
  res.json({ ok: true, achievement });
});

app.patch('/api/admin/achievements/:id', (req, res) => {
  const b = req.body || {};
  if (b.code !== ADMIN_CODE) return res.status(403).json({ error: 'Code admin incorrect.' });
  const ach = db.achievementById(req.params.id);
  if (!ach) return res.status(404).json({ error: 'Succès introuvable.' });
  const patch = {};
  if (b.name !== undefined) {
    const name = String(b.name).trim();
    if (!name) return res.status(400).json({ error: 'Le nom ne peut pas être vide.' });
    patch.name = name;
  }
  if (b.description !== undefined) patch.description = String(b.description).trim();
  if (b.rewardCredits !== undefined) patch.rewardCredits = Math.max(0, Number(b.rewardCredits) || 0);
  if (b.rewardDust !== undefined) patch.rewardDust = Math.max(0, Number(b.rewardDust) || 0);
  if (b.condition) {
    const condType = b.condition.type;
    if (!condType || !achievementsEngine.CONDITION_TYPES[condType]) return res.status(400).json({ error: 'Type de condition inconnu.' });
    patch.condition = { type: condType, param: b.condition.param || null, target: Math.max(1, Number(b.condition.target) || 1) };
  }
  db.updateAchievement(ach.id, patch);
  res.json({ ok: true, achievement: db.achievementById(ach.id) });
});

app.post('/api/admin/achievements/:id/icon', (req, res) => {
  uploadBrandingImage.single('image')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    const b = req.body || {};
    if (b.code !== ADMIN_CODE) return res.status(403).json({ error: 'Code admin incorrect.' });
    const ach = db.achievementById(req.params.id);
    if (!ach) return res.status(404).json({ error: 'Succès introuvable.' });
    if (!req.file) return res.status(400).json({ error: 'Aucune image reçue.' });
    db.updateAchievement(ach.id, { icon: '/uploads/branding/' + req.file.filename });
    res.json({ ok: true, achievement: db.achievementById(ach.id) });
  });
});

app.delete('/api/admin/achievements/:id', (req, res) => {
  if ((req.body || {}).code !== ADMIN_CODE) return res.status(403).json({ error: 'Code admin incorrect.' });
  if (!db.achievementById(req.params.id)) return res.status(404).json({ error: 'Succès introuvable.' });
  db.removeAchievement(req.params.id);
  res.json({ ok: true });
});

app.get('/api/events', (req, res) => {
  const ev = db.getEvents();
  const today = new Date().toDateString();
  let bossAvailableToday = null;
  if (req.session && req.session.userSlug) {
    const user = db.getUser(req.session.userSlug);
    if (user) bossAvailableToday = !user.lastBossFight || new Date(user.lastBossFight).toDateString() !== today;
  }
  const enriched = JSON.parse(JSON.stringify(ev));
  enriched.casino.active = isEventActive(ev.casino);
  enriched.casino.daysRemaining = daysRemaining(ev.casino);
  enriched.boss.active = isEventActive(ev.boss);
  enriched.boss.daysRemaining = daysRemaining(ev.boss);
  enriched.blackjack.active = isEventActive(ev.blackjack);
  enriched.blackjack.daysRemaining = daysRemaining(ev.blackjack);
  res.json({ events: enriched, bossAvailableToday });
});

app.patch('/api/admin/events/tab', (req, res) => {
  const b = req.body || {};
  if (b.code !== ADMIN_CODE) return res.status(403).json({ error: 'Code admin incorrect.' });
  db.updateEvents({ tabEnabled: !!b.enabled });
  res.json({ ok: true, events: db.getEvents() });
});

app.patch('/api/admin/events/casino', (req, res) => {
  const b = req.body || {};
  if (b.code !== ADMIN_CODE) return res.status(403).json({ error: 'Code admin incorrect.' });
  const patch = {};
  if (b.enabled !== undefined) patch.enabled = !!b.enabled;
  if (b.costPerSpinDust !== undefined) {
    const cost = Number(b.costPerSpinDust);
    if (!Number.isFinite(cost) || cost < 0) return res.status(400).json({ error: 'Le coût en poussière doit être un nombre positif ou nul (0 = non proposé dans cette monnaie).' });
    patch.costPerSpinDust = Math.round(cost);
  }
  if (b.costPerSpinCredits !== undefined) {
    const cost = Number(b.costPerSpinCredits);
    if (!Number.isFinite(cost) || cost < 0) return res.status(400).json({ error: 'Le coût en crédits doit être un nombre positif ou nul (0 = non proposé dans cette monnaie).' });
    patch.costPerSpinCredits = Math.round(cost);
  }
  if (Array.isArray(b.symbols)) {
    const current = db.getEvents().casino.symbols;
    if (b.symbols.length !== current.length) return res.status(400).json({ error: 'Nombre de symboles invalide.' });
    const symbols = b.symbols.map((s, i) => ({
      id: current[i].id, icon: String(s.icon || current[i].icon).slice(0, 4),
      weight: Math.max(1, Number(s.weight) || current[i].weight),
      payout: Math.max(0, Number(s.payout) || 0)
    }));
    patch.symbols = symbols;
  }
  if (b.startDate !== undefined) patch.startDate = b.startDate || null;
  if (b.endDate !== undefined) patch.endDate = b.endDate || null;
  db.updateEvents({ casino: patch });
  res.json({ ok: true, events: db.getEvents() });
});

app.patch('/api/admin/events/boss', (req, res) => {
  const b = req.body || {};
  if (b.code !== ADMIN_CODE) return res.status(403).json({ error: 'Code admin incorrect.' });
  const patch = {};
  if (b.enabled !== undefined) patch.enabled = !!b.enabled;
  if (b.name !== undefined) {
    const name = String(b.name).trim();
    if (!name) return res.status(400).json({ error: 'Le nom du boss ne peut pas être vide.' });
    patch.name = name;
  }
  if (b.heroHealth !== undefined) {
    const hp = Number(b.heroHealth);
    if (!Number.isFinite(hp) || hp < 1) return res.status(400).json({ error: 'Points de vie invalides.' });
    patch.heroHealth = Math.round(hp);
  }
  if (b.rewardDust !== undefined) patch.rewardDust = Math.max(0, Number(b.rewardDust) || 0);
  if (b.rewardCredits !== undefined) patch.rewardCredits = Math.max(0, Number(b.rewardCredits) || 0);
  if (b.startDate !== undefined) patch.startDate = b.startDate || null;
  if (b.endDate !== undefined) patch.endDate = b.endDate || null;
  if (Array.isArray(b.deckCardIds)) {
    if (b.deckCardIds.length > 0 && b.deckCardIds.length < 4) {
      return res.status(400).json({ error: 'Le deck du boss doit contenir au moins 4 cartes (ou être vide pour un deck aléatoire).' });
    }
    const unknown = b.deckCardIds.find(id => !db.cardById(id));
    if (unknown) return res.status(400).json({ error: `Carte inconnue dans le deck du boss : ${unknown}` });
    patch.deckCardIds = b.deckCardIds.slice(0, 40);
  }
  if (Array.isArray(b.dialogue)) {
    const cleaned = b.dialogue
      .map(d => ({
        hpPercent: Math.max(0, Math.min(100, Number(d.hpPercent) || 0)),
        text: String(d.text || '').trim(),
        enabled: d.enabled !== false && d.enabled !== 'false'
      }))
      .filter(d => d.text)
      .sort((a, b2) => b2.hpPercent - a.hpPercent)
      .slice(0, 20);
    patch.dialogue = cleaned;
  }
  db.updateEvents({ boss: patch });
  res.json({ ok: true, events: db.getEvents() });
});

app.post('/api/admin/events/boss/image', (req, res) => {
  uploadBrandingImage.single('image')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    const b = req.body || {};
    if (b.code !== ADMIN_CODE) return res.status(403).json({ error: 'Code admin incorrect.' });
    if (!req.file) return res.status(400).json({ error: 'Aucune image reçue.' });
    db.updateEvents({ boss: { image: '/uploads/branding/' + req.file.filename } });
    res.json({ ok: true, events: db.getEvents() });
  });
});

app.post('/api/admin/events/boss/sound', (req, res) => {
  uploadBrandingSound.single('sound')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    const b = req.body || {};
    if (b.code !== ADMIN_CODE) return res.status(403).json({ error: 'Code admin incorrect.' });
    if (!req.file) return res.status(400).json({ error: 'Aucun fichier audio reçu.' });
    db.updateEvents({ boss: { entrySound: '/uploads/branding/' + req.file.filename } });
    res.json({ ok: true, events: db.getEvents() });
  });
});

app.post('/api/events/casino/spin', requireAuth, (req, res) => {
  const events = db.getEvents();
  if (!events.tabEnabled || !isEventActive(events.casino)) return res.status(400).json({ error: "Le casino n'est pas disponible pour le moment." });
  const currency = (req.body || {}).currency === 'credits' ? 'credits' : 'dust';
  const cost = currency === 'credits' ? events.casino.costPerSpinCredits : events.casino.costPerSpinDust;
  if (!cost || cost <= 0) return res.status(400).json({ error: `Le casino n'accepte pas ${currency === 'credits' ? 'les crédits' : 'la poussière'} pour l'instant.` });
  const user = ensureProfileFields(db.getUser(req.session.userSlug));
  const balance = currency === 'credits' ? user.credits : user.dust;
  if (balance < cost) return res.status(400).json({ error: `Il te faut ${cost} ${currency === 'credits' ? 'crédits' : 'poussière'} pour jouer.` });

  if (currency === 'credits') { user.credits -= cost; user.stats.creditsSpent += cost; }
  else { user.dust -= cost; user.stats.dustSpent += cost; }

  const symbols = events.casino.symbols;
  const totalWeight = symbols.reduce((a, s) => a + s.weight, 0);
  function spin() {
    let roll = Math.random() * totalWeight;
    for (const s of symbols) { roll -= s.weight; if (roll <= 0) return s; }
    return symbols[symbols.length - 1];
  }
  const result = [spin(), spin(), spin()];
  let payout = 0;
  if (result[0].id === result[1].id && result[1].id === result[2].id) {
    payout = cost * result[0].payout;
    if (currency === 'credits') user.credits += payout; else user.dust += payout;
    user.stats.casinoJackpots += 1;
  }
  const unlockedAchievements = awardAchievements(user);
  db.updateUser(user.slug, user);
  res.json({ ok: true, symbols: result.map(s => s.icon), payout, currency, credits: user.credits, dust: user.dust, unlockedAchievements });
});

/* ---------- Blackjack ---------- */
app.patch('/api/admin/events/blackjack', (req, res) => {
  const b = req.body || {};
  if (b.code !== ADMIN_CODE) return res.status(403).json({ error: 'Code admin incorrect.' });
  const patch = {};
  if (b.enabled !== undefined) patch.enabled = !!b.enabled;
  if (b.costDust !== undefined) {
    const cost = Number(b.costDust);
    if (!Number.isFinite(cost) || cost < 0) return res.status(400).json({ error: 'Mise en poussière invalide.' });
    patch.costDust = Math.round(cost);
  }
  if (b.costCredits !== undefined) {
    const cost = Number(b.costCredits);
    if (!Number.isFinite(cost) || cost < 0) return res.status(400).json({ error: 'Mise en crédits invalide.' });
    patch.costCredits = Math.round(cost);
  }
  if (b.startDate !== undefined) patch.startDate = b.startDate || null;
  if (b.endDate !== undefined) patch.endDate = b.endDate || null;
  db.updateEvents({ blackjack: patch });
  res.json({ ok: true, events: db.getEvents() });
});

app.post('/api/events/blackjack/start', requireAuth, (req, res) => {
  const events = db.getEvents();
  if (!events.tabEnabled || !isEventActive(events.blackjack)) return res.status(400).json({ error: "Le blackjack n'est pas disponible pour le moment." });
  if (blackjack.getGame(req.session.userSlug)) return res.status(400).json({ error: 'Une manche est déjà en cours — termine-la avant d\'en démarrer une autre.' });
  const currency = (req.body || {}).currency === 'credits' ? 'credits' : 'dust';
  const bet = currency === 'credits' ? events.blackjack.costCredits : events.blackjack.costDust;
  if (!bet || bet <= 0) return res.status(400).json({ error: `Le blackjack n'accepte pas ${currency === 'credits' ? 'les crédits' : 'la poussière'} pour l'instant.` });
  const user = ensureProfileFields(db.getUser(req.session.userSlug));
  const balance = currency === 'credits' ? user.credits : user.dust;
  if (balance < bet) return res.status(400).json({ error: `Il te faut ${bet} ${currency === 'credits' ? 'crédits' : 'poussière'} pour miser.` });

  if (currency === 'credits') { user.credits -= bet; user.stats.creditsSpent += bet; }
  else { user.dust -= bet; user.stats.dustSpent += bet; }

  const state = blackjack.startGame(user.slug, bet, currency);
  let unlockedAchievements = [];
  if (state.status === 'finished') {
    // Blackjack naturel dès la donne : on règle immédiatement la manche
    const payout = Math.round(bet * state.outcome.multiplier);
    if (currency === 'credits') user.credits += payout; else user.dust += payout;
    blackjack.clearGame(user.slug);
  }
  unlockedAchievements = awardAchievements(user);
  db.updateUser(user.slug, user);
  res.json({ ok: true, state: blackjack.redactState(state), profile: decorateProfile(user), unlockedAchievements });
});

app.post('/api/events/blackjack/hit', requireAuth, (req, res) => {
  const result = blackjack.hit(req.session.userSlug);
  if (result.error) return res.status(400).json({ error: result.error });
  const user = ensureProfileFields(db.getUser(req.session.userSlug));
  let unlockedAchievements = [];
  if (result.state.status === 'finished') {
    // Un dépassement (bust) : la mise est déjà perdue, rien à créditer (multiplicateur 0)
    blackjack.clearGame(user.slug);
    unlockedAchievements = awardAchievements(user);
    db.updateUser(user.slug, user);
  }
  res.json({ ok: true, state: blackjack.redactState(result.state), profile: decorateProfile(user), unlockedAchievements });
});

app.post('/api/events/blackjack/stand', requireAuth, (req, res) => {
  const result = blackjack.stand(req.session.userSlug);
  if (result.error) return res.status(400).json({ error: result.error });
  const user = ensureProfileFields(db.getUser(req.session.userSlug));
  const { bet, currency } = result.state;
  const payout = Math.round(bet * result.state.outcome.multiplier);
  if (currency === 'credits') user.credits += payout; else user.dust += payout;
  blackjack.clearGame(user.slug);
  const unlockedAchievements = awardAchievements(user);
  db.updateUser(user.slug, user);
  res.json({ ok: true, state: blackjack.redactState(result.state), profile: decorateProfile(user), unlockedAchievements });
});

app.get('/api/events/blackjack/state', requireAuth, (req, res) => {
  res.json({ state: blackjack.redactState(blackjack.getGame(req.session.userSlug)) });
});

app.get('/api/settings', (req, res) => {
  res.json({ matchDropChance: db.getSettings().matchDropChance });
});

app.patch('/api/admin/settings', (req, res) => {
  const b = req.body || {};
  if (b.code !== ADMIN_CODE) return res.status(403).json({ error: 'Code admin incorrect.' });
  if (b.matchDropChance !== undefined) {
    const chance = Number(b.matchDropChance);
    if (!Number.isFinite(chance) || chance < 0 || chance > 100) return res.status(400).json({ error: 'La probabilité doit être comprise entre 0 et 100.' });
    db.updateSettings({ matchDropChance: chance });
  }
  res.json({ ok: true, settings: db.getSettings() });
});

app.get('/api/extensions', (req, res) => {
  res.json({ extensions: db.getExtensions() });
});

app.post('/api/admin/extensions', (req, res) => {
  uploadCardImage.single('backImage')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    const b = req.body || {};
    if (b.code !== ADMIN_CODE) return res.status(403).json({ error: 'Code admin incorrect.' });
    const name = (b.name || '').trim();
    if (!name) return res.status(400).json({ error: "Le nom de l'extension est obligatoire." });
    if (db.getExtensions().some(e => e.name.toLowerCase() === name.toLowerCase())) {
      return res.status(409).json({ error: 'Une extension porte déjà ce nom.' });
    }
    const ext = {
      id: 'ext-' + uuidv4().slice(0, 8), name, description: b.description || '',
      backImage: req.file ? '/uploads/cards/' + req.file.filename : null,
      packImage: null,
      boosterCreditPrice: b.boosterCreditPrice !== undefined && b.boosterCreditPrice !== '' ? Number(b.boosterCreditPrice) : 100,
      boosterDustPrice: b.boosterDustPrice !== undefined && b.boosterDustPrice !== '' ? Number(b.boosterDustPrice) : null,
      matchDropEligible: b.matchDropEligible === 'true' || b.matchDropEligible === true,
      createdAt: Date.now()
    };
    db.addExtension(ext);
    res.json({ ok: true, extension: ext });
  });
});

app.patch('/api/admin/extensions/:id', (req, res) => {
  const b = req.body || {};
  if (b.code !== ADMIN_CODE) return res.status(403).json({ error: 'Code admin incorrect.' });
  const ext = db.extensionById(req.params.id);
  if (!ext) return res.status(404).json({ error: 'Extension introuvable.' });
  const patch = {};
  if (b.name !== undefined) {
    const name = String(b.name).trim();
    if (!name) return res.status(400).json({ error: 'Le nom ne peut pas être vide.' });
    patch.name = name;
  }
  if (b.description !== undefined) patch.description = String(b.description);
  if (b.boosterCreditPrice !== undefined) {
    patch.boosterCreditPrice = b.boosterCreditPrice === '' || b.boosterCreditPrice === null ? null : Math.max(0, Number(b.boosterCreditPrice) || 0);
  }
  if (b.boosterDustPrice !== undefined) {
    patch.boosterDustPrice = b.boosterDustPrice === '' || b.boosterDustPrice === null ? null : Math.max(0, Number(b.boosterDustPrice) || 0);
  }
  if (b.matchDropEligible !== undefined) {
    patch.matchDropEligible = b.matchDropEligible === 'true' || b.matchDropEligible === true;
  }
  db.updateExtension(ext.id, patch);
  res.json({ ok: true, extension: db.extensionById(ext.id) });
});

app.post('/api/admin/extensions/:id/back-image', (req, res) => {
  uploadCardImage.single('backImage')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if ((req.body || {}).code !== ADMIN_CODE) return res.status(403).json({ error: 'Code admin incorrect.' });
    if (!req.file) return res.status(400).json({ error: 'Aucune image reçue.' });
    const updated = db.updateExtension(req.params.id, { backImage: '/uploads/cards/' + req.file.filename });
    if (!updated) return res.status(404).json({ error: 'Extension introuvable.' });
    res.json({ ok: true, extension: updated });
  });
});

app.post('/api/admin/extensions/:id/pack-image', (req, res) => {
  uploadCardImage.single('packImage')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if ((req.body || {}).code !== ADMIN_CODE) return res.status(403).json({ error: 'Code admin incorrect.' });
    if (!req.file) return res.status(400).json({ error: 'Aucune image reçue.' });
    const updated = db.updateExtension(req.params.id, { packImage: '/uploads/cards/' + req.file.filename });
    if (!updated) return res.status(404).json({ error: 'Extension introuvable.' });
    res.json({ ok: true, extension: updated });
  });
});

app.delete('/api/admin/extensions/:id', (req, res) => {
  if ((req.body || {}).code !== ADMIN_CODE) return res.status(403).json({ error: 'Code admin incorrect.' });
  if (req.params.id === 'base') return res.status(400).json({ error: "L'extension de base ne peut pas être supprimée." });
  const hasCards = db.getCardPool().some(c => (c.extensionId || 'base') === req.params.id);
  if (hasCards) return res.status(400).json({ error: 'Réaffecte ou supprime les cartes de cette extension avant de la supprimer.' });
  db.removeExtension(req.params.id);
  res.json({ ok: true });
});

/* ---------- Cartes ---------- */
app.get('/api/cards', (req, res) => {
  const cards = db.getCardPool().map(c => {
    const ext = db.extensionById(c.extensionId || 'base');
    return Object.assign({}, c, { cardBackImage: ext ? ext.backImage : null, extensionName: ext ? ext.name : null });
  });
  res.json({ cards });
});

app.get('/api/config', (req, res) => {
  res.json({
    rarityWeights: RARITY_WEIGHTS, copyLimits: COPY_LIMITS, dustValues: DUST_VALUES,
    deckSize: DECK_SIZE, ornaments: db.getOrnaments(), ranks: RANKS,
    emotes: db.getEmotePool(), emoteWheelSize: EMOTE_WHEEL_SIZE,
    monthlyRewards: MONTHLY_REWARDS, season: ranking.currentSeason()
  });
});

/* ---------- Admin : création de cartes avec image ---------- */
const cardAssets = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(UPLOAD_ROOT, file.fieldname === 'sound' ? 'sounds' : 'cards')),
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname) || (file.fieldname === 'sound' ? '.mp3' : '.png')).toLowerCase();
      cb(null, uuidv4().slice(0, 12) + ext);
    }
  }),
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const images = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
    const audios = ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/webm', 'audio/mp4', 'audio/aac'];
    const ok = file.fieldname === 'sound' ? audios.includes(file.mimetype) : images.includes(file.mimetype);
    cb(ok ? null : new Error(file.fieldname === 'sound' ? 'Format audio non supporté.' : 'Format image non supporté.'), ok);
  }
}).fields([
  { name: 'image', maxCount: 1 }, { name: 'sound', maxCount: 1 },
  { name: 'parallaxBackground', maxCount: 1 }, { name: 'parallaxCharacter', maxCount: 1 }
]);

app.post('/api/admin/cards', (req, res) => {
  cardAssets(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    const b = req.body || {};
    if (b.code !== ADMIN_CODE) return res.status(403).json({ error: 'Code admin incorrect.' });
    if (!b.name || !b.type || !b.rarity || b.cost === undefined) return res.status(400).json({ error: 'Champs manquants.' });

    const extensionId = db.extensionById(b.extensionId) ? b.extensionId : 'base';
    const parallax = (b.parallax === 'true' || b.parallax === true) &&
      !!(req.files && req.files.parallaxBackground && req.files.parallaxCharacter);
    // Filet de sécurité : la vue 2D (main, plateau, grilles, collection...) affiche
    // toujours card.image, jamais les calques du parallaxe. Si l'admin coche le
    // parallaxe et fournit le personnage sans prendre le temps d'uploader une image
    // fixe séparée, on réutilise le calque personnage comme image 2D par défaut —
    // plutôt qu'une carte qui reste sans aucune image visible en dehors de la
    // visionneuse 3D (le trou remonté après la première version de cette fonctionnalité).
    const fixedImage = (req.files && req.files.image) ? '/uploads/cards/' + req.files.image[0].filename
      : (parallax ? '/uploads/cards/' + req.files.parallaxCharacter[0].filename : null);
    const card = {
      id: 'c-' + uuidv4().slice(0, 8),
      name: b.name, type: b.type, rarity: b.rarity, extensionId,
      cost: Number(b.cost), desc: b.desc || '—',
      image: fixedImage,
      sound: (req.files && req.files.sound) ? '/uploads/sounds/' + req.files.sound[0].filename : null,
      // Effet parallaxe : uniquement visible dans la visionneuse 3D, jamais en
      // 2D. Les deux calques ne sont activés que si les deux images sont bien
      // fournies ensemble — un parallaxe à moitié rempli reste désactivé
      // plutôt que de produire un état incomplet.
      parallax,
      parallaxBackground: parallax ? '/uploads/cards/' + req.files.parallaxBackground[0].filename : null,
      parallaxCharacter: parallax ? '/uploads/cards/' + req.files.parallaxCharacter[0].filename : null
    };
    if (b.type === 'minion') {
      card.attack = Number(b.attack) || 1;
      card.health = Number(b.health) || 1;
      card.taunt = b.taunt === 'true' || b.taunt === true;
      card.charge = b.charge === 'true' || b.charge === true;
      if (b.battlecryHeal) card.battlecryHeal = Number(b.battlecryHeal) || 0;
      card.armor = Math.max(0, Number(b.armor) || 0);
    } else if (b.type === 'weapon') {
      card.attack = Math.max(0, Number(b.attack) || 1);
      card.durability = Math.max(1, Number(b.durability) || 1);
      card.usesPerTurn = Math.max(1, Number(b.usesPerTurn) || 1);
      if (b.battlecryHeal) card.battlecryHeal = Number(b.battlecryHeal) || 0;
    } else {
      card.effectType = b.effectType || 'damage';
      card.value = Number(b.value) || 1;
      if (b.value2 !== undefined && b.value2 !== '') card.value2 = Number(b.value2) || 0;
    }
    if (b.dropWeight !== undefined && b.dropWeight !== '') {
      const w = Number(b.dropWeight);
      if (!Number.isFinite(w) || w < MIN_DROP_WEIGHT || w > MAX_DROP_WEIGHT) {
        return res.status(400).json({ error: `Le taux de drop doit être entre ${MIN_DROP_WEIGHT} et ${MAX_DROP_WEIGHT}.` });
      }
      card.dropWeight = w;
    } else {
      card.dropWeight = DEFAULT_DROP_WEIGHT;
    }
    db.addCard(card);
    res.json({ ok: true, card });
  });
});

app.patch('/api/admin/cards/:id', (req, res) => {
  const b = req.body || {};
  if (b.code !== ADMIN_CODE) return res.status(403).json({ error: 'Code admin incorrect.' });
  const card = db.cardById(req.params.id);
  if (!card) return res.status(404).json({ error: 'Carte introuvable.' });

  const patch = {};
  if (b.name !== undefined) {
    const name = String(b.name).trim();
    if (!name) return res.status(400).json({ error: 'Le nom ne peut pas être vide.' });
    patch.name = name;
  }
  if (b.desc !== undefined) patch.desc = String(b.desc);
  if (b.rarity !== undefined && ['commun', 'rare', 'epique', 'legendaire'].includes(b.rarity)) patch.rarity = b.rarity;
  if (b.cost !== undefined && b.cost !== '') patch.cost = Math.max(0, Number(b.cost) || 0);
  if (b.extensionId !== undefined && db.extensionById(b.extensionId)) patch.extensionId = b.extensionId;

  if (card.type === 'minion') {
    if (b.attack !== undefined && b.attack !== '') patch.attack = Math.max(0, Number(b.attack) || 0);
    if (b.health !== undefined && b.health !== '') patch.health = Math.max(1, Number(b.health) || 1);
    if (b.armor !== undefined && b.armor !== '') patch.armor = Math.max(0, Number(b.armor) || 0);
    if (b.battlecryHeal !== undefined && b.battlecryHeal !== '') patch.battlecryHeal = Math.max(0, Number(b.battlecryHeal) || 0);
    if (b.taunt !== undefined) patch.taunt = b.taunt === 'true' || b.taunt === true;
    if (b.charge !== undefined) patch.charge = b.charge === 'true' || b.charge === true;
  } else if (card.type === 'weapon') {
    if (b.attack !== undefined && b.attack !== '') patch.attack = Math.max(0, Number(b.attack) || 0);
    if (b.durability !== undefined && b.durability !== '') patch.durability = Math.max(1, Number(b.durability) || 1);
    if (b.usesPerTurn !== undefined && b.usesPerTurn !== '') patch.usesPerTurn = Math.max(1, Number(b.usesPerTurn) || 1);
    if (b.battlecryHeal !== undefined && b.battlecryHeal !== '') patch.battlecryHeal = Math.max(0, Number(b.battlecryHeal) || 0);
  } else {
    if (b.effectType !== undefined) patch.effectType = b.effectType;
    if (b.value !== undefined && b.value !== '') patch.value = Number(b.value) || 0;
    if (b.value2 !== undefined) patch.value2 = b.value2 === '' ? undefined : (Number(b.value2) || 0);
  }

  const updated = db.updateCard(req.params.id, patch);
  res.json({ ok: true, card: updated });
});

app.post('/api/admin/cards/:id/image', (req, res) => {
  uploadCardImage.single('image')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if ((req.body || {}).code !== ADMIN_CODE) return res.status(403).json({ error: 'Code admin incorrect.' });
    if (!req.file) return res.status(400).json({ error: 'Aucune image reçue.' });
    const updated = db.updateCard(req.params.id, { image: '/uploads/cards/' + req.file.filename });
    if (!updated) return res.status(404).json({ error: 'Carte introuvable.' });
    res.json({ ok: true, card: updated });
  });
});

app.post('/api/admin/cards/:id/parallax/:layer', (req, res) => {
  const layer = req.params.layer;
  const fieldMap = { background: 'parallaxBackground', character: 'parallaxCharacter' };
  if (!fieldMap[layer]) return res.status(400).json({ error: 'Calque inconnu (attendu : background ou character).' });
  uploadCardImage.single('image')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if ((req.body || {}).code !== ADMIN_CODE) return res.status(403).json({ error: 'Code admin incorrect.' });
    if (!req.file) return res.status(400).json({ error: 'Aucune image reçue.' });
    const card = db.cardById(req.params.id);
    if (!card) return res.status(404).json({ error: 'Carte introuvable.' });
    const patch = { [fieldMap[layer]]: '/uploads/cards/' + req.file.filename };
    // Même filet de sécurité que la création : si la carte n'a toujours pas
    // d'image fixe (2D) et qu'on vient justement d'uploader le calque
    // personnage, on l'utilise aussi comme image fixe par défaut.
    if (layer === 'character' && !card.image) patch.image = patch.parallaxCharacter;
    // Une fois les deux calques présents, le parallaxe peut être activé automatiquement
    const wouldHaveAll = ['parallaxBackground', 'parallaxCharacter']
      .every(k => (patch[k] !== undefined ? patch[k] : card[k]));
    if (wouldHaveAll) patch.parallax = true;
    const updated = db.updateCard(req.params.id, patch);
    res.json({ ok: true, card: updated });
  });
});

app.patch('/api/admin/cards/:id/parallax', (req, res) => {
  const b = req.body || {};
  if (b.code !== ADMIN_CODE) return res.status(403).json({ error: 'Code admin incorrect.' });
  const card = db.cardById(req.params.id);
  if (!card) return res.status(404).json({ error: 'Carte introuvable.' });
  const enabled = b.enabled === true || b.enabled === 'true';
  if (enabled && !(card.parallaxBackground && card.parallaxCharacter)) {
    return res.status(400).json({ error: 'Il faut les deux images (fond et personnage) avant d\'activer le parallaxe.' });
  }
  const updated = db.updateCard(req.params.id, { parallax: enabled });
  res.json({ ok: true, card: updated });
});

app.patch('/api/admin/cards/:id/drop-weight', (req, res) => {
  const b = req.body || {};
  if (b.code !== ADMIN_CODE) return res.status(403).json({ error: 'Code admin incorrect.' });
  const w = Number(b.dropWeight);
  if (!Number.isFinite(w) || w < MIN_DROP_WEIGHT || w > MAX_DROP_WEIGHT) {
    return res.status(400).json({ error: `Le taux de drop doit être entre ${MIN_DROP_WEIGHT} et ${MAX_DROP_WEIGHT}.` });
  }
  const updated = db.updateCard(req.params.id, { dropWeight: w });
  if (!updated) return res.status(404).json({ error: 'Carte introuvable.' });
  res.json({ ok: true, card: updated, effectivePercent: effectiveDropPercent(updated, db.getCardPool()) });
});

app.post('/api/admin/cards/:id/sound', (req, res) => {
  uploadCardSound.single('sound')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if ((req.body || {}).code !== ADMIN_CODE) return res.status(403).json({ error: 'Code admin incorrect.' });
    if (!req.file) return res.status(400).json({ error: 'Aucun fichier audio reçu.' });
    const updated = db.updateCard(req.params.id, { sound: '/uploads/sounds/' + req.file.filename });
    if (!updated) return res.status(404).json({ error: 'Carte introuvable.' });
    res.json({ ok: true, card: updated });
  });
});

app.delete('/api/admin/cards/:id/sound', (req, res) => {
  if ((req.body || {}).code !== ADMIN_CODE) return res.status(403).json({ error: 'Code admin incorrect.' });
  const updated = db.updateCard(req.params.id, { sound: null });
  if (!updated) return res.status(404).json({ error: 'Carte introuvable.' });
  res.json({ ok: true, card: updated });
});

app.delete('/api/admin/cards/:id', (req, res) => {
  if ((req.body || {}).code !== ADMIN_CODE) return res.status(403).json({ error: 'Code admin incorrect.' });
  db.removeCard(req.params.id);
  // La carte disparaît aussi des collections et des decks de tous les joueurs,
  // pour qu'aucun deck ne garde une carte fantôme.
  db.allUsers().forEach(u => { if (purgeDeletedCards(u, [req.params.id])) db.updateUser(u.slug, u); });
  res.json({ ok: true });
});

/* Statistiques mensuelles des cartes jouées (Admin → Stats) */
app.get('/api/admin/card-stats', (req, res) => {
  if (req.query.code !== ADMIN_CODE) return res.status(403).json({ error: 'Code admin incorrect.' });
  const all = db.getCardStats().months;
  const current = ranking.currentSeason();
  const months = [...new Set([current, ...Object.keys(all)])].sort().reverse();
  const month = months.includes(req.query.month) ? req.query.month : current;
  const b = all[month] || { cards: {}, days: {}, pvpMatches: 0 };
  const cards = Object.keys(b.cards).map(id => Object.assign({ id }, b.cards[id]));
  res.json({ months, month, pvpMatches: b.pvpMatches || 0, days: b.days || {}, cards });
});

/* Nettoyage manuel des cartes supprimées avant ce correctif. GET = aperçu (rien
   n'est modifié), POST = nettoyage. Refusé si le pool de cartes est vide, pour
   ne jamais vider les collections à cause d'un fichier de cartes illisible. */
app.get('/api/admin/cards/orphans', (req, res) => {
  if (req.query.code !== ADMIN_CODE) return res.status(403).json({ error: 'Code admin incorrect.' });
  const ids = findOrphanCardIds();
  const players = db.allUsers().filter(u => ids.some(id => (u.collection || {})[id] || (u.deck || []).includes(id) || (u.savedDecks || []).some(d => (d.cardIds || []).includes(id)))).length;
  res.json({ orphanIds: ids, players, poolSize: db.getCardPool().length });
});
app.post('/api/admin/cards/orphans/cleanup', (req, res) => {
  if ((req.body || {}).code !== ADMIN_CODE) return res.status(403).json({ error: 'Code admin incorrect.' });
  if (db.getCardPool().length === 0) return res.status(400).json({ error: 'Le pool de cartes est vide : nettoyage refusé par sécurité.' });
  const ids = findOrphanCardIds();
  db.addDeletedCardIds(ids);
  let players = 0;
  db.allUsers().forEach(u => { if (purgeDeletedCards(u, ids)) { db.updateUser(u.slug, u); players++; } });
  res.json({ ok: true, removed: ids.length, players });
});

/* ---------- Boosters ---------- */
function weightedDraw(cardPool) {
  const roll = Math.random() * 100;
  let acc = 0, chosenRarity = 'commun';
  for (const key of Object.keys(RARITY_WEIGHTS)) {
    acc += RARITY_WEIGHTS[key];
    if (roll <= acc) { chosenRarity = key; break; }
  }
  let pool = cardPool.filter(c => c.rarity === chosenRarity);
  if (pool.length === 0) pool = cardPool;
  return weightedPick(pool);
}

/* Tirage pondéré À L'INTÉRIEUR d'une rareté : chaque carte a un poids
   (dropWeight, 1 par défaut = équivalente aux autres). Le taux global de la
   rareté n'est pas affecté, seule la répartition entre cartes de cette
   rareté change. */
function weightedPick(pool) {
  const weights = pool.map(c => Math.max(MIN_DROP_WEIGHT, Number(c.dropWeight) || DEFAULT_DROP_WEIGHT));
  const total = weights.reduce((a, b) => a + b, 0);
  let roll = Math.random() * total;
  for (let i = 0; i < pool.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return pool[i];
  }
  return pool[pool.length - 1];
}

/* Probabilité effective d'obtenir CETTE carte dans un booster, en tenant
   compte du taux de sa rareté et de son poids relatif face aux autres
   cartes de la même rareté. Sert d'indicateur dans le panel admin. */
function effectiveDropPercent(card, cardPool) {
  const bucket = cardPool.filter(c => c.rarity === card.rarity);
  if (bucket.length === 0) return 0;
  const weights = bucket.map(c => Math.max(MIN_DROP_WEIGHT, Number(c.dropWeight) || DEFAULT_DROP_WEIGHT));
  const total = weights.reduce((a, b) => a + b, 0);
  const mine = Math.max(MIN_DROP_WEIGHT, Number(card.dropWeight) || DEFAULT_DROP_WEIGHT);
  const rarityPercent = RARITY_WEIGHTS[card.rarity] || 0;
  return total > 0 ? (rarityPercent * mine / total) : 0;
}

app.post('/api/shop/buy-booster', requireAuth, (req, res) => {
  const user = ensureProfileFields(db.getUser(req.session.userSlug));
  const { extensionId, currency } = req.body || {};
  const quantity = Math.max(1, Math.min(20, Math.round(Number((req.body || {}).quantity) || 1)));
  const ext = db.extensionById(extensionId);
  if (!ext) return res.status(400).json({ error: 'Extension introuvable.' });

  const pool = db.getCardPool().filter(c => (c.extensionId || 'base') === ext.id);
  if (pool.length === 0) return res.status(400).json({ error: 'Cette extension ne contient encore aucune carte.' });

  let unitPrice = null;
  if (currency === 'credits') unitPrice = ext.boosterCreditPrice;
  else if (currency === 'dust') unitPrice = ext.boosterDustPrice;
  else return res.status(400).json({ error: 'Choisis une monnaie : crédits ou poussière.' });
  if (unitPrice === null || unitPrice === undefined) return res.status(400).json({ error: "Ce booster n'est pas achetable avec cette monnaie." });

  const totalPrice = unitPrice * quantity;
  if (currency === 'credits') {
    if (user.credits < totalPrice) return res.status(400).json({ error: `Il te manque ${totalPrice - user.credits} crédits pour ${quantity} booster(s).` });
    user.credits -= totalPrice;
    user.stats.creditsSpent += totalPrice;
  } else {
    if (user.dust < totalPrice) return res.status(400).json({ error: `Il te manque ${totalPrice - user.dust} poussière pour ${quantity} booster(s).` });
    user.dust -= totalPrice;
    user.stats.dustSpent += totalPrice;
  }

  // Les boosters achetés sont rangés dans l'inventaire plutôt qu'ouverts tout de
  // suite — le joueur choisit quand (et lesquels) ouvrir depuis l'onglet Boosters.
  if (!Array.isArray(user.boosterInventory)) user.boosterInventory = [];
  const stored = [];
  for (let i = 0; i < quantity; i++) {
    const entry = { id: 'inv-' + uuidv4().slice(0, 10), extensionId: ext.id, extensionName: ext.name, acquiredAt: Date.now() };
    user.boosterInventory.push(entry);
    stored.push(entry);
  }
  const unlockedAchievements = awardAchievements(user);
  db.updateUser(user.slug, user);
  res.json({ ok: true, stored, profile: decorateProfile(user), unlockedAchievements });
});

app.post('/api/pack/open-inventory', requireAuth, (req, res) => {
  const user = ensureProfileFields(db.getUser(req.session.userSlug));
  if (!Array.isArray(user.boosterInventory)) user.boosterInventory = [];
  const idx = user.boosterInventory.findIndex(b => b.id === (req.body || {}).inventoryId);
  if (idx === -1) return res.status(404).json({ error: 'Booster introuvable dans ton inventaire.' });
  const stored = user.boosterInventory[idx];
  const pool = db.getCardPool().filter(c => (c.extensionId || 'base') === stored.extensionId);
  if (pool.length === 0) return res.status(400).json({ error: "Cette extension ne contient plus de cartes (elle a peut-être été supprimée)." });

  const drawn = [];
  for (let i = 0; i < 5; i++) {
    const c = weightedPick(pool);
    drawn.push(c);
    user.collection[c.id] = (user.collection[c.id] || 0) + 1;
  }
  user.boosterInventory.splice(idx, 1);
  markDiscovered(user, drawn.map(c => c.id));
  const unlockedAchievements = awardAchievements(user);
  db.updateUser(user.slug, user);
  res.json({ drawn, profile: decorateProfile(user), unlockedAchievements });
});

app.get('/api/pack/status', requireAuth, (req, res) => {
  const user = ensureProfileFields(db.getUser(req.session.userSlug));
  const remaining = PACK_COOLDOWN_MS - (Date.now() - user.lastPack);
  res.json({ ready: remaining <= 0, remainingMs: Math.max(remaining, 0), credits: user.credits, boosterInventory: user.boosterInventory });
});

app.post('/api/pack/open', requireAuth, (req, res) => {
  const user = ensureProfileFields(db.getUser(req.session.userSlug));
  const useCredits = !!(req.body && req.body.useCredits);
  const remaining = PACK_COOLDOWN_MS - (Date.now() - user.lastPack);
  const ready = remaining <= 0;
  if (!ready && !useCredits) return res.status(400).json({ error: "Le prochain booster n'est pas encore prêt." });
  if (!ready && useCredits) {
    if (user.credits < 50) return res.status(400).json({ error: 'Pas assez de crédits (50 requis).' });
    user.credits -= 50;
    user.stats.creditsSpent += 50;
  }
  const pool = db.getCardPool();
  const drawn = [];
  for (let i = 0; i < 5; i++) {
    const c = weightedDraw(pool);
    drawn.push(c);
    user.collection[c.id] = (user.collection[c.id] || 0) + 1;
  }
  user.lastPack = Date.now();
  markDiscovered(user, drawn.map(c => c.id));
  const unlockedAchievements = awardAchievements(user);
  db.updateUser(user.slug, user);
  res.json({ drawn, profile: decorateProfile(user), unlockedAchievements });
});

/* ---------- Poussière : désenchantement des doublons ---------- */
function excessCopies(user, cardId) {
  const card = db.cardById(cardId);
  if (!card) return 0;
  const limit = COPY_LIMITS[card.rarity] || 2;
  const owned = user.collection[cardId] || 0;
  return Math.max(0, owned - limit);
}

app.get('/api/dust/duplicates', requireAuth, (req, res) => {
  const user = ensureProfileFields(db.getUser(req.session.userSlug));
  const list = Object.keys(user.collection).map(id => {
    const card = db.cardById(id);
    if (!card) return null;
    const excess = excessCopies(user, id);
    if (excess <= 0) return null;
    return { cardId: id, name: card.name, rarity: card.rarity, excess, dustEach: DUST_VALUES[card.rarity] || 1 };
  }).filter(Boolean);
  res.json({ duplicates: list, dust: user.dust });
});

app.post('/api/dust/disenchant', requireAuth, (req, res) => {
  const user = ensureProfileFields(db.getUser(req.session.userSlug));
  const { cardId, amount } = req.body || {};
  const card = db.cardById(cardId);
  if (!card) return res.status(400).json({ error: 'Carte inconnue.' });
  const excess = excessCopies(user, cardId);
  const qty = Math.min(Number(amount) || 1, excess);
  if (qty <= 0) return res.status(400).json({ error: 'Tu n\'as pas d\'exemplaire en trop de cette carte.' });

  const gain = qty * (DUST_VALUES[card.rarity] || 1);
  user.collection[cardId] -= qty;
  if (user.collection[cardId] <= 0) delete user.collection[cardId];
  user.dust += gain;
  // On retire du deck les exemplaires devenus non possédés
  const stillOwned = user.collection[cardId] || 0;
  let inDeck = user.deck.filter(id => id === cardId).length;
  while (inDeck > stillOwned) {
    user.deck.splice(user.deck.lastIndexOf(cardId), 1);
    inDeck--;
  }
  db.updateUser(user.slug, user);
  res.json({ ok: true, gained: gain, profile: decorateProfile(user) });
});

app.post('/api/dust/disenchant-all', requireAuth, (req, res) => {
  const user = ensureProfileFields(db.getUser(req.session.userSlug));
  let total = 0;
  Object.keys(user.collection).forEach(id => {
    const card = db.cardById(id);
    if (!card) return;
    const excess = excessCopies(user, id);
    if (excess <= 0) return;
    total += excess * (DUST_VALUES[card.rarity] || 1);
    user.collection[id] -= excess;
    if (user.collection[id] <= 0) delete user.collection[id];
    const stillOwned = user.collection[id] || 0;
    let inDeck = user.deck.filter(x => x === id).length;
    while (inDeck > stillOwned) { user.deck.splice(user.deck.lastIndexOf(id), 1); inDeck--; }
  });
  user.dust += total;
  db.updateUser(user.slug, user);
  res.json({ ok: true, gained: total, profile: decorateProfile(user) });
});

/* ---------- Boutique d'ornements ---------- */
app.get('/api/shop', requireAuth, (req, res) => {
  const user = ensureProfileFields(db.getUser(req.session.userSlug));
  const boosters = db.getExtensions().map(ext => ({
    id: ext.id, name: ext.name, description: ext.description,
    backImage: ext.backImage, packImage: ext.packImage,
    creditPrice: ext.boosterCreditPrice, dustPrice: ext.boosterDustPrice,
    cardCount: db.getCardPool().filter(c => (c.extensionId || 'base') === ext.id).length
  }));
  res.json({
    dust: user.dust, credits: user.credits,
    owned: user.ownedOrnaments, equipped: user.ornament,
    ornaments: db.getOrnaments(),
    emotes: db.getEmotePool(), ownedEmotes: user.ownedEmotes, emoteWheel: user.emoteWheel,
    wheelSize: EMOTE_WHEEL_SIZE,
    boosters
  });
});

app.post('/api/shop/buy', requireAuth, (req, res) => {
  const user = ensureProfileFields(db.getUser(req.session.userSlug));
  const orn = db.ornamentById((req.body || {}).ornamentId);
  if (!orn) return res.status(400).json({ error: 'Ornement inconnu.' });
  if (user.ownedOrnaments.includes(orn.id)) return res.status(400).json({ error: 'Tu possèdes déjà cet ornement.' });
  if (user.dust < orn.price) return res.status(400).json({ error: `Il te manque ${orn.price - user.dust} poussière.` });
  user.dust -= orn.price;
  user.stats.dustSpent += orn.price;
  user.ownedOrnaments.push(orn.id);
  const unlockedAchievements = awardAchievements(user);
  db.updateUser(user.slug, user);
  res.json({ ok: true, profile: decorateProfile(user), unlockedAchievements });
});

app.post('/api/shop/equip', requireAuth, (req, res) => {
  const user = ensureProfileFields(db.getUser(req.session.userSlug));
  const id = (req.body || {}).ornamentId;
  if (!user.ownedOrnaments.includes(id)) return res.status(400).json({ error: 'Tu ne possèdes pas cet ornement.' });
  user.ornament = id;
  db.updateUser(user.slug, user);
  res.json({ ok: true, profile: decorateProfile(user) });
});


/* ---------- Provocations (emotes) ---------- */
/* ---------- Packs de crédits (achetables contre de la poussière) ---------- */
app.get('/api/credit-packs', (req, res) => {
  res.json({ packs: db.getCreditPacks() });
});

app.post('/api/admin/credit-packs', (req, res) => {
  const b = req.body || {};
  if (b.code !== ADMIN_CODE) return res.status(403).json({ error: 'Code admin incorrect.' });
  const name = String(b.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Le nom du pack ne peut pas être vide.' });
  const creditsAmount = Math.max(1, Number(b.creditsAmount) || 0);
  const dustPrice = Math.max(1, Number(b.dustPrice) || 0);
  const pack = { id: 'pack-' + uuidv4().slice(0, 8), name, creditsAmount, dustPrice, createdAt: Date.now() };
  db.addCreditPack(pack);
  res.json({ ok: true, pack });
});

app.patch('/api/admin/credit-packs/:id', (req, res) => {
  const b = req.body || {};
  if (b.code !== ADMIN_CODE) return res.status(403).json({ error: 'Code admin incorrect.' });
  const pack = db.creditPackById(req.params.id);
  if (!pack) return res.status(404).json({ error: 'Pack introuvable.' });
  const patch = {};
  if (b.name !== undefined) {
    const name = String(b.name).trim();
    if (!name) return res.status(400).json({ error: 'Le nom ne peut pas être vide.' });
    patch.name = name;
  }
  if (b.creditsAmount !== undefined) patch.creditsAmount = Math.max(1, Number(b.creditsAmount) || 0);
  if (b.dustPrice !== undefined) patch.dustPrice = Math.max(1, Number(b.dustPrice) || 0);
  db.updateCreditPack(pack.id, patch);
  res.json({ ok: true, pack: db.creditPackById(pack.id) });
});

app.delete('/api/admin/credit-packs/:id', (req, res) => {
  if ((req.body || {}).code !== ADMIN_CODE) return res.status(403).json({ error: 'Code admin incorrect.' });
  if (!db.creditPackById(req.params.id)) return res.status(404).json({ error: 'Pack introuvable.' });
  db.removeCreditPack(req.params.id);
  res.json({ ok: true });
});

app.post('/api/shop/buy-credit-pack', requireAuth, (req, res) => {
  const pack = db.creditPackById((req.body || {}).packId);
  if (!pack) return res.status(400).json({ error: 'Pack introuvable.' });
  const user = ensureProfileFields(db.getUser(req.session.userSlug));
  if (user.dust < pack.dustPrice) return res.status(400).json({ error: `Il te manque ${pack.dustPrice - user.dust} poussière.` });
  user.dust -= pack.dustPrice;
  user.stats.dustSpent += pack.dustPrice;
  user.credits += pack.creditsAmount;
  const unlockedAchievements = awardAchievements(user);
  db.updateUser(user.slug, user);
  res.json({ ok: true, profile: decorateProfile(user), unlockedAchievements });
});

app.post('/api/shop/buy-emote', requireAuth, (req, res) => {
  const user = ensureProfileFields(db.getUser(req.session.userSlug));
  const emote = db.emoteById((req.body || {}).emoteId);
  if (!emote) return res.status(400).json({ error: 'Provocation inconnue.' });
  if (user.ownedEmotes.includes(emote.id)) return res.status(400).json({ error: 'Tu possèdes déjà cette provocation.' });
  if (user.dust < emote.price) return res.status(400).json({ error: `Il te manque ${emote.price - user.dust} poussière.` });
  user.dust -= emote.price;
  user.stats.dustSpent += emote.price;
  user.ownedEmotes.push(emote.id);
  const unlockedAchievements = awardAchievements(user);
  db.updateUser(user.slug, user);
  res.json({ ok: true, profile: decorateProfile(user), unlockedAchievements });
});

app.post('/api/me/emote-wheel', requireAuth, (req, res) => {
  const user = ensureProfileFields(db.getUser(req.session.userSlug));
  const wheel = (req.body || {}).wheel;
  if (!Array.isArray(wheel) || wheel.length !== EMOTE_WHEEL_SIZE) {
    return res.status(400).json({ error: `La roue doit contenir exactement ${EMOTE_WHEEL_SIZE} provocations.` });
  }
  for (const id of wheel) {
    if (!db.emoteById(id)) return res.status(400).json({ error: 'Provocation inconnue : ' + id });
    if (!user.ownedEmotes.includes(id)) return res.status(400).json({ error: 'Tu ne possèdes pas toutes ces provocations.' });
  }
  user.emoteWheel = wheel;
  db.updateUser(user.slug, user);
  res.json({ ok: true, profile: decorateProfile(user) });
});


app.post('/api/admin/emotes', requireAuth, (req, res) => {
  const b = req.body || {};
  if (b.code !== ADMIN_CODE) return res.status(403).json({ error: 'Code admin incorrect.' });
  const text = (b.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Le texte de la provocation est obligatoire.' });
  if (text.length > 60) return res.status(400).json({ error: 'Texte trop long (60 caractères maximum).' });
  const price = Math.max(0, Number(b.price) || 0);
  const tone = ['neutre', 'amical', 'piquant', 'fier'].includes(b.tone) ? b.tone : 'neutre';
  if (db.getEmotePool().some(e => e.text.toLowerCase() === text.toLowerCase())) {
    return res.status(409).json({ error: 'Une provocation avec ce texte existe déjà.' });
  }
  const emote = { id: 'e-' + uuidv4().slice(0, 8), text, price, tone };
  db.addEmote(emote);
  // Une provocation gratuite est immédiatement offerte à tout le monde
  if (price === 0) {
    db.allUsers().forEach(u => {
      if (!Array.isArray(u.ownedEmotes)) u.ownedEmotes = [];
      if (!u.ownedEmotes.includes(emote.id)) { u.ownedEmotes.push(emote.id); db.updateUser(u.slug, u); }
    });
  }
  res.json({ ok: true, emote });
});

app.patch('/api/admin/emotes/:id', requireAuth, (req, res) => {
  const b = req.body || {};
  if (b.code !== ADMIN_CODE) return res.status(403).json({ error: 'Code admin incorrect.' });
  const emote = db.emoteById(req.params.id);
  if (!emote) return res.status(404).json({ error: 'Provocation introuvable.' });

  const patch = {};
  if (b.price !== undefined && b.price !== null && b.price !== '') {
    const price = Number(b.price);
    if (!Number.isFinite(price) || price < 0) return res.status(400).json({ error: 'Prix invalide.' });
    patch.price = Math.floor(price);
  }
  if (b.text !== undefined) {
    const text = String(b.text).trim();
    if (!text) return res.status(400).json({ error: 'Le texte ne peut pas être vide.' });
    if (text.length > 60) return res.status(400).json({ error: 'Texte trop long (60 caractères maximum).' });
    const clash = db.getEmotePool().some(e => e.id !== emote.id && e.text.toLowerCase() === text.toLowerCase());
    if (clash) return res.status(409).json({ error: 'Une autre provocation utilise déjà ce texte.' });
    patch.text = text;
  }
  if (b.tone !== undefined && ['neutre', 'amical', 'piquant', 'fier'].includes(b.tone)) patch.tone = b.tone;
  if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'Rien à modifier.' });

  const wasFree = emote.price === 0;
  const updated = db.updateEmote(emote.id, patch);

  // Passage payant → gratuit : on l'offre à tout le monde, comme à la création
  if (!wasFree && updated.price === 0) {
    db.allUsers().forEach(u => {
      if (!Array.isArray(u.ownedEmotes)) u.ownedEmotes = [];
      if (!u.ownedEmotes.includes(updated.id)) { u.ownedEmotes.push(updated.id); db.updateUser(u.slug, u); }
    });
  }
  // Passage gratuit → payant : les joueurs qui l'avaient déjà la conservent
  res.json({ ok: true, emote: updated });
});

app.delete('/api/admin/emotes/:id', requireAuth, (req, res) => {
  if ((req.body || {}).code !== ADMIN_CODE) return res.status(403).json({ error: 'Code admin incorrect.' });
  const emote = db.emoteById(req.params.id);
  if (!emote) return res.status(404).json({ error: 'Provocation introuvable.' });
  db.removeEmote(req.params.id);
  // On la retire des collections et des roues, puis on recomplète les roues
  db.allUsers().forEach(u => { ensureProfileFields(u); db.updateUser(u.slug, u); });
  res.json({ ok: true });
});

/* ---------- Codex de collection ---------- */
app.get('/api/codex', requireAuth, (req, res) => {
  const user = ensureProfileFields(db.getUser(req.session.userSlug));
  const discovered = new Set(user.discoveredCards);
  const pool = db.getCardPool();
  const extensions = db.getExtensions();

  const byExtension = extensions.map(ext => {
    const cards = pool
      .filter(c => (c.extensionId || 'base') === ext.id)
      .map(c => {
        const isDiscovered = discovered.has(c.id);
        // Les cartes non découvertes sont renvoyées sans détails (pas de triche possible
        // en lisant la réponse réseau pour connaître le contenu d'une carte jamais obtenue)
        return isDiscovered
          ? Object.assign({}, c, { discovered: true, owned: user.collection[c.id] || 0 })
          : { id: c.id, rarity: c.rarity, type: c.type, discovered: false, owned: 0 };
      });
    const discoveredCount = cards.filter(c => c.discovered).length;
    return {
      id: ext.id, name: ext.name, totalCards: cards.length,
      discoveredCount, percent: cards.length ? Math.round((discoveredCount / cards.length) * 100) : 0,
      cards
    };
  });

  const totalCards = pool.length;
  const totalDiscovered = pool.filter(c => discovered.has(c.id)).length;
  res.json({
    extensions: byExtension,
    totalCards, totalDiscovered,
    totalPercent: totalCards ? Math.round((totalDiscovered / totalCards) * 100) : 0
  });
});

/* ---------- Admin : ornements de la boutique ---------- */
app.post('/api/admin/ornaments', (req, res) => {
  uploadCardImage.single('image')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    const b = req.body || {};
    if (b.code !== ADMIN_CODE) return res.status(403).json({ error: 'Code admin incorrect.' });
    const name = (b.name || '').trim();
    if (!name) return res.status(400).json({ error: "Le nom de l'ornement est obligatoire." });
    if (!req.file) return res.status(400).json({ error: 'Une image PNG est obligatoire pour un ornement personnalisé.' });
    const price = Math.max(0, Number(b.price) || 0);
    const ornament = {
      id: 'orn-' + uuidv4().slice(0, 8), name, price,
      css: null, image: '/uploads/cards/' + req.file.filename,
      desc: b.desc || 'Ornement personnalisé.'
    };
    db.addOrnament(ornament);
    res.json({ ok: true, ornament });
  });
});

app.patch('/api/admin/ornaments/:id', (req, res) => {
  const b = req.body || {};
  if (b.code !== ADMIN_CODE) return res.status(403).json({ error: 'Code admin incorrect.' });
  const orn = db.ornamentById(req.params.id);
  if (!orn) return res.status(404).json({ error: 'Ornement introuvable.' });
  const patch = {};
  if (b.name !== undefined) {
    const name = String(b.name).trim();
    if (!name) return res.status(400).json({ error: 'Le nom ne peut pas être vide.' });
    patch.name = name;
  }
  if (b.price !== undefined) {
    const price = Number(b.price);
    if (!Number.isFinite(price) || price < 0) return res.status(400).json({ error: 'Prix invalide.' });
    patch.price = price;
  }
  const updated = db.updateOrnament(orn.id, patch);
  res.json({ ok: true, ornament: updated });
});

app.delete('/api/admin/ornaments/:id', (req, res) => {
  if ((req.body || {}).code !== ADMIN_CODE) return res.status(403).json({ error: 'Code admin incorrect.' });
  if (req.params.id === 'none') return res.status(400).json({ error: "L'ornement « Aucun » ne peut pas être supprimé." });
  db.removeOrnament(req.params.id);
  // Les joueurs qui l'avaient équipé retombent sur "aucun ornement"
  db.allUsers().forEach(u => {
    if (u.ornament === req.params.id) { u.ornament = 'none'; db.updateUser(u.slug, u); }
  });
  res.json({ ok: true });
});

/* ---------- Deck ---------- */
/* Valide un deck de 30 cartes : possession suffisante + limites de copies.
   Réutilisé par le deck actif et par la bibliothèque de decks nommés. */
function validateDeckCards(cardIds, user) {
  if (!Array.isArray(cardIds) || cardIds.length !== DECK_SIZE) {
    return { error: `Le deck doit contenir exactement ${DECK_SIZE} cartes.` };
  }
  const counts = {};
  cardIds.forEach(id => { counts[id] = (counts[id] || 0) + 1; });
  for (const id of Object.keys(counts)) {
    const card = db.cardById(id);
    if (!card) return { error: `Carte inconnue : ${id}` };
    const owned = user.collection[id] || 0;
    if (counts[id] > owned) return { error: `Tu ne possèdes pas assez de "${card.name}".` };
    const limit = COPY_LIMITS[card.rarity] || 2;
    if (counts[id] > limit) return { error: `Maximum ${limit} exemplaire(s) de "${card.name}".` };
  }
  return { ok: true };
}

app.get('/api/deck', requireAuth, (req, res) => {
  const user = db.getUser(req.session.userSlug);
  res.json({ deck: user.deck, collection: user.collection });
});

app.post('/api/deck', requireAuth, (req, res) => {
  const user = ensureProfileFields(db.getUser(req.session.userSlug));
  const { cardIds } = req.body || {};
  const check = validateDeckCards(cardIds, user);
  if (check.error) return res.status(400).json({ error: check.error });
  user.deck = cardIds;
  // Cette sauvegarde rapide ne correspond à aucun deck nommé précis (elle ne
  // touche jamais savedDecks) — si le deck actuellement actif était un deck
  // nommé, ce lien devient incertain dès qu'on modifie le contenu sans passer
  // par ce deck nommé, donc on le retire plutôt que de laisser une
  // correspondance qui pourrait être fausse.
  user.activeDeckId = null;
  db.updateUser(user.slug, user);
  res.json({ ok: true });
});

/* ---------- Bibliothèque de decks nommés ---------- */
const MAX_SAVED_DECKS = 12;

app.get('/api/decks', requireAuth, (req, res) => {
  const user = ensureProfileFields(db.getUser(req.session.userSlug));
  res.json({ decks: user.savedDecks, activeDeck: user.deck, activeDeckId: user.activeDeckId });
});

app.post('/api/decks', requireAuth, (req, res) => {
  const user = ensureProfileFields(db.getUser(req.session.userSlug));
  const { name, cardIds } = req.body || {};
  const cleanName = String(name || '').trim().slice(0, 40);
  if (!cleanName) return res.status(400).json({ error: 'Donne un nom à ton deck.' });
  if (user.savedDecks.length >= MAX_SAVED_DECKS) return res.status(400).json({ error: `Maximum ${MAX_SAVED_DECKS} decks enregistrés.` });
  const check = validateDeckCards(cardIds, user);
  if (check.error) return res.status(400).json({ error: check.error });
  const deck = { id: 'deck-' + uuidv4().slice(0, 8), name: cleanName, cardIds, createdAt: Date.now() };
  user.savedDecks.push(deck);
  user.deck = cardIds; // enregistrer un deck l'active aussi, pour rester cohérent avec l'ancien comportement
  user.activeDeckId = deck.id;
  db.updateUser(user.slug, user);
  res.json({ ok: true, deck });
});

app.patch('/api/decks/:id', requireAuth, (req, res) => {
  const user = ensureProfileFields(db.getUser(req.session.userSlug));
  const deck = user.savedDecks.find(d => d.id === req.params.id);
  if (!deck) return res.status(404).json({ error: 'Deck introuvable.' });
  const b = req.body || {};
  if (b.name !== undefined) {
    const cleanName = String(b.name).trim().slice(0, 40);
    if (!cleanName) return res.status(400).json({ error: 'Le nom ne peut pas être vide.' });
    deck.name = cleanName;
  }
  if (b.cardIds !== undefined) {
    const check = validateDeckCards(b.cardIds, user);
    if (check.error) return res.status(400).json({ error: check.error });
    deck.cardIds = b.cardIds;
    // Si c'est justement le deck actif qu'on modifie, le deck en jeu doit suivre —
    // sinon le deck "actif" affiché ne correspondrait plus à ce que la carte contient.
    if (user.activeDeckId === deck.id) user.deck = deck.cardIds;
  }
  db.updateUser(user.slug, user);
  res.json({ ok: true, deck });
});

app.post('/api/decks/:id/activate', requireAuth, (req, res) => {
  const user = ensureProfileFields(db.getUser(req.session.userSlug));
  const deck = user.savedDecks.find(d => d.id === req.params.id);
  if (!deck) return res.status(404).json({ error: 'Deck introuvable.' });
  // On revalide au moment d'activer : la collection a pu changer depuis l'enregistrement
  // (cartes désenchantées ou échangées), un deck sauvegardé peut donc devenir invalide entretemps.
  const check = validateDeckCards(deck.cardIds, user);
  if (check.error) return res.status(400).json({ error: `Ce deck n'est plus valide : ${check.error}` });
  user.deck = deck.cardIds;
  user.activeDeckId = deck.id;
  db.updateUser(user.slug, user);
  res.json({ ok: true });
});

app.delete('/api/decks/:id', requireAuth, (req, res) => {
  const user = ensureProfileFields(db.getUser(req.session.userSlug));
  const before = user.savedDecks.length;
  user.savedDecks = user.savedDecks.filter(d => d.id !== req.params.id);
  if (user.savedDecks.length === before) return res.status(404).json({ error: 'Deck introuvable.' });
  // Le deck supprimé n'est plus un deck nommé, mais ses cartes restent jouées
  // tant qu'on n'en active pas un autre — seul le LIEN vers ce deck nommé disparaît.
  if (user.activeDeckId === req.params.id) user.activeDeckId = null;
  db.updateUser(user.slug, user);
  res.json({ ok: true });
});

/* Fait jouer le bot une action à la fois : état envoyé après chaque carte
   jouée ou attaque, avec une pause qui laisse le temps aux animations de
   combat (charge, impact, mort) de se jouer chez le joueur. */
const BOT_STEP_DELAY = { play: 1100, attack: 1000 };
function runBotTurnAnimated(found) {
  const entry = found.entry;
  if (entry.botTurnRunning) return; // un seul tour du bot à la fois
  entry.botTurnRunning = true;
  const it = bot.botTurnSteps(entry.match, db.getCardPool());
  const step = () => {
    let r;
    try { r = it.next(); } catch (e) { console.error('Tour du bot :', e.message); r = { done: true }; }
    mm.broadcastState(found.matchId, db.getCardPool(), io);
    if (r.done || entry.match.status !== 'active') { entry.botTurnRunning = false; return; }
    setTimeout(step, BOT_STEP_DELAY[r.value] || 900);
  };
  setTimeout(step, 650);
}

/* ---------- Joueurs / amis ---------- */
app.get('/api/players', requireAuth, (req, res) => {
  const list = db.allUsers()
    .filter(u => u.slug !== req.session.userSlug)
    .map(u => ({ slug: u.slug, pseudo: u.pseudo, avatar: u.avatar || null, ornament: u.ornament || 'none', online: mm.isOnline(u.slug), rank: rankFor(u.seasonVP || 0) }));
  res.json({ players: list });
});

app.get('/api/players/:slug', requireAuth, (req, res) => {
  const u = db.getUser(req.params.slug);
  if (!u) return res.status(404).json({ error: 'Joueur introuvable.' });
  ensureProfileFields(u);
  const defs = db.getAchievements();
  const showcase = (u.achievementShowcase || [])
    .map(id => defs.find(d => d.id === id))
    .filter(Boolean)
    .map(d => ({ id: d.id, name: d.name, icon: d.icon || null }));
  res.json({
    pseudo: u.pseudo, slug: u.slug, collection: u.collection, bio: u.bio || '', cardShowcase: u.cardShowcase || [],
    avatar: u.avatar, ornament: u.ornament, online: mm.isOnline(u.slug),
    rank: rankFor(u.seasonVP), seasonVP: u.seasonVP, seasonWins: u.seasonWins, seasonLosses: u.seasonLosses,
    achievementShowcase: showcase
  });
});

app.post('/api/players/:slug/friend', requireAuth, (req, res) => {
  const me = db.getUser(req.session.userSlug);
  const other = db.getUser(req.params.slug);
  if (!other) return res.status(404).json({ error: 'Joueur introuvable.' });
  const isFriend = me.friends.includes(other.slug);
  if (isFriend) {
    me.friends = me.friends.filter(s => s !== other.slug);
    other.friends = other.friends.filter(s => s !== me.slug);
  } else {
    me.friends.push(other.slug);
    if (!other.friends.includes(me.slug)) other.friends.push(me.slug);
  }
  db.updateUser(me.slug, me);
  db.updateUser(other.slug, other);
  res.json({ ok: true, isFriend: !isFriend });
});

app.get('/api/friends', requireAuth, (req, res) => {
  const me = ensureProfileFields(db.getUser(req.session.userSlug));
  const friends = (me.friends || []).map(slug => {
    const u = db.getUser(slug);
    if (!u) return null;
    ensureProfileFields(u);
    return {
      slug: u.slug, pseudo: u.pseudo, avatar: u.avatar, ornament: u.ornament,
      online: mm.isOnline(u.slug), rank: rankFor(u.seasonVP), seasonVP: u.seasonVP
    };
  }).filter(Boolean);
  res.json({ friends });
});

/* ---------- Classement ---------- */
app.get('/api/leaderboard', requireAuth, (req, res) => {
  ranking.closeSeasonIfNeeded(db);
  const board = ranking.buildLeaderboard(db.allUsers().map(ensureProfileFields));
  const meta = db.getMeta();
  const myIndex = board.findIndex(e => e.slug === req.session.userSlug);
  res.json({
    season: ranking.currentSeason(),
    leaderboard: board.slice(0, 50),
    myPosition: myIndex >= 0 ? myIndex + 1 : null,
    rewards: MONTHLY_REWARDS,
    history: (meta.seasonHistory || []).slice(0, 3)
  });
});

/* ---------- Échanges ---------- */
app.get('/api/trade', requireAuth, (req, res) => {
  const mySlug = req.session.userSlug;
  const all = db.getTrades();
  res.json({ received: all.filter(t => t.toSlug === mySlug), sent: all.filter(t => t.fromSlug === mySlug) });
});

app.post('/api/trade/request', requireAuth, (req, res) => {
  const me = db.getUser(req.session.userSlug);
  const { toSlug, offerCardIds, requestCardIds } = req.body || {};
  const other = db.getUser(toSlug);
  if (!other) return res.status(404).json({ error: 'Joueur introuvable.' });
  if (other.slug === me.slug) return res.status(400).json({ error: 'Tu ne peux pas échanger avec toi-même.' });

  const offers = Array.isArray(offerCardIds) ? offerCardIds.filter(Boolean) : [];
  const requests = Array.isArray(requestCardIds) ? requestCardIds.filter(Boolean) : [];
  if (offers.length === 0 && requests.length === 0) return res.status(400).json({ error: 'Choisis au moins une carte, à offrir ou à demander.' });
  if (offers.length > 10 || requests.length > 10) return res.status(400).json({ error: 'Maximum 10 cartes de chaque côté.' });

  // Vérifie que je possède bien tout ce que je propose (en tenant compte des doublons)
  const offerCounts = {};
  offers.forEach(id => { offerCounts[id] = (offerCounts[id] || 0) + 1; });
  for (const id of Object.keys(offerCounts)) {
    if ((me.collection[id] || 0) < offerCounts[id]) {
      const card = db.cardById(id);
      return res.status(400).json({ error: `Tu ne possèdes pas assez de "${card ? card.name : id}".` });
    }
  }
  const offerCards = offers.map(id => { const c = db.cardById(id); return c ? { cardId: id, name: c.name } : null; });
  const requestCards = requests.map(id => { const c = db.cardById(id); return c ? { cardId: id, name: c.name } : null; });
  if (offerCards.some(c => !c) || requestCards.some(c => !c)) return res.status(400).json({ error: 'Carte inconnue.' });

  const trade = {
    id: 't-' + uuidv4().slice(0, 8), fromSlug: me.slug, fromPseudo: me.pseudo,
    toSlug: other.slug, toPseudo: other.pseudo,
    offerCards, requestCards,
    status: 'pending', createdAt: Date.now()
  };
  db.addTrade(trade);
  const sock = mm.socketFor(other.slug);
  if (sock) sock.emit('trade:incoming', trade);
  res.json({ ok: true, trade });
});

app.post('/api/trade/:id/accept', requireAuth, (req, res) => {
  const mySlug = req.session.userSlug;
  const trade = db.getTrades().find(t => t.id === req.params.id);
  if (!trade || trade.toSlug !== mySlug || trade.status !== 'pending') return res.status(400).json({ error: 'Demande invalide.' });
  const me = db.getUser(mySlug);
  const requester = db.getUser(trade.fromSlug);

  // Compte les besoins de chaque côté (au cas où plusieurs exemplaires de la même carte sont demandés/offerts)
  const requestCounts = {};
  (trade.requestCards || []).forEach(c => { requestCounts[c.cardId] = (requestCounts[c.cardId] || 0) + 1; });
  const offerCounts = {};
  (trade.offerCards || []).forEach(c => { offerCounts[c.cardId] = (offerCounts[c.cardId] || 0) + 1; });

  const iHaveEverything = Object.keys(requestCounts).every(id => (me.collection[id] || 0) >= requestCounts[id]);
  const theyHaveEverything = Object.keys(offerCounts).every(id => (requester.collection[id] || 0) >= offerCounts[id]);
  if (!iHaveEverything || !theyHaveEverything) {
    trade.status = 'invalide'; db.saveTradesNow();
    return res.status(400).json({ error: "Une des cartes de l'échange n'est plus disponible." });
  }

  // Transfert : mes cartes demandées partent vers le demandeur, ses cartes offertes viennent à moi
  Object.keys(requestCounts).forEach(id => {
    me.collection[id] -= requestCounts[id];
    if (me.collection[id] <= 0) delete me.collection[id];
    requester.collection[id] = (requester.collection[id] || 0) + requestCounts[id];
  });
  Object.keys(offerCounts).forEach(id => {
    requester.collection[id] -= offerCounts[id];
    if (requester.collection[id] <= 0) delete requester.collection[id];
    me.collection[id] = (me.collection[id] || 0) + offerCounts[id];
  });

  markDiscovered(me, Object.keys(offerCounts));
  markDiscovered(requester, Object.keys(requestCounts));
  ensureProfileFields(me); ensureProfileFields(requester);
  const unlockedMe = awardAchievements(me);
  const unlockedRequester = awardAchievements(requester);
  db.updateUser(me.slug, me);
  db.updateUser(requester.slug, requester);
  trade.status = 'accepté';
  db.saveTradesNow();
  res.json({ ok: true, unlockedAchievements: unlockedMe });
});

app.post('/api/trade/:id/decline', requireAuth, (req, res) => {
  const trade = db.getTrades().find(t => t.id === req.params.id);
  if (!trade || trade.toSlug !== req.session.userSlug || trade.status !== 'pending') return res.status(400).json({ error: 'Demande invalide.' });
  trade.status = 'refusé'; db.saveTradesNow();
  res.json({ ok: true });
});

app.post('/api/trade/:id/cancel', requireAuth, (req, res) => {
  const trade = db.getTrades().find(t => t.id === req.params.id);
  if (!trade || trade.fromSlug !== req.session.userSlug || trade.status !== 'pending') return res.status(400).json({ error: 'Demande invalide.' });
  trade.status = 'annulé'; db.saveTradesNow();
  res.json({ ok: true });
});

/* ---------- Socket.io : file d'attente, défis, combat ---------- */
function buildPlayerInfo(slug) {
  const u = db.getUser(slug);
  if (!u) return null;
  ensureProfileFields(u);
  if (!Array.isArray(u.deck) || u.deck.length !== DECK_SIZE) return null;
  return { slug: u.slug, pseudo: u.pseudo, avatar: u.avatar, ornament: u.ornament, deck: u.deck.slice(), emoteWheel: u.emoteWheel.slice() };
}

/* Attribue victoire/défaite et points de victoire à la fin d'un match. */
function settleMatch(match, vpGain) {
  // Les combats d'entraînement contre le bot ne comptent jamais pour le
  // classement ni la poussière (sinon on pourrait en abuser pour en farmer).
  if (match.players.some(p => p.slug === 'bot')) return null;

  // Stats des cartes : chaque carte jouée dans cette partie JcJ compte une
  // partie, et une victoire si celui qui l'a jouée a gagné.
  try {
    db.recordMatchCards(ranking.currentSeason(), match.players.map(p => ({
      cardIds: (match.cardsPlayedBy && match.cardsPlayedBy[p.slug]) || [],
      won: match.winner === p.slug
    })));
  } catch (e) { console.error('Stats cartes :', e.message); }

  let settleResult = null;
  const achievementsPerSlug = {};
  match.players.forEach(p => {
    const user = db.getUser(p.slug);
    if (!user) return;
    ensureProfileFields(user);
    if (match.winner === null) {
      // égalité : rien
    } else if (match.winner === p.slug) {
      user.seasonWins += 1;
      user.seasonVP += vpGain;
      user.dust += 20; // petite récompense de victoire
      user.stats.totalWins += 1;
      const opponentSlug = match.players.find(x => x.slug !== p.slug).slug;
      user.stats.winsVsPlayer[opponentSlug] = (user.stats.winsVsPlayer[opponentSlug] || 0) + 1;
      trackRankReached(user);

      // Chance (réglable en admin) d'obtenir un booster bonus en gagnant
      const chance = db.getSettings().matchDropChance || 0;
      if (Math.random() * 100 < chance) {
        const eligible = db.getExtensions().filter(e => e.matchDropEligible === true);
        const candidates = eligible.filter(e => db.getCardPool().some(c => (c.extensionId || 'base') === e.id));
        if (candidates.length > 0) {
          const ext = candidates[Math.floor(Math.random() * candidates.length)];
          const pool = db.getCardPool().filter(c => (c.extensionId || 'base') === ext.id);
          const drawn = [];
          for (let i = 0; i < 5; i++) drawn.push(weightedPick(pool));
          drawn.forEach(c => { user.collection[c.id] = (user.collection[c.id] || 0) + 1; });
          markDiscovered(user, drawn.map(c => c.id));
          settleResult = { winnerSlug: p.slug, bonusBooster: { extensionName: ext.name, cards: drawn } };
        }
      }
    } else {
      user.seasonLosses += 1;
    }
    const unlocked = awardAchievements(user);
    if (unlocked.length > 0) achievementsPerSlug[user.slug] = unlocked;
    db.updateUser(user.slug, user);
  });
  if (Object.keys(achievementsPerSlug).length > 0) {
    settleResult = settleResult || {};
    settleResult.achievementsPerSlug = achievementsPerSlug;
  }
  return settleResult;
}

/* Règlement d'un combat de boss d'événement : pas d'impact sur le classement
   saisonnier (ni victoires ni points), seulement la récompense de l'event si
   le joueur gagne. La limite d'une tentative par jour est déjà posée au
   LANCEMENT du combat (pas ici), pour empêcher de relancer le même jour même
   après une défaite. */
function settleBossMatch(match) {
  const human = match.players.find(p => p.slug !== 'boss');
  if (!human) return null;
  const user = db.getUser(human.slug);
  if (!user) return null;
  ensureProfileFields(user);
  if (match.winner !== human.slug) return null; // défaite ou égalité : rien à régler
  const events = db.getEvents();
  const rewardDust = events.boss.rewardDust || 0;
  const rewardCredits = events.boss.rewardCredits || 0;
  user.dust += rewardDust;
  user.credits += rewardCredits;
  user.stats.bossDefeats += 1;
  const unlocked = awardAchievements(user);
  db.updateUser(user.slug, user);
  const result = { winnerSlug: human.slug, bossReward: { dust: rewardDust, credits: rewardCredits } };
  if (unlocked.length > 0) result.achievementsPerSlug = { [human.slug]: unlocked };
  return result;
}

io.on('connection', (socket) => {
  const session = socket.request.session;
  const userSlug = session && session.userSlug;
  if (!userSlug) { socket.disconnect(); return; }
  const user = db.getUser(userSlug);
  if (!user) { socket.disconnect(); return; }
  mm.registerOnline(socket, userSlug);
  const me = () => db.getUser(userSlug) || { pseudo: '?' };

  socket.on('queue:join', () => {
    const info = buildPlayerInfo(userSlug);
    if (!info) { socket.emit('queue:error', { error: `Configure un deck de ${DECK_SIZE} cartes avant de combattre.` }); return; }
    mm.joinQueue(socket, info, db.getCardPool(), io, settleMatch);
  });

  socket.on('queue:leave', () => mm.leaveQueue(socket));

  socket.on('admin:botMatch', ({ code }) => {
    if (code !== ADMIN_CODE) { socket.emit('queue:error', { error: 'Code admin incorrect.' }); return; }
    const pool = db.getCardPool();
    if (pool.length < 5) { socket.emit('queue:error', { error: 'Pas assez de cartes dans le pool pour composer un deck de test.' }); return; }
    const adminInfo = { slug: userSlug, pseudo: user.pseudo, avatar: user.avatar, ornament: user.ornament, deck: bot.buildTestDeck(pool) };
    const botInfo = { slug: 'bot', pseudo: 'Bot (entraînement)', avatar: null, ornament: 'none', deck: bot.buildTestDeck(pool) };
    mm.startBotMatch(socket, adminInfo, botInfo, pool, io);
  });

  socket.on('boss:start', () => {
    const events = db.getEvents();
    if (!events.tabEnabled || !isEventActive(events.boss)) { socket.emit('queue:error', { error: "L'événement boss n'est pas disponible pour le moment." }); return; }
    const fresh = db.getUser(userSlug);
    ensureProfileFields(fresh);
    const today = new Date().toDateString();
    if (fresh.lastBossFight && new Date(fresh.lastBossFight).toDateString() === today) {
      socket.emit('queue:error', { error: 'Tu as déjà affronté le boss aujourd\'hui — reviens demain !' });
      return;
    }
    const pool = db.getCardPool();
    if (pool.length < 5) { socket.emit('queue:error', { error: 'Pas assez de cartes dans le pool pour composer le deck du boss.' }); return; }
    // La tentative du jour est consommée dès le LANCEMENT du combat, pas seulement en cas
    // de victoire — sinon un joueur pourrait abandonner une partie perdante et retenter aussitôt.
    fresh.lastBossFight = new Date().toISOString();
    db.updateUser(fresh.slug, fresh);
    const playerInfo = { slug: userSlug, pseudo: fresh.pseudo, avatar: fresh.avatar, ornament: fresh.ornament, deck: fresh.deck };
    // Deck personnalisé par l'admin si configuré (au moins 4 cartes, la taille de la main de départ),
    // sinon un deck aléatoire dans tout le pool comme pour le bot d'entraînement.
    const bossDeck = Array.isArray(events.boss.deckCardIds) && events.boss.deckCardIds.length >= 4
      ? events.boss.deckCardIds : bot.buildTestDeck(pool);
    const bossInfo = { slug: 'boss', pseudo: events.boss.name, avatar: events.boss.image, ornament: 'none', deck: bossDeck };
    const matchId = mm.startBotMatch(socket, playerInfo, bossInfo, pool, io, settleBossMatch, {
      isBossFight: true, opponentHeroHealth: Math.max(1, Number(events.boss.heroHealth) || 60)
    });
  });

  socket.on('challenge:send', ({ toSlug }) => {
    const info = buildPlayerInfo(userSlug);
    if (!info) { socket.emit('queue:error', { error: `Configure un deck de ${DECK_SIZE} cartes avant de défier quelqu'un.` }); return; }
    const me = db.getUser(userSlug);
    if (!me.friends.includes(toSlug)) { socket.emit('queue:error', { error: 'Tu ne peux défier que tes amis.' }); return; }
    const r = mm.createChallenge(info, toSlug);
    if (r.error) socket.emit('queue:error', r);
    else socket.emit('challenge:sent', { toSlug });
  });

  socket.on('challenge:accept', ({ challengeId }) => {
    const info = buildPlayerInfo(userSlug);
    if (!info) { socket.emit('queue:error', { error: `Configure un deck de ${DECK_SIZE} cartes avant de combattre.` }); return; }
    const r = mm.acceptChallenge(challengeId, info, socket, buildPlayerInfo, db.getCardPool(), io, settleMatch);
    if (r.error) socket.emit('queue:error', r);
  });

  socket.on('challenge:decline', ({ challengeId }) => mm.declineChallenge(challengeId, userSlug));


  let lastEmoteAt = 0;
  socket.on('emote:send', ({ emoteId }) => {
    const found = mm.getMatchForSocket(socket);
    if (!found) return;
    const now = Date.now();
    if (now - lastEmoteAt < EMOTE_COOLDOWN_MS) return; // anti-spam
    const me = ensureProfileFields(db.getUser(userSlug));
    if (!me.emoteWheel.includes(emoteId)) return;   // seulement depuis sa propre roue
    const emote = db.emoteById(emoteId);
    if (!emote) return;
    lastEmoteAt = now;
    const payload = { fromSlug: userSlug, fromPseudo: me.pseudo, emoteId, text: emote.text, at: now };
    found.entry.sockets.forEach(s => s.emit('emote:shown', payload));
  });

  socket.on('action:play', ({ cardId, targetType, targetId }) => {
    const found = mm.getMatchForSocket(socket);
    if (!found) return;
    const result = game.playCard(found.entry.match, db.getCardPool(), found.playerIndex, cardId, { targetType, targetId });
    if (result.error) { socket.emit('action:error', result); }
    else {
      // La carte est bien posée : si elle a un son personnalisé, les deux joueurs l'entendent ;
      // sinon on joue un petit son générique plutôt que rien du tout.
      const card = db.cardById(cardId);
      if (card && card.sound) {
        const payload = { cardId: card.id, name: card.name, sound: card.sound, byPseudo: me().pseudo, at: Date.now() };
        found.entry.sockets.forEach(s => s.emit('card:sound', payload));
      } else if (card) {
        found.entry.sockets.forEach(s => s.emit('card:play-default', { cardId: card.id }));
      }
      // Statistiques mensuelles des cartes (page Admin → Stats) : seuls les vrais
      // joueurs passent par ici, les coups du bot/boss ne sont jamais comptés.
      if (card) {
        const now = new Date();
        db.recordCardPlay(card, ranking.currentSeason(now), String(now.getDate()), !!found.entry.isBot);
        const m = found.entry.match;
        if (!m.cardsPlayedBy) m.cardsPlayedBy = {};
        if (!m.cardsPlayedBy[userSlug]) m.cardsPlayedBy[userSlug] = [];
        if (!m.cardsPlayedBy[userSlug].includes(card.id)) m.cardsPlayedBy[userSlug].push(card.id);
      }
      // Suivi des succès liés aux cartes jouées (seul un vrai joueur connecté déclenche
      // cet événement — les coups du bot/boss passent directement par game.playCard sans socket).
      if (card) {
        const statUser = db.getUser(userSlug);
        if (statUser) {
          ensureProfileFields(statUser);
          statUser.stats.cardsPlayedByType[card.type] = (statUser.stats.cardsPlayedByType[card.type] || 0) + 1;
          statUser.stats.cardsPlayedById[card.id] = (statUser.stats.cardsPlayedById[card.id] || 0) + 1;
          const unlocked = awardAchievements(statUser);
          db.updateUser(statUser.slug, statUser);
          unlocked.forEach(a => socket.emit('achievement:unlocked', a));
        }
      }
    }
    mm.broadcastState(found.matchId, db.getCardPool(), io);
    const found2 = mm.getMatchForSocket(socket);
    if (found2 && found2.entry.isBot && found2.entry.match.status === 'active' && found2.entry.match.turn === 1) {
      runBotTurnAnimated(found2);
    }
  });

  socket.on('action:attack', ({ attackerId, targetType, targetId }) => {
    const found = mm.getMatchForSocket(socket);
    if (!found) return;
    const result = game.attack(found.entry.match, found.playerIndex, attackerId, targetType, targetId);
    if (result.error) socket.emit('action:error', result);
    mm.broadcastState(found.matchId, db.getCardPool(), io);
    const found2 = mm.getMatchForSocket(socket);
    if (found2 && found2.entry.isBot && found2.entry.match.status === 'active' && found2.entry.match.turn === 1) {
      runBotTurnAnimated(found2);
    }
  });

  socket.on('action:mulligan', ({ cardIds }) => {
    const found = mm.getMatchForSocket(socket);
    if (!found) return;
    const result = game.submitMulligan(found.entry.match, found.playerIndex, cardIds);
    if (result.error) { socket.emit('action:error', result); return; }
    mm.broadcastState(found.matchId, db.getCardPool(), io);
    // Si l'adversaire est le bot, il valide sa propre main immédiatement après celle de l'admin
    const found2 = mm.getMatchForSocket(socket);
    if (found2 && found2.entry.isBot && found2.entry.match.phase === 'mulligan' && !found2.entry.match.mulliganDone[1]) {
      const botMulligan = bot.chooseMulligan(found2.entry.match, db.getCardPool());
      game.submitMulligan(found2.entry.match, 1, botMulligan);
      mm.broadcastState(found2.matchId, db.getCardPool(), io);
    }
  });

  socket.on('action:forfeit', () => {
    const found = mm.getMatchForSocket(socket);
    if (!found || found.entry.match.status !== 'active') return;
    const match = found.entry.match;
    const me2 = match.players[found.playerIndex];
    const opp2 = match.players[1 - found.playerIndex];
    match.status = 'finished';
    match.winner = found.entry.isBot ? null : opp2.slug; // pas de "vainqueur" contre le bot, juste une fin de partie
    match.log.push(`${me2.pseudo} abandonne la partie.`);
    mm.broadcastState(found.matchId, db.getCardPool(), io);
  });

  socket.on('action:endTurn', () => {
    const found = mm.getMatchForSocket(socket);
    if (!found) return;
    game.endTurn(found.entry.match);
    mm.broadcastState(found.matchId, db.getCardPool(), io);
    const found2 = mm.getMatchForSocket(socket);
    if (found2 && found2.entry.isBot && found2.entry.match.status === 'active' && found2.entry.match.turn === 1) {
      runBotTurnAnimated(found2);
    }
  });

  socket.on('disconnect', () => mm.handleDisconnect(socket, userSlug, db.getCardPool(), io));
});

server.listen(PORT, () => {
  console.log(`Clean Gang Decks lancé sur http://localhost:${PORT}`);
});

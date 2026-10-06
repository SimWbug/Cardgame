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
  RANKS, rankFor, nextRankFor, MONTHLY_REWARDS, buildStarterCollection, RANKING_DEFAULTS, setRankThresholds,
  EMOTE_WHEEL_SIZE, EMOTE_COOLDOWN_MS, freeEmotesFrom, defaultWheelFrom,
  DEFAULT_DROP_WEIGHT, MIN_DROP_WEIGHT, MAX_DROP_WEIGHT
} = require('./src/cards');
const game = require('./src/game');
const mm = require('./src/matchmaking');
const push = require('./src/push');
const survival = require('./src/survival');
const draft = require('./src/draft');
const boards = require('./src/boards');
const puzzle = require('./src/puzzle');
const brawl = require('./src/brawl');
const community = require('./src/community');
const banners = require('./src/banners');
const secrets = require('./src/secrets');
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
// Pages, scripts et styles du jeu toujours revérifiés auprès du serveur : après
// une mise à jour, le navigateur ne garde pas l'ancienne version en cache (un
// vieux app.js face au nouveau serveur peut rendre des cartes injouables).
app.use(express.static('public', {
  setHeaders: (res, filePath) => {
    if (/\.(html|js|css|webmanifest)$/i.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
  }
}));
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
fs.mkdirSync(path.join(UPLOAD_ROOT, 'boards'), { recursive: true });

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
function makeAudioUploader(subdir, maxMb) {
  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(UPLOAD_ROOT, subdir)),
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname) || '.mp3').toLowerCase();
      cb(null, uuidv4().slice(0, 12) + ext);
    }
  });
  return multer({
    storage,
    limits: { fileSize: (maxMb || 2) * 1024 * 1024 }, // 2 Mo pour un son court, plus pour une musique
    fileFilter: (req, file, cb) => {
      const ok = ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/webm', 'audio/mp4', 'audio/aac'].includes(file.mimetype);
      cb(ok ? null : new Error('Format audio non supporté (MP3, WAV, OGG, WEBP audio, M4A ou AAC).'), ok);
    }
  });
}

const uploadCardImage = makeUploader('cards');
const uploadCardSound = makeAudioUploader('sounds');
const uploadAvatar = makeUploader('avatars');
/* Images de plateau : grandes (2480×2008 conseillé), donc jusqu'à 15 Mo */
const uploadBoard = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(UPLOAD_ROOT, 'boards')),
    filename: (req, file, cb) => cb(null, 'board-' + uuidv4().slice(0, 10) + ((path.extname(file.originalname) || '.png').toLowerCase()))
  }),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ['image/png', 'image/jpeg', 'image/webp'].includes(file.mimetype);
    cb(ok ? null : new Error('Format non supporté (PNG, JPG ou WEBP).'), ok);
  }
});
const uploadBrandingImage = makeUploader('branding');
const uploadBrandingSound = makeAudioUploader('branding');
const uploadMusic = makeAudioUploader('branding', 12); // musiques de fond : 12 Mo max

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

/* Limite d'exemplaires par rareté appliquée aux decks d'un joueur : si une
   carte change de rareté (ex. rare → légendaire), les exemplaires en trop
   sortent de son deck actif et de ses decks enregistrés. Le deck passe alors
   sous 30 cartes et le joueur doit le compléter avant de combattre. */
function enforceDeckLimits(user) {
  let changed = false;
  const trim = list => {
    const seen = {};
    const out = (list || []).filter(id => {
      const card = db.cardById(id);
      const limit = card ? (COPY_LIMITS[card.rarity] || 2) : Infinity;
      seen[id] = (seen[id] || 0) + 1;
      return seen[id] <= limit;
    });
    if (out.length !== (list || []).length) changed = true;
    return out;
  };
  if (Array.isArray(user.deck)) user.deck = trim(user.deck);
  (user.savedDecks || []).forEach(d => { d.cardIds = trim(d.cardIds); });
  return changed;
}

function ensureProfileFields(user) {
  if (user.dust === undefined) user.dust = 0;
  progression.ensure(user); progression.ensureDaily(user);
  enforceDeckLimits(user);
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
  banners.ensure(user); secrets.ensure(user); survival.ensure(user); draft.ensure(user); boards.ensure(user); puzzle.ensureUser(user); brawl.ensure(user);
  if (!Array.isArray(user.favoriteCards)) user.favoriteCards = [];
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
  const unlocked = achievementsEngine.checkAchievements(user, db.getAchievements(), { cardPool: db.getCardPool() });
  // Chaque succès débloqué rapporte aussi de l'XP de compte
  if (Array.isArray(unlocked) && unlocked.length) progression.grantXp(user, progression.XP.achievement * unlocked.length, 'succès', applyLevelReward);
  return unlocked;
}

/* ---------- Progression : niveaux, défis du jour, évolution des cartes ---------- */
const progression = require('./src/progression');
// Contours exclusifs de niveau : créés une fois, jamais vendus en boutique
progression.LEVEL_ORNAMENTS.forEach(o => {
  const cur = db.ornamentById(o.id);
  if (!cur) db.addOrnament({ id: o.id, name: o.name, price: 0, css: o.css, desc: o.desc, levelOnly: true });
  else if (cur.levelOnly && (cur.css !== o.css || cur.desc !== o.desc)) db.updateOrnament(o.id, { css: o.css, desc: o.desc });
});
/* Récompenses de niveau modifiables par l'admin (data/level-rewards.json) */
const LEVEL_REWARDS_FILE = 'level-rewards.json';
progression.setCustomRewards(require('./src/store').readJSON(LEVEL_REWARDS_FILE, {}));
progression.setNameResolver({
  ornament: id => (db.ornamentById(id) || {}).name,
  banner: id => (banners.byId(id) || {}).name,
  extension: id => (db.extensionById(id) || {}).name
});
function applyLevelReward(user, reward) {
  if (!reward || reward.kind === 'none') return;
  if (reward.kind === 'credits') user.credits = (user.credits || 0) + (Number(reward.amount) || 0);
  else if (reward.kind === 'dust') user.dust = (user.dust || 0) + (Number(reward.amount) || 0);
  else if (reward.kind === 'banner') { banners.grant(user, reward.bannerId); }
  else if (reward.kind === 'booster') {
    const ext = (reward.extensionId && db.extensionById(reward.extensionId)) || db.extensionById('base') || { id: 'base', name: 'Édition de Base' };
    user.boosterInventory = user.boosterInventory || [];
    user.boosterInventory.push({ id: 'inv-' + uuidv4().slice(0, 10), extensionId: ext.id, extensionName: ext.name, acquiredAt: Date.now() });
  } else if (reward.kind === 'title') career.grantTitle(user, { name: reward.title, source: 'Niveau de compte' });
  else if (reward.kind === 'ornament') { user.ownedOrnaments = user.ownedOrnaments || []; if (!user.ownedOrnaments.includes(reward.ornamentId)) user.ownedOrnaments.push(reward.ornamentId); }
}
/* Après un combat : XP selon le mode et le résultat, défis du jour, évolution des cartes */
function progressAfterMatch(user, report) {
  const X = progression.XP, win = report.result === 'win';
  const xp = { pvp: win ? X.pvpWin : X.pvpLoss, tournament: X.tournament, story: win ? X.storyWin : X.storyLoss,
    bot: win ? X.botWin : X.botLoss, boss: win ? X.storyWin : X.storyLoss, practice: X.practice,
    survival: win ? X.botWin : X.botLoss, draft: win ? X.botWin : X.botLoss, brawl: win ? X.botWin : X.botLoss, duel: win ? X.pvpWin : X.pvpLoss, blitz: win ? X.pvpWin : X.pvpLoss }[report.mode] || 0;
  progression.grantXp(user, xp, 'combat', applyLevelReward);
  const pool = db.getCardPool();
  // Les combats contre le bot ne font pas avancer les défis du jour
  const counts = career.countsForDailies(report.mode);
  const d = counts ? { play_games: 1, win_games: win ? 1 : 0, win_story: win && report.mode === 'story' ? 1 : 0,
    play_minions: 0, play_spells: 0, deal_damage: 0, destroy_minions: 0 } : {};
  if (counts) Object.keys(report.perCard || {}).forEach(id => {
    const s = report.perCard[id], c = pool.find(x => x.id === id);
    if (c && c.type === 'minion') d.play_minions += s.played || 0;
    else if (c && c.type !== 'weapon') d.play_spells += s.played || 0;
    d.deal_damage += s.damage || 0; d.destroy_minions += s.kills || 0;
  });
  progression.progressDaily(user, d, applyLevelReward);
  progression.checkCardEvolution(user, (user.career || {}).cards || {}, id => (db.cardById(id) || {}).name);
}
function progressAfterBoosters(user, n, drawn) {
  progression.grantXp(user, progression.XP.booster * n, 'booster', applyLevelReward);
  progression.progressDaily(user, { open_boosters: n }, applyLevelReward);
  const legends = (drawn || []).filter(c => c && c.rarity === 'legendaire').length;
  recordSecrets(user, { boosters_opened: n, legendary_pulled: legends, double_legendary: legends >= 2 ? 1 : 0 });
  communityContribute(user, { open_boosters: n });
}

/* Enregistre qu'un rang vient d'être atteint (pour le succès "reach_rank"),
   sans jamais retirer un rang déjà enregistré. */
function trackRankReached(user) {
  achievementsEngine.ensureStatsFields(user);
  const rank = rankFor(user.seasonVP);
  if (!user.stats.ranksReached.includes(rank)) user.stats.ranksReached.push(rank);
}

const career = require('./src/career');
function titleCtx() { const st = require('./src/story').get(); return { storyCount: (st.chapters || []).filter(c => c.enabled !== false).length }; }
function decorateProfile(user) {
  const pub = db.publicUser(ensureProfileFields(user));
  pub.rank = rankFor(pub.seasonVP);
  pub.nextRank = nextRankFor(pub.seasonVP);
  pub.titles = career.titlesFor(user, titleCtx());
  pub.progress = {
    level: user.level, xp: user.xp, xpNext: progression.xpForLevel(user.level),
    next: Array.from({ length: 10 }, (_, k) => user.level + 1 + k).map(l => { const r = progression.rewardFor(l); return { level: l, reward: r.label, kind: r.kind, ornamentId: r.ornamentId || null, bannerId: r.bannerId || null }; }),
    daily: progression.ensureDaily(user).list,
    evo: Object.fromEntries(Object.entries((user.career || {}).cards || {}).map(([id, n]) => [id, { plays: n, tier: progression.evoTier(n) }]).filter(([, v]) => v.tier > 0 || v.plays > 0)),
    evoTiers: progression.EVO_TIERS
  };
  pub.notices = user.notices || [];
  pub.careerStats = career.summary(user, id => db.cardById(id));
  pub.secretCount = (user.secretsUnlocked || []).length;
  pub.survival = { best: user.survival.best, run: user.survival.run ? { round: user.survival.run.round, hp: user.survival.run.hp } : null };
  pub.puzzle = { solvedToday: user.puzzle.lastSolved === puzzle.dayKey(), streak: user.puzzle.streak || 0 };
  pub.brawl = { wins: user.brawl.wins || 0, firstDone: !!user.brawl.firstDone, rule: (() => { const r = brawl.ruleFor(community.weekKey(), brawlOverride()); return { id: r.id, name: r.name, icon: r.icon }; })() };
  pub.draft = { best: user.draft.best, run: user.draft.run ? { picks: user.draft.run.picks.length, wins: user.draft.run.wins, losses: user.draft.run.losses } : null, free: draft.freeAvailable(user) };
  delete pub.secretStats; delete pub.secretsUnlocked;
  return pub;
}

/* ---------- Succès secrets : récompense spéciale + notification ---------- */
function secretReward(user, def) {
  if (def.banner) banners.grant(user, def.banner);
  if (def.title) career.grantTitle(user, { name: def.title, source: 'Succès secret : ' + def.name });
  progression.grantXp(user, progression.XP.achievement, 'succès', applyLevelReward);
}
/* Met à jour les métriques des succès secrets et prévient le joueur (n'écrit pas le user) */
function recordSecrets(user, facts) {
  try {
    secrets.ensure(user); banners.ensure(user);
    const newly = secrets.record(user, facts, secretReward);
    // Une bannière gagnée peut en débloquer un autre (« Posséder 5 bannières »)
    const more = secrets.record(user, { banners_owned: user.ownedBanners.length }, secretReward);
    const all = newly.concat(more);
    if (all.length) {
      const sock = mm.socketFor(user.slug);
      if (sock) sock.emit('secrets:unlocked', all.map(d => ({ name: d.name, desc: d.desc, credits: d.credits, dust: d.dust, banner: d.banner ? (banners.byId(d.banner) || {}).name : null, title: d.title })));
    }
    return all;
  } catch (e) { console.error('Succès secrets :', e.message); return []; }
}

/* ---------- Objectif communautaire de la semaine ---------- */
function ensureCommunityWeek() { try { community.ensureWeek(db.allUsers().length); } catch (e) { console.error('Objectif communautaire :', e.message); } }
ensureCommunityWeek();
setInterval(ensureCommunityWeek, 10 * 60 * 1000);
function communityContribute(user, deltas) {
  try {
    ensureCommunityWeek();
    const r = community.contribute(user.slug, deltas);
    r.reward.forEach(slug => {
      const u = slug === user.slug ? user : db.getUser(slug);
      if (!u) return;
      ensureProfileFields(u);
      u.credits = (u.credits || 0) + community.REWARD.credits;
      const ext = randomEligibleExtension();
      if (ext) u.boosterInventory.push({ id: 'inv-' + uuidv4().slice(0, 10), extensionId: ext.id, extensionName: ext.name, acquiredAt: Date.now(), source: 'community' });
      banners.grant(u, 'communaute');
      if (u !== user) db.updateUser(u.slug, u);
      const sock = mm.socketFor(u.slug);
      if (sock) sock.emit('community:reward', { goal: (community.view(u.slug) || {}).goal, credits: community.REWARD.credits, booster: ext ? ext.name : null });
    });
    if (r.reward.length || r.completedNow) io.emit('community:update');
  } catch (e) { console.error('Objectif communautaire :', e.message); }
}
function randomEligibleExtension() {
  const exts = db.getExtensions().filter(e => !e.hidden && db.getCardPool().some(c => (c.extensionId || 'base') === e.id && !c.unobtainable));
  return exts.length ? exts[Math.floor(Math.random() * exts.length)] : null;
}

// Clôture de saison au démarrage, puis vérifiée à chaque heure
setRankThresholds(rankingSettings().rankThresholds); // paliers réglés par l'admin, avant toute clôture de saison
ranking.closeSeasonIfNeeded(db, rankingSettings());
setInterval(() => ranking.closeSeasonIfNeeded(db, rankingSettings()), 60 * 60 * 1000);

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

/* Notifications de progression lues par le client */
app.post('/api/me/notices/ack', requireAuth, (req, res) => {
  const user = db.getUser(req.session.userSlug);
  if (user) { user.notices = []; db.updateUser(user.slug, user); }
  res.json({ ok: true });
});

/* Titre affiché sous le pseudo : à choisir parmi les titres débloqués (ou aucun) */
app.post('/api/me/title', requireAuth, (req, res) => {
  const user = ensureProfileFields(db.getUser(req.session.userSlug));
  const id = (req.body || {}).titleId || null;
  if (!id) { user.title = null; user.titleName = null; }
  else {
    const t = career.titlesFor(user, titleCtx()).find(x => x.id === id);
    if (!t) return res.status(400).json({ error: "Tu n'as pas encore débloqué ce titre." });
    user.title = t.id; user.titleName = t.name;
  }
  db.updateUser(user.slug, user);
  res.json({ ok: true, title: user.titleName });
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
  (/^music/.test(req.params.key) ? uploadMusic : uploadBrandingSound).single('sound')(req, res, (err) => {
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
    rewardCredits: def.rewardCredits || 0, rewardDust: def.rewardDust || 0, rewardTitle: def.rewardTitle || '',
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
    rewardTitle: String(b.rewardTitle || '').trim().slice(0, 40),
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
  if (b.rewardTitle !== undefined) patch.rewardTitle = String(b.rewardTitle || '').trim().slice(0, 40);
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
  const st = db.getSettings();
  res.json({ matchDropChance: st.matchDropChance, winCredits: st.winCredits != null ? st.winCredits : 50, lossCredits: st.lossCredits != null ? st.lossCredits : 25, shinyMultiplier: st.shinyMultiplier != null ? st.shinyMultiplier : 1 });
});

app.patch('/api/admin/settings', (req, res) => {
  const b = req.body || {};
  if (b.code !== ADMIN_CODE) return res.status(403).json({ error: 'Code admin incorrect.' });
  if (b.matchDropChance !== undefined) {
    const chance = Number(b.matchDropChance);
    if (!Number.isFinite(chance) || chance < 0 || chance > 100) return res.status(400).json({ error: 'La probabilité doit être comprise entre 0 et 100.' });
    db.updateSettings({ matchDropChance: chance });
  }
  if (b.shinyMultiplier !== undefined) {
    const m = Number(b.shinyMultiplier);
    if (!Number.isFinite(m) || m < 0 || m > 20) return res.status(400).json({ error: 'Le multiplicateur des cartes brillantes doit être entre 0 et 20.' });
    db.updateSettings({ shinyMultiplier: m });
  }
  for (const key of ['winCredits', 'lossCredits']) {
    if (b[key] === undefined) continue;
    const v = Number(b[key]);
    if (!Number.isFinite(v) || v < 0 || v > 100000) return res.status(400).json({ error: 'Les crédits de fin de combat doivent être un nombre entre 0 et 100 000.' });
    db.updateSettings({ [key]: Math.round(v) });
  }
  if (b.ranking && typeof b.ranking === 'object') {
    const r = b.ranking, cur = rankingSettings();
    const num = (v, lo, hi, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
    const th = Array.isArray(r.rankThresholds) ? r.rankThresholds.map(v => num(v, 1, 100000, 0)) : cur.rankThresholds;
    if (th.length !== 4 || th.some((v, i) => !v || (i > 0 && v <= th[i - 1]))) return res.status(400).json({ error: 'Les paliers doivent être 4 nombres croissants (Argent < Or < Diamant < Maître).' });
    const rr = Object.assign({}, cur.rankRewards);
    Object.keys(rr).forEach(k => { if (r.rankRewards && r.rankRewards[k] !== undefined) rr[k] = num(r.rankRewards[k], 0, 100000, rr[k]); });
    const next = {
      rankThresholds: th, vpWin: num(r.vpWin, 1, 1000, cur.vpWin), vpLoss: num(r.vpLoss, 0, 1000, cur.vpLoss),
      minLossTurns: num(r.minLossTurns, 0, 50, cur.minLossTurns), firstWinMultiplier: num(r.firstWinMultiplier, 1, 5, cur.firstWinMultiplier),
      streakFrom: num(r.streakFrom, 2, 20, cur.streakFrom), streakBonus: num(r.streakBonus, 0, 1000, cur.streakBonus),
      softReset: r.softReset === undefined ? cur.softReset : (r.softReset === true || r.softReset === 'true'), rankRewards: rr
    };
    db.updateSettings({ ranking: next });
    setRankThresholds(next.rankThresholds);
  }
  res.json({ ok: true, settings: db.getSettings(), ranking: rankingSettings() });
});

/* Extensions cachées (en préparation) : invisibles pour les joueurs —
   pas de booster en boutique, pas de drop, cartes absentes du Codex, des
   decks du bot et des suggestions. L'admin (avec son code) voit tout. */
function hiddenExtIds() { return new Set(db.getExtensions().filter(e => e.hidden && e.id !== 'base').map(e => e.id)); }
function isPlayableCard(c) { return c && !hiddenExtIds().has(c.extensionId || 'base'); }
// Cartes « normales » : publiées et obtenables (les cartes spéciales n'apparaissent que via des effets)
function playablePool() { const h = hiddenExtIds(); return db.getCardPool().filter(c => !h.has(c.extensionId || 'base') && !c.unobtainable); }
function visiblePool() { const h = hiddenExtIds(); return db.getCardPool().filter(c => !h.has(c.extensionId || 'base')); }
const isAdminReq = req => (req.query && req.query.code === ADMIN_CODE);
game.setHiddenCardCheck(c => !isPlayableCard(c));
app.get('/api/extensions', (req, res) => {
  const all = db.getExtensions();
  res.json({ extensions: isAdminReq(req) ? all : all.filter(e => !e.hidden || e.id === 'base') });
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
      hidden: b.hidden === undefined ? true : (b.hidden === 'true' || b.hidden === true), // une nouvelle extension reste cachée jusqu'à sa publication
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
  if (b.hidden !== undefined) {
    if (ext.id === 'base' && (b.hidden === true || b.hidden === 'true')) return res.status(400).json({ error: "L'Édition de base ne peut pas être cachée." });
    patch.hidden = b.hidden === true || b.hidden === 'true';
  }
  db.updateExtension(ext.id, patch);
  if (patch.hidden !== undefined || patch.name !== undefined) io.emit('extensions:update');
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
  const cards = (isAdminReq(req) ? db.getCardPool() : visiblePool()).map(c => {
    const ext = db.extensionById(c.extensionId || 'base');
    return Object.assign({}, c, { cardBackImage: ext ? ext.backImage : null, extensionName: ext ? ext.name : null });
  });
  res.json({ cards });
});

app.get('/api/config', (req, res) => {
  res.json({
    rarityWeights: RARITY_WEIGHTS, copyLimits: COPY_LIMITS, dustValues: DUST_VALUES,
    deckSize: DECK_SIZE, ornaments: db.getOrnaments(), ranks: RANKS, ranking: rankingSettings(),
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

/* Chance de Daltonisme : pourcentage entier entre 1 et 100 (50 par défaut) */
function clampChance(v) { return Math.max(1, Math.min(100, Math.round(Number(v) || 50))); }

/* Effets de sort disponibles, aussi utilisables en cri de guerre par un serviteur */
const SPELL_EFFECTS = ['damage', 'heal', 'buff_attack', 'aoe_damage', 'aoe_heal', 'damage_all', 'buff_all_allies', 'board_wipe', 'buff_ally_and_heal', 'modify_stats', 'draw', 'armor', 'sleep', 'destroy', 'silence',
  'give_shield', 'give_windfury', 'give_stealth', 'give_taunt', 'give_deathrattle', 'summon', 'trap', 'random_cards'];
/* Mots-clés de serviteur (Bouclier, Furie, Camouflage) et Râle d'agonie
   (effet à la mort). Un sort « donner un Râle d'agonie » porte aussi drEffect. */
const flag = v => v === true || v === 'true';
/* Jetons (invocation), aura, piège : champs communs à toutes les cartes qui s'en servent */
function readMechanics(b, target) {
  if (b.tokenName !== undefined) target.tokenName = String(b.tokenName || '').trim().slice(0, 40) || null;
  if (b.tokenAttack !== undefined && b.tokenAttack !== '') target.tokenAttack = Math.max(0, Math.min(30, Math.round(Number(b.tokenAttack) || 0)));
  if (b.tokenHealth !== undefined && b.tokenHealth !== '') target.tokenHealth = Math.max(1, Math.min(30, Math.round(Number(b.tokenHealth) || 1)));
  if (b.auraAttack !== undefined) target.auraAttack = Math.max(0, Math.min(10, Math.round(Number(b.auraAttack) || 0)));
  // Rage : bonus d'ATQ tant que le serviteur est blessé (0 = pas de Rage)
  if (b.rage !== undefined) target.rage = Math.max(0, Math.min(10, Math.round(Number(b.rage) || 0)));
  if (b.auraScope !== undefined) target.auraScope = b.auraScope === 'adjacent' ? 'adjacent' : 'others';
  if (b.trapTrigger !== undefined) target.trapTrigger = Object.keys(game.TRAP_TRIGGERS).includes(b.trapTrigger) ? b.trapTrigger : 'enemy_attack';
  if (b.trapEffect !== undefined) target.trapEffect = game.TRAP_EFFECT_TYPES.includes(b.trapEffect) ? b.trapEffect : 'sleep';
  if (b.trapValue !== undefined && b.trapValue !== '') target.trapValue = Math.max(1, Math.min(20, Math.round(Number(b.trapValue) || 1)));
  // Cartes au hasard : liste des cartes possibles (vide = toutes les cartes du jeu)
  if (b.randomPool !== undefined) {
    const ids = (Array.isArray(b.randomPool) ? b.randomPool : String(b.randomPool || '').split(',')).map(x => String(x).trim()).filter(id => id && db.cardById(id));
    target.randomPool = [...new Set(ids)].slice(0, 60);
  }
  // Carte spéciale : jamais dans les boosters, n'apparaît que via des effets
  if (b.unobtainable !== undefined) target.unobtainable = b.unobtainable === true || b.unobtainable === 'true';
  // Combo : partenaire + carte qui apparaît quand les deux sont sur le plateau
  if (b.comboPartnerId !== undefined) target.comboPartnerId = db.cardById(b.comboPartnerId) ? b.comboPartnerId : null;
  if (b.comboSpawnId !== undefined) { const sp = db.cardById(b.comboSpawnId); target.comboSpawnId = sp && sp.type === 'minion' ? b.comboSpawnId : null; }
}
function readKeywords(b, target) {
  readMechanics(b, target);
  ['shield', 'windfury', 'stealth', 'standing'].forEach(k => { if (b[k] !== undefined) target[k] = flag(b[k]); });
  if (b.drEffect !== undefined) {
    if (!b.drEffect || !SPELL_EFFECTS.includes(b.drEffect) || /^give_/.test(b.drEffect)) { target.drEffect = null; target.drValue = null; target.drValue2 = null; }
    else {
      target.drEffect = b.drEffect;
      target.drValue = b.drEffect === 'modify_stats' ? Math.round(Number(b.drValue) || 0) : Math.max(1, Math.round(Number(b.drValue) || 1));
      target.drValue2 = b.drValue2 !== undefined && b.drValue2 !== '' ? Math.round(Number(b.drValue2) || 0) : null;
    }
  }
}
/* Cri de guerre : effet principal (bc…) et jusqu'à 2 effets cumulés (bc2…, bc3…) */
function readBattlecry(b, target) {
  [['bcEffect', 'bcValue', 'bcValue2'], ['bc2Effect', 'bc2Value', 'bc2Value2'], ['bc3Effect', 'bc3Value', 'bc3Value2']].forEach(([ek, vk, v2k]) => {
    if (b[ek] === undefined) return;
    const eff = b[ek];
    if (!eff || !SPELL_EFFECTS.includes(eff) || eff === 'give_deathrattle') { target[ek] = null; target[vk] = null; target[v2k] = null; return; }
    target[ek] = eff;
    target[vk] = eff === 'modify_stats' ? Math.round(Number(b[vk]) || 0) : Math.max(1, Math.round(Number(b[vk]) || 1));
    target[v2k] = b[v2k] !== undefined && b[v2k] !== '' ? Math.round(Number(b[v2k]) || 0) : null;
  });
}

/* Vérifie le code admin AVANT d'ouvrir le panneau (avant, n'importe quel mot
   ouvrait l'interface, sans pouvoir rien enregistrer). Tentatives limitées. */
const adminTries = new Map();
app.post('/api/admin/verify', (req, res) => {
  const key = (req.session && req.session.userSlug) || req.ip;
  const now = Date.now();
  const t = (adminTries.get(key) || []).filter(x => now - x < 60000);
  if (t.length >= 5) return res.status(429).json({ error: 'Trop de tentatives : réessaie dans une minute.' });
  if ((req.body || {}).code !== ADMIN_CODE) {
    t.push(now); adminTries.set(key, t);
    return res.status(403).json({ error: 'Code admin incorrect.' });
  }
  adminTries.delete(key);
  res.json({ ok: true });
});

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
      card.colorblind = b.colorblind === 'true' || b.colorblind === true;
      if (card.colorblind) card.colorblindChance = clampChance(b.colorblindChance);
      readBattlecry(b, card);
      readKeywords(b, card);
    } else if (b.type === 'weapon') {
      card.attack = Math.max(0, Number(b.attack) || 1);
      card.durability = Math.max(1, Number(b.durability) || 1);
      card.usesPerTurn = Math.max(1, Number(b.usesPerTurn) || 1);
      if (b.battlecryHeal) card.battlecryHeal = Number(b.battlecryHeal) || 0;
    } else {
      card.effectType = b.effectType || 'damage';
      // « Modifier les stats » accepte 0 et les valeurs négatives (ex. -1 PV, +2 ATQ)
      card.value = card.effectType === 'modify_stats' ? Math.round(Number(b.value) || 0) : (Number(b.value) || 1);
      if (b.value2 !== undefined && b.value2 !== '') card.value2 = Math.round(Number(b.value2) || 0);
      if (card.effectType === 'give_deathrattle') readKeywords({ drEffect: b.drEffect, drValue: b.drValue, drValue2: b.drValue2 }, card);
      readMechanics(b, card);
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
    if (b.colorblind !== undefined) patch.colorblind = b.colorblind === 'true' || b.colorblind === true;
    if (b.colorblindChance !== undefined && b.colorblindChance !== '') patch.colorblindChance = clampChance(b.colorblindChance);
    readBattlecry(b, patch);
    readKeywords(b, patch);
  } else if (card.type === 'weapon') {
    if (b.attack !== undefined && b.attack !== '') patch.attack = Math.max(0, Number(b.attack) || 0);
    if (b.durability !== undefined && b.durability !== '') patch.durability = Math.max(1, Number(b.durability) || 1);
    if (b.usesPerTurn !== undefined && b.usesPerTurn !== '') patch.usesPerTurn = Math.max(1, Number(b.usesPerTurn) || 1);
    if (b.battlecryHeal !== undefined && b.battlecryHeal !== '') patch.battlecryHeal = Math.max(0, Number(b.battlecryHeal) || 0);
  } else {
    if (b.effectType !== undefined) patch.effectType = b.effectType;
    if ((b.effectType || card.effectType) === 'give_deathrattle') readKeywords({ drEffect: b.drEffect, drValue: b.drValue, drValue2: b.drValue2 }, patch);
    readMechanics(b, patch);
    if (b.value !== undefined && b.value !== '') patch.value = Number(b.value) || 0;
    if (b.value2 !== undefined) patch.value2 = b.value2 === '' ? undefined : (Number(b.value2) || 0);
  }

  const updated = db.updateCard(req.params.id, patch);
  // Rareté changée : on remet tout de suite les decks des joueurs dans les règles
  let decksFixed = 0;
  if (patch.rarity) db.allUsers().forEach(u => { if (enforceDeckLimits(u)) { db.updateUser(u.slug, u); decksFixed++; } });
  res.json({ ok: true, card: updated, decksFixed });
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
/* Râles d'agonie : liste des cartes qui en ont un, et retrait (une carte, toute
   une extension ou tout le jeu). Les sorts « Donner un Râle d'agonie » ne sont
   pas concernés : c'est leur effet normal. */
function cardsWithDeathrattle() { return db.getCardPool().filter(c => c.type === 'minion' && c.drEffect); }
app.get('/api/admin/cards/deathrattles', (req, res) => {
  if (req.query.code !== ADMIN_CODE) return res.status(403).json({ error: 'Code admin incorrect.' });
  res.json({ cards: cardsWithDeathrattle().map(c => ({ id: c.id, name: c.name, extensionId: c.extensionId || 'base', drEffect: c.drEffect, drValue: c.drValue, drValue2: c.drValue2 })) });
});
app.post('/api/admin/cards/deathrattles/clear', (req, res) => {
  const b = req.body || {};
  if (b.code !== ADMIN_CODE) return res.status(403).json({ error: 'Code admin incorrect.' });
  const targets = cardsWithDeathrattle().filter(c => Array.isArray(b.cardIds) ? b.cardIds.includes(c.id) : b.extensionId ? (c.extensionId || 'base') === b.extensionId : !!b.all);
  targets.forEach(c => db.updateCard(c.id, { drEffect: null, drValue: null, drValue2: null }));
  res.json({ ok: true, cleared: targets.length });
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
/* Un booster de 5 cartes : jamais plus de MAX_SAME_PER_PACK exemplaires de la
   même carte. Une carte déjà sortie 2 fois est retirée des tirages suivants du
   booster (si l'extension a trop peu de cartes, on accepte le doublon). */
const PACK_SIZE = 5, MAX_SAME_PER_PACK = 2;
function drawPack(pool) {
  const drawn = [], count = {};
  for (let i = 0; i < PACK_SIZE; i++) {
    const allowed = pool.filter(c => (count[c.id] || 0) < MAX_SAME_PER_PACK);
    const c = weightedDraw(allowed.length ? allowed : pool);
    count[c.id] = (count[c.id] || 0) + 1;
    drawn.push(c);
  }
  return drawn;
}

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
  if (!ext || ext.hidden) return res.status(400).json({ error: 'Extension introuvable.' });

  const pool = db.getCardPool().filter(c => (c.extensionId || 'base') === ext.id && !c.unobtainable);
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
  const pool = db.getCardPool().filter(c => (c.extensionId || 'base') === stored.extensionId && !c.unobtainable);
  if (pool.length === 0) return res.status(400).json({ error: "Cette extension ne contient plus de cartes (elle a peut-être été supprimée)." });

  // Taux de rareté (60/25/12/3 %) appliqués aussi aux boosters d'extension, 2 exemplaires max d'une même carte
  const drawn = rollShiny(user, drawPack(pool));
  drawn.forEach(c => { user.collection[c.id] = (user.collection[c.id] || 0) + 1; });
  user.boosterInventory.splice(idx, 1);
  markDiscovered(user, drawn.map(c => c.id));
  progressAfterBoosters(user, 1, drawn); // ouvrir un booster rapporte de l'XP (et compte pour les défis)
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
  // Le booster gratuit est celui de l'Édition de base : on ne tire QUE ses cartes.
  // (Avant, il piochait dans toutes les cartes du jeu, extensions comprises.)
  const basePool = db.getCardPool().filter(c => (c.extensionId || 'base') === 'base' && !c.unobtainable);
  const pool = basePool.length ? basePool : db.getCardPool();
  const drawn = rollShiny(user, drawPack(pool)); // 2 exemplaires max d'une même carte
  drawn.forEach(c => { user.collection[c.id] = (user.collection[c.id] || 0) + 1; });
  user.lastPack = Date.now();
  markDiscovered(user, drawn.map(c => c.id));
  progressAfterBoosters(user, 1, drawn); // ouvrir un booster rapporte de l'XP (et compte pour les défis)
  const unlockedAchievements = awardAchievements(user);
  db.updateUser(user.slug, user);
  res.json({ drawn, profile: decorateProfile(user), unlockedAchievements });
});

/* ---------- Cartes brillantes ----------
   Version rare d'une carte (reflet animé + particules), purement esthétique.
   Chance d'en obtenir une dans les boosters, ou fabrication avec de la poussière.
   user.foils = { idDeCarte: nombre d'exemplaires brillants } */
const SHINY_CHANCE = { commun: 2, rare: 3, epique: 4, legendaire: 6 }; // % par carte de booster
const SHINY_CRAFT = { commun: 100, rare: 200, epique: 400, legendaire: 800 }; // poussière
function shinyChanceOf(card) {
  const mult = Number((db.getSettings() || {}).shinyMultiplier);
  return (SHINY_CHANCE[card.rarity] || 2) * (Number.isFinite(mult) && mult >= 0 ? mult : 1);
}
/* Après un tirage de booster : certaines cartes sortent brillantes (copies marquées shiny, le pool n'est pas modifié) */
function rollShiny(user, drawn) {
  if (!user.foils || typeof user.foils !== 'object') user.foils = {};
  return drawn.map(c => {
    if (Math.random() * 100 >= shinyChanceOf(c)) return c;
    user.foils[c.id] = (user.foils[c.id] || 0) + 1;
    return Object.assign({}, c, { shiny: true });
  });
}
function shinyIdsOf(slug) {
  const u = db.getUser(slug);
  return u && u.foils ? Object.keys(u.foils).filter(id => u.foils[id] > 0) : [];
}
mm.setFoilsProvider(shinyIdsOf);

app.post('/api/foil/craft', requireAuth, (req, res) => {
  const user = ensureProfileFields(db.getUser(req.session.userSlug));
  const card = db.cardById((req.body || {}).cardId);
  if (!card) return res.status(400).json({ error: 'Carte introuvable.' });
  if (!(user.collection[card.id] > 0)) return res.status(400).json({ error: "Il faut posséder la carte pour en faire une version brillante." });
  if (!user.foils || typeof user.foils !== 'object') user.foils = {};
  if (user.foils[card.id] > 0) return res.status(400).json({ error: 'Tu as déjà cette carte en version brillante.' });
  const price = SHINY_CRAFT[card.rarity] || 100;
  if (user.dust < price) return res.status(400).json({ error: `Il te manque ${price - user.dust} poussière.` });
  user.dust -= price;
  user.stats.dustSpent = (user.stats.dustSpent || 0) + price;
  user.foils[card.id] = 1;
  db.updateUser(user.slug, user);
  res.json({ ok: true, profile: decorateProfile(user) });
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
  if (orn.tournamentOnly) return res.status(400).json({ error: "Ce contour ne s'obtient qu'en gagnant un tournoi." });
  if (orn.levelOnly) return res.status(400).json({ error: "Ce contour s'obtient en montant de niveau." });
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
  const pool = playablePool(); // ni extensions cachées, ni cartes spéciales (non obtenables)
  const extensions = db.getExtensions().filter(e => !e.hidden || e.id === 'base');

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


/* ======================================================
   MODE HISTOIRE (solo)
   ====================================================== */
const story = require('./src/story');
function storyChapters() {
  if (!story.get().chapters.length) story.generate(playablePool(), 8); // première fois : créée à partir des cartes du jeu
  else story.ensureFights(playablePool());
  return story.get().chapters;
}
/* Progression d'un joueur : nombre de combats gagnés dans chaque chapitre.
   (Un chapitre terminé avec l'ancienne version, à un seul combat, compte comme fini.) */
function storyProgressOf(user, ch) {
  const total = story.fightsOf(ch).length;
  const p = (user.storyProgress || {})[ch.id] || 0;
  return (user.storyCleared || []).includes(ch.id) ? Math.max(p, total) : p;
}
app.get('/api/story', requireAuth, (req, res) => {
  const user = ensureProfileFields(db.getUser(req.session.userSlug));
  const all = storyChapters();
  const chapters = all.map((c, i) => {
    const boss = db.cardById(c.bossCardId) || {};
    const fights = story.fightsOf(c);
    const progress = Math.min(storyProgressOf(user, c), fights.length);
    const prevDone = i === 0 || storyProgressOf(user, all[i - 1]) >= story.fightsOf(all[i - 1]).length;
    return Object.assign({}, c, {
      index: i, enabled: c.enabled !== false, unlocked: c.enabled !== false && prevDone,
      cleared: progress >= fights.length, progress,
      bossImage: boss.image || null, bossRarity: boss.rarity || null,
      fights: fights.map((f, k) => {
        const card = db.cardById(f.cardId) || {};
        return { kind: f.kind, index: k, name: f.name, hp: f.hp, armor: f.armor, image: card.image || null, rarity: card.rarity || null,
          won: k < progress, reward: story.rewardFor(c, k >= progress, f.kind === 'minion') };
      })
    });
  });
  res.json({ tabEnabled: !!story.get().tabEnabled, chapters });
});
function settleStoryMatch(chapterId, fightIndex, match) {
  const human = match.players[0];
  const user = db.getUser(human.slug);
  if (!user || match.winner !== human.slug) return null;
  ensureProfileFields(user);
  const chapter = storyChapters().find(c => c.id === chapterId);
  if (!chapter) return null;
  const fights = story.fightsOf(chapter);
  const fight = fights[fightIndex];
  if (!fight) return null;
  const progress = storyProgressOf(user, chapter);
  const firstWin = fightIndex >= progress;
  const reward = story.rewardFor(chapter, firstWin, fight.kind === 'minion');
  user.dust += reward.dust; user.credits += reward.credits;
  user.storyProgress = user.storyProgress || {};
  user.storyProgress[chapterId] = Math.max(progress, fightIndex + 1);
  user.storyCleared = user.storyCleared || [];
  const chapterDone = user.storyProgress[chapterId] >= fights.length;
  if (chapterDone && !user.storyCleared.includes(chapterId)) user.storyCleared.push(chapterId);
  db.updateUser(user.slug, user);
  return { winnerSlug: human.slug, bossReward: reward, storyResult: {
    chapterId, firstClear: firstWin, title: chapter.title, fightName: fight.name, isBoss: fight.kind === 'boss',
    fightNumber: fightIndex + 1, fightCount: fights.length, chapterDone: chapterDone && fight.kind === 'boss',
    victory: fight.kind === 'boss' ? chapter.victory : `${fight.name} est vaincu. ${fights.length - fightIndex - 1 > 0 ? `Encore ${fights.length - fightIndex - 1} combat${fights.length - fightIndex - 1 > 1 ? 's' : ''} avant la fin du chapitre.` : ''}` } };
}
/* Admin : modifier les chapitres ou les recréer à partir des cartes */
app.get('/api/admin/story', (req, res) => {
  if (req.query.code !== ADMIN_CODE) return res.status(403).json({ error: 'Code admin incorrect.' });
  res.json({ chapters: storyChapters(), tabEnabled: !!story.get().tabEnabled });
});
/* Afficher ou masquer l'onglet Histoire (masqué au départ) */
app.post('/api/admin/story/tab', (req, res) => {
  if ((req.body || {}).code !== ADMIN_CODE) return res.status(403).json({ error: 'Code admin incorrect.' });
  story.setTabEnabled(req.body.enabled);
  io.emit('story:update');
  res.json({ ok: true, tabEnabled: !!story.get().tabEnabled });
});
app.post('/api/admin/story', (req, res) => {
  const b = req.body || {};
  if (b.code !== ADMIN_CODE) return res.status(403).json({ error: 'Code admin incorrect.' });
  const r = b.regenerate ? story.generate(playablePool(), Number(b.count) || 8) : story.setChapters(b.chapters);
  if (r.error) return res.status(400).json(r);
  res.json({ ok: true, chapters: story.get().chapters });
});
/* ======================================================
   NOTIFICATIONS PUSH (appli installée sur le téléphone / PC)
   Envoyées seulement si le joueur n'a pas le jeu ouvert à l'écran :
   onglet fermé, en arrière-plan ou téléphone verrouillé.
   ====================================================== */
function playerAway(slug) {
  const sock = mm.socketFor(slug);
  return !sock || !sock.connected || sock.data.visible === false;
}
function pushIfAway(slug, msg) {
  if (!slug || slug === 'bot' || slug === 'boss' || !push.hasSubs(slug) || !playerAway(slug)) return;
  push.send(slug, msg).catch(() => {});
}
app.get('/api/push/key', requireAuth, (req, res) => res.json({ publicKey: push.publicKey() }));
app.post('/api/push/subscribe', requireAuth, (req, res) => {
  const r = push.subscribe(req.session.userSlug, (req.body || {}).subscription);
  if (r.error) return res.status(400).json(r);
  res.json({ ok: true });
});
app.post('/api/push/unsubscribe', requireAuth, (req, res) => res.json(push.unsubscribe(req.session.userSlug, (req.body || {}).endpoint)));
app.post('/api/push/test', requireAuth, async (req, res) => {
  if (!push.hasSubs(req.session.userSlug)) return res.status(400).json({ error: "Aucun appareil abonné : active d'abord les notifications." });
  const codes = await push.send(req.session.userSlug, { title: 'Clean Gang Decks', body: 'Les notifications fonctionnent ! 🎉', tag: 'test-' + Date.now(), url: '/' });
  res.json({ ok: codes.some(c => c >= 200 && c < 300), devices: codes.length });
});
mm.setTurnStartHandler(({ slug, opponentPseudo, matchId, turnNumber }) =>
  pushIfAway(slug, { title: "C'est ton tour !", body: `${opponentPseudo} a fini de jouer.`, tag: `turn-${matchId}-${turnNumber}`, url: '/' }));

/* ======================================================
   TOURNOI
   ====================================================== */
const tournament = require('./src/tournament');
const tourPushed = new Set();
function pushTournamentReady() {
  const t = tournament.get().current;
  if (!t || t.status !== 'running') return;
  (t.rounds || []).forEach(round => round.forEach(m => {
    if (m.winner || !m.a || !m.b || m.status !== 'pending' || tourPushed.has(m.id)) return;
    tourPushed.add(m.id);
    const pseudoOf = s2 => { const u = db.getUser(s2); return u ? u.pseudo : s2; };
    pushIfAway(m.a, { title: 'Ton match de tournoi est prêt', body: `Adversaire : ${pseudoOf(m.b)}. Clique sur « Je suis prêt » !`, tag: 'tour-' + m.id, url: '/' });
    pushIfAway(m.b, { title: 'Ton match de tournoi est prêt', body: `Adversaire : ${pseudoOf(m.a)}. Clique sur « Je suis prêt » !`, tag: 'tour-' + m.id, url: '/' });
  }));
}
function broadcastTournament() { io.emit('tournament:update'); try { pushTournamentReady(); } catch (e) {} }
function tournamentView(slug) {
  const d = tournament.get(), t = d.current;
  const orn = t ? db.ornamentById(t.rewardOrnamentId) : null;
  const pseudoOf = s2 => { const u = db.getUser(s2); return u ? u.pseudo : s2; };
  const mine = t ? tournament.currentMatchOf(slug) : null;
  return {
    tabEnabled: !!d.tabEnabled, minPlayers: tournament.MIN_PLAYERS,
    current: t ? Object.assign({}, t, {
      players: t.players.map(p => { const u = db.getUser(p.slug); return { slug: p.slug, pseudo: u ? u.pseudo : p.pseudo, avatar: u ? u.avatar : null, ornament: u ? u.ornament : 'none', online: mm.isOnline(p.slug) }; }),
      championPseudo: t.champion ? pseudoOf(t.champion) : null,
      rewardOrnament: orn
    }) : null,
    me: { registered: !!(t && t.players.some(p => p.slug === slug)), match: mine ? Object.assign({ round: mine.r }, mine.m) : null },
    history: d.history.map(h => Object.assign({}, h, { rewardOrnament: db.ornamentById(h.rewardOrnamentId) }))
  };
}
app.get('/api/tournament', requireAuth, (req, res) => res.json(tournamentView(req.session.userSlug)));
app.post('/api/tournament/register', requireAuth, (req, res) => {
  const user = db.getUser(req.session.userSlug);
  if (!buildPlayerInfo(user.slug)) return res.status(400).json({ error: `Il te faut un deck de ${DECK_SIZE} cartes pour t'inscrire.` });
  const r = tournament.register(user);
  if (r.error) return res.status(400).json(r);
  broadcastTournament(); res.json(tournamentView(user.slug));
});
app.post('/api/tournament/unregister', requireAuth, (req, res) => {
  const r = tournament.unregister(req.session.userSlug);
  if (r.error) return res.status(400).json(r);
  broadcastTournament(); res.json(tournamentView(req.session.userSlug));
});
app.post('/api/tournament/ready', requireAuth, (req, res) => {
  const slug = req.session.userSlug;
  const r = tournament.setReady(slug, (req.body || {}).ready !== false);
  if (r.error) return res.status(400).json(r);
  if (r.bothReady) startTournamentMatch(r.match);
  broadcastTournament(); res.json(tournamentView(slug));
});

/* Les deux joueurs sont prêts : on lance le combat (decks actifs des joueurs) */
function startTournamentMatch(m) {
  const sa = mm.socketFor(m.a), sb = mm.socketFor(m.b);
  const fail = msg => { tournament.resetReady(m.id); [sa, sb].forEach(x => x && x.emit('queue:error', { error: msg })); broadcastTournament(); };
  if (!sa || !sb) return fail("Ton adversaire n'est plus connecté : réessayez quand vous êtes tous les deux en ligne.");
  if (mm.activeMatchOf(m.a) || mm.activeMatchOf(m.b)) return fail('Un des deux joueurs est déjà en combat : réessayez à la fin de son combat.');
  const ia = buildPlayerInfo(m.a), ib = buildPlayerInfo(m.b);
  if (!ia || !ib) return fail(`Un des deux joueurs n'a pas de deck de ${DECK_SIZE} cartes valide.`);
  const ref = m.id;
  const gameId = mm.startMatch({ socket: sa, playerInfo: ia }, { socket: sb, playerInfo: ib }, db.getCardPool(), io,
    (match) => onTournamentMatchEnd(ref, match), { tournamentRef: ref });
  if (!gameId) return fail('Un des deux joueurs est déjà en combat : réessayez à la fin de son combat.');
  tournament.markPlaying(ref, gameId);
}
/* Fin d'un combat de tournoi : le vainqueur avance ; en finale, il gagne le contour exclusif */
function onTournamentMatchEnd(ref, match) {
  if (!match.winner) { tournament.resetReady(ref); broadcastTournament(); return null; } // égalité : le match se rejoue
  const r = tournament.reportWinner(ref, match.winner);
  if (r.champion) awardTournament(r.champion);
  broadcastTournament();
  return null;
}
function awardTournament(slug) {
  const t = tournament.get().current;
  const u = db.getUser(slug);
  if (!t || !u) return;
  ensureProfileFields(u);
  if (t.rewardOrnamentId && !u.ownedOrnaments.includes(t.rewardOrnamentId)) u.ownedOrnaments.push(t.rewardOrnamentId);
  career.grantTitle(u, { name: t.titleName || `Champion — ${t.name}`, source: `Tournoi « ${t.name} »` });
  banners.grant(u, banners.byId(t.rewardBannerId) ? t.rewardBannerId : 'champion');
  recordSecrets(u, {});
  db.updateUser(u.slug, u);
  // Le finaliste reçoit la bannière « Finaliste »
  try {
    const last = (t.rounds || [])[t.rounds.length - 1] || [];
    const final = last[0];
    const runnerUp = final && (final.a === slug ? final.b : final.a);
    const ru = runnerUp && db.getUser(runnerUp);
    if (ru) { ensureProfileFields(ru); banners.grant(ru, 'finaliste'); recordSecrets(ru, {}); db.updateUser(ru.slug, ru); }
  } catch (e) {}
  const sock = mm.socketFor(slug);
  if (sock) sock.emit('tournament:won', { name: t.name, ornament: db.ornamentById(t.rewardOrnamentId) });
}

/* ---------- Admin du tournoi ---------- */
const adminOnly = (req, res) => { if ((req.body || {}).code !== ADMIN_CODE) { res.status(403).json({ error: 'Code admin incorrect.' }); return false; } return true; };
app.post('/api/admin/tournament', (req, res) => {
  uploadCardImage.single('image')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!adminOnly(req, res)) return;
    const b = req.body || {};
    if (!(b.name || '').trim()) return res.status(400).json({ error: 'Donne un nom au tournoi.' });
    let ornId = b.rewardOrnamentId || null;
    if (req.file) {
      // Nouveau contour d'avatar exclusif : jamais en vente, seulement gagné
      const orn = { id: 'orn-' + uuidv4().slice(0, 8), name: (b.rewardName || '').trim() || `Champion — ${b.name.trim()}`, price: 0,
        css: null, image: '/uploads/cards/' + req.file.filename, desc: `Récompense du tournoi « ${b.name.trim()} ».`, tournamentOnly: true };
      db.addOrnament(orn); ornId = orn.id;
    }
    if (!ornId || !db.ornamentById(ornId)) return res.status(400).json({ error: "Choisis le contour d'avatar à gagner (nouvelle image PNG ou contour existant)." });
    const r = tournament.create({ name: b.name, desc: b.desc, rewardOrnamentId: ornId, titleName: (b.titleName || '').trim().slice(0, 40),
      rewardBannerId: banners.byId(b.rewardBannerId) ? b.rewardBannerId : 'champion' });
    if (r.error) return res.status(400).json(r);
    broadcastTournament(); res.json({ ok: true });
  });
});
/* ---------- Admin : récompenses de niveau (modifiables) ---------- */
function levelRewardsView(maxLevel) {
  const custom = progression.getCustomRewards();
  const top = Math.max(maxLevel || 60, ...Object.keys(custom).map(Number).filter(Number.isFinite));
  const levels = [];
  for (let l = 2; l <= top; l++) levels.push({ level: l, reward: progression.rewardFor(l), isCustom: !!custom[l], byDefault: progression.defaultRewardFor(l) });
  return {
    levels, kinds: progression.REWARD_KINDS,
    ornaments: db.getOrnaments().map(o => ({ id: o.id, name: o.name, css: o.css || null, image: o.image || null, levelOnly: !!o.levelOnly })),
    banners: banners.catalog().map(b => ({ id: b.id, name: b.name, bg: b.bg, source: b.source })),
    extensions: db.getExtensions().map(e => ({ id: e.id, name: e.name }))
  };
}
app.post('/api/admin/level-rewards/list', (req, res) => { if (!adminOnly(req, res)) return; res.json(levelRewardsView(Number(req.body.maxLevel) || 60)); });
app.post('/api/admin/level-rewards/set', (req, res) => {
  if (!adminOnly(req, res)) return;
  const b = req.body || {};
  const level = Math.round(Number(b.level));
  if (!Number.isFinite(level) || level < 2 || level > 1000) return res.status(400).json({ error: 'Niveau invalide (2 à 1000).' });
  const custom = Object.assign({}, progression.getCustomRewards());
  const r = b.reward;
  if (!r) delete custom[level]; // retour à la récompense par défaut
  else {
    if (!progression.REWARD_KINDS.includes(r.kind)) return res.status(400).json({ error: 'Type de récompense inconnu.' });
    const clean = { kind: r.kind };
    if (r.kind === 'credits' || r.kind === 'dust') { clean.amount = Math.round(Number(r.amount)); if (!(clean.amount > 0) || clean.amount > 100000) return res.status(400).json({ error: 'Montant invalide.' }); }
    if (r.kind === 'title') { clean.title = String(r.title || '').trim().slice(0, 40); if (!clean.title) return res.status(400).json({ error: 'Écris le titre.' }); }
    if (r.kind === 'ornament') { if (!db.ornamentById(r.ornamentId)) return res.status(400).json({ error: 'Contour introuvable.' }); clean.ornamentId = r.ornamentId; }
    if (r.kind === 'banner') { if (!banners.byId(r.bannerId)) return res.status(400).json({ error: 'Bannière introuvable.' }); clean.bannerId = r.bannerId; }
    if (r.kind === 'booster' && r.extensionId) { if (!db.extensionById(r.extensionId)) return res.status(400).json({ error: 'Extension introuvable.' }); clean.extensionId = r.extensionId; }
    custom[level] = clean;
  }
  progression.setCustomRewards(custom);
  require('./src/store').writeJSON(LEVEL_REWARDS_FILE, custom);
  res.json(levelRewardsView(Number(b.maxLevel) || 60));
});
app.post('/api/admin/tournament/tab', (req, res) => { if (!adminOnly(req, res)) return; tournament.setTabEnabled(req.body.enabled); broadcastTournament(); res.json({ ok: true }); });
app.post('/api/admin/tournament/start', (req, res) => {
  if (!adminOnly(req, res)) return;
  const r = tournament.start();
  if (r.error) return res.status(400).json(r);
  const t = tournament.get().current;
  if (t && t.champion) awardTournament(t.champion);
  broadcastTournament(); res.json({ ok: true });
});
app.post('/api/admin/tournament/cancel', (req, res) => { if (!adminOnly(req, res)) return; const r = tournament.cancel(); if (r.error) return res.status(400).json(r); broadcastTournament(); res.json({ ok: true }); });
app.post('/api/admin/tournament/archive', (req, res) => { if (!adminOnly(req, res)) return; tournament.archive(); broadcastTournament(); res.json({ ok: true }); });
/* L'admin désigne le vainqueur d'un match (joueur absent, problème technique…) */
app.post('/api/admin/tournament/winner', (req, res) => {
  if (!adminOnly(req, res)) return;
  const r = tournament.reportWinner(req.body.matchRef, req.body.winner);
  if (r.error) return res.status(400).json(r);
  if (r.champion) awardTournament(r.champion);
  broadcastTournament(); res.json({ ok: true });
});

/* ---------- Mode Survie ---------- */
function survivalView(u) {
  const sv = survival.ensure(u);
  const run = sv.run;
  return {
    best: sv.best, runs: sv.runs,
    run: run ? { round: run.round, hp: run.paused ? ((run.paused.match.players[0] || {}).heroHealth || run.hp) : run.hp, wins: run.wins || 0, startedAt: run.startedAt,
      paused: run.paused ? { at: run.paused.at, turn: run.paused.match.turnNumber, botHp: (run.paused.match.players[1] || {}).heroHealth } : null,
      deck: run.deck.map(id => db.cardById(id)).filter(Boolean) } : null,
    next: run ? survival.roundConfig(run.round) : survival.roundConfig(1),
    top: survival.leaderboard(db.allUsers(), 3),
    rules: { startHp: survival.START_HP, heal: survival.HEAL_BETWEEN, milestoneEvery: survival.MILESTONE_EVERY }
  };
}
function settleSurvivalMatch(slug, round, match) {
  const u = db.getUser(slug);
  if (!u) return null;
  ensureProfileFields(u);
  if (!u.survival.run || u.survival.run.round !== round) return null; // partie abandonnée entre-temps
  const human = match.players[0];
  const won = match.winner === human.slug;
  const res = survival.recordResult(u, won, human.heroHealth);
  if (res && res.milestone) { u.credits += res.milestone.credits; u.dust += res.milestone.dust; }
  if (res && res.won) recordSecrets(u, { survival_round: res.round });
  db.updateUser(u.slug, u);
  return { winnerSlug: won ? human.slug : null, survivalResult: res };
}
/* Pause d'un combat de Survie : le combat est enregistré dans la partie du
   joueur et retiré du serveur ; il reprendra exactement au même endroit.
   Possible seulement pendant le tour du joueur (pas pendant celui du bot). */
function pauseSurvival(matchId, entry) {
  const m = entry.match;
  if (m.status !== 'active') return { error: 'Le combat est terminé.' };
  if (entry.botTurnRunning || m.turn !== 0) { entry.pendingPause = true; return { error: 'Attends ton tour pour mettre en pause.' }; }
  const u = db.getUser(m.players[0].slug);
  if (!u) return { error: 'Joueur introuvable.' };
  ensureProfileFields(u);
  const run = u.survival.run;
  if (!run || !entry.survival || run.round !== entry.survival.round) return { error: 'Aucune partie de Survie en cours.' };
  const saved = JSON.parse(JSON.stringify(m, (k, v) => (k === '__pool' ? undefined : v)));
  saved.events = (saved.events || []).slice(-200);
  run.paused = { match: saved, round: run.round, at: Date.now() };
  const sock = entry.sockets[0];
  mm.detachMatch(matchId);
  db.updateUser(u.slug, u);
  if (sock && sock.connected) sock.emit('survival:paused', { round: run.round });
  return { ok: true };
}
// Déconnexion pendant un combat de Survie : mise en pause automatique (dès que c'est le tour du joueur)
mm.setSurvivalDisconnectHandler((matchId, entry) => { entry.pendingPause = true; pauseSurvival(matchId, entry); });
function maybePendingPause(matchId, entry) {
  if (!entry.pendingPause || !entry.survival) return;
  const sock = entry.sockets[0];
  if (sock && sock.connected) { entry.pendingPause = false; return; } // le joueur est revenu
  pauseSurvival(matchId, entry);
}
app.get('/api/survival', requireAuth, (req, res) => {
  const u = ensureProfileFields(db.getUser(req.session.userSlug));
  res.json(survivalView(u));
});
app.post('/api/survival/start', requireAuth, (req, res) => {
  const u = ensureProfileFields(db.getUser(req.session.userSlug));
  const r = survival.start(u, playablePool(), COPY_LIMITS);
  if (r.error) return res.status(400).json(r);
  db.updateUser(u.slug, u);
  res.json(survivalView(u));
});
app.post('/api/survival/abandon', requireAuth, (req, res) => {
  const u = ensureProfileFields(db.getUser(req.session.userSlug));
  const r = survival.abandon(u);
  if (r.error) return res.status(400).json(r);
  db.updateUser(u.slug, u);
  res.json(survivalView(u));
});

/* ---------- Puzzle du jour ---------- */
function grantBooster(u, n) {
  const ext = db.extensionById('base') || { id: 'base', name: 'Édition de Base' };
  if (!Array.isArray(u.boosterInventory)) u.boosterInventory = [];
  for (let i = 0; i < (n || 1); i++) u.boosterInventory.push({ id: 'inv-' + uuidv4().slice(0, 10), extensionId: ext.id, extensionName: ext.name, acquiredAt: Date.now() });
}
function settlePuzzleMatch(slug, day, match) {
  const u = db.getUser(slug);
  if (!u) return null;
  ensureProfileFields(u);
  const human = match.players[0];
  const won = match.winner === human.slug;
  if (!won) return { winnerSlug: null, puzzleResult: { won: false } };
  if (puzzle.dayKey() !== day) return { winnerSlug: human.slug, puzzleResult: { won: true, expired: true } }; // puzzle de la veille
  const res = puzzle.recordSolve(u);
  if (res && res.reward) {
    u.credits += res.reward.credits; u.dust += res.reward.dust;
    progression.grantXp(u, res.reward.xp, 'puzzle', applyLevelReward);
    if (res.reward.booster) grantBooster(u, 1);
  }
  db.updateUser(u.slug, u);
  return { winnerSlug: human.slug, puzzleResult: Object.assign({ won: true }, res || {}) };
}
app.get('/api/puzzle', requireAuth, (req, res) => {
  const u = ensureProfileFields(db.getUser(req.session.userSlug));
  res.json(puzzle.view(u, playablePool()));
});
app.post('/api/puzzle/reveal', requireAuth, (req, res) => {
  const u = ensureProfileFields(db.getUser(req.session.userSlug));
  if (mm.activeMatchOf(u.slug)) return res.status(400).json({ error: 'Termine ton combat en cours avant.' });
  puzzle.reveal(u);
  db.updateUser(u.slug, u);
  res.json(puzzle.view(u, playablePool()));
});
app.post('/api/admin/puzzle/regenerate', (req, res) => {
  if ((req.body || {}).code !== ADMIN_CODE) return res.status(403).json({ error: 'Code admin incorrect.' });
  const d = puzzle.regenerate(playablePool());
  if (!d.puzzle) return res.status(400).json({ error: "Impossible de fabriquer un puzzle avec les cartes actuelles." });
  res.json({ ok: true, puzzle: d.puzzle });
});

/* ---------- Bagarre de la semaine ---------- */
const BRAWL_FILE = 'brawl.json';
function brawlOverride() {
  const b = require('./src/store').readJSON(BRAWL_FILE, null) || {};
  return b.override && b.override.week === community.weekKey() ? b.override.rule : null;
}
function settleBrawlMatch(slug, week, match) {
  const u = db.getUser(slug);
  if (!u) return null;
  ensureProfileFields(u);
  const human = match.players[0];
  const won = match.winner === human.slug;
  if (community.weekKey() !== week) return { winnerSlug: won ? human.slug : null }; // la semaine a changé pendant le combat
  const res = brawl.recordResult(u, won);
  if (res.reward) {
    if (res.reward.credits) u.credits += res.reward.credits;
    if (res.reward.dust) u.dust += res.reward.dust;
    if (res.reward.booster) grantBooster(u, res.reward.booster);
  }
  db.updateUser(u.slug, u);
  return { winnerSlug: won ? human.slug : null, brawlResult: res };
}
app.get('/api/brawl', requireAuth, (req, res) => {
  const u = ensureProfileFields(db.getUser(req.session.userSlug));
  res.json(Object.assign(brawl.view(u, null, brawlOverride()), { rules: brawl.RULES }));
});
app.post('/api/admin/brawl/rule', (req, res) => {
  const b = req.body || {};
  if (b.code !== ADMIN_CODE) return res.status(403).json({ error: 'Code admin incorrect.' });
  if (b.rule && !brawl.RULES.some(r => r.id === b.rule)) return res.status(400).json({ error: 'Règle inconnue.' });
  require('./src/store').writeJSON(BRAWL_FILE, { override: b.rule ? { week: community.weekKey(), rule: b.rule } : null });
  res.json({ ok: true });
});

/* ---------- Mode Draft (Arène) ---------- */
function draftView(u) {
  const d = draft.ensure(u), run = d.run;
  const card = id => db.cardById(id);
  return {
    best: d.best, runs: d.runs, history: d.history.slice(0, 5), free: draft.freeAvailable(u), price: draft.ENTRY_PRICE,
    rules: { deckSize: draft.DECK_SIZE, maxWins: draft.MAX_WINS, maxLosses: draft.MAX_LOSSES, specialPicks: draft.SPECIAL_PICKS },
    rewardTable: [0, 3, 5, 7, 9, 12].map(w => Object.assign({ wins: w }, draft.rewardsFor(w))),
    run: run ? {
      picks: run.picks.map(card).filter(Boolean), offer: (run.offer || []).map(card).filter(Boolean),
      wins: run.wins, losses: run.losses, startedAt: run.startedAt,
      next: draft.botConfig(run.wins), rewardsNow: draft.rewardsFor(run.wins)
    } : null,
    top: draft.leaderboard(db.allUsers(), 3)
  };
}
/* Récompenses de fin de Draft (crédits, poussière, boosters, titre) */
function grantDraftRewards(u, r) {
  if (!r) return;
  u.credits = (u.credits || 0) + r.credits;
  u.dust = (u.dust || 0) + r.dust;
  const ext = db.extensionById('base') || { id: 'base', name: 'Édition de Base' };
  if (!Array.isArray(u.boosterInventory)) u.boosterInventory = [];
  for (let i = 0; i < r.boosters; i++) u.boosterInventory.push({ id: 'inv-' + uuidv4().slice(0, 10), extensionId: ext.id, extensionName: ext.name, acquiredAt: Date.now() });
  if (r.title) career.grantTitle(u, { name: r.title, source: 'Mode Draft' });
}
function settleDraftMatch(slug, startedAt, match) {
  const u = db.getUser(slug);
  if (!u) return null;
  ensureProfileFields(u);
  const run = u.draft.run;
  if (!run || run.startedAt !== startedAt) return null; // Draft abandonné entre-temps
  const human = match.players[0];
  const won = match.winner === human.slug;
  const res = draft.recordResult(u, won);
  if (res && res.over) grantDraftRewards(u, res.rewards);
  db.updateUser(u.slug, u);
  return { winnerSlug: won ? human.slug : null, draftResult: res };
}
app.get('/api/draft', requireAuth, (req, res) => {
  const u = ensureProfileFields(db.getUser(req.session.userSlug));
  res.json(draftView(u));
});
app.post('/api/draft/start', requireAuth, (req, res) => {
  const u = ensureProfileFields(db.getUser(req.session.userSlug));
  const r = draft.start(u, playablePool(), COPY_LIMITS);
  if (r.error) return res.status(400).json(r);
  db.updateUser(u.slug, u);
  res.json(Object.assign(draftView(u), { profile: decorateProfile(u) }));
});
app.post('/api/draft/pick', requireAuth, (req, res) => {
  const u = ensureProfileFields(db.getUser(req.session.userSlug));
  const r = draft.pick(u, (req.body || {}).cardId, playablePool(), COPY_LIMITS);
  if (r.error) return res.status(400).json(r);
  db.updateUser(u.slug, u);
  res.json(draftView(u));
});
app.post('/api/draft/abandon', requireAuth, (req, res) => {
  const u = ensureProfileFields(db.getUser(req.session.userSlug));
  if (mm.activeMatchOf(u.slug)) return res.status(400).json({ error: 'Termine ton combat en cours avant.' });
  const r = draft.abandon(u);
  if (r.error) return res.status(400).json(r);
  if (r.rewards) grantDraftRewards(u, r.rewards);
  db.updateUser(u.slug, u);
  res.json(Object.assign(draftView(u), { ended: r, profile: decorateProfile(u) }));
});

/* ---------- Objectif communautaire ---------- */
app.get('/api/community', requireAuth, (req, res) => {
  ensureCommunityWeek();
  const v = community.view(req.session.userSlug);
  if (v) v.top = v.top.map(t => { const u = db.getUser(t.slug); return Object.assign({ pseudo: u ? u.pseudo : t.slug }, t); });
  res.json({ community: v });
});

/* ---------- Cartes favorites ---------- */
app.post('/api/me/favorite', requireAuth, (req, res) => {
  const u = ensureProfileFields(db.getUser(req.session.userSlug));
  const id = String((req.body || {}).cardId || '');
  if (!db.cardById(id)) return res.status(404).json({ error: 'Carte introuvable.' });
  const want = (req.body || {}).on;
  const on = want === undefined ? !u.favoriteCards.includes(id) : !!want; // sans précision : on bascule
  u.favoriteCards = u.favoriteCards.filter(x => x !== id);
  if (on) u.favoriteCards.push(id);
  recordSecrets(u, { favorites: u.favoriteCards.length });
  db.updateUser(u.slug, u);
  res.json({ ok: true, favoriteCards: u.favoriteCards });
});

/* ---------- Bannières de profil ---------- */
app.get('/api/banners', requireAuth, (req, res) => res.json({ banners: banners.catalog() }));
app.post('/api/me/banner', requireAuth, (req, res) => {
  const u = ensureProfileFields(db.getUser(req.session.userSlug));
  const id = (req.body || {}).bannerId || null;
  if (id && !u.ownedBanners.includes(id)) return res.status(400).json({ error: "Tu ne possèdes pas cette bannière." });
  u.banner = id;
  db.updateUser(u.slug, u);
  res.json({ ok: true, profile: decorateProfile(u) });
});
app.post('/api/shop/buy-banner', requireAuth, (req, res) => {
  const u = ensureProfileFields(db.getUser(req.session.userSlug));
  const b = banners.byId((req.body || {}).bannerId);
  if (!b || b.source !== 'shop') return res.status(400).json({ error: "Cette bannière n'est pas en vente." });
  if (u.ownedBanners.includes(b.id)) return res.status(400).json({ error: 'Tu as déjà cette bannière.' });
  if ((u.credits || 0) < b.price) return res.status(400).json({ error: 'Pas assez de crédits.' });
  u.credits -= b.price;
  u.stats.creditsSpent = (u.stats.creditsSpent || 0) + b.price;
  banners.grant(u, b.id);
  if (!u.banner) u.banner = b.id;
  recordSecrets(u, {});
  awardAchievements(u);
  db.updateUser(u.slug, u);
  res.json({ ok: true, profile: decorateProfile(u) });
});

/* ---------- Vitrine du jour (boutique) ---------- */
const showcase = require('./src/showcase');
function showcaseView(u, now) {
  const key = showcase.dayKey(now);
  const bought = (u.showcaseBought && u.showcaseBought.day === key) ? u.showcaseBought.slots : [];
  const slots = showcase.forDay(key, { extensions: db.getExtensions(), cardPool: db.getCardPool(), banners: banners.BANNERS, emotes: db.getEmotePool() })
    .map(s => {
      const owned = s.slot === 'banner' ? (u.ownedBanners || []).includes(s.id)
        : s.slot === 'emote' ? (u.ownedEmotes || []).includes(s.id) : false;
      const v = Object.assign({}, s, { owned, bought: bought.includes(s.slot) });
      delete v.emote;
      return v;
    });
  return { day: key, endsAt: showcase.endsAt(now), discount: showcase.DISCOUNT, slots };
}
app.get('/api/shop/daily', requireAuth, (req, res) => {
  const u = ensureProfileFields(db.getUser(req.session.userSlug));
  banners.ensure(u);
  res.json(showcaseView(u));
});
app.post('/api/shop/daily/buy', requireAuth, (req, res) => {
  const u = ensureProfileFields(db.getUser(req.session.userSlug));
  banners.ensure(u);
  const view = showcaseView(u);
  const s = view.slots.find(x => x.slot === (req.body || {}).slot);
  if (!s) return res.status(400).json({ error: "Cet article n'est plus dans la vitrine." });
  // Le client envoie l'id vu à l'écran : si la vitrine a changé à minuit, on refuse plutôt que d'acheter autre chose
  if ((req.body || {}).id && req.body.id !== s.id) return res.status(409).json({ error: 'La vitrine vient de changer, regarde les nouveaux articles !', daily: view });
  if (s.bought) return res.status(400).json({ error: "Tu as déjà acheté cet article aujourd'hui." });
  if (s.owned) return res.status(400).json({ error: 'Tu le possèdes déjà.' });
  const wallet = s.currency === 'credits' ? 'credits' : 'dust';
  if ((u[wallet] || 0) < s.price) return res.status(400).json({ error: `Il te manque ${s.price - (u[wallet] || 0)} ${wallet === 'credits' ? 'crédits' : 'poussière'}.` });
  u[wallet] -= s.price;
  if (wallet === 'credits') u.stats.creditsSpent = (u.stats.creditsSpent || 0) + s.price;
  else u.stats.dustSpent = (u.stats.dustSpent || 0) + s.price;
  if (s.slot === 'booster') {
    const ext = db.extensionById(s.id);
    if (!Array.isArray(u.boosterInventory)) u.boosterInventory = [];
    u.boosterInventory.push({ id: 'inv-' + uuidv4().slice(0, 10), extensionId: s.id, extensionName: ext ? ext.name : s.name, acquiredAt: Date.now() });
  } else if (s.slot === 'banner') {
    banners.grant(u, s.id);
    if (!u.banner) u.banner = s.id;
    recordSecrets(u, {});
  } else if (s.slot === 'emote') {
    u.ownedEmotes.push(s.id);
  }
  if (!u.showcaseBought || u.showcaseBought.day !== view.day) u.showcaseBought = { day: view.day, slots: [] };
  u.showcaseBought.slots.push(s.slot);
  const unlockedAchievements = awardAchievements(u);
  db.updateUser(u.slug, u);
  res.json({ ok: true, profile: decorateProfile(u), daily: showcaseView(u), unlockedAchievements });
});

/* ---------- Plateaux de combat ---------- */
app.get('/api/boards', requireAuth, (req, res) => res.json({ boards: boards.catalog() }));
app.post('/api/shop/buy-board', requireAuth, (req, res) => {
  const u = ensureProfileFields(db.getUser(req.session.userSlug));
  const b = boards.byId((req.body || {}).boardId);
  if (!b || b.enabled === false) return res.status(400).json({ error: "Ce plateau n'est pas en vente." });
  if (boards.owns(u, b.id)) return res.status(400).json({ error: 'Tu as déjà ce plateau.' });
  if ((u.credits || 0) < b.price) return res.status(400).json({ error: `Il te manque ${b.price - (u.credits || 0)} crédits.` });
  u.credits -= b.price;
  u.stats.creditsSpent = (u.stats.creditsSpent || 0) + b.price;
  boards.grant(u, b.id);
  u.board = b.id; // on l'équipe tout de suite
  const unlockedAchievements = awardAchievements(u);
  db.updateUser(u.slug, u);
  res.json({ ok: true, profile: decorateProfile(u), unlockedAchievements });
});
app.post('/api/me/board', requireAuth, (req, res) => {
  const u = ensureProfileFields(db.getUser(req.session.userSlug));
  const id = (req.body || {}).boardId || boards.DEFAULT_ID;
  if (!boards.owns(u, id) || (id !== boards.DEFAULT_ID && !boards.byId(id))) return res.status(400).json({ error: "Tu ne possèdes pas ce plateau." });
  u.board = id;
  db.updateUser(u.slug, u);
  res.json({ ok: true, profile: decorateProfile(u) });
});
// Admin : ajouter, modifier (nom, prix, image, en vente ou non) et supprimer des plateaux
const BOARD_FIELDS = [{ name: 'image', maxCount: 1 }, { name: 'imageMobile', maxCount: 1 }];
const boardFile = (req, k) => (req.files && req.files[k] && req.files[k][0]) || null;
const dropUpload = req => ['image', 'imageMobile'].forEach(k => { const f = boardFile(req, k); if (f) fs.unlink(f.path, () => {}); });
app.post('/api/admin/boards/list', (req, res) => {
  if ((req.body || {}).code !== ADMIN_CODE) return res.status(403).json({ error: 'Code admin incorrect.' });
  const owners = {};
  db.allUsers().forEach(u => (u.ownedBoards || []).forEach(id => { owners[id] = (owners[id] || 0) + 1; }));
  res.json({ boards: boards.all().map(b => Object.assign({ owners: owners[b.id] || 0 }, b)) });
});
app.post('/api/admin/boards', (req, res) => {
  uploadBoard.fields(BOARD_FIELDS)(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    const b = req.body || {};
    if (b.code !== ADMIN_CODE) { dropUpload(req); return res.status(403).json({ error: 'Code admin incorrect.' }); }
    const pc = boardFile(req, 'image'), mob = boardFile(req, 'imageMobile');
    if (!pc) { dropUpload(req); return res.status(400).json({ error: "Ajoute au moins l'image PC du plateau (PNG, JPG ou WEBP)." }); }
    const r = boards.add({ name: b.name, price: b.price, image: '/uploads/boards/' + pc.filename, imageMobile: mob ? '/uploads/boards/' + mob.filename : null });
    if (r.error) { dropUpload(req); return res.status(400).json(r); }
    res.json({ ok: true, board: r.board });
  });
});
app.post('/api/admin/boards/update', (req, res) => {
  uploadBoard.fields(BOARD_FIELDS)(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    const b = req.body || {};
    if (b.code !== ADMIN_CODE) { dropUpload(req); return res.status(403).json({ error: 'Code admin incorrect.' }); }
    const patch = {};
    if (b.name !== undefined) patch.name = b.name;
    if (b.price !== undefined) patch.price = b.price;
    if (b.enabled !== undefined) patch.enabled = b.enabled === true || b.enabled === 'true';
    const pc = boardFile(req, 'image'), mob = boardFile(req, 'imageMobile');
    if (pc) patch.image = '/uploads/boards/' + pc.filename;
    if (mob) patch.imageMobile = '/uploads/boards/' + mob.filename;
    if (b.removeMobile === 'true' && !mob) patch.removeMobile = true;
    const r = boards.update(b.id, patch);
    if (r.error) { dropUpload(req); return res.status(400).json(r); }
    res.json(r);
  });
});
app.post('/api/admin/boards/delete', (req, res) => {
  const b = req.body || {};
  if (b.code !== ADMIN_CODE) return res.status(403).json({ error: 'Code admin incorrect.' });
  const r = boards.remove(b.id);
  if (r.error) return res.status(400).json(r);
  // Les joueurs qui l'avaient le perdent et reviennent au plateau classique
  db.allUsers().forEach(u => {
    if (!(u.ownedBoards || []).includes(b.id) && u.board !== b.id) return;
    u.ownedBoards = (u.ownedBoards || []).filter(x => x !== b.id);
    if (u.board === b.id) u.board = boards.DEFAULT_ID;
    db.updateUser(u.slug, u);
  });
  res.json({ ok: true });
});

/* ---------- Succès secrets ---------- */
app.get('/api/secrets', requireAuth, (req, res) => {
  const u = ensureProfileFields(db.getUser(req.session.userSlug));
  res.json(secrets.viewFor(u));
});

/* ---------- Stats de deck : bilan enregistré à la fin de chaque combat ---------- */
const deckstats = require('./src/deckstats');
const DECK_REPORTS_MAX = 20;
const replays = require('./src/replays');
/* Mode d'un combat (stats, XP, succès) */
function matchModeOf(entry) {
  if (entry.story) return 'story';
  if (entry.tournamentRef) return 'tournament';
  if (entry.practice) return 'practice';
  if (entry.isBossFight) return 'boss';
  if (entry.survival) return 'survival';
  if (entry.draft) return 'draft';
  if (entry.duel || entry.draftDuel) return 'duel'; // duel amical (Bagarre ou Draft) entre deux amis
  if (entry.brawl) return 'brawl';
  if (entry.isBot) return 'bot';
  if (entry.blitz) return 'blitz';
  return 'pvp';
}
mm.setMatchReportHandler((entry) => {
  const out = {};
  if (entry.sandbox || entry.puzzle) return out; // bac à sable de l'admin et puzzle : ne comptent nulle part
  const mode = matchModeOf(entry);
  try { replays.finalize(entry, mode); } catch (e) { console.error('Replay :', e.message); }
  entry.match.players.forEach((p, i) => {
    const user = db.getUser(p.slug);
    if (!user) return; // le bot ou le boss
    const report = deckstats.analyzeMatch(entry.match, i, mode);
    // La Survie joue avec un deck tiré au hasard : pas de bilan dans « Stats du deck »
    if (!['survival', 'draft', 'brawl', 'duel'].includes(mode)) user.deckReports = [report].concat(user.deckReports || []).slice(0, DECK_REPORTS_MAX);
    const opp = entry.match.players[1 - i];
    career.recordMatch(user, report, { slug: opp.slug, pseudo: opp.pseudo });
    progressAfterMatch(user, report);
    // Succès secrets et objectif communautaire (pas pour l'entraînement depuis le constructeur)
    if (mode !== 'practice') {
      recordSecrets(user, secrets.analyzeMatch(entry.match, i, mode));
      const won = entry.match.winner === user.slug;
      const sum = k => Object.values(report.perCard || {}).reduce((a, s) => a + (Number(s[k]) || 0), 0);
      const pool = db.getCardPool();
      const playedOf = type => Object.keys(report.perCard || {}).reduce((a, id) => { const c = pool.find(x => x.id === id); const t = c ? (c.type === 'minion' ? 'minion' : c.type === 'weapon' ? 'weapon' : 'spell') : null; return a + (t === type ? (report.perCard[id].played || 0) : 0); }, 0);
      communityContribute(user, { play_games: 1, win_games: won ? 1 : 0, destroy_minions: sum('kills'), deal_damage: sum('damage'),
        play_spells: playedOf('spell'), play_minions: playedOf('minion'), survival_rounds: mode === 'survival' && won ? 1 : 0 });
    }
    db.updateUser(user.slug, user);
    if (!['survival', 'draft', 'brawl', 'duel'].includes(mode)) out[p.slug] = report.id;
  });
  return out;
});

/* Replays : liste de mes combats et lecture d'un combat (seulement si j'y ai joué) */
app.get('/api/replays', requireAuth, (req, res) => res.json({ replays: replays.listFor(req.session.userSlug).slice(0, 30) }));
app.get('/api/replays/:id', requireAuth, (req, res) => {
  const r = replays.get(req.params.id);
  if (!r || !r.players.some(p => p.slug === req.session.userSlug)) return res.status(404).json({ error: 'Replay introuvable.' });
  res.json({ replay: r, viewer: req.session.userSlug });
});

/* ======================================================
   EQUILIBRIUM : simulateur d'équilibrage (admin)
   ====================================================== */
const equilibrium = require('./src/equilibrium');
const eqJobs = new Map();
app.post('/api/admin/equilibrium', (req, res) => {
  const b = req.body || {};
  if (b.code !== ADMIN_CODE) return res.status(403).json({ error: 'Code admin incorrect.' });
  if ([...eqJobs.values()].some(j => !j.finished)) return res.status(429).json({ error: 'Une simulation est déjà en cours : attends qu\'elle se termine.' });
  const eqPool = playablePool().concat(db.getCardPool().filter(c => c.id === b.cardId && !isPlayableCard(c)));
  const r = equilibrium.createJob(eqPool, b.cardId, b.games, COPY_LIMITS);
  if (r.error) return res.status(400).json(r);
  eqJobs.set(r.job.id, r.job);
  // on ne garde que les 20 dernières simulations
  [...eqJobs.keys()].slice(0, -20).forEach(k => eqJobs.delete(k));
  res.json({ ok: true, jobId: r.job.id, games: r.job.games });
});
app.get('/api/admin/equilibrium/:id', (req, res) => {
  if (req.query.code !== ADMIN_CODE) return res.status(403).json({ error: 'Code admin incorrect.' });
  const j = eqJobs.get(req.params.id);
  if (!j) return res.status(404).json({ error: 'Simulation introuvable.' });
  res.json({ done: j.done, games: j.games, finished: j.finished, result: j.result || null });
});

/* ======================================================
   IMAGES : optimisation des images DÉJÀ envoyées (admin)
   La conversion en WebP est faite par le NAVIGATEUR de l'admin (aucune
   bibliothèque côté serveur) : le serveur liste les images PNG/JPG, puis
   reçoit chaque version WebP et met à jour les adresses partout.
   ====================================================== */
function imageRefs() {
  const out = [];
  db.getCardPool().forEach(c => ['image', 'parallaxBackground', 'parallaxCharacter'].forEach(k => out.push(c[k])));
  db.getExtensions().forEach(e => out.push(e.packImage, e.backImage));
  db.getOrnaments().forEach(o => out.push(o.image));
  db.allUsers().forEach(u => out.push((db.getUser(u.slug) || {}).avatar));
  return [...new Set(out.filter(u => typeof u === 'string' && /^\/uploads\/[\w-]+\/[\w.-]+\.(png|jpe?g)$/i.test(u)))]
    .filter(u => fs.existsSync(path.join(UPLOAD_ROOT, u.replace(/^\/uploads\//, ''))));
}
app.get('/api/admin/images/list', (req, res) => {
  if (req.query.code !== ADMIN_CODE) return res.status(403).json({ error: 'Code admin incorrect.' });
  res.json({ urls: imageRefs() });
});
const imageReplaceUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(file.mimetype === 'image/webp' ? null : new Error('WebP attendu.'), file.mimetype === 'image/webp') });
app.post('/api/admin/images/replace', (req, res) => {
  imageReplaceUpload.single('image')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    const b = req.body || {};
    if (b.code !== ADMIN_CODE) return res.status(403).json({ error: 'Code admin incorrect.' });
    const url = String(b.url || '');
    if (!imageRefs().includes(url) || !req.file) return res.status(400).json({ error: 'Image inconnue.' });
    const rel = url.replace(/^\/uploads\//, '');
    const oldFile = path.join(UPLOAD_ROOT, rel);
    const newRel = rel.replace(/\.(png|jpe?g)$/i, '.webp');
    fs.writeFileSync(path.join(UPLOAD_ROOT, newRel), req.file.buffer);
    const newUrl = '/uploads/' + newRel;
    // Mise à jour de toutes les références à cette image
    db.getCardPool().forEach(c => { const p = {}; ['image', 'parallaxBackground', 'parallaxCharacter'].forEach(k => { if (c[k] === url) p[k] = newUrl; }); if (Object.keys(p).length) db.updateCard(c.id, p); });
    db.getExtensions().forEach(e => { const p = {}; ['packImage', 'backImage'].forEach(k => { if (e[k] === url) p[k] = newUrl; }); if (Object.keys(p).length) db.updateExtension(e.id, p); });
    db.getOrnaments().forEach(o => { if (o.image === url) db.updateOrnament(o.id, { image: newUrl }); });
    db.allUsers().forEach(u => { const full = db.getUser(u.slug); if (full && full.avatar === url) { full.avatar = newUrl; db.updateUser(full.slug, full); } });
    try { fs.unlinkSync(oldFile); } catch (e) {}
    res.json({ ok: true, url: newUrl });
  });
});

/* ======================================================
   CHAT GÉNÉRAL : derniers messages gardés sur le disque, anti-spam simple
   ====================================================== */
const CHAT_HISTORY = 60, CHAT_KEEP = 200, CHAT_MAX_LEN = 200, CHAT_COOLDOWN_MS = 1200;
const chatStore = require('./src/store');
let chatLog = chatStore.readJSON('chat.json', []);
if (!Array.isArray(chatLog)) chatLog = [];
let chatSaveTimer = null;
function saveChat() { clearTimeout(chatSaveTimer); chatSaveTimer = setTimeout(() => chatStore.writeJSON('chat.json', chatLog), 1500); }
const chatLastSent = new Map();

/* ======================================================
   PROGRAMMATION (admin) : actions déclenchées automatiquement à une date
   Ex. « ouvrir le chapitre 3 samedi à 18 h », « lancer le tournoi »,
   « afficher l'onglet Événements ». Vérifié toutes les 20 secondes.
   ====================================================== */
const scheduleStore = require('./src/store');
let schedule = scheduleStore.readJSON('schedule.json', []);
if (!Array.isArray(schedule)) schedule = [];
const saveSchedule = () => scheduleStore.writeJSON('schedule.json', schedule);
const SCHEDULE_ACTIONS = {
  story_chapter_open: { label: 'Ouvrir un chapitre du mode Histoire', run: p => {
    const chs = storyChapters(); const ch = chs.find(c => c.id === p.chapterId);
    if (!ch) throw new Error('Chapitre introuvable.');
    story.setChapters(chs.map(c => c.id === ch.id ? Object.assign({}, c, { enabled: true }) : c));
    if (p.alsoTab) story.setTabEnabled(true);
    io.emit('story:update');
    return `Chapitre « ${ch.title} » ouvert.`;
  } },
  extension_publish: { label: 'Publier une extension cachée', run: p => {
    const e = db.extensionById(p.extensionId); if (!e) throw new Error('Extension introuvable.');
    db.updateExtension(e.id, { hidden: false }); io.emit('extensions:update');
    return `Extension « ${e.name} » publiée.`;
  } },
  story_tab: { label: "Afficher / masquer l'onglet Histoire", run: p => { story.setTabEnabled(!!p.enabled); io.emit('story:update'); return p.enabled ? 'Onglet Histoire affiché.' : 'Onglet Histoire masqué.'; } },
  tournament_tab: { label: "Afficher / masquer l'onglet Tournoi", run: p => { tournament.setTabEnabled(!!p.enabled); broadcastTournament(); return p.enabled ? 'Onglet Tournoi affiché.' : 'Onglet Tournoi masqué.'; } },
  tournament_start: { label: 'Lancer le tournoi en cours', run: () => {
    const r = tournament.start(); if (r.error) throw new Error(r.error);
    broadcastTournament(); return 'Tournoi lancé.';
  } },
  events_tab: { label: "Afficher / masquer l'onglet Événements", run: p => { db.updateEvents({ tabEnabled: !!p.enabled }); io.emit('events:update'); return p.enabled ? 'Onglet Événements affiché.' : 'Onglet Événements masqué.'; } }
};
function runDueSchedule() {
  const now = Date.now();
  let changed = false;
  schedule.filter(t => t.status === 'pending' && t.at <= now).forEach(t => {
    try { t.result = SCHEDULE_ACTIONS[t.action].run(t.params || {}); t.status = 'done'; }
    catch (e) { t.status = 'error'; t.result = e.message; }
    t.doneAt = now; changed = true;
    console.log(`[programmation] ${t.label} → ${t.status} : ${t.result}`);
  });
  if (changed) saveSchedule();
}
setInterval(runDueSchedule, 20000);
setTimeout(runDueSchedule, 3000); // au démarrage : rattrape ce qui aurait dû se faire pendant un arrêt
app.get('/api/admin/schedule', (req, res) => {
  if (req.query.code !== ADMIN_CODE) return res.status(403).json({ error: 'Code admin incorrect.' });
  res.json({ tasks: schedule.slice().sort((a, b) => a.at - b.at), actions: Object.fromEntries(Object.entries(SCHEDULE_ACTIONS).map(([k, v]) => [k, v.label])), now: Date.now() });
});
app.post('/api/admin/schedule', (req, res) => {
  const b = req.body || {};
  if (b.code !== ADMIN_CODE) return res.status(403).json({ error: 'Code admin incorrect.' });
  if (b.deleteId) { schedule = schedule.filter(t => t.id !== b.deleteId); saveSchedule(); return res.json({ ok: true }); }
  if (!SCHEDULE_ACTIONS[b.action]) return res.status(400).json({ error: 'Action inconnue.' });
  const at = Number(b.at);
  if (!Number.isFinite(at) || at < Date.now() - 60000) return res.status(400).json({ error: 'Choisis une date dans le futur.' });
  const params = b.params && typeof b.params === 'object' ? b.params : {};
  let label = SCHEDULE_ACTIONS[b.action].label;
  if (b.action === 'story_chapter_open') { const ch = storyChapters().find(c => c.id === params.chapterId); if (!ch) return res.status(400).json({ error: 'Choisis un chapitre.' }); label = `Ouvrir le chapitre « ${ch.title} »`; }
  if (b.action === 'extension_publish') { const e = db.extensionById(params.extensionId); if (!e) return res.status(400).json({ error: 'Choisis une extension.' }); label = `Publier l'extension « ${e.name} »`; }
  if (['story_tab', 'tournament_tab', 'events_tab'].includes(b.action)) label = label.replace('Afficher / masquer', params.enabled ? 'Afficher' : 'Masquer');
  schedule.push({ id: 'sch-' + uuidv4().slice(0, 8), at, action: b.action, params, label, status: 'pending', createdAt: Date.now() });
  saveSchedule();
  res.json({ ok: true });
});

/* ======================================================
   SIGNALEMENTS DE BUGS
   Un joueur décrit le problème ; on enregistre avec lui la partie en cours
   (photo du plateau, dernières actions, journal) pour pouvoir comprendre.
   Le replay du combat est retrouvé une fois la partie terminée.
   ====================================================== */
const { readJSON: readStore, writeJSON: writeStore } = require('./src/store');
let bugReports = readStore('bug-reports.json', []);
if (!Array.isArray(bugReports)) bugReports = [];
const saveBugs = () => writeStore('bug-reports.json', bugReports);
app.post('/api/bug-report', requireAuth, (req, res) => {
  const user = db.getUser(req.session.userSlug);
  const text = String((req.body || {}).text || '').trim().slice(0, 2000);
  if (text.length < 5) return res.status(400).json({ error: 'Décris le problème en quelques mots.' });
  const recent = bugReports.filter(r => r.slug === user.slug && Date.now() - r.at < 60000).length;
  if (recent >= 3) return res.status(429).json({ error: 'Merci ! Attends une minute avant un nouveau signalement.' });
  const sock = mm.socketFor(user.slug);
  const found = sock ? mm.getMatchForSocket(sock) : null;
  let match = null;
  if (found) {
    const m = found.entry.match;
    const st = game.redactStateFor(m, db.getCardPool(), found.playerIndex);
    match = { matchId: m.id, status: m.status, turnNumber: m.turnNumber, yourTurn: st.yourTurn, mode: matchModeOf(found.entry),
      opponent: st.opponent.pseudo, snapshot: replays.snapshot(m), you: { mana: st.you.mana, hand: st.you.hand.map(c => c.name), board: st.you.board.map(x => ({ name: x.name, attack: x.attack, health: x.health, canAttack: x.canAttack, sickness: x.sickness, asleep: !!x.asleep, attacksLeft: x.attacksLeft })) },
      lastEvents: (m.events || []).slice(-15), log: m.log.slice(-15) };
  }
  const report = { id: 'bug-' + uuidv4().slice(0, 8), at: Date.now(), slug: user.slug, pseudo: user.pseudo, text,
    client: String((req.body || {}).client || '').slice(0, 300), screen: String((req.body || {}).screen || '').slice(0, 40),
    clientState: (req.body || {}).clientState && typeof req.body.clientState === 'object' ? JSON.stringify(req.body.clientState).slice(0, 2000) : null,
    match, status: 'open' };
  bugReports.unshift(report);
  bugReports = bugReports.slice(0, 300);
  saveBugs();
  res.json({ ok: true, id: report.id });
});
app.get('/api/admin/bug-reports', (req, res) => {
  if (req.query.code !== ADMIN_CODE) return res.status(403).json({ error: 'Code admin incorrect.' });
  res.json({ reports: bugReports.map(r => Object.assign({}, r, { replayId: r.match ? (replays.byMatch(r.match.matchId) || {}).id || null : null })) });
});
app.post('/api/admin/bug-reports/:id', (req, res) => {
  const b = req.body || {};
  if (b.code !== ADMIN_CODE) return res.status(403).json({ error: 'Code admin incorrect.' });
  if (b.delete) bugReports = bugReports.filter(r => r.id !== req.params.id);
  else { const r = bugReports.find(x => x.id === req.params.id); if (!r) return res.status(404).json({ error: 'Signalement introuvable.' }); r.status = b.status === 'resolved' ? 'resolved' : 'open'; }
  saveBugs();
  res.json({ ok: true });
});
/* L'admin peut revoir le combat d'un signalement */
app.get('/api/admin/replays/:id', (req, res) => {
  if (req.query.code !== ADMIN_CODE) return res.status(403).json({ error: 'Code admin incorrect.' });
  const r = replays.get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Replay introuvable.' });
  res.json({ replay: r, viewer: req.query.viewer || r.players[0].slug });
});

/* Analyse d'un deck + suggestions + bilans des combats joués avec ce deck */
app.post('/api/deck/analysis', requireAuth, (req, res) => {
  const user = ensureProfileFields(db.getUser(req.session.userSlug));
  const pool = db.getCardPool();
  const ids = Array.isArray((req.body || {}).cardIds) && req.body.cardIds.length ? req.body.cardIds.filter(id => db.cardById(id)) : (user.deck || []);
  const analysis = deckstats.analyzeDeck(ids, pool);
  const suggestions = deckstats.suggestCards(ids, playablePool(), user.collection, analysis, COPY_LIMITS);
  const key = list => list.slice().sort().join(',');
  const reports = user.deckReports || [];
  const sameDeck = reports.filter(r => key(r.deck || []) === key(ids));
  res.json({ analysis, suggestions, reports, sameDeckCount: sameDeck.length,
    aggregate: deckstats.aggregateReports(sameDeck.length ? sameDeck : reports), aggregateScope: sameDeck.length ? 'deck' : 'all' });
});

// Temps écoulé pendant le tour du joueur contre le bot : c'est au bot de jouer
mm.setTurnTimeoutHandler((matchId, entry) => {
  if (entry.isBot && entry.match.status === 'active' && entry.match.turn === 1) runBotTurnAnimated({ entry, matchId });
});

function runBotTurnAnimated(found) {
  const entry = found.entry;
  if (entry.botTurnRunning) return; // un seul tour du bot à la fois
  entry.botTurnRunning = true;
  const it = bot.botTurnSteps(entry.match, db.getCardPool());
  const step = () => {
    let r;
    try { r = it.next(); } catch (e) { console.error('Tour du bot :', e.message); r = { done: true }; }
    mm.broadcastState(found.matchId, db.getCardPool(), io);
    if (r.done || entry.match.status !== 'active') {
      entry.botTurnRunning = false;
      // Filet de sécurité : si le tour du bot s'est arrêté sans se terminer (erreur
      // sur une carte), on le termine pour ne jamais bloquer le joueur.
      if (entry.match.status === 'active' && entry.match.turn === 1) {
        game.endTurn(entry.match);
        mm.broadcastState(found.matchId, db.getCardPool(), io);
      }
      maybePendingPause(found.matchId, entry);
      return;
    }
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
    pseudo: u.pseudo, slug: u.slug, collection: u.collection, bio: u.bio || '', cardShowcase: u.cardShowcase || [], title: u.titleName || null, careerStats: career.summary(u, id => db.cardById(id)),
    avatar: u.avatar, ornament: u.ornament, online: mm.isOnline(u.slug), banner: u.banner || null,
    rank: rankFor(u.seasonVP), seasonVP: u.seasonVP, seasonWins: u.seasonWins, seasonLosses: u.seasonLosses,
    achievementShowcase: showcase, secretCount: (u.secretsUnlocked || []).length, survivalBest: (u.survival || {}).best || 0
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
      online: mm.isOnline(u.slug), rank: rankFor(u.seasonVP), seasonVP: u.seasonVP,
      inMatch: !!mm.activeMatchOf(u.slug), watchable: u.allowSpectate !== false
    };
  }).filter(Boolean);
  res.json({ friends });
});

/* ---------- Mode spectateur ----------
   On peut regarder en direct les combats de ses amis et ceux du tournoi,
   sauf si le joueur a désactivé « Autoriser les spectateurs » dans les Options. */
function spectateFilterFor(viewerSlug) {
  const me = db.getUser(viewerSlug);
  const friends = new Set((me && me.friends) || []);
  return (entry, humans) => {
    if (humans.some(p => p.slug === viewerSlug)) return false; // son propre combat
    if (humans.some(p => { const u = db.getUser(p.slug); return u && u.allowSpectate === false; })) return false;
    return !!entry.tournamentRef || humans.some(p => friends.has(p.slug));
  };
}
app.get('/api/spectate/live', requireAuth, (req, res) => {
  const filter = spectateFilterFor(req.session.userSlug);
  const me = db.getUser(req.session.userSlug) || {};
  const friends = new Set(me.friends || []);
  const list = mm.liveMatches(filter).map(x => Object.assign(x, { tournament: x.mode === 'tournament', friend: x.players.some(p => friends.has(p.slug)) }));
  res.json({ matches: list });
});
app.post('/api/me/allow-spectate', requireAuth, (req, res) => {
  const u = ensureProfileFields(db.getUser(req.session.userSlug));
  u.allowSpectate = !!(req.body || {}).allow;
  db.updateUser(u.slug, u);
  res.json({ ok: true, profile: decorateProfile(u) });
});

/* ---------- Classement ---------- */
app.get('/api/leaderboard', requireAuth, (req, res) => {
  ranking.closeSeasonIfNeeded(db, rankingSettings());
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
  pushIfAway(other.slug, { title: "Proposition d'échange", body: `${me.pseudo} te propose un échange de cartes.`, tag: 'trade-' + trade.id, url: '/' });
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
  recordSecrets(me, { trades_done: 1 }); recordSecrets(requester, { trades_done: 1 });
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
  return { slug: u.slug, pseudo: u.pseudo, avatar: u.avatar, ornament: u.ornament, title: u.titleName || null, deck: u.deck.slice(), emoteWheel: u.emoteWheel.slice() };
}

/* Attribue victoire/défaite et points de victoire à la fin d'un match. */
/* Crédits de fin de combat (réglables dans l'admin). Pour éviter qu'on
   enchaîne des parties abandonnées tout de suite pour farmer des crédits, il
   faut au moins MIN_TURNS_FOR_CREDITS tours joués ; et celui qui abandonne ne
   touche pas la récompense de défaite. */
const MIN_TURNS_FOR_CREDITS = 4;
function matchCredits(match, slug) {
  const st = db.getSettings();
  const win = Math.max(0, Math.round(Number(st.winCredits != null ? st.winCredits : 50) || 0));
  const loss = Math.max(0, Math.round(Number(st.lossCredits != null ? st.lossCredits : 25) || 0));
  if ((match.turnNumber || 0) < MIN_TURNS_FOR_CREDITS) return 0;
  if (match.winner === slug) return win;
  if (match.forfeitBy === slug) return 0;
  return loss; // défaite (ou égalité) au terme d'un vrai combat
}

/* Réglages du classement (Admin → Classement), avec les valeurs par défaut */
function rankingSettings() { return Object.assign({}, RANKING_DEFAULTS, db.getSettings().ranking || {}); }

/* Points gagnés pour un combat entre joueurs :
   victoire = points fixes (×2 pour la 1re victoire du jour) + bonus de série ;
   défaite = quelques points si la partie a duré assez longtemps et sans abandon. */
function matchVP(match, user, won) {
  const rs = rankingSettings();
  if (won) {
    const today = new Date().toDateString();
    const first = user.lastWinDay !== today;
    user.lastWinDay = today;
    user.winStreak = (user.winStreak || 0) + 1;
    const streak = user.winStreak >= rs.streakFrom ? rs.streakBonus : 0;
    const base = rs.vpWin * (first ? rs.firstWinMultiplier : 1);
    return { total: base + streak, base: rs.vpWin, firstWin: first ? base - rs.vpWin : 0, streak, streakCount: user.winStreak };
  }
  user.winStreak = 0;
  const played = (match.turnNumber || 0) >= rs.minLossTurns && match.forfeitBy !== user.slug;
  return { total: played ? rs.vpLoss : 0, loss: true };
}

function settleMatch(match, vpGain, opts) {
  const casual = !!(opts && opts.blitz); // Blitz : crédits et succès, mais pas de points de classement
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
  const creditsPerSlug = {};
  const vpPerSlug = {};
  match.players.forEach(p => {
    const user = db.getUser(p.slug);
    if (!user) return;
    ensureProfileFields(user);
    // Crédits de fin de combat, pour le gagnant ET pour le perdant
    const credits = matchCredits(match, p.slug);
    if (credits > 0) user.credits = (user.credits || 0) + credits;
    creditsPerSlug[p.slug] = credits;
    if (match.winner === null) {
      // égalité : rien d'autre
    } else if (match.winner === p.slug && casual) {
      user.dust += 10; // Blitz : petite récompense, sans classement
    } else if (match.winner === p.slug) {
      user.seasonWins += 1;
      const vp = matchVP(match, user, true);
      user.seasonVP += vp.total; vpPerSlug[p.slug] = vp;
      user.dust += 20; // petite récompense de victoire
      user.stats.totalWins += 1;
      const opponentSlug = match.players.find(x => x.slug !== p.slug).slug;
      user.stats.winsVsPlayer[opponentSlug] = (user.stats.winsVsPlayer[opponentSlug] || 0) + 1;
      trackRankReached(user);

      // Chance (réglable en admin) d'obtenir un booster bonus en gagnant
      const chance = db.getSettings().matchDropChance || 0;
      if (Math.random() * 100 < chance) {
        const eligible = db.getExtensions().filter(e => e.matchDropEligible === true && !e.hidden);
        const candidates = eligible.filter(e => db.getCardPool().some(c => (c.extensionId || 'base') === e.id));
        if (candidates.length > 0) {
          const ext = candidates[Math.floor(Math.random() * candidates.length)];
          const pool = db.getCardPool().filter(c => (c.extensionId || 'base') === ext.id && !c.unobtainable);
          const drawn = rollShiny(user, drawPack(pool)); // mêmes règles qu'un booster normal
          drawn.forEach(c => { user.collection[c.id] = (user.collection[c.id] || 0) + 1; });
          markDiscovered(user, drawn.map(c => c.id));
  progressAfterBoosters(user, 1, drawn); // ouvrir un booster rapporte de l'XP (et compte pour les défis)
          settleResult = { winnerSlug: p.slug, bonusBooster: { extensionName: ext.name, cards: drawn } };
        }
      }
    } else if (casual) {
      // Blitz : une défaite ne change pas le classement
    } else {
      user.seasonLosses += 1;
      const vp = matchVP(match, user, false);
      user.seasonVP += vp.total; vpPerSlug[p.slug] = vp;
      trackRankReached(user);
    }
    const unlocked = awardAchievements(user);
    if (unlocked.length > 0) achievementsPerSlug[user.slug] = unlocked;
    db.updateUser(user.slug, user);
  });
  if (Object.keys(achievementsPerSlug).length > 0) {
    settleResult = settleResult || {};
    settleResult.achievementsPerSlug = achievementsPerSlug;
  }
  settleResult = settleResult || {};
  settleResult.creditsPerSlug = creditsPerSlug;
  settleResult.vpPerSlug = vpPerSlug;
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
  // Retour sur la page pendant un combat : on reprend la partie en cours
  setTimeout(() => { if (socket.connected) mm.rejoinMatch(socket, userSlug, db.getCardPool(), io); }, 300);

  socket.on('queue:join', (opts) => {
    const info = buildPlayerInfo(userSlug);
    if (!info) { socket.emit('queue:error', { error: `Configure un deck de ${DECK_SIZE} cartes avant de combattre.` }); return; }
    const blitz = !!(opts && opts.blitz);
    mm.joinQueue(socket, info, db.getCardPool(), io, blitz ? (m, vp) => settleMatch(m, vp, { blitz: true }) : settleMatch, { blitz });
  });

  // Blitz contre le bot : pour s'entraîner au rythme rapide (ne compte pas dans les stats)
  socket.on('blitz:bot', () => {
    if (busy()) return;
    const info = buildPlayerInfo(userSlug);
    if (!info) { socket.emit('queue:error', { error: `Configure un deck de ${DECK_SIZE} cartes avant de combattre.` }); return; }
    const botInfo = { slug: 'bot', pseudo: 'Bot Blitz', avatar: null, ornament: 'none', deck: bot.buildTestDeck(playablePool()) };
    mm.startBotMatch(socket, info, botInfo, db.getCardPool(), io, null, mm.blitzFields());
  });

  // Survie : mettre en pause le combat en cours (pendant son tour)
  socket.on('survival:pause', () => {
    const found = mm.getMatchForSocket(socket);
    if (!found || !found.entry.survival) { socket.emit('queue:error', { error: "Aucun combat de Survie en cours." }); return; }
    const r = pauseSurvival(found.matchId, found.entry);
    if (r.error) { found.entry.pendingPause = false; socket.emit('queue:error', r); }
  });

  // Survie : combattre la manche en cours avec le deck tiré au hasard
  socket.on('survival:fight', () => {
    const u = ensureProfileFields(db.getUser(userSlug));
    const run = u.survival.run;
    if (!run) { socket.emit('queue:error', { error: 'Lance d’abord une partie de Survie.' }); return; }
    if (busy()) return;
    if (run.paused) {
      // Reprise du combat mis en pause, exactement où il en était
      const saved = run.paused.match, round = run.paused.round;
      delete run.paused; db.updateUser(u.slug, u);
      const id = mm.startBotMatch(socket, null, null, db.getCardPool(), io, (match) => settleSurvivalMatch(u.slug, round, match), { survival: { round }, resumeMatch: saved });
      if (!id) { run.paused = { match: saved, round, at: Date.now() }; db.updateUser(u.slug, u); return; } // refusé : la pause est conservée
      const e = mm.getEntry(id);
      if (e && e.match.status === 'active' && e.match.turn === 1) runBotTurnAnimated({ entry: e, matchId: id });
      return;
    }
    const deck = run.deck.filter(id => db.cardById(id));
    if (deck.length < DECK_SIZE) { // une carte du deck a été supprimée par l'admin : on complète au hasard
      const extra = survival.randomDeck(playablePool(), COPY_LIMITS).filter(id => !deck.includes(id));
      while (deck.length < DECK_SIZE && extra.length) deck.push(extra.shift());
      run.deck = deck; db.updateUser(u.slug, u);
    }
    const cfg = survival.roundConfig(run.round);
    const info = { slug: u.slug, pseudo: u.pseudo, avatar: u.avatar, ornament: u.ornament, title: u.titleName || null, deck: deck.slice(), emoteWheel: (u.emoteWheel || []).slice() };
    const botInfo = { slug: 'bot', pseudo: `${cfg.botName} — manche ${cfg.round}`, avatar: null, ornament: 'none',
      deck: story.bossDeck({ quality: cfg.quality }, playablePool(), COPY_LIMITS) };
    mm.startBotMatch(socket, info, botInfo, db.getCardPool(), io, (match) => settleSurvivalMatch(u.slug, cfg.round, match), {
      survival: { round: cfg.round }, playerHeroHealth: run.hp, opponentHeroHealth: cfg.botHp, opponentArmor: cfg.botArmor, manaBonus: [0, cfg.botMana]
    });
  });

  // Mode spectateur
  socket.on('spectate:join', ({ matchId } = {}) => {
    const ok = mm.liveMatches(spectateFilterFor(userSlug)).some(x => x.matchId === matchId);
    if (!ok) { socket.emit('spectate:error', { error: "Ce combat n'est pas (ou plus) visible." }); return; }
    const r = mm.addSpectator(matchId, socket, db.getCardPool());
    if (r.error) socket.emit('spectate:error', r);
  });
  socket.on('spectate:leave', () => mm.removeSpectator(socket));

  // Puzzle du jour : (re)commencer. Un puzzle déjà en cours est simplement remplacé.
  socket.on('puzzle:start', () => {
    const u = ensureProfileFields(db.getUser(userSlug));
    const active = mm.activeMatchOf(userSlug);
    if (active && active.entry.puzzle) mm.detachMatch(active.matchId);
    else if (busy()) return;
    const pool = db.getCardPool();
    const day = puzzle.today(playablePool());
    if (!day.puzzle) { socket.emit('queue:error', { error: "Pas de puzzle aujourd'hui : il n'a pas pu être fabriqué avec les cartes du jeu." }); return; }
    const info = { slug: u.slug, pseudo: u.pseudo, avatar: u.avatar, ornament: u.ornament, title: u.titleName || null, deck: [], emoteWheel: (u.emoteWheel || []).slice() };
    const botInfo = { slug: 'bot', pseudo: 'Puzzle du jour', avatar: null, ornament: 'none', deck: [] };
    const dk = puzzle.dayKey();
    const matchId = mm.startBotMatch(socket, info, botInfo, pool, io, (match) => settlePuzzleMatch(u.slug, dk, match), { puzzle: { day: dk, steps: day.puzzle.steps }, turnMs: 5 * 60000 });
    if (!matchId) return;
    const e = mm.getEntry(matchId);
    puzzle.install(e.match, day.puzzle, pool);
    e.match.log.push('Puzzle du jour : gagne pendant ce tour-ci !');
    e.turnKey = null; // relance la minuterie sur le tour installé
    puzzle.markTried(u.slug);
    mm.broadcastState(matchId, pool, io);
  });

  // Bagarre de la semaine
  socket.on('brawl:fight', () => {
    const u = ensureProfileFields(db.getUser(userSlug));
    const week = community.weekKey();
    const rule = brawl.ruleFor(week, brawlOverride());
    if (brawl.needsOwnDeck(rule) && (!Array.isArray(u.deck) || u.deck.length !== DECK_SIZE)) {
      socket.emit('queue:error', { error: `Cette semaine, la Bagarre se joue avec ton deck : configure un deck de ${DECK_SIZE} cartes.` }); return;
    }
    if (busy()) return;
    const decks = brawl.decksFor(rule, (u.deck || []).filter(id => db.cardById(id)), playablePool(), COPY_LIMITS, () => story.bossDeck({ quality: 0.45 }, playablePool(), COPY_LIMITS));
    const info = { slug: u.slug, pseudo: u.pseudo, avatar: u.avatar, ornament: u.ornament, title: u.titleName || null, deck: decks.player, emoteWheel: (u.emoteWheel || []).slice() };
    const botInfo = { slug: 'bot', pseudo: `Bagarreur — ${rule.name}`, avatar: null, ornament: 'none', deck: decks.bot };
    mm.startBotMatch(socket, info, botInfo, db.getCardPool(), io, (match) => settleBrawlMatch(u.slug, week, match), brawl.matchFields(rule));
  });

  // Draft : combattre avec le deck construit (1 carte parmi 3)
  socket.on('draft:fight', () => {
    const u = ensureProfileFields(db.getUser(userSlug));
    const run = u.draft.run;
    if (!run) { socket.emit('queue:error', { error: 'Lance d’abord un Draft.' }); return; }
    if (run.picks.length < DECK_SIZE) { socket.emit('queue:error', { error: 'Termine de choisir tes 30 cartes avant de combattre.' }); return; }
    if (busy()) return;
    const deck = run.picks.filter(id => db.cardById(id));
    if (deck.length < DECK_SIZE) { // carte supprimée par l'admin : on complète au hasard
      const extra = survival.randomDeck(playablePool(), COPY_LIMITS).filter(id => !deck.includes(id));
      while (deck.length < DECK_SIZE && extra.length) deck.push(extra.shift());
      run.picks = deck; db.updateUser(u.slug, u);
    }
    const cfg = draft.botConfig(run.wins);
    const info = { slug: u.slug, pseudo: u.pseudo, avatar: u.avatar, ornament: u.ornament, title: u.titleName || null, deck: deck.slice(), emoteWheel: (u.emoteWheel || []).slice() };
    const botInfo = { slug: 'bot', pseudo: `${cfg.botName} — ${run.wins} victoire${run.wins > 1 ? 's' : ''}`, avatar: null, ornament: 'none',
      deck: story.bossDeck({ quality: cfg.quality }, playablePool(), COPY_LIMITS) };
    const startedAt = run.startedAt;
    mm.startBotMatch(socket, info, botInfo, db.getCardPool(), io, (match) => settleDraftMatch(u.slug, startedAt, match), {
      draft: { wins: run.wins, losses: run.losses }, opponentHeroHealth: cfg.botHp
    });
  });

  socket.on('queue:leave', () => mm.leaveQueue(socket));
  /* Un seul combat à la fois : si le joueur en a déjà un (dans cet onglet ou un
     autre), on le prévient au lieu d'en lancer un deuxième (vérifié AVANT toute dépense).
     Le combat en cours reste dans l'onglet où il se joue. */
  function busy() {
    if (!mm.activeMatchOf(userSlug)) return false;
    socket.emit('queue:error', { error: mm.BUSY_MSG });
    return true;
  }
  // Le jeu est-il affiché à l'écran ? (sert à décider d'envoyer une notification push)
  socket.data.visible = true;
  socket.on('presence', (p) => { socket.data.visible = !!(p && p.visible); });

  /* Bac à sable (admin) : combat contre le bot avec une main et des plateaux
     choisis, pour tester une carte. Pas de récompense, pas de statistiques. */
  socket.on('admin:sandbox', ({ code, hand, myBoard, oppBoard, mana, oppHp } = {}) => {
    if (code !== ADMIN_CODE) { socket.emit('queue:error', { error: 'Code admin incorrect.' }); return; }
    const pool = db.getCardPool();
    const pick = (ids, max, type) => (Array.isArray(ids) ? ids : []).map(id => db.cardById(id)).filter(c => c && (!type || c.type === type)).slice(0, max);
    const handCards = pick(hand, 10), mine = pick(myBoard, 7, 'minion'), theirs = pick(oppBoard, 7, 'minion');
    if (!handCards.length && !mine.length) { socket.emit('queue:error', { error: 'Choisis au moins une carte pour ta main ou ton plateau.' }); return; }
    if (busy()) return;
    const u = db.getUser(userSlug);
    const deck = bot.buildTestDeck(pool);
    const playerInfo = { slug: userSlug, pseudo: u.pseudo, avatar: u.avatar, ornament: u.ornament, deck };
    const botInfo = { slug: 'bot', pseudo: 'Bot du bac à sable', avatar: null, ornament: 'none', deck: bot.buildTestDeck(pool) };
    const matchId = mm.startBotMatch(socket, playerInfo, botInfo, pool, io, null, { sandbox: true });
    if (!matchId) return;
    const found = mm.getMatchForSocket(socket);
    if (!found || found.matchId !== matchId) return;
    const m = found.entry.match;
    // On saute le mulligan et on installe la situation choisie, au tour du joueur
    game.submitMulligan(m, 0, []); game.submitMulligan(m, 1, []);
    m.turn = 0;
    const me = m.players[0], foe = m.players[1];
    me.hand = handCards.map(c => c.id);
    me.board = mine.map(c => Object.assign(game.createMinionFrom(c), { canAttack: true, sickness: false }));
    foe.board = theirs.map(c => Object.assign(game.createMinionFrom(c), { canAttack: true, sickness: false }));
    const mn = Math.max(1, Math.min(10, Math.round(Number(mana) || 10)));
    me.maxMana = mn; me.mana = mn;
    if (Number(oppHp) > 0) foe.heroHealth = Math.min(200, Math.round(Number(oppHp)));
    game.recomputeAuras(m);
    m.log.push('Bac à sable : situation de départ installée.');
    mm.broadcastState(matchId, pool, io);
  });

  socket.on('admin:botMatch', ({ code }) => {
    if (code !== ADMIN_CODE) { socket.emit('queue:error', { error: 'Code admin incorrect.' }); return; }
    const pool = db.getCardPool();
    if (pool.length < 5) { socket.emit('queue:error', { error: 'Pas assez de cartes dans le pool pour composer un deck de test.' }); return; }
    if (busy()) return;
    const adminInfo = { slug: userSlug, pseudo: user.pseudo, avatar: user.avatar, ornament: user.ornament, deck: bot.buildTestDeck(pool) };
    const botInfo = { slug: 'bot', pseudo: 'Bot (entraînement)', avatar: null, ornament: 'none', deck: bot.buildTestDeck(pool) };
    mm.startBotMatch(socket, adminInfo, botInfo, pool, io);
  });

  // Entraînement contre le bot avec le deck en cours de construction (pas de récompense)
  socket.on('match:practice', ({ cardIds } = {}) => {
    const u = db.getUser(userSlug);
    const ids = Array.isArray(cardIds) && cardIds.length ? cardIds : (u.deck || []);
    const check = validateDeckCards(ids, u);
    if (check.error) { socket.emit('queue:error', { error: check.error }); return; }
    if (busy()) return;
    const pool = db.getCardPool();
    const playerInfo = { slug: userSlug, pseudo: u.pseudo, avatar: u.avatar, ornament: u.ornament, deck: ids.slice() };
    const botInfo = { slug: 'bot', pseudo: "Bot d'entraînement", avatar: null, ornament: 'none', deck: bot.buildTestDeck(playablePool()) };
    mm.startBotMatch(socket, playerInfo, botInfo, pool, io, null, { practice: true });
  });

  // Mode Histoire : affronter le boss d'un chapitre débloqué
  socket.on('story:start', ({ chapterId, fightIndex } = {}) => {
    if (!story.get().tabEnabled) { socket.emit('queue:error', { error: "Le mode Histoire n'est pas encore ouvert." }); return; }
    const u = ensureProfileFields(db.getUser(userSlug));
    const chapters = storyChapters();
    const i = chapters.findIndex(c => c.id === chapterId);
    if (i < 0) { socket.emit('queue:error', { error: 'Chapitre introuvable.' }); return; }
    const ch = chapters[i];
    if (ch.enabled === false) { socket.emit('queue:error', { error: "Ce chapitre n'est pas encore disponible. Patience !" }); return; }
    if (i > 0 && storyProgressOf(u, chapters[i - 1]) < story.fightsOf(chapters[i - 1]).length) { socket.emit('queue:error', { error: "Termine d'abord le chapitre précédent." }); return; }
    const fights = story.fightsOf(ch);
    const progress = storyProgressOf(u, ch);
    // Par défaut : le prochain combat ; on peut aussi rejouer un combat déjà gagné
    const k = Number.isInteger(fightIndex) ? fightIndex : Math.min(progress, fights.length - 1);
    if (k < 0 || k >= fights.length || k > progress) { socket.emit('queue:error', { error: 'Gagne d\'abord les combats précédents de ce chapitre.' }); return; }
    const info = buildPlayerInfo(userSlug);
    if (!info) { socket.emit('queue:error', { error: `Configure un deck de ${DECK_SIZE} cartes avant de combattre.` }); return; }
    if (busy()) return;
    const fight = fights[k];
    const pool = db.getCardPool();
    const card = db.cardById(fight.cardId) || {};
    const bossInfo = { slug: 'story-boss', pseudo: fight.name || card.name || 'Boss', avatar: card.image || null, ornament: 'none',
      deck: story.bossDeck({ bossCardId: fight.cardId, quality: fight.quality }, playablePool(), COPY_LIMITS) };
    const matchId = mm.startBotMatch(socket, info, bossInfo, pool, io, (match) => settleStoryMatch(ch.id, k, match),
      { story: ch.id, opponentHeroHealth: fight.hp });
    if (!matchId) return;
    const found = mm.getMatchForSocket(socket);
    if (found && found.matchId === matchId && fight.armor) { found.entry.match.players[1].heroArmor = fight.armor; mm.broadcastState(matchId, pool, io); }
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
    if (busy()) return; // vérifié avant de consommer la tentative du jour
    // La tentative du jour est consommée dès le LANCEMENT du combat, pas seulement en cas
    // de victoire — sinon un joueur pourrait abandonner une partie perdante et retenter aussitôt.
    fresh.lastBossFight = new Date().toISOString();
    db.updateUser(fresh.slug, fresh);
    const playerInfo = { slug: userSlug, pseudo: fresh.pseudo, avatar: fresh.avatar, ornament: fresh.ornament, deck: fresh.deck };
    // Deck personnalisé par l'admin si configuré (au moins 4 cartes, la taille de la main de départ),
    // sinon un deck aléatoire dans tout le pool comme pour le bot d'entraînement.
    const bossDeck = Array.isArray(events.boss.deckCardIds) && events.boss.deckCardIds.length >= 4
      ? events.boss.deckCardIds : bot.buildTestDeck(playablePool());
    const bossInfo = { slug: 'boss', pseudo: events.boss.name, avatar: events.boss.image, ornament: 'none', deck: bossDeck };
    const matchId = mm.startBotMatch(socket, playerInfo, bossInfo, pool, io, settleBossMatch, {
      isBossFight: true, opponentHeroHealth: Math.max(1, Number(events.boss.heroHealth) || 60)
    });
  });

  /* Défis entre amis, dans plusieurs modes : combat classique, Blitz, Bagarre de
     la semaine ou Draft (chacun avec son deck de Draft terminé). Seul le combat
     classique compte pour le classement ; les autres sont des duels amicaux. */
  const DECKLESS_MODES = ['draft'];
  function duelInfo(slug, mode) {
    const u = db.getUser(slug);
    if (!u) return null;
    ensureProfileFields(u);
    const base = buildPlayerInfo(slug);
    if (base) return base;
    const rule = brawl.ruleFor(community.weekKey(), brawlOverride());
    if (DECKLESS_MODES.includes(mode) || (mode === 'brawl' && !brawl.needsOwnDeck(rule))) {
      return { slug: u.slug, pseudo: u.pseudo, avatar: u.avatar, ornament: u.ornament, title: u.titleName || null, deck: [], emoteWheel: (u.emoteWheel || []).slice() };
    }
    return null;
  }
  function prepareDuel(ch, a, b) {
    const mode = ch.mode || 'normal';
    if (mode === 'blitz') return { extra: mm.blitzFields(), onMatchEnd: (m, vp) => settleMatch(m, vp, { blitz: true }) };
    if (mode === 'brawl') {
      const rule = brawl.ruleFor(community.weekKey(), brawlOverride());
      const deckOf = info => brawl.decksFor(rule, (info.deck || []).filter(id => db.cardById(id)), playablePool(), COPY_LIMITS, () => []).player;
      if (brawl.needsOwnDeck(rule) && (a.deck.length !== DECK_SIZE || b.deck.length !== DECK_SIZE)) return { error: `Cette semaine, la Bagarre se joue avec son deck : les deux joueurs doivent avoir un deck de ${DECK_SIZE} cartes.` };
      return { a: Object.assign({}, a, { deck: deckOf(a) }), b: Object.assign({}, b, { deck: deckOf(b) }),
        extra: Object.assign(brawl.matchFields(rule), { duel: true }), onMatchEnd: (m, vp) => settleMatch(m, vp, { blitz: true }) };
    }
    if (mode === 'draft') {
      const deckOf = slug => { const u = db.getUser(slug); const run = u && u.draft && u.draft.run; return run && run.picks.length >= DECK_SIZE ? run.picks.filter(id => db.cardById(id)) : null; };
      const da = deckOf(a.slug), dbk = deckOf(b.slug);
      if (!da || !dbk) return { error: "Duel Draft : les deux joueurs doivent avoir terminé de choisir leurs 30 cartes de Draft (un Draft en cours)." };
      return { a: Object.assign({}, a, { deck: da }), b: Object.assign({}, b, { deck: dbk }),
        extra: { draftDuel: true }, onMatchEnd: (m, vp) => settleMatch(m, vp, { blitz: true }) };
    }
    return null;
  }
  socket.on('challenge:send', ({ toSlug, mode } = {}) => {
    const m = mm.CHALLENGE_MODES[mode] ? mode : 'normal';
    const info = duelInfo(userSlug, m);
    if (!info) { socket.emit('queue:error', { error: `Configure un deck de ${DECK_SIZE} cartes avant de défier quelqu'un.` }); return; }
    const me = db.getUser(userSlug);
    if (!me.friends.includes(toSlug)) { socket.emit('queue:error', { error: 'Tu ne peux défier que tes amis.' }); return; }
    if (m === 'draft' && !(me.draft && me.draft.run && me.draft.run.picks.length >= DECK_SIZE)) { socket.emit('queue:error', { error: 'Termine d’abord de choisir tes 30 cartes de Draft pour lancer un duel Draft.' }); return; }
    let label = mm.CHALLENGE_MODES[m];
    if (m === 'brawl') { const r = brawl.ruleFor(community.weekKey(), brawlOverride()); label = `Bagarre · ${r.name}`; }
    const r = mm.createChallenge(info, toSlug, m, label);
    if (r.error) socket.emit('queue:error', r);
    else {
      socket.emit('challenge:sent', { toSlug, mode: m });
      pushIfAway(toSlug, { title: 'Défi reçu !', body: `${info.pseudo} te défie${m === 'normal' ? ' en combat' : ` en ${label}`} (60 s pour accepter).`, tag: 'challenge-' + r.challenge.id, url: '/' });
    }
  });

  socket.on('challenge:accept', ({ challengeId } = {}) => {
    const ch = mm.getChallenge ? mm.getChallenge(challengeId) : null;
    const mode = (ch && ch.mode) || 'normal';
    const info = duelInfo(userSlug, mode);
    if (!info) { socket.emit('queue:error', { error: `Configure un deck de ${DECK_SIZE} cartes avant de combattre.` }); return; }
    const r = mm.acceptChallenge(challengeId, info, socket, slug => duelInfo(slug, mode), db.getCardPool(), io, settleMatch, prepareDuel);
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
    match.forfeitBy = me2.slug; // utile pour les récompenses : un abandon ne rapporte rien au perdant
    match.log.push(`${me2.pseudo} abandonne la partie.`);
    mm.broadcastState(found.matchId, db.getCardPool(), io);
  });

  socket.on('action:endTurn', () => {
    const found = mm.getMatchForSocket(socket);
    if (!found) return;
    // Seul le joueur dont c'est le tour peut le terminer. Sans ce contrôle, un clic
    // arrivé juste après la fin du minuteur (fréquent en Blitz, 20 s) terminait le
    // tour de l'ADVERSAIRE, et le tour revenait aussitôt : bouton qui « ne répond plus ».
    if (found.entry.match.turn !== found.playerIndex || found.entry.match.status !== 'active') {
      mm.broadcastState(found.matchId, db.getCardPool(), io); // l'écran se remet à jour
      return;
    }
    if (found.entry.puzzle) { mm.failPuzzle(found.entry); mm.broadcastState(found.matchId, db.getCardPool(), io); return; }
    game.endTurn(found.entry.match);
    mm.broadcastState(found.matchId, db.getCardPool(), io);
    const found2 = mm.getMatchForSocket(socket);
    if (found2 && found2.entry.isBot && found2.entry.match.status === 'active' && found2.entry.match.turn === 1) {
      runBotTurnAnimated(found2);
    }
  });

  socket.on('disconnect', () => { mm.handleDisconnect(socket, userSlug, db.getCardPool(), io); setTimeout(() => io.emit('chat:online', mm.onlineCount()), 200); });

  /* ---------- Chat général ---------- */
  socket.emit('chat:history', chatLog.slice(-CHAT_HISTORY));
  io.emit('chat:online', mm.onlineCount());
  socket.on('chat:send', ({ text } = {}) => {
    const u = db.getUser(userSlug);
    if (!u) return;
    const msg = String(text || '').replace(/\s+/g, ' ').trim().slice(0, CHAT_MAX_LEN);
    if (!msg) return;
    const now = Date.now();
    if (now - (chatLastSent.get(userSlug) || 0) < CHAT_COOLDOWN_MS) { socket.emit('chat:error', { error: 'Doucement ! Attends une seconde entre deux messages.' }); return; }
    chatLastSent.set(userSlug, now);
    const m = { id: 'm-' + uuidv4().slice(0, 8), slug: u.slug, pseudo: u.pseudo, avatar: u.avatar || null, ornament: u.ornament || 'none', title: u.titleName || null, text: msg, at: now };
    chatLog.push(m);
    if (chatLog.length > CHAT_KEEP) chatLog.splice(0, chatLog.length - CHAT_KEEP);
    saveChat();
    io.emit('chat:msg', m);
    if (recordSecrets(u, { chat_messages: 1 }).length) db.updateUser(u.slug, u);
    else { secrets.ensure(u); db.updateUser(u.slug, u); }
  });
  // Modération : l'admin peut supprimer un message
  socket.on('chat:delete', ({ code, id } = {}) => {
    if (code !== ADMIN_CODE) return;
    const i = chatLog.findIndex(m => m.id === id);
    if (i >= 0) { chatLog.splice(i, 1); saveChat(); io.emit('chat:deleted', { id }); }
  });
});

server.listen(PORT, () => {
  console.log(`Clean Gang Decks lancé sur http://localhost:${PORT}`);
});

/* File d'attente, défis entre amis, et gestion des parties en cours.
   Tout vit en mémoire dans le process serveur. */
const { v4: uuidv4 } = require('uuid');
const game = require('./game');
const replays = require('./replays');
const { VP_MIN, VP_MAX } = require('./cards');

const queue = [];                 // joueurs en recherche d'adversaire
const blitzQueue = [];            // file d'attente du mode Blitz (tours de 20 s, 3 mana au départ)
const BLITZ_TURN_MS = 20000;
const BLITZ_MANA_BONUS = 2;       // 1 + 2 = 3 cristaux dès le premier tour
const bets = require('./bets');
const matches = new Map();        // matchId -> { match, sockets:[a,b] }
const socketToMatch = new Map();  // socket.id -> matchId
const onlineBySlug = new Map();   // slug -> socket (dernière connexion)
const challenges = new Map();     // challengeId -> { fromSlug, toSlug, ... }

function registerOnline(socket, slug) { onlineBySlug.set(slug, socket); }
function unregisterOnline(slug, socketId) {
  const s = onlineBySlug.get(slug);
  if (s && s.id === socketId) onlineBySlug.delete(slug);
}
function isOnline(slug) { return onlineBySlug.has(slug); }
function onlineCount() { return onlineBySlug.size; }
function socketFor(slug) { return onlineBySlug.get(slug) || null; }

/* ---------- Un seul combat à la fois par joueur ----------
   Combat « en cours » = partie active (main de départ comprise) où le joueur
   est un vrai participant. Tous les lancements de combat passent par ici. */
function activeMatchOf(slug) {
  if (!slug) return null;
  for (const [matchId, entry] of matches) {
    if (entry.match.status !== 'active') continue;
    const i = entry.match.players.findIndex(p => p.slug === slug);
    if (i < 0 || (entry.isBot && i !== 0)) continue;
    return { matchId, entry, playerIndex: i };
  }
  return null;
}
const BUSY_MSG = 'Tu as déjà un combat en cours : termine-le (ou abandonne-le) avant d\'en lancer un autre.';
/* Retire un joueur de toutes les files d'attente, quel que soit l'onglet */
function leaveQueueSlug(slug) {
  [queue, blitzQueue].forEach(q => { for (let i = q.length - 1; i >= 0; i--) if (q[i].playerInfo.slug === slug) q.splice(i, 1); });
}

function isQueued(slug) { return [queue, blitzQueue].some(q => q.some(e => e.playerInfo && e.playerInfo.slug === slug)); }
function joinQueue(socket, playerInfo, cardPool, io, onMatchEnd, opts) {
  leaveQueue(socket);
  if (activeMatchOf(playerInfo.slug)) { socket.emit('queue:error', { error: BUSY_MSG }); return; }
  leaveQueueSlug(playerInfo.slug); // un seul onglet en recherche à la fois
  const blitz = !!(opts && opts.blitz);
  const q = blitz ? blitzQueue : queue;
  q.push({ socket, playerInfo });
  // On écarte de la file ceux qui sont partis en combat entre-temps
  for (let i = q.length - 1; i >= 0; i--) if (activeMatchOf(q[i].playerInfo.slug) || !q[i].socket.connected) q.splice(i, 1);
  if (q.length >= 2) {
    const a = q.shift();
    const b = q.shift();
    startMatch(a, b, cardPool, io, onMatchEnd, blitz ? blitzFields() : undefined);
  } else {
    socket.emit('queue:waiting', { blitz });
  }
}
function blitzFields() { return { blitz: true, turnMs: BLITZ_TURN_MS, manaBonus: [BLITZ_MANA_BONUS, BLITZ_MANA_BONUS] }; }

function leaveQueue(socket) {
  [queue, blitzQueue].forEach(q => {
    const idx = q.findIndex(x => x.socket.id === socket.id);
    if (idx >= 0) q.splice(idx, 1);
  });
}

function startMatch(a, b, cardPool, io, onMatchEnd, extraFields) {
  // Dernier filet de sécurité : jamais deux combats en même temps pour un joueur
  if (a.playerInfo.slug === b.playerInfo.slug) { a.socket.emit('queue:error', { error: 'Tu ne peux pas te battre contre toi-même.' }); return null; }
  const busyA = activeMatchOf(a.playerInfo.slug), busyB = activeMatchOf(b.playerInfo.slug);
  if (busyA || busyB) {
    [[a, busyA], [b, busyB]].forEach(([x, busy]) => x.socket.emit('queue:error', { error: busy ? BUSY_MSG : 'Ton adversaire est déjà en combat : relance la recherche.' }));
    return null;
  }
  leaveQueueSlug(a.playerInfo.slug); leaveQueueSlug(b.playerInfo.slug);
  const matchId = uuidv4();
  const match = game.createMatch(matchId, a.playerInfo, b.playerInfo);
  if (extraFields && extraFields.manaBonus) match.manaBonus = extraFields.manaBonus;
  // Duel entre amis en mode Bagarre : PV de départ et coût des cartes modifiés
  if (extraFields && Number.isFinite(extraFields.bothHeroHealth)) match.players.forEach(p => { p.heroHealth = extraFields.bothHeroHealth; p.heroMaxHealth = extraFields.bothHeroHealth; });
  if (extraFields && Number.isFinite(extraFields.costMod)) match.costMod = extraFields.costMod;
  leaveQueue(a.socket); leaveQueue(b.socket);
  matches.set(matchId, Object.assign({ match, sockets: [a.socket, b.socket], onMatchEnd, settled: false }, extraFields || {}));
  socketToMatch.set(a.socket.id, matchId);
  socketToMatch.set(b.socket.id, matchId);
  broadcastState(matchId, cardPool, io);
  return matchId;
}

/* Partie d'entraînement contre un bot (admin uniquement). Un seul vrai
   socket (l'admin, toujours joueur d'index 0) ; le bot occupe l'index 1
   sans connexion réseau. */
function startBotMatch(adminSocket, adminInfo, botInfo, cardPool, io, onMatchEnd, extraFields) {
  leaveQueue(adminSocket);
  // Reprise d'un combat mis en pause (Survie) : on repart du combat enregistré
  const resumed = extraFields && extraFields.resumeMatch;
  const slug = adminInfo ? adminInfo.slug : resumed && resumed.players[0].slug;
  if (activeMatchOf(slug)) { adminSocket.emit('queue:error', { error: BUSY_MSG }); return null; }
  leaveQueueSlug(slug);
  const matchId = resumed ? resumed.id : uuidv4();
  const match = resumed || game.createMatch(matchId, adminInfo, botInfo);
  if (resumed) {
    const ex = Object.assign({}, extraFields); delete ex.resumeMatch;
    matches.set(matchId, Object.assign({ match, sockets: [adminSocket], isBot: true, settled: false, onMatchEnd }, ex));
    socketToMatch.set(adminSocket.id, matchId);
    broadcastState(matchId, cardPool, io);
    return matchId;
  }
  if (extraFields && Number.isFinite(extraFields.opponentHeroHealth)) {
    match.players[1].heroHealth = extraFields.opponentHeroHealth;
    match.players[1].heroMaxHealth = Math.max(30, extraFields.opponentHeroHealth); // un soin ne le ramène pas à 30
  }
  // Bagarre : PV de départ des deux héros, et coût des cartes modifié
  if (extraFields && Number.isFinite(extraFields.bothHeroHealth)) {
    match.players.forEach(p => { p.heroHealth = extraFields.bothHeroHealth; p.heroMaxHealth = extraFields.bothHeroHealth; });
  }
  if (extraFields && Number.isFinite(extraFields.costMod)) match.costMod = extraFields.costMod;
  if (extraFields && Number.isFinite(extraFields.playerHeroHealth)) match.players[0].heroHealth = Math.max(1, extraFields.playerHeroHealth);
  if (extraFields && Number.isFinite(extraFields.playerMaxHealth)) match.players[0].heroMaxHealth = Math.max(1, extraFields.playerMaxHealth);
  if (extraFields && Number.isFinite(extraFields.playerArmor)) match.players[0].heroArmor = Math.max(0, extraFields.playerArmor);
  if (extraFields && Number.isFinite(extraFields.opponentArmor)) match.players[1].heroArmor = Math.max(0, extraFields.opponentArmor);
  if (extraFields && extraFields.manaBonus) match.manaBonus = extraFields.manaBonus;
  matches.set(matchId, Object.assign({ match, sockets: [adminSocket], isBot: true, settled: false, onMatchEnd }, extraFields || {}));
  socketToMatch.set(adminSocket.id, matchId);
  broadcastState(matchId, cardPool, io);
  return matchId;
}

/* ---- Défis entre amis ---- */
/* mode : 'normal' (par défaut), 'blitz', 'brawl' (règle de la semaine), 'draft' (decks de Draft) */
const CHALLENGE_MODES = { normal: 'Combat classique', blitz: 'Blitz', brawl: 'Bagarre', draft: 'Draft' };
function createChallenge(fromInfo, toSlug, mode, modeLabel) {
  const target = socketFor(toSlug);
  if (!target) return { error: "Ce joueur n'est pas connecté en ce moment." };
  if (activeMatchOf(fromInfo.slug)) return { error: BUSY_MSG };
  if (activeMatchOf(toSlug)) return { error: 'Ton ami est déjà en combat : réessaie à la fin de sa partie.' };
  const id = 'ch-' + uuidv4().slice(0, 8);
  const m = CHALLENGE_MODES[mode] ? mode : 'normal';
  const challenge = { id, fromSlug: fromInfo.slug, fromPseudo: fromInfo.pseudo, toSlug, createdAt: Date.now(), mode: m, modeLabel: modeLabel || CHALLENGE_MODES[m] };
  challenges.set(id, challenge);
  target.emit('challenge:incoming', challenge);
  // Expire tout seul au bout de 60 secondes
  setTimeout(() => { challenges.delete(id); }, 60000);
  return { ok: true, challenge };
}

/* prepare(défi, infoLanceur, infoAccepteur) → { a, b, extra, onMatchEnd } ou { error } : réglages propres au mode */
function acceptChallenge(challengeId, accepterInfo, accepterSocket, buildInfo, cardPool, io, onMatchEnd, prepare) {
  const ch = challenges.get(challengeId);
  if (!ch) return { error: 'Ce défi a expiré.' };
  if (ch.toSlug !== accepterInfo.slug) return { error: "Ce défi ne t'est pas destiné." };
  const challengerSocket = socketFor(ch.fromSlug);
  if (!challengerSocket) return { error: "L'adversaire s'est déconnecté." };
  const challengerInfo = buildInfo(ch.fromSlug);
  if (!challengerInfo) return { error: 'Adversaire introuvable.' };
  if (activeMatchOf(accepterInfo.slug)) return { error: BUSY_MSG };
  if (activeMatchOf(ch.fromSlug)) { challenges.delete(challengeId); return { error: "Ton ami est déjà parti dans un autre combat." }; }
  const prep = prepare ? prepare(ch, challengerInfo, accepterInfo) : null;
  if (prep && prep.error) { challenges.delete(challengeId); challengerSocket.emit('queue:error', { error: prep.error }); return { error: prep.error }; }
  challenges.delete(challengeId);
  leaveQueue(challengerSocket);
  leaveQueue(accepterSocket);
  const id = startMatch(
    { socket: challengerSocket, playerInfo: (prep && prep.a) || challengerInfo },
    { socket: accepterSocket, playerInfo: (prep && prep.b) || accepterInfo },
    cardPool, io, (prep && prep.onMatchEnd) || onMatchEnd, (prep && prep.extra) || undefined
  );
  return id ? { ok: true } : { error: 'Le combat n\'a pas pu être lancé.' };
}

function getChallenge(id) { return challenges.get(id) || null; }
function declineChallenge(challengeId, bySlug) {
  const ch = challenges.get(challengeId);
  if (!ch || ch.toSlug !== bySlug) return { error: 'Défi introuvable.' };
  challenges.delete(challengeId);
  const from = socketFor(ch.fromSlug);
  if (from) from.emit('challenge:declined', { toSlug: bySlug });
  return { ok: true };
}

/* ---- Diffusion d'état + attribution des récompenses ---- */
/* ---------- Minuterie de tour (la « mèche ») ----------
   Chaque joueur a TURN_MS pour jouer son tour. À la fin du temps, le tour se
   termine tout seul. Le bot n'a pas de minuterie (il joue de lui-même). Le
   temps restant est envoyé à chaque état ; le client affiche la mèche qui brûle. */
const TURN_MS = Math.max(5, Number(process.env.TURN_SECONDS) || 60) * 1000; // 60 s par défaut (TURN_SECONDS pour les tests)
let onTurnTimeout = null;
/* Cartes brillantes de chaque joueur (affichées en combat) */
let foilsProvider = null;
function setFoilsProvider(fn) { foilsProvider = fn; }
function foilsOf(entry, i) {
  if (!entry.foils) entry.foils = entry.match.players.map(p => { try { return foilsProvider ? foilsProvider(p.slug) : []; } catch (e) { return []; } });
  return entry.foils[i] || [];
}
/* Cartes « full art » de chaque joueur (illustration plein cadre, vue des deux joueurs) */
let fullArtsProvider = null;
function setFullArtsProvider(fn) { fullArtsProvider = fn; }
function fullArtsOf(entry, i) {
  if (!entry.fullArts) entry.fullArts = entry.match.players.map(p => { try { return fullArtsProvider ? fullArtsProvider(p.slug) : []; } catch (e) { return []; } });
  return entry.fullArts[i] || [];
}
let onMatchReport = null; // bilan de fin de combat (Collection → Stats du deck)
function setMatchReportHandler(fn) { onMatchReport = fn; }
/* Nouveau tour d'un vrai joueur (pas contre le bot) : prévenir par notification push */
let onTurnStart = null;
function setTurnStartHandler(fn) { onTurnStart = fn; }
function setTurnTimeoutHandler(fn) { onTurnTimeout = fn; }
function manageTurnTimer(entry, matchId, cardPool, io) {
  const m = entry.match;
  if (m.status !== 'active' || m.phase === 'mulligan') {
    clearTimeout(entry.turnTimer); entry.turnTimer = null; entry.turnEndsAt = null; entry.turnKey = null;
    return;
  }
  const key = m.turnNumber + ':' + m.turn;
  if (entry.turnKey === key) return; // même tour : la minuterie continue
  entry.turnKey = key;
  clearTimeout(entry.turnTimer);
  if (entry.isBot && m.turn === 1) { entry.turnEndsAt = null; return; }
  const ms = entry.turnMs || TURN_MS;
  entry.turnEndsAt = Date.now() + ms;
  entry.turnTimer = setTimeout(() => {
    if (!matches.has(matchId) || entry.match.status !== 'active' || entry.turnKey !== key) return;
    const p = entry.match.players[entry.match.turn];
    if (entry.puzzle) { failPuzzle(entry, 'Temps écoulé : puzzle raté.'); broadcastState(matchId, cardPool, io); return; }
    entry.match.log.push(`Temps écoulé : le tour de ${p.pseudo} se termine.`);
    game.endTurn(entry.match);
    broadcastState(matchId, cardPool, io);
    if (onTurnTimeout) onTurnTimeout(matchId, entry);
  }, ms);
}

function broadcastState(matchId, cardPool, io) {
  const entry = matches.get(matchId);
  if (!entry) return;
  manageTurnTimer(entry, matchId, cardPool, io);
  const m0 = entry.match;
  if (onTurnStart && !entry.isBot && m0.status === 'active' && m0.phase !== 'mulligan' && entry.notifiedTurn !== m0.turnNumber) {
    entry.notifiedTurn = m0.turnNumber;
    const p = m0.players[m0.turn], o = m0.players[1 - m0.turn];
    try { onTurnStart({ slug: p.slug, opponentPseudo: o.pseudo, matchId: m0.id, turnNumber: m0.turnNumber }); } catch (e) {}
  }
  try { replays.record(entry); } catch (e) { console.error('Replay :', e.message); }
  emitSpectators(entry);

  // Une fois la partie terminée et réglée, TOUT nouvel appel (même déclenché par une
  // action tardive et rejetée après coup, comme un "Fin du tour" envoyé juste après le
  // coup gagnant) doit continuer à renvoyer les récompenses déjà calculées — sinon elles
  // disparaissent silencieusement de l'état vu par le client au prochain envoi.
  if (entry.match.status === 'finished' && entry.settled && entry.rewardsPerPlayer) {
    entry.sockets.forEach((sock, i) => {
      const state = game.redactStateFor(entry.match, cardPool, i);
      state.rewards = entry.rewardsPerPlayer[i];
      if (entry.survival) state.survival = entry.survival;
      if (entry.draft) state.draft = entry.draft;
      if (entry.puzzle) state.puzzle = entry.puzzle;
      if (entry.brawl) state.brawl = entry.brawl;
      if (entry.seasonal) state.seasonal = entry.seasonal;
      if (entry.expedition) state.expedition = entry.expedition;
      if (entry.blitz) state.blitz = true;
      sock.emit('match:state', state);
    });
    return;
  }

  // Partie qui vient de se terminer : on n'envoie pas d'abord un état SANS les
  // récompenses (l'écran de victoire se construisait sur cet état-là et
  // n'affichait ni points, ni poussière, ni crédits). L'état complet part juste après.
  if (!(entry.match.status === 'finished' && !entry.settled)) {
    entry.sockets.forEach((sock, i) => {
      const state = game.redactStateFor(entry.match, cardPool, i);
      state.turnRemainingMs = entry.turnEndsAt ? Math.max(0, entry.turnEndsAt - Date.now()) : null;
      state.turnTotalMs = entry.turnMs || TURN_MS;
      if (entry.tournamentRef) state.tournament = true;
      if (entry.blitz) state.blitz = true;
      if (entry.survival) state.survival = entry.survival;
      if (entry.draft) state.draft = entry.draft;
      if (entry.puzzle) state.puzzle = entry.puzzle;
      if (entry.brawl) state.brawl = entry.brawl;
      if (entry.seasonal) state.seasonal = entry.seasonal;
      if (entry.expedition) state.expedition = entry.expedition;
      if (entry.sandbox) state.sandbox = true;
      state.spectators = liveSpectators(entry).length;
      { const bp = bets.poolsOf(entry.match.id); if (bp.count) state.bets = bp; }
      state.you.foils = foilsOf(entry, i); state.opponent.foils = foilsOf(entry, 1 - i);
      state.you.fullArts = fullArtsOf(entry, i); state.opponent.fullArts = fullArtsOf(entry, 1 - i);
      // Adversaire déconnecté : temps qu'il lui reste pour revenir
      const od = entry.disconnected && entry.disconnected[1 - i];
      state.opponentDisconnected = od ? Math.max(0, Math.ceil((od.until - Date.now()) / 1000)) : null;
      sock.emit('match:state', state);
    });
  }
  if (entry.match.status === 'finished' && !entry.settled) {
    entry.settled = true;
    const vpGain = entry.isBot ? 0 : (Math.floor(Math.random() * (VP_MAX - VP_MIN + 1)) + VP_MIN);
    const settleResult = typeof entry.onMatchEnd === 'function' ? entry.onMatchEnd(entry.match, vpGain) : null;
    // On renvoie un état enrichi avec le gain de points, une fois les stats à jour
    // (un combat d'entraînement contre le bot n'accorde jamais de points ni de poussière)
    let reports = null;
    try { reports = onMatchReport ? onMatchReport(entry, matchId) : null; } catch (e) { console.error('Bilan de deck :', e.message); }
    entry.rewardsPerPlayer = [];
    entry.sockets.forEach((sock, i) => {
      const state = game.redactStateFor(entry.match, cardPool, i);
      const won = entry.match.winner === entry.match.players[i].slug;
      const casual = !!(entry.blitz || entry.duel || entry.draftDuel); // pas de points de classement
      state.rewards = { won, vpGain: won && !entry.isBot && !casual ? vpGain : 0, isBot: !!entry.isBot, isBossFight: !!entry.isBossFight, isStory: !!entry.story, isDuel: !!(entry.duel || entry.draftDuel) };
      if (settleResult && settleResult.winnerSlug === entry.match.players[i].slug) {
        if (settleResult.bonusBooster) state.rewards.bonusBooster = settleResult.bonusBooster;
        if (settleResult.bossReward) state.rewards.bossReward = settleResult.bossReward;
        if (settleResult.storyResult) state.rewards.story = settleResult.storyResult;
      }
      if (settleResult && settleResult.creditsPerSlug) state.rewards.credits = settleResult.creditsPerSlug[entry.match.players[i].slug] || 0;
      // Points de classement réellement gagnés (victoire, défaite jouée, bonus du jour, série)
      if (settleResult && settleResult.vpPerSlug && settleResult.vpPerSlug[entry.match.players[i].slug]) {
        const vp = settleResult.vpPerSlug[entry.match.players[i].slug];
        state.rewards.vpGain = vp.total; state.rewards.vpDetail = vp;
      }
      if (settleResult && settleResult.achievementsPerSlug) {
        const mine = settleResult.achievementsPerSlug[entry.match.players[i].slug];
        if (mine && mine.length > 0) state.rewards.achievementsUnlocked = mine;
      }
      if (settleResult && settleResult.survivalResult) state.rewards.survival = settleResult.survivalResult;
      if (settleResult && settleResult.draftResult) state.rewards.draft = settleResult.draftResult;
      if (settleResult && settleResult.puzzleResult) state.rewards.puzzle = settleResult.puzzleResult;
      if (settleResult && settleResult.brawlResult) state.rewards.brawl = settleResult.brawlResult;
      if (settleResult && settleResult.seasonalResult) state.rewards.seasonal = settleResult.seasonalResult;
      if (settleResult && settleResult.expeditionResult) state.rewards.expedition = settleResult.expeditionResult;
      if (entry.draft) state.draft = entry.draft;
      if (entry.puzzle) state.puzzle = entry.puzzle;
      if (entry.brawl) state.brawl = entry.brawl;
      if (entry.seasonal) state.seasonal = entry.seasonal;
      if (entry.expedition) state.expedition = entry.expedition;
      if (entry.survival) state.survival = entry.survival;
      if (entry.blitz) { state.blitz = true; state.rewards.isBlitz = true; }
      if (reports && reports[entry.match.players[i].slug]) state.rewards.deckReportId = reports[entry.match.players[i].slug];
      if (entry.tournamentRef) { state.tournament = true; state.rewards.isTournament = true; }
      entry.rewardsPerPlayer[i] = state.rewards;
      sock.emit('match:state', state);
    });
    if (matchEndHook) { try { matchEndHook(matchId, entry); } catch (e) { console.error('Paris :', e.message); } }
    setTimeout(() => cleanupMatch(matchId), 60000);
  }
}

function getMatchForSocket(socket) {
  const matchId = socketToMatch.get(socket.id);
  if (!matchId) return null;
  const entry = matches.get(matchId);
  if (!entry) return null;
  const playerIndex = entry.sockets[0].id === socket.id ? 0 : 1;
  return { matchId, entry, playerIndex };
}

/* Déconnexion pendant un combat : le joueur a RECONNECT_MS pour revenir
   (page rechargée, réseau coupé, téléphone en veille…). Passé ce délai, il
   perd par forfait. En revenant, il retrouve sa partie là où il l'avait laissée. */
const RECONNECT_MS = Math.max(10, Number(process.env.RECONNECT_SECONDS) || 90) * 1000;
function handleDisconnect(socket, slug, cardPool, io) {
  removeSpectator(socket);
  leaveQueue(socket);
  unregisterOnline(slug, socket.id);
  const found = getMatchForSocket(socket);
  if (!found) return;
  const { entry, playerIndex, matchId } = found;
  if (entry.match.status !== 'active') return;
  if (entry.sockets[playerIndex] !== socket) return; // un autre onglet a déjà repris la partie
  entry.disconnected = entry.disconnected || {};
  clearTimeout((entry.disconnected[playerIndex] || {}).timer);
  const who = entry.match.players[playerIndex];
  // Survie : pas de défaite par forfait, le combat est mis en pause et enregistré
  if (entry.survival && onSurvivalDisconnect) { onSurvivalDisconnect(matchId, entry); return; }
  entry.match.log.push(`${who.pseudo} s'est déconnecté : il a ${Math.round(RECONNECT_MS / 1000)} s pour revenir.`);
  entry.disconnected[playerIndex] = {
    until: Date.now() + RECONNECT_MS,
    timer: setTimeout(() => {
      if (!matches.has(matchId) || entry.match.status !== 'active' || !entry.disconnected[playerIndex]) return;
      entry.match.status = 'finished';
      entry.match.winner = entry.match.players[1 - playerIndex].slug;
      entry.match.forfeitBy = who.slug;
      entry.match.log.push(`${who.pseudo} n'est pas revenu — victoire par forfait.`);
      broadcastState(matchId, cardPool, io);
    }, RECONNECT_MS)
  };
  broadcastState(matchId, cardPool, io);
}
/* Le joueur revient (nouvelle page, nouvel onglet) : il reprend sa partie en cours */
function rejoinMatch(socket, slug, cardPool, io) {
  for (const [matchId, entry] of matches) {
    if (entry.match.status !== 'active') continue;
    const i = entry.match.players.findIndex(p => p.slug === slug);
    if (i < 0 || entry.isBot && i === 1) continue;
    const old = entry.sockets[i];
    if (old && old !== socket) socketToMatch.delete(old.id);
    entry.sockets[i] = socket;
    socketToMatch.set(socket.id, matchId);
    if (entry.disconnected && entry.disconnected[i]) {
      clearTimeout(entry.disconnected[i].timer);
      delete entry.disconnected[i];
      entry.match.log.push(`${entry.match.players[i].pseudo} est de retour.`);
    }
    broadcastState(matchId, cardPool, io);
    return matchId;
  }
  return null;
}

let onSurvivalDisconnect = null;
function setSurvivalDisconnectHandler(fn) { onSurvivalDisconnect = fn; }
/* Retire un combat en cours sans le régler (mise en pause) et le renvoie */
function detachMatch(matchId) {
  const entry = matches.get(matchId);
  if (!entry) return null;
  clearTimeout(entry.turnTimer);
  Object.values(entry.disconnected || {}).forEach(d => clearTimeout(d && d.timer));
  cleanupMatch(matchId);
  return entry.match;
}
function getEntry(matchId) { return matches.get(matchId) || null; }
/* Puzzle du jour : finir son tour sans avoir gagné = puzzle raté */
function failPuzzle(entry, msg) {
  const m = entry.match;
  if (m.status !== 'active') return;
  m.status = 'finished'; m.winner = null; m.forfeitBy = m.players[0].slug;
  m.log.push(msg || 'Tour terminé sans victoire : puzzle raté.');
}

/* ---- Spectateurs ----
   Un spectateur reçoit une « photo » neutre du plateau (les deux mains restent
   cachées, comme dans les replays) et les derniers événements du combat.
   Il ne fait pas partie du combat : aucune action possible. */
const spectatorToMatch = new Map();
const MAX_SPECTATORS = 20;
function liveSpectators(entry) {
  entry.spectators = (entry.spectators || []).filter(s => s.connected && spectatorToMatch.get(s.id) === entry.match.id);
  return entry.spectators;
}
function spectatorPayload(entry) {
  const m = entry.match;
  return {
    matchId: m.id, status: m.status, winner: m.winner || null, forfeitBy: m.forfeitBy || null, phase: m.phase,
    mode: entry.tournamentRef ? 'tournament' : entry.survival ? 'survival' : entry.draft ? 'draft' : entry.puzzle ? 'puzzle' : entry.brawl ? 'brawl' : entry.blitz ? 'blitz' : entry.isBot ? 'bot' : 'pvp',
    players: m.players.map(p => ({ slug: p.slug, pseudo: p.pseudo, avatar: p.avatar || null, ornament: p.ornament || 'none', title: p.title || null })),
    frame: replays.snapshot(m), events: (m.events || []).slice(-60), spectators: (entry.spectators || []).length,
    bets: bets.poolsOf(m.id), betOpen: m.status === 'active' && !entry.puzzle && !entry.sandbox && (m.turnNumber || 0) <= bets.BET_MAX_TURN, betMaxTurn: bets.BET_MAX_TURN
  };
}
function emitSpectators(entry) {
  const list = liveSpectators(entry);
  if (!list.length) return;
  const payload = spectatorPayload(entry);
  list.forEach(s => s.emit('spectate:state', payload));
}
function addSpectator(matchId, socket, cardPool) {
  const entry = matches.get(matchId);
  if (!entry || entry.match.status !== 'active' || entry.sandbox) return { error: "Ce combat est terminé." };
  if (socketToMatch.has(socket.id)) return { error: 'Tu es déjà en combat.' };
  removeSpectator(socket);
  if (liveSpectators(entry).length >= MAX_SPECTATORS) return { error: 'Trop de spectateurs sur ce combat.' };
  spectatorToMatch.set(socket.id, matchId);
  entry.spectators.push(socket);
  socket.emit('spectate:state', spectatorPayload(entry));
  broadcastState(matchId, cardPool, null); // les joueurs voient le nombre de spectateurs
  return { ok: true };
}
function removeSpectator(socket) {
  const matchId = spectatorToMatch.get(socket.id);
  if (!matchId) return;
  spectatorToMatch.delete(socket.id);
  const entry = matches.get(matchId);
  if (entry) entry.spectators = (entry.spectators || []).filter(s => s.id !== socket.id);
}
/* Réaction d'un spectateur (emoji) : envoyée aux deux joueurs et aux autres spectateurs */
const REACTIONS = ['👏', '🔥', '😂', '😮', '😱', '💀', '👑', '❤️', '🍿', 'GG'];
function spectatorReact(socket, emoji, pseudo) {
  const matchId = spectatorToMatch.get(socket.id);
  const entry = matchId && matches.get(matchId);
  if (!entry || entry.match.status !== 'active' || !REACTIONS.includes(emoji)) return false;
  const now = Date.now();
  // Pas plus de 6 réactions par seconde sur un même combat (tous spectateurs confondus)
  entry.reactTimes = (entry.reactTimes || []).filter(t => now - t < 1000);
  if (entry.reactTimes.length >= 6) return false;
  entry.reactTimes.push(now);
  const payload = { id: Math.random().toString(36).slice(2, 9), emoji, from: String(pseudo || '').slice(0, 24), at: now };
  (entry.sockets || []).forEach(s => { if (s && s.connected) s.emit('match:reaction', payload); });
  liveSpectators(entry).forEach(s => s.emit('match:reaction', payload));
  return true;
}
/* Combats en cours qu'un joueur peut regarder : ceux de ses amis et ceux du tournoi */
function liveMatches(filter) {
  const out = [];
  for (const [matchId, entry] of matches) {
    const m = entry.match;
    if (m.status !== 'active' || entry.sandbox || entry.puzzle) continue; // le puzzle se joue seul (pas de solution soufflée)
    const humans = entry.isBot ? [m.players[0]] : m.players;
    if (!filter(entry, humans)) continue;
    out.push({ matchId, turnNumber: m.turnNumber, spectators: liveSpectators(entry).length,
      mode: spectatorPayload(entry).mode,
      players: m.players.map(p => ({ slug: p.slug, pseudo: p.pseudo, avatar: p.avatar || null, ornament: p.ornament || 'none', hp: p.heroHealth })) });
  }
  return out;
}

/* Fin d'un combat (réglé) ou disparition sans fin (pause de Survie…) : sert aux paris des spectateurs */
let matchEndHook = null, matchGoneHook = null;
function setMatchEndHook(fn) { matchEndHook = fn; }
function setMatchGoneHook(fn) { matchGoneHook = fn; }
function spectatedMatchOf(socket) { return spectatorToMatch.get(socket.id) || null; }
/* Envoie un message aux deux joueurs et à tous les spectateurs d'un combat */
function emitToMatch(matchId, event, payload) {
  const entry = matches.get(matchId);
  if (!entry) return;
  (entry.sockets || []).forEach(s => { if (s && s.connected) s.emit(event, payload); });
  liveSpectators(entry).forEach(s => s.emit(event, payload));
}
function cleanupMatch(matchId) {
  const entry = matches.get(matchId);
  if (!entry) return;
  if (!entry.settled && matchGoneHook) { try { matchGoneHook(matchId, entry); } catch (e) {} }
  (entry.spectators || []).forEach(s => { if (spectatorToMatch.get(s.id) === matchId) { spectatorToMatch.delete(s.id); if (s.connected) s.emit('spectate:end', { matchId, finished: entry.match.status === 'finished' }); } });
  // Seulement si l'onglet est toujours relié à CE combat : s'il a enchaîné sur un
  // nouveau combat (manche suivante, revanche…), il ne doit pas perdre ce nouveau combat.
  entry.sockets.forEach(s => { if (socketToMatch.get(s.id) === matchId) socketToMatch.delete(s.id); });
  matches.delete(matchId);
}

module.exports = { isQueued,
  spectatorReact, REACTIONS, setMatchEndHook, setMatchGoneHook, spectatedMatchOf, emitToMatch,
  joinQueue, leaveQueue, startMatch, blitzFields, startBotMatch, broadcastState, getMatchForSocket, setTurnTimeoutHandler, setMatchReportHandler, setTurnStartHandler, TURN_MS,
  handleDisconnect, rejoinMatch, onlineCount, cleanupMatch, detachMatch, activeMatchOf, BUSY_MSG, getEntry, setSurvivalDisconnectHandler, registerOnline, unregisterOnline, isOnline, socketFor,
  createChallenge, acceptChallenge, declineChallenge, getChallenge, CHALLENGE_MODES, failPuzzle, setFoilsProvider, setFullArtsProvider, addSpectator, removeSpectator, liveMatches
};

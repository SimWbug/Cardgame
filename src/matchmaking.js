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
  }
  if (extraFields && Number.isFinite(extraFields.playerHeroHealth)) match.players[0].heroHealth = Math.max(1, extraFields.playerHeroHealth);
  if (extraFields && Number.isFinite(extraFields.opponentArmor)) match.players[1].heroArmor = Math.max(0, extraFields.opponentArmor);
  if (extraFields && extraFields.manaBonus) match.manaBonus = extraFields.manaBonus;
  matches.set(matchId, Object.assign({ match, sockets: [adminSocket], isBot: true, settled: false, onMatchEnd }, extraFields || {}));
  socketToMatch.set(adminSocket.id, matchId);
  broadcastState(matchId, cardPool, io);
  return matchId;
}

/* ---- Défis entre amis ---- */
function createChallenge(fromInfo, toSlug) {
  const target = socketFor(toSlug);
  if (!target) return { error: "Ce joueur n'est pas connecté en ce moment." };
  if (activeMatchOf(fromInfo.slug)) return { error: BUSY_MSG };
  if (activeMatchOf(toSlug)) return { error: 'Ton ami est déjà en combat : réessaie à la fin de sa partie.' };
  const id = 'ch-' + uuidv4().slice(0, 8);
  const challenge = { id, fromSlug: fromInfo.slug, fromPseudo: fromInfo.pseudo, toSlug, createdAt: Date.now() };
  challenges.set(id, challenge);
  target.emit('challenge:incoming', challenge);
  // Expire tout seul au bout de 60 secondes
  setTimeout(() => { challenges.delete(id); }, 60000);
  return { ok: true, challenge };
}

function acceptChallenge(challengeId, accepterInfo, accepterSocket, buildInfo, cardPool, io, onMatchEnd) {
  const ch = challenges.get(challengeId);
  if (!ch) return { error: 'Ce défi a expiré.' };
  if (ch.toSlug !== accepterInfo.slug) return { error: "Ce défi ne t'est pas destiné." };
  const challengerSocket = socketFor(ch.fromSlug);
  if (!challengerSocket) return { error: "L'adversaire s'est déconnecté." };
  const challengerInfo = buildInfo(ch.fromSlug);
  if (!challengerInfo) return { error: 'Adversaire introuvable.' };
  if (activeMatchOf(accepterInfo.slug)) return { error: BUSY_MSG };
  if (activeMatchOf(ch.fromSlug)) { challenges.delete(challengeId); return { error: "Ton ami est déjà parti dans un autre combat." }; }
  challenges.delete(challengeId);
  leaveQueue(challengerSocket);
  leaveQueue(accepterSocket);
  const id = startMatch(
    { socket: challengerSocket, playerInfo: challengerInfo },
    { socket: accepterSocket, playerInfo: accepterInfo },
    cardPool, io, onMatchEnd
  );
  return id ? { ok: true } : { error: 'Le combat n\'a pas pu être lancé.' };
}

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

  // Une fois la partie terminée et réglée, TOUT nouvel appel (même déclenché par une
  // action tardive et rejetée après coup, comme un "Fin du tour" envoyé juste après le
  // coup gagnant) doit continuer à renvoyer les récompenses déjà calculées — sinon elles
  // disparaissent silencieusement de l'état vu par le client au prochain envoi.
  if (entry.match.status === 'finished' && entry.settled && entry.rewardsPerPlayer) {
    entry.sockets.forEach((sock, i) => {
      const state = game.redactStateFor(entry.match, cardPool, i);
      state.rewards = entry.rewardsPerPlayer[i];
      if (entry.survival) state.survival = entry.survival;
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
      if (entry.sandbox) state.sandbox = true;
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
      state.rewards = { won, vpGain: won && !entry.isBot ? vpGain : 0, isBot: !!entry.isBot, isBossFight: !!entry.isBossFight, isStory: !!entry.story };
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
      if (entry.survival) state.survival = entry.survival;
      if (entry.blitz) { state.blitz = true; state.rewards.isBlitz = true; }
      if (reports && reports[entry.match.players[i].slug]) state.rewards.deckReportId = reports[entry.match.players[i].slug];
      if (entry.tournamentRef) { state.tournament = true; state.rewards.isTournament = true; }
      entry.rewardsPerPlayer[i] = state.rewards;
      sock.emit('match:state', state);
    });
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

function cleanupMatch(matchId) {
  const entry = matches.get(matchId);
  if (!entry) return;
  entry.sockets.forEach(s => socketToMatch.delete(s.id));
  matches.delete(matchId);
}

module.exports = {
  joinQueue, leaveQueue, startMatch, blitzFields, startBotMatch, broadcastState, getMatchForSocket, setTurnTimeoutHandler, setMatchReportHandler, setTurnStartHandler, TURN_MS,
  handleDisconnect, rejoinMatch, onlineCount, cleanupMatch, detachMatch, activeMatchOf, BUSY_MSG, getEntry, setSurvivalDisconnectHandler, registerOnline, unregisterOnline, isOnline, socketFor,
  createChallenge, acceptChallenge, declineChallenge
};

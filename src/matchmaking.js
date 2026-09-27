/* File d'attente, défis entre amis, et gestion des parties en cours.
   Tout vit en mémoire dans le process serveur. */
const { v4: uuidv4 } = require('uuid');
const game = require('./game');
const { VP_MIN, VP_MAX } = require('./cards');

const queue = [];                 // joueurs en recherche d'adversaire
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
function socketFor(slug) { return onlineBySlug.get(slug) || null; }

function joinQueue(socket, playerInfo, cardPool, io, onMatchEnd) {
  leaveQueue(socket);
  queue.push({ socket, playerInfo });
  if (queue.length >= 2) {
    const a = queue.shift();
    const b = queue.shift();
    startMatch(a, b, cardPool, io, onMatchEnd);
  } else {
    socket.emit('queue:waiting');
  }
}

function leaveQueue(socket) {
  const idx = queue.findIndex(q => q.socket.id === socket.id);
  if (idx >= 0) queue.splice(idx, 1);
}

function startMatch(a, b, cardPool, io, onMatchEnd) {
  const matchId = uuidv4();
  const match = game.createMatch(matchId, a.playerInfo, b.playerInfo);
  matches.set(matchId, { match, sockets: [a.socket, b.socket], onMatchEnd, settled: false });
  socketToMatch.set(a.socket.id, matchId);
  socketToMatch.set(b.socket.id, matchId);
  broadcastState(matchId, cardPool, io);
}

/* Partie d'entraînement contre un bot (admin uniquement). Un seul vrai
   socket (l'admin, toujours joueur d'index 0) ; le bot occupe l'index 1
   sans connexion réseau. */
function startBotMatch(adminSocket, adminInfo, botInfo, cardPool, io, onMatchEnd, extraFields) {
  leaveQueue(adminSocket);
  const matchId = uuidv4();
  const match = game.createMatch(matchId, adminInfo, botInfo);
  if (extraFields && Number.isFinite(extraFields.opponentHeroHealth)) {
    match.players[1].heroHealth = extraFields.opponentHeroHealth;
  }
  matches.set(matchId, Object.assign({ match, sockets: [adminSocket], isBot: true, settled: false, onMatchEnd }, extraFields || {}));
  socketToMatch.set(adminSocket.id, matchId);
  broadcastState(matchId, cardPool, io);
  return matchId;
}

/* ---- Défis entre amis ---- */
function createChallenge(fromInfo, toSlug) {
  const target = socketFor(toSlug);
  if (!target) return { error: "Ce joueur n'est pas connecté en ce moment." };
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
  challenges.delete(challengeId);
  leaveQueue(challengerSocket);
  leaveQueue(accepterSocket);
  startMatch(
    { socket: challengerSocket, playerInfo: challengerInfo },
    { socket: accepterSocket, playerInfo: accepterInfo },
    cardPool, io, onMatchEnd
  );
  return { ok: true };
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
function broadcastState(matchId, cardPool, io) {
  const entry = matches.get(matchId);
  if (!entry) return;

  // Une fois la partie terminée et réglée, TOUT nouvel appel (même déclenché par une
  // action tardive et rejetée après coup, comme un "Fin du tour" envoyé juste après le
  // coup gagnant) doit continuer à renvoyer les récompenses déjà calculées — sinon elles
  // disparaissent silencieusement de l'état vu par le client au prochain envoi.
  if (entry.match.status === 'finished' && entry.settled && entry.rewardsPerPlayer) {
    entry.sockets.forEach((sock, i) => {
      const state = game.redactStateFor(entry.match, cardPool, i);
      state.rewards = entry.rewardsPerPlayer[i];
      sock.emit('match:state', state);
    });
    return;
  }

  entry.sockets.forEach((sock, i) => {
    sock.emit('match:state', game.redactStateFor(entry.match, cardPool, i));
  });
  if (entry.match.status === 'finished' && !entry.settled) {
    entry.settled = true;
    const vpGain = entry.isBot ? 0 : (Math.floor(Math.random() * (VP_MAX - VP_MIN + 1)) + VP_MIN);
    const settleResult = typeof entry.onMatchEnd === 'function' ? entry.onMatchEnd(entry.match, vpGain) : null;
    // On renvoie un état enrichi avec le gain de points, une fois les stats à jour
    // (un combat d'entraînement contre le bot n'accorde jamais de points ni de poussière)
    entry.rewardsPerPlayer = [];
    entry.sockets.forEach((sock, i) => {
      const state = game.redactStateFor(entry.match, cardPool, i);
      const won = entry.match.winner === entry.match.players[i].slug;
      state.rewards = { won, vpGain: won && !entry.isBot ? vpGain : 0, isBot: !!entry.isBot, isBossFight: !!entry.isBossFight };
      if (settleResult && settleResult.winnerSlug === entry.match.players[i].slug) {
        if (settleResult.bonusBooster) state.rewards.bonusBooster = settleResult.bonusBooster;
        if (settleResult.bossReward) state.rewards.bossReward = settleResult.bossReward;
      }
      if (settleResult && settleResult.achievementsPerSlug) {
        const mine = settleResult.achievementsPerSlug[entry.match.players[i].slug];
        if (mine && mine.length > 0) state.rewards.achievementsUnlocked = mine;
      }
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

function handleDisconnect(socket, slug, cardPool, io) {
  leaveQueue(socket);
  unregisterOnline(slug, socket.id);
  const found = getMatchForSocket(socket);
  if (!found) return;
  const { entry, playerIndex } = found;
  if (entry.match.status === 'active') {
    entry.match.status = 'finished';
    entry.match.winner = entry.match.players[1 - playerIndex].slug;
    entry.match.log.push(`${entry.match.players[playerIndex].pseudo} s'est déconnecté — victoire par forfait.`);
    broadcastState(found.matchId, cardPool, io);
  }
}

function cleanupMatch(matchId) {
  const entry = matches.get(matchId);
  if (!entry) return;
  entry.sockets.forEach(s => socketToMatch.delete(s.id));
  matches.delete(matchId);
}

module.exports = {
  joinQueue, leaveQueue, startMatch, startBotMatch, broadcastState, getMatchForSocket,
  handleDisconnect, cleanupMatch, registerOnline, unregisterOnline, isOnline, socketFor,
  createChallenge, acceptChallenge, declineChallenge
};

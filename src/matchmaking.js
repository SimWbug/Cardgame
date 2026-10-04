/* File d'attente, défis entre amis, et gestion des parties en cours.
   Tout vit en mémoire dans le process serveur. */
const { v4: uuidv4 } = require('uuid');
const game = require('./game');
const replays = require('./replays');
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

function startMatch(a, b, cardPool, io, onMatchEnd, extraFields) {
  const matchId = uuidv4();
  const match = game.createMatch(matchId, a.playerInfo, b.playerInfo);
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
/* ---------- Minuterie de tour (la « mèche ») ----------
   Chaque joueur a TURN_MS pour jouer son tour. À la fin du temps, le tour se
   termine tout seul. Le bot n'a pas de minuterie (il joue de lui-même). Le
   temps restant est envoyé à chaque état ; le client affiche la mèche qui brûle. */
const TURN_MS = Math.max(5, Number(process.env.TURN_SECONDS) || 60) * 1000; // 60 s par défaut (TURN_SECONDS pour les tests)
let onTurnTimeout = null;
let onMatchReport = null; // bilan de fin de combat (Collection → Stats du deck)
function setMatchReportHandler(fn) { onMatchReport = fn; }
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
  entry.turnEndsAt = Date.now() + TURN_MS;
  entry.turnTimer = setTimeout(() => {
    if (!matches.has(matchId) || entry.match.status !== 'active' || entry.turnKey !== key) return;
    const p = entry.match.players[entry.match.turn];
    entry.match.log.push(`Temps écoulé : le tour de ${p.pseudo} se termine.`);
    game.endTurn(entry.match);
    broadcastState(matchId, cardPool, io);
    if (onTurnTimeout) onTurnTimeout(matchId, entry);
  }, TURN_MS);
}

function broadcastState(matchId, cardPool, io) {
  const entry = matches.get(matchId);
  if (!entry) return;
  manageTurnTimer(entry, matchId, cardPool, io);
  try { replays.record(entry); } catch (e) { console.error('Replay :', e.message); }

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

  // Partie qui vient de se terminer : on n'envoie pas d'abord un état SANS les
  // récompenses (l'écran de victoire se construisait sur cet état-là et
  // n'affichait ni points, ni poussière, ni crédits). L'état complet part juste après.
  if (!(entry.match.status === 'finished' && !entry.settled)) {
    entry.sockets.forEach((sock, i) => {
      const state = game.redactStateFor(entry.match, cardPool, i);
      state.turnRemainingMs = entry.turnEndsAt ? Math.max(0, entry.turnEndsAt - Date.now()) : null;
      state.turnTotalMs = TURN_MS;
      if (entry.tournamentRef) state.tournament = true;
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
  joinQueue, leaveQueue, startMatch, startBotMatch, broadcastState, getMatchForSocket, setTurnTimeoutHandler, setMatchReportHandler, TURN_MS,
  handleDisconnect, cleanupMatch, registerOnline, unregisterOnline, isOnline, socketFor,
  createChallenge, acceptChallenge, declineChallenge
};

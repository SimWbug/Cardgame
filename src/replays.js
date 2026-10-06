/* ======================================================
   Replays : chaque combat est enregistré étape par étape (une « photo » du
   plateau après chaque action) avec son journal d'événements. On garde les
   MAX_REPLAYS derniers combats ; chaque joueur revoit les siens depuis
   l'onglet Combat → Historique.
   ====================================================== */
const { readJSON, writeJSON } = require('./store');
const MAX_REPLAYS = 120;
const MAX_FRAMES = 400;

let store = readJSON('replays.json', null);
if (!Array.isArray(store)) store = [];
function save() { writeJSON('replays.json', store); }

/* Photo compacte du plateau (vue neutre : les deux mains sont cachées) */
function snapshot(match) {
  const evs = match.events || [];
  return {
    turnNumber: match.turnNumber, turn: match.turn,
    lastSeq: evs.length ? evs[evs.length - 1].seq : 0,
    players: match.players.map(p => ({
      hp: p.heroHealth, armor: p.heroArmor || 0, mana: p.mana, maxMana: p.maxMana,
      hand: p.hand.length, deck: p.library.length,
      weapon: p.heroWeapon ? { name: p.heroWeapon.name, attack: p.heroWeapon.attack, durability: p.heroWeapon.durability, cardId: p.heroWeapon.cardId } : null,
      board: p.board.map(m => ({ id: m.instanceId, cardId: m.cardId, name: m.name, image: m.image || null, rarity: m.rarity,
        attack: m.attack, health: m.health, maxHealth: m.maxHealth, taunt: !!m.taunt, shield: !!m.shield, stealth: !!m.stealth,
        windfury: !!m.windfury, asleep: !!m.asleep, standLevel: m.standLevel || 0, silenced: !!m.silenced, drEffect: m.drEffect || null }))
    }))
  };
}
/* Appelé à chaque diffusion d'état : on ajoute une photo si quelque chose a changé */
function record(entry) {
  const m = entry.match;
  if (m.phase === 'mulligan') return;
  const rec = entry.replay = entry.replay || { frames: [] };
  const snap = snapshot(m);
  const last = rec.frames[rec.frames.length - 1];
  if (last && last.lastSeq === snap.lastSeq && last.turnNumber === snap.turnNumber) return;
  if (rec.frames.length < MAX_FRAMES) rec.frames.push(snap);
}
/* Fin de combat : le replay complet est rangé dans le stockage */
function finalize(entry, mode) {
  const m = entry.match;
  if (!entry.replay || !entry.replay.frames.length) return null;
  const last = snapshot(m);
  const frames = entry.replay.frames;
  if (frames[frames.length - 1].lastSeq !== last.lastSeq) frames.push(last);
  const r = {
    id: 'rp-' + Math.random().toString(36).slice(2, 10), at: Date.now(), mode, matchId: m.id,
    winner: m.winner || null, forfeitBy: m.forfeitBy || null,
    players: m.players.map(p => ({ slug: p.slug, pseudo: p.pseudo, avatar: p.avatar || null, ornament: p.ornament || 'none' })),
    frames, events: (m.events || []).slice(-1500)
  };
  store.unshift(r);
  store = store.slice(0, MAX_REPLAYS);
  save();
  return r.id;
}
function listFor(slug) {
  return store.filter(r => r.players.some(p => p.slug === slug)).map(r => {
    const me = r.players.find(p => p.slug === slug), opp = r.players.find(p => p.slug !== slug) || {};
    const result = r.winner ? (r.winner === slug ? 'win' : 'loss') : r.forfeitBy ? (r.forfeitBy === slug ? 'loss' : 'win') : 'draw';
    const lastFrame = r.frames[r.frames.length - 1] || {};
    return { id: r.id, at: r.at, mode: r.mode, opponent: opp.pseudo, opponentAvatar: opp.avatar, result, turns: lastFrame.turnNumber || 0, me: me.pseudo };
  });
}
function get(id) { return store.find(r => r.id === id) || null; }
function byMatch(matchId) { return store.find(r => r.matchId === matchId) || null; }
module.exports = { record, finalize, listFor, get, snapshot, byMatch };

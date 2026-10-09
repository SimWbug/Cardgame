/* ======================================================
   Présence détaillée : ce que fait chaque ami (« en Expédition, acte 2 »,
   « regarde un combat », « à la forge »…). Calculé par le serveur à partir
   de l'onglet ouvert, du combat en cours et du mode spectateur : le client
   n'envoie que le nom de son onglet (pas de texte libre).
   ====================================================== */
const TABS = {
  accueil: ['🏠', "Sur l'accueil"], combat: ['⚔️', 'Prépare un combat'], collection: ['📚', 'Admire sa collection'],
  deck: ['🛠️', 'Construit un deck'], deckstats: ['📊', 'Analyse ses decks'], boosters: ['🎁', 'Ouvre des boosters'],
  boutique: ['🛒', 'Fait les boutiques'], poussiere: ['✨', 'Fabrique des cartes'], echanges: ['🤝', 'Négocie un échange'],
  joueurs: ['👥', 'Regarde les joueurs'], classement: ['🏅', 'Consulte le classement'], tournoi: ['🏆', 'Aux tournois'],
  survie: ['🔥', 'Prépare une Survie'], draft: ['🃏', 'Fait un Draft'], puzzle: ['🧩', 'Réfléchit au puzzle du jour'],
  bagarre: ['🥊', 'Prépare une Bagarre'], expedition: ['🧭', "Prépare une Expédition"], forge: ['⚒️', 'À la forge'],
  evenements: ['🎉', "À l'événement"], histoire: ['📖', 'Joue au mode Histoire'], achievements: ['🏆', 'Regarde ses succès'],
  codex: ['📕', 'Lit le codex'], wiki: ['📘', 'Lit le wiki'], options: ['⚙️', 'Règle ses options'], profil: ['👤', 'Personnalise son profil']
};
const cleanTab = t => { const s = String(t || '').slice(0, 20); return TABS[s] ? s : null; };

/* Libellé d'un combat en cours, d'après les champs du combat (entry) */
function matchLabel(entry, slug) {
  if (!entry) return null;
  const m = entry.match || {};
  const me = (m.players || []).findIndex(p => p.slug === slug);
  const opp = (m.players || [])[me === 0 ? 1 : 0] || {};
  const oppName = String(opp.pseudo || '').replace(/^[^\p{L}\p{N}]+/u, ''); // « 🐺 Loup gris » → « Loup gris »
  if (entry.expedition) {
    const x = entry.expedition;
    return { icon: '🧭', text: `En Expédition · région ${x.region || 1}, danger ${x.level || 1}${x.asc ? ` · Ascension ${x.asc}` : ''}`, sub: oppName ? `contre ${oppName}` : null, busy: true };
  }
  if (entry.story) return { icon: '📖', text: 'Joue au mode Histoire', busy: true };
  if (entry.tournamentRef) return { icon: '🏆', text: 'Match de tournoi', sub: opp.pseudo ? `contre ${opp.pseudo}` : null, busy: true };
  if (entry.isBossFight) return { icon: '👹', text: 'Affronte le boss du jour', busy: true };
  if (entry.survival) return { icon: '🔥', text: `En Survie · manche ${(entry.survival && entry.survival.round) || 1}`, busy: true };
  if (entry.draft) return { icon: '🃏', text: `En Draft · ${entry.draft.wins || 0} victoire${(entry.draft.wins || 0) > 1 ? 's' : ''}`, busy: true };
  if (entry.puzzle) return { icon: '🧩', text: 'Résout le puzzle du jour', busy: true };
  if (entry.seasonal) return { icon: entry.seasonal.icon || '🎉', text: `Combat d'événement${entry.seasonal.name ? ` · ${entry.seasonal.name}` : ''}`, busy: true };
  if (entry.brawl) return { icon: '🥊', text: `En Bagarre${entry.brawl.name ? ` · ${entry.brawl.name}` : ''}`, busy: true };
  if (entry.sandbox || entry.practice) return { icon: '🎯', text: "S'entraîne contre le bot", busy: true };
  if (entry.isBot) return { icon: '🤖', text: 'Combat contre le bot', busy: true };
  if (entry.duel || entry.draftDuel) return { icon: '⚔️', text: 'Duel amical', sub: opp.pseudo ? `contre ${opp.pseudo}` : null, busy: true };
  return { icon: '⚔️', text: entry.blitz ? 'Combat Blitz' : 'En combat', sub: opp.pseudo ? `contre ${opp.pseudo}` : null, busy: true };
}

/* ctx : { online, visible, tab, matchEntry, spectating: { a, b } | null, user, queued } */
function compute(slug, ctx) {
  if (!ctx || !ctx.online) return null;
  const m = matchLabel(ctx.matchEntry, slug);
  if (m) return m;
  if (ctx.spectating) return { icon: '👁', text: 'Regarde un combat', sub: [ctx.spectating.a, ctx.spectating.b].filter(Boolean).join(' contre ') || null };
  if (ctx.queued) return { icon: '⏳', text: 'Cherche un adversaire' };
  if (ctx.visible === false) return { icon: '💤', text: 'Absent' };
  const tab = cleanTab(ctx.tab);
  if (tab === 'expedition') {
    const run = ctx.user && ctx.user.expedition && ctx.user.expedition.run;
    if (run) return { icon: '🧭', text: `En Expédition · ${run.regionName || 'région ' + ((run.region || 0) + 1)}, ${run.fightsWon || 0} combat${(run.fightsWon || 0) > 1 ? 's' : ''} gagné${(run.fightsWon || 0) > 1 ? 's' : ''}${run.asc ? ` · Ascension ${run.asc}` : ''}` };
  }
  if (tab) return { icon: TABS[tab][0], text: TABS[tab][1] };
  return { icon: '🟢', text: 'En ligne' };
}
const same = (a, b) => JSON.stringify(a || null) === JSON.stringify(b || null);

module.exports = { TABS, cleanTab, matchLabel, compute, same };

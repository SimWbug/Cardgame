/* ======================================================
   Vitrine du jour de la boutique
   Chaque jour (heure de Paris) : un booster, une bannière et une provocation
   mis en avant, avec une remise. Le tirage est déterministe (graine = date),
   donc tous les joueurs voient la même vitrine sans rien stocker.
   Chaque emplacement ne peut être acheté qu'une fois par jour et par joueur.
   ====================================================== */
const DISCOUNT = 0.25; // -25 %

function dayKey(now) {
  return new Date(now || Date.now()).toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' }); // AAAA-MM-JJ
}
/* Prochain minuit à Paris (en ms) */
function endsAt(now) {
  const t = now || Date.now();
  const [y, m, d] = dayKey(t).split('-').map(Number);
  const next = Date.UTC(y, m - 1, d + 1); // minuit UTC du lendemain
  // Paris est en avance de 1 h ou 2 h sur UTC : on teste les deux
  for (const off of [1, 2]) {
    const cand = next - off * 3600000;
    if (cand > t && dayKey(cand) !== dayKey(t) && dayKey(cand - 1000) === dayKey(t)) return cand;
  }
  return next - 3600000;
}
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function pickFrom(list, seed) { return list.length ? list[hash(seed) % list.length] : null; }
const off = p => Math.max(1, Math.round(p * (1 - DISCOUNT)));

/* ctx = { extensions, cardPool, banners, emotes } */
function forDay(key, ctx) {
  const exts = (ctx.extensions || []).filter(e => !e.hidden &&
    (e.boosterCreditPrice != null || e.boosterDustPrice != null) &&
    (ctx.cardPool || []).some(c => (c.extensionId || 'base') === e.id && !c.unobtainable))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const bans = (ctx.banners || []).filter(b => b.source === 'shop' && b.price > 0).sort((a, b) => a.id.localeCompare(b.id));
  const emos = (ctx.emotes || []).filter(e => e.price > 0).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const ext = pickFrom(exts, key + ':booster');
  const ban = pickFrom(bans, key + ':banner');
  const emo = pickFrom(emos, key + ':emote');
  const slots = [];
  if (ext) {
    const cur = ext.boosterCreditPrice != null ? 'credits' : 'dust';
    const base = cur === 'credits' ? ext.boosterCreditPrice : ext.boosterDustPrice;
    slots.push({ slot: 'booster', id: ext.id, name: ext.name, currency: cur, basePrice: base, price: off(base) });
  }
  if (ban) slots.push({ slot: 'banner', id: ban.id, name: ban.name, bg: ban.bg, currency: 'credits', basePrice: ban.price, price: off(ban.price) });
  if (emo) slots.push({ slot: 'emote', id: emo.id, name: emo.name || emo.text || emo.id, emote: emo, currency: 'dust', basePrice: emo.price, price: off(emo.price) });
  return slots;
}

module.exports = { DISCOUNT, dayKey, endsAt, forDay, hash };

/* ======================================================
   Notifications push (Web Push) — sans bibliothèque externe
   - clés VAPID générées une fois et gardées dans data/push.json
   - chiffrement du message « aes128gcm » (RFC 8291) avec le module crypto
   - un joueur peut avoir plusieurs appareils abonnés (téléphone, PC…)
   Le serveur n'envoie un push que si le joueur n'a pas le jeu ouvert à l'écran.
   ====================================================== */
const crypto = require('crypto');
const { readJSON, writeJSON } = require('./store');

const FILE = 'push.json';
const MAX_SUBS_PER_USER = 6;
let data = null;

const b64u = buf => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function load() {
  if (data) return data;
  data = readJSON(FILE, null) || {};
  if (!data.vapid || !data.vapid.privatePem || !data.vapid.publicKey) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = publicKey.export({ format: 'jwk' });
    const raw = Buffer.concat([Buffer.from([4]), unb64u(jwk.x), unb64u(jwk.y)]);
    data.vapid = { publicKey: b64u(raw), privatePem: privateKey.export({ format: 'pem', type: 'pkcs8' }) };
  }
  if (!data.subs || typeof data.subs !== 'object') data.subs = {};
  save();
  return data;
}
function save() { writeJSON(FILE, data); }

function publicKey() { return load().vapid.publicKey; }

function validSub(sub) {
  return sub && typeof sub.endpoint === 'string' && /^https:\/\//.test(sub.endpoint) && sub.endpoint.length < 1000 &&
    sub.keys && typeof sub.keys.p256dh === 'string' && typeof sub.keys.auth === 'string' &&
    unb64u(sub.keys.p256dh).length === 65 && unb64u(sub.keys.auth).length === 16;
}
function subscribe(slug, sub) {
  if (!validSub(sub)) return { error: 'Abonnement invalide.' };
  const d = load();
  const list = (d.subs[slug] || []).filter(s => s.endpoint !== sub.endpoint);
  list.unshift({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, at: Date.now() });
  d.subs[slug] = list.slice(0, MAX_SUBS_PER_USER);
  save();
  return { ok: true };
}
function unsubscribe(slug, endpoint) {
  const d = load();
  if (!d.subs[slug]) return { ok: true };
  d.subs[slug] = endpoint ? d.subs[slug].filter(s => s.endpoint !== endpoint) : [];
  if (!d.subs[slug].length) delete d.subs[slug];
  save();
  return { ok: true };
}
function hasSubs(slug) { return !!(load().subs[slug] || []).length; }

/* Chiffrement du contenu pour un abonnement (RFC 8291, un seul bloc) */
function encrypt(sub, payload) {
  const uaPublic = unb64u(sub.keys.p256dh), authSecret = unb64u(sub.keys.auth);
  const ecdh = crypto.createECDH('prime256v1');
  const asPublic = ecdh.generateKeys();
  const shared = ecdh.computeSecret(uaPublic);
  const hmac = (key, d) => crypto.createHmac('sha256', key).update(d).digest();
  const prkKey = hmac(authSecret, shared);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
  const salt = crypto.randomBytes(16);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

/* En-tête d'autorisation VAPID (JWT signé ES256) */
function vapidHeader(endpoint) {
  const d = load();
  const aud = new URL(endpoint).origin;
  const sub = process.env.VAPID_SUBJECT || 'mailto:admin@cle4nergang.fr';
  const enc = o => b64u(Buffer.from(JSON.stringify(o)));
  const unsigned = enc({ typ: 'JWT', alg: 'ES256' }) + '.' + enc({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub });
  const sig = crypto.sign('sha256', Buffer.from(unsigned), { key: d.vapid.privatePem, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${unsigned}.${b64u(sig)}, k=${d.vapid.publicKey}`;
}

let transport = null; // remplaçable dans les tests
async function sendOne(slug, sub, msg) {
  const body = encrypt(sub, JSON.stringify(msg));
  const req = { method: 'POST', headers: {
    'Content-Type': 'application/octet-stream', 'Content-Encoding': 'aes128gcm', TTL: '3600', Urgency: 'high',
    Authorization: vapidHeader(sub.endpoint) }, body };
  try {
    const res = transport ? await transport(sub.endpoint, req) : await fetch(sub.endpoint, req);
    // Abonnement expiré ou révoqué : on l'oublie
    if (res.status === 404 || res.status === 410) unsubscribe(slug, sub.endpoint);
    return res.status;
  } catch (e) { return 0; }
}

/* msg = { title, body, tag, url } */
function send(slug, msg) {
  const subs = (load().subs[slug] || []).slice();
  return Promise.all(subs.map(s => sendOne(slug, s, msg)));
}

module.exports = { publicKey, subscribe, unsubscribe, hasSubs, send, encrypt, vapidHeader, _setTransport: t => { transport = t; }, _b64u: b64u, _unb64u: unb64u };

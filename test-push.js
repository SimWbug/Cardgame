/* Notifications push : chiffrement aes128gcm (RFC 8291) et signature VAPID vérifiables */
const assert = require('assert');
const crypto = require('crypto');
const push = require('./src/push');
const { _b64u: b64u, _unb64u: unb64u } = push;

// Faux navigateur : sa paire de clés et son secret d'authentification
const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
const auth = crypto.randomBytes(16);
const sub = { endpoint: 'https://push.example.com/abc', keys: { p256dh: b64u(ua.getPublicKey()), auth: b64u(auth) } };

// Déchiffrement côté navigateur
function decrypt(buf) {
  const salt = buf.subarray(0, 16), idlen = buf[20], asPublic = buf.subarray(21, 21 + idlen), ct = buf.subarray(21 + idlen);
  const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
  const shared = ua.computeSecret(asPublic);
  const ikm = hmac(hmac(auth, shared), Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const pt = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  assert.strictEqual(pt[pt.length - 1], 2, 'délimiteur de dernier bloc');
  return pt.subarray(0, pt.length - 1).toString();
}
const msg = { title: "C'est ton tour !", body: 'Bob a fini de jouer.', tag: 'turn-x-3' };
assert.deepStrictEqual(JSON.parse(decrypt(push.encrypt(sub, JSON.stringify(msg)))), msg);
console.log('✅ Push : le message chiffré se déchiffre côté navigateur.');

// Signature VAPID vérifiable avec la clé publique
const h = push.vapidHeader(sub.endpoint);
const [, jwt, k] = h.match(/^vapid t=([^,]+), k=(.+)$/);
assert.strictEqual(k, push.publicKey());
const [hd, pl, sig] = jwt.split('.');
const claims = JSON.parse(unb64u(pl).toString());
assert.strictEqual(claims.aud, 'https://push.example.com'); assert.ok(claims.exp > Date.now() / 1000);
const raw = unb64u(k);
const pubKey = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(raw.subarray(1, 33)), y: b64u(raw.subarray(33)) }, format: 'jwk' });
assert.ok(crypto.verify('sha256', Buffer.from(hd + '.' + pl), { key: pubKey, dsaEncoding: 'ieee-p1363' }, unb64u(sig)));
console.log('✅ Push : en-tête VAPID signé (ES256) et vérifiable.');

// Abonnements : envoi, puis oubli automatique si le service répond 410
(async () => {
  const slug = 'test-push-' + Date.now();
  assert.ok(push.subscribe(slug, { endpoint: 'pas une url', keys: {} }).error);
  assert.ok(push.subscribe(slug, sub).ok); assert.ok(push.hasSubs(slug));
  const sent = [];
  push._setTransport(async (url, req) => { sent.push({ url, req }); return { status: 201 }; });
  await push.send(slug, msg);
  assert.strictEqual(sent.length, 1); assert.strictEqual(sent[0].req.headers['Content-Encoding'], 'aes128gcm');
  assert.deepStrictEqual(JSON.parse(decrypt(sent[0].req.body)), msg);
  push._setTransport(async () => ({ status: 410 }));
  await push.send(slug, msg);
  assert.ok(!push.hasSubs(slug), 'abonnement expiré retiré');
  console.log('✅ Push : envoi à chaque appareil, abonnements expirés retirés.');
  console.log('\n✅ Notifications push validées.');
})().catch(e => { console.error(e); process.exit(1); });

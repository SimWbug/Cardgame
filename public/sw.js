/* Service worker de Clean Gang Decks : uniquement les notifications push.
   (Pas de cache hors-ligne : le jeu se charge toujours depuis le serveur.) */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let msg = {};
  try { msg = e.data ? e.data.json() : {}; } catch (err) { msg = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil((async () => {
    // Le jeu est déjà affiché à l'écran : inutile de notifier
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins.some(w => w.visibilityState === 'visible' && w.focused)) return;
    await self.registration.showNotification(msg.title || 'Clean Gang Decks', {
      body: msg.body || '', tag: msg.tag || undefined, renotify: !!msg.tag,
      icon: '/icons/icon-192.png', data: { url: msg.url || '/' }, vibrate: [120, 60, 120]
    });
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const w = wins.find(x => new URL(x.url).origin === self.location.origin);
    if (w) { await w.focus(); return; }
    await self.clients.openWindow(url);
  })());
});

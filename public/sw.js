// DusukMB Call - service worker
// Sadece bildirimler için: sayfa arka plandayken "karşı taraf katıldı / yeni mesaj" bildirimini gösterir,
// bildirime dokununca görüşme sekmesini öne getirir. Önbellekleme yapmaz (her açılışta güncel sürüm gelsin).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || self.registration.scope;
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const same = all.find((c) => c.url.startsWith(self.registration.scope));
    if (same) { try { await same.focus(); return; } catch {} }
    await self.clients.openWindow(url);
  })());
});

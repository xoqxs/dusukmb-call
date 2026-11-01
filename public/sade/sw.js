// DusukMB Call - service worker
// 1) Arka plandaki sayfanın bildirimlerine dokununca görüşme sekmesini öne getirir.
// 2) Web Push: biri kullanıcı adınla arayınca sunucu boş bir "uyan" mesajı yollar; burada kimin aradığı
//    sunucudan okunur ve "📞 X arıyor" bildirimi gösterilir (tarayıcı arka planda uyurken bile).
// Önbellekleme yapmaz (her açılışta güncel sürüm gelsin).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

async function readMe() {
  try { const r = await (await caches.open('dusukmb')).match('me'); return r ? await r.json() : null; } catch { return null; }
}

self.addEventListener('push', (e) => {
  e.waitUntil((async () => {
    const me = await readMe();
    let ring = null;
    if (me && me.api) {
      try {
        const r = await fetch(`${me.api}/phone/pending?name=${encodeURIComponent(me.name)}&token=${encodeURIComponent(me.token)}`, { cache: 'no-store' });
        ring = (await r.json()).ring;
      } catch {}
    }
    if (!ring) {
      // Arama çoktan bitmiş: bilgi bildirimi (Chrome her push için bir bildirim bekler)
      const old = await self.registration.getNotifications({ tag: 'dusukmb-call' });
      if (old.length) return;
      await self.registration.showNotification('DusukMB Call', { body: 'Cevapsız arama', tag: 'dusukmb-missed', icon: 'icon.svg', badge: 'icon.svg' });
      return;
    }
    await self.registration.showNotification(`📞 @${ring.from} arıyor`, {
      body: 'Görüntülü arama · açmak için dokun', tag: 'dusukmb-call', renotify: true, requireInteraction: true,
      icon: 'icon.svg', badge: 'icon.svg', vibrate: [700, 400, 700, 400, 700, 400, 700],
      actions: [{ action: 'accept', title: '📞 Aç' }, { action: 'decline', title: '✕ Reddet' }],
      data: { ring, url: self.registration.scope },
    });
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const data = e.notification.data || {};
  const ring = data.ring;
  const action = e.action || 'open';
  e.waitUntil((async () => {
    if (ring && action === 'decline') {
      const me = await readMe();
      if (me && me.api) {
        try { await fetch(`${me.api}/phone/answer?name=${encodeURIComponent(me.name)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: me.token, id: ring.id, accept: false }) }); } catch {}
      }
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      all.forEach((c) => c.postMessage({ t: 'notif', action, ring }));
      return;
    }
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const same = all.find((c) => c.url.startsWith(self.registration.scope));
    if (same) {
      try { await same.focus(); } catch {}
      if (ring) same.postMessage({ t: 'notif', action, ring });
      return;
    }
    let url = data.url || self.registration.scope;
    if (ring) {
      const q = new URLSearchParams({ cevap: ring.id, oda: ring.room, kimden: ring.from });
      if (action !== 'accept') q.set('islem', 'gor');
      url = self.registration.scope + '?' + q;
    }
    await self.clients.openWindow(url);
  })());
});

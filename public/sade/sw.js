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

// Gelen arama: telefon gibi çalsın diye bildirim, arama sürdükçe her 3 sn yeniden gösterilir
// (her seferinde ses + titreşim). Açılınca, reddedilince ya da arayan kapatınca durur.
let ringing = null; // { id, stop }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function fetchPending(me) {
  try {
    const r = await fetch(`${me.api}/phone/pending?name=${encodeURIComponent(me.name)}&token=${encodeURIComponent(me.token)}`, { cache: 'no-store' });
    return (await r.json()).ring;
  } catch { return undefined; } // ağ hatası: bilinmiyor
}
function callNote(ring, n) {
  return self.registration.showNotification(`📞 Gelen arama · @${ring.from}`, {
    body: n ? `Görüntülü arıyor… (${n * 3} sn)` : 'Görüntülü arıyor… açmak için dokun',
    tag: 'dusukmb-call', renotify: true, requireInteraction: true, silent: false,
    icon: 'icon-192.png', badge: 'icon-192.png', vibrate: [800, 300, 800, 300, 800],
    actions: [{ action: 'accept', title: '📞 Aç' }, { action: 'decline', title: '✕ Reddet' }],
    data: { ring, url: self.registration.scope },
  });
}
async function ringLoop(ring) {
  if (ringing && ringing.id === ring.id) return;
  if (ringing) ringing.stop = true;
  const me = await readMe();
  const st = { id: ring.id, stop: false };
  ringing = st;
  const t0 = Date.now();
  for (let n = 0; !st.stop && Date.now() - t0 < 46000; n++) {
    // Sayfa ekranda açıksa (kendi arama ekranını gösteriyor) bildirim çalma
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (!wins.some((c) => c.visibilityState === 'visible')) await callNote(ring, n);
    await sleep(3000);
    if (st.stop) break;
    if (me && me.api && n % 2 === 1) {
      const p = await fetchPending(me);
      if (p === null || (p && p.id !== ring.id)) break; // arama bitti
    }
  }
  if (ringing === st) ringing = null;
  const open = await self.registration.getNotifications({ tag: 'dusukmb-call' });
  open.forEach((x) => x.close());
  if (!st.stop && Date.now() - t0 >= 3000) {
    await self.registration.showNotification('DusukMB Call', { body: `Cevapsız arama · @${ring.from}`, tag: 'dusukmb-missed', icon: 'icon-192.png', badge: 'icon-192.png' });
  }
}
function stopRing() { if (ringing) { ringing.stop = true; ringing = null; } }

// Sayfadan gelen komutlar (sayfa arka plandayken zili service worker çalar)
self.addEventListener('message', (e) => {
  const m = e.data || {};
  if (m.t === 'ring' && m.ring) e.waitUntil(ringLoop(m.ring));
  if (m.t === 'stopring') { stopRing(); e.waitUntil(self.registration.getNotifications({ tag: 'dusukmb-call' }).then((l) => l.forEach((x) => x.close()))); }
});

self.addEventListener('push', (e) => {
  e.waitUntil((async () => {
    const me = await readMe();
    const ring = me && me.api ? await fetchPending(me) : null;
    if (!ring) {
      if (ringing) return;
      await self.registration.showNotification('DusukMB Call', { body: 'Cevapsız arama', tag: 'dusukmb-missed', icon: 'icon-192.png', badge: 'icon-192.png' });
      return;
    }
    await ringLoop(ring);
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  if (e.notification.tag === 'dusukmb-call') stopRing();
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

// DusukMB Call - Cloudflare Worker + Durable Object tanıştırma sunucusu
//
// PeerJS sunucu protokolünün ihtiyacımız olan kısmı:
//   wss://<worker>/peerjs?key=peerjs&id=<kimlik>&token=<anahtar>
//   Sunucu -> {type:"OPEN"} veya {type:"ID-TAKEN"}
//   İstemci -> {type:"OFFER"|"ANSWER"|"CANDIDATE"|"LEAVE", dst, payload}  => karşıya {type, src, dst, payload}
//   Karşı taraf yoksa -> {type:"EXPIRE", src:dst}
//   {type:"HEARTBEAT"} sunucuyu uyandırmadan otomatik yanıtlanır (ücretsiz kotayı harcamaz)
//
// Her oda kendi Durable Object'inde çalışır (kimlik "...-a"/"...-b" son ekinden oda bulunur),
// böylece iki taraf her zaman aynı nesnede buluşur.

const HEARTBEAT = '{"type":"HEARTBEAT"}';
const STALE_MS = 20000; // bu kadar süre ses gelmeyen eski bağlantı "ölü" sayılır

function roomOf(id) {
  // dusukmb-<oda>-<hash>-a  ->  dusukmb-<oda>-<hash>
  return id.replace(/-[ab]$/, '');
}

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' },
});

// TURN: Cloudflare TURN anahtarı tanımlıysa kısa ömürlü kimlik bilgisi üret; yoksa sadece STUN.
// Tarayıcı önce doğrudan (P2P) bağlanmayı dener, olmazsa kendiliğinden TURN'e geçer.
async function iceServers(env) {
  const base = [{ urls: 'stun:stun.cloudflare.com:3478' }, { urls: 'stun:stun.l.google.com:19302' }];
  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) return { iceServers: base, turn: false };
  try {
    const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: 86400 }),
    });
    if (!r.ok) return { iceServers: base, turn: false, error: r.status };
    const j = await r.json();
    const list = Array.isArray(j.iceServers) ? j.iceServers : [j.iceServers];
    return { iceServers: [...base, ...list.filter(Boolean)], turn: true };
  } catch (e) {
    return { iceServers: base, turn: false, error: String(e) };
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') return new Response('dusukmb-signal ok', { headers: { 'Access-Control-Allow-Origin': '*' } });
    if (url.pathname === '/ice') return json(await iceServers(env));

    // 1'e 1 görüşme tanıştırması (PeerJS protokolü)
    if (url.pathname === '/peerjs/id') return new Response(crypto.randomUUID(), { headers: { 'Access-Control-Allow-Origin': '*' } });
    if (url.pathname === '/peerjs') {
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('websocket bekleniyor', { status: 426 });
      const id = url.searchParams.get('id') || '';
      const token = url.searchParams.get('token') || '';
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(id) || !token) return new Response('geçersiz kimlik', { status: 400 });
      return env.ROOMS.get(env.ROOMS.idFromName(roomOf(id))).fetch(request);
    }

    // Topluluk (Discord sunucusu gibi): oda listesi, kim nerede, çok kişili görüşme tanıştırması
    if (url.pathname === '/community') {
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('websocket bekleniyor', { status: 426 });
      const code = (url.searchParams.get('c') || '').toLowerCase();
      if (!/^[a-z0-9_-]{2,40}$/.test(code)) return new Response('geçersiz topluluk kodu', { status: 400 });
      return env.COMMUNITY.get(env.COMMUNITY.idFromName(code)).fetch(request);
    }

    // Site dosyası değilse
    if (env.ASSETS) {
      const r = await env.ASSETS.fetch(request);
      if (r.status !== 404) return r;
    }
    return new Response('bulunamadı', { status: 404 });
  },
};

export class SignalRoom {
  constructor(state) {
    this.state = state;
    // Kalp atışı mesajı nesneyi uyandırmadan yanıtlanır
    this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair(HEARTBEAT, HEARTBEAT));
  }

  findSocket(id) {
    const list = this.state.getWebSockets(id);
    return list.length ? list[0] : null;
  }

  lastSeen(ws) {
    const t = this.state.getWebSocketAutoResponseTimestamp(ws);
    const a = ws.deserializeAttachment() || {};
    return Math.max(t ? t.getTime() : 0, a.connectedAt || 0, a.lastMsg || 0);
  }

  async fetch(request) {
    const url = new URL(request.url);
    const id = url.searchParams.get('id');
    const token = url.searchParams.get('token');
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    const existing = this.findSocket(id);
    if (existing) {
      const a = existing.deserializeAttachment() || {};
      const stale = Date.now() - this.lastSeen(existing) > STALE_MS;
      if (a.token === token || stale) {
        // Aynı kişi yeniden bağlanıyor (sayfa yenileme / ağ değişimi) ya da eski bağlantı ölü: yenisi geçer
        try { existing.close(4000, 'yeniden bağlandı'); } catch {}
      } else {
        this.state.acceptWebSocket(server, ['_taken']);
        server.send(JSON.stringify({ type: 'ID-TAKEN', payload: { msg: 'ID is taken' } }));
        server.close(1008, 'ID-TAKEN');
        return new Response(null, { status: 101, webSocket: client });
      }
    }

    this.state.acceptWebSocket(server, [id]);
    server.serializeAttachment({ id, token, connectedAt: Date.now() });
    server.send(JSON.stringify({ type: 'OPEN' }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== 'string' || raw.length > 64 * 1024) return;
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const a = ws.deserializeAttachment() || {};
    if (!a.id) return;
    if (msg.type === 'HEARTBEAT') return;
    a.lastMsg = Date.now();
    ws.serializeAttachment(a);

    if (!['OFFER', 'ANSWER', 'CANDIDATE', 'LEAVE'].includes(msg.type) || typeof msg.dst !== 'string') return;
    const dst = this.findSocket(msg.dst);
    if (!dst) {
      if (msg.type !== 'LEAVE') ws.send(JSON.stringify({ type: 'EXPIRE', src: msg.dst }));
      return;
    }
    try { dst.send(JSON.stringify({ type: msg.type, src: a.id, dst: msg.dst, payload: msg.payload })); } catch {}
  }

  async webSocketClose(ws, code, reason) {
    try { ws.close(code === 1005 ? 1000 : code, 'kapandı'); } catch {}
  }

  async webSocketError(ws) {
    try { ws.close(1011, 'hata'); } catch {}
  }
}


// ---------------------------------------------------------------------------
// Topluluk: kalıcı oda listesi + kim hangi odada + oda içi sinyal ve sohbet aktarımı
//
// İstemci -> sunucu:
//   {t:'create', room} {t:'delete', room} {t:'join', room} {t:'leave'}
//   {t:'signal', to, data}  (aynı odadaki kişiye WebRTC kurulum mesajı)
//   {t:'chat', text}        (odadakilere)
//   {t:'meta', muted, cam}  (mikrofon/kamera durumu)
// Sunucu -> istemci:
//   {t:'welcome', id, state} {t:'state', ...} {t:'joined', room, peers} {t:'signal', from, data}
//   {t:'chat', from, name, text, ts} {t:'error', msg}
const ROOM_MAX = 4;          // oda başına kişi (herkes herkese bağlanır; daha fazlası veri tüketimini katlar)
const ROOMS_MAX = 30;        // topluluk başına oda
const DEFAULT_ROOMS = ['Genel', 'Sohbet', 'Oyun'];
const PING = 'ping';

export class Community {
  constructor(state) {
    this.state = state;
    this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, 'pong'));
    this.rooms = null;
  }

  async loadRooms() {
    if (!this.rooms) this.rooms = (await this.state.storage.get('rooms')) || DEFAULT_ROOMS.slice();
    return this.rooms;
  }
  async saveRooms() { await this.state.storage.put('rooms', this.rooms); }

  members() {
    const out = [];
    for (const ws of this.state.getWebSockets()) {
      const a = ws.deserializeAttachment();
      if (a && a.id && !a.closed) out.push({ ws, a });
    }
    return out;
  }

  async snapshot() {
    const rooms = await this.loadRooms();
    const ms = this.members();
    return {
      t: 'state',
      locked: !!(await this.state.storage.get('pw')),
      online: ms.length,
      rooms: rooms.map((name) => ({
        name,
        members: ms.filter((m) => m.a.room === name).map((m) => ({ id: m.a.id, name: m.a.name, muted: !!m.a.muted, cam: !!m.a.cam })),
      })),
      lobby: ms.filter((m) => !m.a.room).map((m) => ({ id: m.a.id, name: m.a.name })),
    };
  }

  async broadcast() {
    const s = JSON.stringify(await this.snapshot());
    for (const m of this.members()) { try { m.ws.send(s); } catch {} }
  }

  send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch {} }

  async fetch(request) {
    const url = new URL(request.url);
    const id = (url.searchParams.get('id') || '').slice(0, 40);
    const token = (url.searchParams.get('token') || '').slice(0, 80);
    const name = (url.searchParams.get('name') || 'Misafir').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 24) || 'Misafir';
    if (!/^[A-Za-z0-9_-]{6,40}$/.test(id) || !token) return new Response('geçersiz', { status: 400 });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Parola: istemci parolanın kendisini değil SHA-256 özetini gönderir (k). Sunucu parolayı hiç görmez.
    const pw = await this.state.storage.get('pw');
    const key = (url.searchParams.get('k') || '').slice(0, 128);
    if (pw && key !== pw) {
      this.state.acceptWebSocket(server, ['_auth']);
      server.serializeAttachment({ closed: true });
      server.send(JSON.stringify({ t: 'auth', msg: key ? 'Parola yanlış' : 'Bu topluluk parolalı' }));
      server.close(4001, 'parola');
      return new Response(null, { status: 101, webSocket: client });
    }

    // Aynı kişi yeniden bağlanıyorsa (yenileme, ağ değişimi) eskisini kapat; başkası aynı kimliği kullanamaz
    for (const m of this.members()) {
      if (m.a.id !== id) continue;
      if (m.a.token !== token) { return new Response('kimlik kullanımda', { status: 409 }); }
      m.a.closed = true; m.ws.serializeAttachment(m.a);
      try { m.ws.close(4000, 'yeniden bağlandı'); } catch {}
    }

    this.state.acceptWebSocket(server);
    server.serializeAttachment({ id, token, name, room: null, muted: false, cam: false, at: Date.now() });
    this.send(server, { t: 'welcome', id, state: await this.snapshot() });
    await this.broadcast();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== 'string' || raw.length > 64 * 1024) return;
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    const a = ws.deserializeAttachment();
    if (!a || a.closed) return;
    const rooms = await this.loadRooms();
    const clean = (s) => String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 32);

    switch (msg.t) {
      case 'create': {
        const room = clean(msg.room);
        if (!room) return;
        if (rooms.includes(room)) return this.send(ws, { t: 'error', msg: 'Bu isimde oda zaten var' });
        if (rooms.length >= ROOMS_MAX) return this.send(ws, { t: 'error', msg: 'Oda sınırına ulaşıldı' });
        rooms.push(room); await this.saveRooms(); await this.broadcast();
        return;
      }
      case 'delete': {
        const room = clean(msg.room);
        if (this.members().some((m) => m.a.room === room)) return this.send(ws, { t: 'error', msg: 'Dolu oda silinemez' });
        this.rooms = rooms.filter((r) => r !== room); await this.saveRooms(); await this.broadcast();
        return;
      }
      case 'join': {
        const room = clean(msg.room);
        if (!rooms.includes(room)) return this.send(ws, { t: 'error', msg: 'Oda bulunamadı' });
        if (a.room === room) return;
        const inside = this.members().filter((m) => m.a.room === room && m.a.id !== a.id);
        if (inside.length >= ROOM_MAX) return this.send(ws, { t: 'error', msg: `Oda dolu (en fazla ${ROOM_MAX} kişi)` });
        a.room = room; a.muted = !!msg.muted; a.cam = !!msg.cam; ws.serializeAttachment(a);
        this.send(ws, { t: 'joined', room, peers: inside.map((m) => ({ id: m.a.id, name: m.a.name })) });
        await this.broadcast();
        return;
      }
      case 'leave': {
        if (!a.room) return;
        a.room = null; ws.serializeAttachment(a);
        await this.broadcast();
        return;
      }
      case 'setpass': {
        // İçerideki biri parola koyar/değiştirir/kaldırır (key = özet; boş = kaldır). İçeridekiler bağlı kalır.
        const k = String(msg.key || '').slice(0, 128);
        if (k && !/^[a-f0-9]{64}$/.test(k)) return;
        if (k) await this.state.storage.put('pw', k); else await this.state.storage.delete('pw');
        await this.broadcast();
        return;
      }
      case 'meta': {
        a.muted = !!msg.muted; a.cam = !!msg.cam; ws.serializeAttachment(a);
        await this.broadcast();
        return;
      }
      case 'signal': {
        if (!a.room || typeof msg.to !== 'string') return;
        const dst = this.members().find((m) => m.a.id === msg.to && m.a.room === a.room);
        if (dst) this.send(dst.ws, { t: 'signal', from: a.id, data: msg.data });
        return;
      }
      case 'chat': {
        if (!a.room) return;
        const text = String(msg.text || '').slice(0, 500);
        if (!text.trim()) return;
        const out = { t: 'chat', from: a.id, name: a.name, text, ts: Date.now(), id: String(msg.id || '').slice(0, 40) };
        for (const m of this.members()) if (m.a.room === a.room) this.send(m.ws, out);
        return;
      }
    }
  }

  async webSocketClose(ws) {
    const a = ws.deserializeAttachment();
    if (a) { a.closed = true; ws.serializeAttachment(a); }
    try { ws.close(1000, 'kapandı'); } catch {}
    await this.broadcast();
  }

  async webSocketError(ws) { await this.webSocketClose(ws); }
}

// DusukMB Call - kullanıcı adıyla arama ("telefon rehberi")
//
// Her kullanıcı adının kendi Durable Object'i (UserBox) var:
//   - Sahibi (o kullanıcı adının telefonları) WebSocket ile bağlı kalır  => "çevrimiçi"
//   - Arayan WebSocket açınca sahibin tüm cihazları çalar; tarayıcı kapalı/uyuyorsa Web Push ile uyandırılır
//   - Sahip "kabul/ret" der, arayana iletilir; kabul edilirse iki taraf aynı oda koduyla 1'e 1 görüşmeye girer
// Web Push anahtarı (VAPID) ilk kullanımda üretilip VapidKeys nesnesinde saklanır; gizli değişken gerekmez.
// Push mesajı boş gönderilir (şifreleme gerekmez); telefon uyanınca kimin aradığını /phone/pending'den öğrenir.

const RING_MS = 45000;
const NAME_RE = /^[a-z0-9_.-]{3,20}$/;
const HDR = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: HDR });

const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64uStr = (s) => b64u(new TextEncoder().encode(s));
async function sha256(s) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(h)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export function cors() {
  return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' } });
}

// Worker tarafı yönlendirme: /phone/...
export async function handlePhone(request, env, url) {
  if (request.method === 'OPTIONS') return cors();
  const keys = () => env.KEYS.get(env.KEYS.idFromName('vapid'));
  const box = (name) => env.USERS.get(env.USERS.idFromName(name));
  const sub = url.pathname.slice('/phone'.length);

  if (sub === '/vapid') return keys().fetch('https://k/pub');

  if (sub === '/status') {
    const names = (url.searchParams.get('names') || '').toLowerCase().split(',').filter((n) => NAME_RE.test(n)).slice(0, 30);
    const out = {};
    await Promise.all(names.map(async (n) => {
      try { out[n] = await (await box(n).fetch('https://u/status')).json(); } catch { out[n] = { online: false }; }
    }));
    return json(out);
  }

  const name = (url.searchParams.get('name') || '').toLowerCase();
  if (!NAME_RE.test(name)) return json({ error: 'Kullanıcı adı 3-20 karakter: harf, rakam, . _ -' }, 400);
  if (sub === '/ws') {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('websocket bekleniyor', { status: 426 });
    return box(name).fetch(request);
  }
  if (['/sub', '/unsub', '/pending', '/answer', '/claim'].includes(sub)) {
    const u = new URL('https://u' + sub + url.search);
    return box(name).fetch(new Request(u, { method: request.method, headers: request.headers, body: request.method === 'POST' ? await request.text() : undefined }));
  }
  return json({ error: 'bulunamadı' }, 404);
}

// ---------- VAPID anahtarı ----------
export class VapidKeys {
  constructor(state) { this.state = state; this.cache = new Map(); }
  async keys() {
    if (this.k) return this.k;
    let s = await this.state.storage.get('k');
    if (!s) {
      const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
      s = { priv: await crypto.subtle.exportKey('jwk', kp.privateKey), pub: b64u(await crypto.subtle.exportKey('raw', kp.publicKey)) };
      await this.state.storage.put('k', s);
    }
    const priv = await crypto.subtle.importKey('jwk', s.priv, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    this.k = { priv, pub: s.pub };
    return this.k;
  }
  async fetch(request) {
    const url = new URL(request.url);
    const k = await this.keys();
    if (url.pathname === '/pub') return json({ key: k.pub });
    if (url.pathname === '/sign') {
      const aud = url.searchParams.get('aud');
      const c = this.cache.get(aud);
      if (c && c.exp - Date.now() / 1000 > 3600) return json({ jwt: c.jwt, k: k.pub });
      const exp = Math.floor(Date.now() / 1000) + 12 * 3600;
      const head = b64uStr(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
      const body = b64uStr(JSON.stringify({ aud, exp, sub: 'https://dusukmb-signal.akadirpars.workers.dev/' }));
      const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, k.priv, new TextEncoder().encode(`${head}.${body}`));
      const jwt = `${head}.${body}.${b64u(sig)}`;
      this.cache.set(aud, { jwt, exp });
      return json({ jwt, k: k.pub });
    }
    return json({ error: 'bulunamadı' }, 404);
  }
}

// ---------- Kullanıcı kutusu ----------
export class UserBox {
  constructor(state, env) {
    this.state = state; this.env = env;
    this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'));
  }
  owners() { return this.state.getWebSockets('owner'); }
  callers() { return this.state.getWebSockets('caller'); }
  send(list, msg) { const s = JSON.stringify(msg); for (const ws of list) { try { ws.send(s); } catch {} } }
  async authed(token) {
    if (!token) return false;
    const h = await this.state.storage.get('owner');
    return !!h && h === await sha256(token);
  }
  async pending() {
    const p = await this.state.storage.get('pending');
    if (p && Date.now() - p.ts < RING_MS) return p;
    return null;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const q = url.searchParams;
    const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {};
    const token = body.token || q.get('token') || '';

    if (url.pathname === '/status') {
      const subs = (await this.state.storage.get('subs')) || [];
      return json({ online: this.owners().length > 0, push: subs.length > 0, exists: !!(await this.state.storage.get('owner')) });
    }

    // Kullanıcı adını al (ilk alan sahibi olur) ya da sahibi olduğunu doğrula
    if (url.pathname === '/claim') {
      if (!token || token.length < 16) return json({ error: 'geçersiz anahtar' }, 400);
      const h = await this.state.storage.get('owner');
      if (!h) { await this.state.storage.put('owner', await sha256(token)); return json({ ok: true, created: true }); }
      if (h === await sha256(token)) return json({ ok: true });
      return json({ error: 'Bu kullanıcı adı alınmış, başka bir ad dene' }, 409);
    }

    if (q.get('role') === 'owner' || q.get('role') === 'caller') {
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('websocket bekleniyor', { status: 426 });
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      if (q.get('role') === 'owner') {
        if (!(await this.authed(token))) {
          this.state.acceptWebSocket(server, ['x']);
          server.send(JSON.stringify({ t: 'auth', error: 'Kullanıcı adı doğrulanamadı' }));
          server.close(4001, 'auth');
          return new Response(null, { status: 101, webSocket: client });
        }
        this.state.acceptWebSocket(server, ['owner']);
        const p = await this.pending();
        server.send(JSON.stringify({ t: 'hello', ring: p ? { id: p.id, from: p.from, room: p.room, video: !!p.video } : null }));
        return new Response(null, { status: 101, webSocket: client });
      }
      // Arayan
      const from = (q.get('from') || '').toLowerCase().slice(0, 20) || 'misafir';
      const room = (q.get('room') || '').toLowerCase();
      const video = q.get('video') === '1';
      const exists = !!(await this.state.storage.get('owner'));
      const subs = (await this.state.storage.get('subs')) || [];
      const online = this.owners().length > 0;
      const cur = await this.pending();
      const fail = !/^[a-z0-9]{4,16}$/.test(room) ? 'error' : !exists ? 'nouser' : (!online && !subs.length) ? 'offline' : (cur && cur.room !== room) ? 'busy' : '';
      if (fail) {
        this.state.acceptWebSocket(server, ['x']);
        server.send(JSON.stringify({ t: fail }));
        server.close(1000, fail);
        return new Response(null, { status: 101, webSocket: client });
      }
      this.state.acceptWebSocket(server, ['caller']);
      const p = { id: crypto.randomUUID().slice(0, 8), from, room, video, ts: Date.now() };
      await this.state.storage.put('pending', p);
      await this.state.storage.setAlarm(Date.now() + RING_MS);
      this.send(this.owners(), { t: 'ring', id: p.id, from, room, video });
      const pushed = subs.length ? this.push(subs) : Promise.resolve(0);
      server.send(JSON.stringify({ t: 'ringing', online, push: subs.length }));
      this.state.waitUntil(pushed);
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === '/pending') {
      if (!(await this.authed(token))) return json({ error: 'yetkisiz' }, 401);
      const p = await this.pending();
      return json({ ring: p ? { id: p.id, from: p.from, room: p.room, video: !!p.video } : null });
    }
    if (url.pathname === '/answer') {
      if (!(await this.authed(token))) return json({ error: 'yetkisiz' }, 401);
      return json({ ok: await this.answer(body.id, !!body.accept) });
    }
    if (url.pathname === '/sub' || url.pathname === '/unsub') {
      if (!(await this.authed(token))) return json({ error: 'yetkisiz' }, 401);
      const s = body.sub;
      let subs = (await this.state.storage.get('subs')) || [];
      if (s && s.endpoint) subs = subs.filter((x) => x.endpoint !== s.endpoint);
      if (url.pathname === '/sub') {
        if (!s || typeof s.endpoint !== 'string' || !/^https:\/\//.test(s.endpoint)) return json({ error: 'geçersiz abonelik' }, 400);
        subs.push({ endpoint: s.endpoint, t: Date.now() });
        subs = subs.slice(-5);
      }
      await this.state.storage.put('subs', subs);
      return json({ ok: true, count: subs.length });
    }
    return json({ error: 'bulunamadı' }, 404);
  }

  async answer(id, accept) {
    const p = await this.pending();
    if (!p || p.id !== id) return false;
    await this.state.storage.delete('pending');
    this.send(this.callers(), { t: 'answer', accept });
    this.send(this.owners(), { t: 'handled', id, accept });
    return true;
  }

  // Boş Web Push: telefondaki service worker uyanır, /pending'den kimin aradığını okur ve bildirimi gösterir
  async push(subs) {
    let n = 0;
    const keep = [];
    const keys = this.env.KEYS.get(this.env.KEYS.idFromName('vapid'));
    for (const s of subs) {
      try {
        const aud = new URL(s.endpoint).origin;
        const { jwt, k } = await (await keys.fetch('https://k/sign?aud=' + encodeURIComponent(aud))).json();
        const r = await fetch(s.endpoint, { method: 'POST', headers: { Authorization: `vapid t=${jwt}, k=${k}`, TTL: '45', Urgency: 'high', 'Content-Length': '0' } });
        if (r.status === 404 || r.status === 410) continue; // abonelik ölmüş
        if (r.ok) n++;
        keep.push(s);
      } catch { keep.push(s); }
    }
    if (keep.length !== subs.length) await this.state.storage.put('subs', keep);
    return n;
  }

  async alarm() {
    const p = await this.state.storage.get('pending');
    if (p && Date.now() - p.ts >= RING_MS - 500) {
      await this.state.storage.delete('pending');
      this.send(this.callers(), { t: 'noanswer' });
      this.send(this.owners(), { t: 'cancel', id: p.id });
    }
  }

  async webSocketMessage(ws, raw) {
    let m; try { m = JSON.parse(raw); } catch { return; }
    const tags = this.state.getTags(ws);
    if (tags.includes('owner') && m.t === 'answer') await this.answer(m.id, !!m.accept);
    if (tags.includes('caller') && m.t === 'cancel') await this.cancel();
  }
  async cancel() {
    const p = await this.state.storage.get('pending');
    if (!p) return;
    await this.state.storage.delete('pending');
    this.send(this.owners(), { t: 'cancel', id: p.id });
  }
  async webSocketClose(ws) {
    const tags = this.state.getTags(ws);
    // Arayan vazgeçti (sayfayı kapattı) ve başka arayan yoksa çalmayı durdur
    if (tags.includes('caller') && this.callers().filter((c) => c !== ws).length === 0) await this.cancel();
  }
  async webSocketError(ws) { await this.webSocketClose(ws); }
}

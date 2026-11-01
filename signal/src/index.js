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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = { 'Access-Control-Allow-Origin': '*' };

    if (url.pathname === '/' || url.pathname === '/health') {
      return new Response('dusukmb-signal ok', { headers: { ...cors, 'Content-Type': 'text/plain' } });
    }
    // PeerJS istemcisi kimlik vermezse buradan ister (bizim uygulama hep kimlik verir)
    if (url.pathname === '/peerjs/id') {
      return new Response(crypto.randomUUID(), { headers: cors });
    }
    if (url.pathname === '/peerjs') {
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('websocket bekleniyor', { status: 426 });
      const id = url.searchParams.get('id') || '';
      const token = url.searchParams.get('token') || '';
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(id) || !token) return new Response('geçersiz kimlik', { status: 400 });
      const stub = env.ROOMS.get(env.ROOMS.idFromName(roomOf(id)));
      return stub.fetch(request);
    }
    return new Response('bulunamadı', { status: 404, headers: cors });
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

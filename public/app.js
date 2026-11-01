// DusukMB Call - istemci
(() => {
  // Bit hızları "kablodaki" toplamı ~hedefe oturtacak şekilde seçildi (RTP/UDP başlıkları ~15-20 kbps ekler)
  const PROFILES = {
    // Hedefler telefon başına TOPLAM (gönderilen + alınan)
    // (Chrome videoyu 30 kbps altına indirmiyor; altı için fotoğraf modu kullanılır)
    ses:    { audioOnly: true, abr: 10000 },                     // ~15 MB/saat
    // 30 kbps altı: tarayıcı videoyu bu kadar kısamıyor, kamera küçük fotoğraflar olarak gönderilir
    endusuk:  { snap: true, w: 160, h: 120, fps: 1, vbr: 8000,  abr: 8000 },  // ~21 MB/saat
    cokdusuk: { snap: true, w: 240, h: 180, fps: 2, vbr: 16000, abr: 8000 },  // ~28 MB/saat
    normal: { w: 240, h: 180, fps: 12, vbr: 32000, abr: 10000 }, // ~47 MB/saat
    iyi:    { w: 320, h: 240, fps: 15, vbr: 70000, abr: 16000 }, // ~85 MB/saat
    hd:     { w: 1280, h: 720, fps: 24, vbr: 900000, abr: 24000, capW: 1280, capH: 720 }, // 720p, ~800 MB/saat
    ozel:   { w: 240, h: 180, fps: 12, vbr: 32000, abr: 10000 },  // kullanıcı ayarlar
  };
  const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  const $ = (id) => document.getElementById(id);
  const lobby = $('lobby'), call = $('call');
  const localVideo = $('localVideo'), remoteVideo = $('remoteVideo'), remoteCanvas = $('remoteCanvas');
  const statusEl = $('status');

  let pc, localStream, room, iceConfig, profile = 'normal', codecPref = 'auto';
  let isOfferer = false, remoteIOS = false, pendingIce = [];
  let statsTimer = null, callStart = 0, prevStats = null, leaving = false, hourBase = null;
  function resetHourly() { hourBase = null; if ($('sHour')) $('sHour').textContent = 'ölçülüyor…'; }
  window.__dusukmb = { get pc() { return pc; } }; // hata ayıklama için
  const enhancer = window.Enhancer ? window.Enhancer.create(remoteVideo, remoteCanvas) : null;

  // ---------- Lobi ----------
  const params = new URLSearchParams(location.search);
  if (params.get('oda')) $('room').value = params.get('oda');
  $('randomBtn').onclick = () => { $('room').value = Math.random().toString(36).slice(2, 8); };
  $('joinBtn').onclick = () => start($('room').value.trim().toLowerCase());
  $('room').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('joinBtn').click(); });

  function setStatus(t) { statusEl.textContent = t; statusEl.classList.toggle('hidden', !t); }

  async function start(r) {
    if (!r) { $('room').focus(); return; }
    room = r;
    history.replaceState(null, '', `?oda=${encodeURIComponent(room)}`);
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
        // 480×360 aç, profil küçültmeyi kodlayıcıda yapsın (scaleResolutionDownBy)
        video: { facingMode: 'user', width: { ideal: 480 }, height: { ideal: 360 }, frameRate: { ideal: 15, max: 15 } },
      });
    } catch (e) {
      alertInline('Kamera/mikrofon izni gerekli: ' + e.message);
      return;
    }
    localVideo.srcObject = localStream;
    lobby.classList.add('hidden');
    call.classList.remove('hidden');
    setStatus('Sunucuya bağlanıyor…');
    // Kendi sunucumuz varsa config.json'dan okunur; yoksa (GitHub Pages) ücretsiz PeerJS sinyal sunucusu kullanılır
    let cfg = {};
    try { const r = await fetch('config.json', { cache: 'no-store' }); if (r.ok) cfg = await r.json(); } catch {}
    signalCfg = cfg.signal || { host: '0.peerjs.com', port: 443, secure: true, path: '/', key: 'peerjs' };
    iceConfig = { iceServers: cfg.iceServers || [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun.cloudflare.com:3478' }] };
    connectSignal('a');
  }

  function alertInline(t) {
    let el = document.querySelector('.error');
    if (!el) { el = document.createElement('p'); el.className = 'error'; lobby.appendChild(el); }
    el.textContent = t;
  }

  // ---------- Sinyal (resmi PeerJS kütüphanesi) ----------
  // Odaya ilk giren "a", ikinci giren "b" kimliğini alır. "b", "a"ya küçük bir veri kanalı açar;
  // görüşme kurulum mesajları (offer/answer/ice) bu kanaldan gider. Görüntü/ses ayrı bağlantıdan akar.
  let signalCfg, myRole = null, myId = '', otherId = '', peer = null, conn = null, retryTimer = null;
  function roomKey(r) {
    let h = 0x811c9dc5;
    for (const ch of r) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
    return `dusukmb-${r.replace(/[^a-z0-9]/g, '').slice(0, 16)}-${h.toString(16)}`;
  }
  function connectSignal(role) {
    const base = roomKey(room);
    myRole = role; myId = `${base}-${role}`; otherId = `${base}-${role === 'a' ? 'b' : 'a'}`;
    const c = signalCfg;
    const p = new Peer(myId, { host: c.host, port: Number(c.port), secure: c.secure, path: c.path, key: c.key, config: iceConfig, debug: 0 });
    peer = p;
    p.on('open', () => {
      if (myRole === 'a') { if (!pc) setStatus('Karşı taraf bekleniyor… Linki paylaş 🔗'); }
      else { setStatus('Bağlanıyor…'); connectToA(); }
    });
    p.on('connection', (c2) => { if (c2.peer === otherId) attachConn(c2); else c2.close(); });
    p.on('disconnected', () => { if (!leaving && !p.destroyed) { try { p.reconnect(); } catch {} } });
    p.on('error', (e) => {
      if (e.type === 'unavailable-id') {
        p.destroy();
        if (role === 'a') connectSignal('b'); else onSignal({ type: 'full' });
      } else if (e.type === 'peer-unavailable') {
        // "a" henüz/artık yok: biraz sonra tekrar dene
        scheduleRetry();
      } else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(e.type)) {
        if (leaving) return;
        setStatus('Sunucuya ulaşılamıyor, tekrar deneniyor…');
        clearTimeout(retryTimer);
        retryTimer = setTimeout(() => { try { p.destroy(); } catch {} connectSignal('a'); }, 3000);
      } else console.warn('sinyal', e.type, e);
    });
  }
  function scheduleRetry() {
    clearTimeout(retryTimer);
    if (!leaving && myRole === 'b') retryTimer = setTimeout(connectToA, 3000);
  }
  function connectToA() {
    if (!peer || peer.destroyed || leaving) return;
    if (conn && conn.open) return;
    attachConn(peer.connect(otherId, { serialization: 'binary', reliable: true }));
  }
  function attachConn(c) {
    if (conn && conn !== c) { try { conn.close(); } catch {} }
    conn = c;
    c.on('open', () => { if (myRole === 'b') { isOfferer = false; signal({ type: 'hello', ios: IS_IOS }); } });
    c.on('data', (m) => { if (m && m.type) onSignal(m); });
    c.on('close', () => {
      if (conn !== c) return;
      conn = null;
      if (!leaving) { onSignal({ type: 'bye' }); scheduleRetry(); }
    });
    c.on('error', () => scheduleRetry());
  }
  function signal(msg) { if (conn && conn.open) conn.send(msg); }

  async function onSignal(msg) {
    switch (msg.type) {
      case 'full':
        setStatus('Bu oda dolu (en fazla 2 kişi).');
        leaving = true; if (peer) peer.destroy();
        break;
      case 'hello':
        // İlk giren taraf ("a") teklifi oluşturur
        if (myRole !== 'a') break;
        resetPc();
        isOfferer = true; remoteIOS = !!msg.ios;
        setStatus('Bağlanıyor…');
        makeOffer();
        break;
      case 'offer':
        await ensurePc(false);
        await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
        attachTracksToOffered();
        await flushIce();
        {
          const ans = await pc.createAnswer();
          ans.sdp = mungeSdp(ans.sdp);
          await pc.setLocalDescription(ans);
          signal({ type: 'answer', sdp: ans.sdp });
        }
        applyProfile();
        break;
      case 'answer':
        if (pc) { await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp }); await flushIce(); applyProfile(); }
        break;
      case 'ice':
        if (pc && pc.remoteDescription) { try { await pc.addIceCandidate(msg.candidate); } catch (e) { console.warn(e); } }
        else pendingIce.push(msg.candidate);
        break;
      case 'codec':
        setCodec(msg.value, false);
        break;
      case 'profile':
        if (msg.custom) Object.assign(PROFILES.ozel, msg.custom);
        if (PROFILES[msg.value]) { profile = msg.value; $('profile').value = profile; syncCustomUi(); applyProfile(); }
        break;
      case 'frame':
        showSnap(msg);
        break;
      case 'chat':
        addChat(String(msg.text || '').slice(0, 1000), 'them');
        break;
      case 'bye':
        setStatus('Karşı taraf ayrıldı. Bekleniyor…');
        resetPc();
        break;
    }
  }

  async function flushIce() {
    for (const c of pendingIce) { try { await pc.addIceCandidate(c); } catch (e) { console.warn(e); } }
    pendingIce = [];
  }

  // ---------- WebRTC ----------
  // Cevap veren taraf: teklifle gelen alıcıları (transceiver) yeniden kullan, yenisini açma
  function attachTracksToOffered() {
    const sending = new Set(pc.getSenders().map((s) => s.track).filter(Boolean));
    for (const track of localStream.getTracks()) {
      if (sending.has(track)) continue;
      pc.addTrack(track, localStream);
    }
    for (const tr of pc.getTransceivers()) {
      if (tr.receiver.track && tr.receiver.track.kind === 'video') preferCodecs(tr);
    }
  }

  async function ensurePc(addTracks = true) {
    if (pc) return pc;
    pc = new RTCPeerConnection(iceConfig);
    if (addTracks) {
      for (const track of localStream.getTracks()) {
        const tr = pc.addTransceiver(track, { direction: 'sendrecv', streams: [localStream] });
        if (track.kind === 'video') preferCodecs(tr);
      }
    }
    pc.onicecandidate = (e) => { if (e.candidate) signal({ type: 'ice', candidate: e.candidate.toJSON() }); };
    pc.ontrack = (e) => {
      if (remoteVideo.srcObject !== e.streams[0]) {
        remoteVideo.srcObject = e.streams[0];
        remoteVideo.play().catch(() => setStatus('Sesi açmak için ekrana dokun'));
        if (enhancer) enhancer.start();
      }
    };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === 'connected') { setStatus(''); if (!callStart) callStart = Date.now(); startStats(); applyProfile(); }
      else if (s === 'disconnected') setStatus('Bağlantı zayıf…');
      else if (s === 'failed') {
        // Karşı taraf gitti ya da ağ koptu: baştan kurmayı dene, karşı taraf hâlâ oradaysa yanıt verir
        setStatus('Bağlantı koptu. Karşı taraf bekleniyor…');
        resetPc();
        if (myRole === 'b') signal({ type: 'hello', ios: IS_IOS });
      }
    };
    return pc;
  }

  async function makeOffer(iceRestart = false) {
    await ensurePc();
    const offer = await pc.createOffer({ iceRestart });
    offer.sdp = mungeSdp(offer.sdp);
    await pc.setLocalDescription(offer);
    signal({ type: 'offer', sdp: offer.sdp });
  }

  function resetPc() {
    if (pc) { pc.close(); pc = null; }
    pendingIce = []; remoteVideo.srcObject = null; callStart = 0; prevStats = null; hourBase = null;
    if (enhancer) enhancer.stop();
    stopStats();
  }

  // Düşük bit hızında VP9 en verimli; iPhone tarafında donanım H.264 daha az pil yer
  function preferCodecs(transceiver) {
    if (!transceiver.setCodecPreferences || !RTCRtpReceiver.getCapabilities) return;
    const caps = RTCRtpReceiver.getCapabilities('video');
    if (!caps) return;
    const auto = (IS_IOS || remoteIOS) ? ['video/H264', 'video/VP8', 'video/VP9'] : ['video/VP9', 'video/VP8', 'video/H264'];
    const pick = { av1: 'video/AV1', vp9: 'video/VP9', h264: 'video/H264' }[codecPref];
    // Seçilen codec en başa; karşı taraf desteklemezse sıradaki otomatik kullanılır
    const order = pick ? [pick, ...auto.filter((m) => m !== pick)] : auto;
    const rank = (c) => { const i = order.indexOf(c.mimeType); return i === -1 ? 99 : i; };
    try { transceiver.setCodecPreferences([...caps.codecs].sort((a, b) => rank(a) - rank(b))); } catch (e) { console.warn(e); }
  }

  // Opus: mono, dar bant (16 kHz), hedef bit hızı, sessizlikte veri kesme (DTX)
  function mungeOpus(sdp, abr) {
    const m = sdp.match(/a=rtpmap:(\d+) opus\/48000\/2/i);
    if (!m) return sdp;
    const pt = m[1];
    const want = `maxaveragebitrate=${abr};usedtx=1;stereo=0;sprop-stereo=0;maxplaybackrate=12000;useinbandfec=1;minptime=40`;
    const drop = /^(maxaveragebitrate|usedtx|stereo|sprop-stereo|maxplaybackrate|useinbandfec|ptime|minptime)=/;
    const re = new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`);
    if (!/a=ptime:/.test(sdp)) sdp = sdp.replace(/(m=audio[^\r\n]*\r\n)/, '$1a=ptime:60\r\n');
    if (re.test(sdp)) {
      return sdp.replace(re, (_, p) => `a=fmtp:${pt} ${[...p.split(';').filter((x) => x && !drop.test(x.trim())), want].join(';')}`);
    }
    return sdp.replace(m[0], `${m[0]}\r\na=fmtp:${pt} ${want}`);
  }

  function mungeSdp(sdp) { return mungeOpus(sdp, PROFILES[profile].abr); }

  // getParameters/setParameters çağrıları üst üste binmesin diye sıraya al
  let profileQueue = Promise.resolve();
  function applyProfile() { profileQueue = profileQueue.then(applyProfileNow, applyProfileNow); return profileQueue; }

  async function applyProfileNow() {
    const p = PROFILES[profile];
    resetHourly();
    const snap = !p.audioOnly && (p.snap || p.vbr < 30000);
    const vt = localStream && localStream.getVideoTracks()[0];
    if (vt && !p.audioOnly) {
      // Kamerayı en az 480×360 aç (HD için 1280×720); küçültmeyi kodlayıcı yapar
      const capW = p.capW || Math.max(480, p.w), capH = p.capH || Math.max(360, p.h);
      const wantFps = Math.max(Math.ceil(p.fps), 15);
      try { await vt.applyConstraints({ width: { ideal: capW }, height: { ideal: capH }, frameRate: { ideal: wantFps, max: wantFps } }); } catch {}
    }
    localVideo.classList.toggle('dim', !!p.audioOnly);
    if (snap) startSnap(p); else stopSnap();
    if (!snap) $('remoteSnap').classList.add('hidden');
    if (pc && pc.connectionState === 'connected') {
      setStatus(p.audioOnly ? '🔈 Sadece ses modu' : '');
    }
    if (!pc) return;
    for (const tr of pc.getTransceivers()) {
      const s = tr.sender;
      const kind = tr.receiver.track && tr.receiver.track.kind;
      if (kind === 'video') {
        // Sadece ses / fotoğraf modu: video akışını tamamen durdur (siyah kare bile gitmesin)
        if (p.audioOnly || snap) { if (s.track) { try { await s.replaceTrack(null); } catch {} } continue; }
        if (!s.track && vt) { try { await s.replaceTrack(vt); } catch {} }
      }
      if (!s.track) continue;
      const params = s.getParameters();
      if (!params.encodings || !params.encodings.length) continue; // henüz müzakere edilmedi
      const e = params.encodings[0];
      if (s.track.kind === 'video') {
        // Bazı telefonlar istenen çözünürlüğü yok sayar; büyük gelirse kodlayıcıda küçült
        const st = s.track.getSettings();
        const big = Math.max(st.width || p.w, st.height || p.h);
        e.scaleResolutionDownBy = Math.max(1, big / Math.max(p.w, p.h));
        e.maxBitrate = p.vbr;
        e.maxFramerate = p.fps;
      } else {
        e.maxBitrate = p.abr;
      }
      try { await s.setParameters(params); } catch (err) { console.warn('setParameters', err); }
    }
  }

  // ---------- Fotoğraf modu (30 kbps altı) ----------
  // Video yerine belirli aralıklarla küçük bir fotoğraf gönderilir; kalite hedef veri miktarına göre kendini ayarlar.
  const snapCanvas = document.createElement('canvas');
  const snapCtx = snapCanvas.getContext('2d');
  const SNAP_TYPE = (() => {
    try { const c = document.createElement('canvas'); c.width = c.height = 2; return c.toDataURL('image/webp').startsWith('data:image/webp') ? 'image/webp' : 'image/jpeg'; }
    catch { return 'image/jpeg'; }
  })();
  let snapTimer = null, snapQ = 0.5, snapBusy = false, snapTx = 0, snapRx = 0, snapKey = '', snapUrl = null, lastSnapAt = 0;
  function startSnap(p) {
    const key = `${p.w}x${p.h}@${p.fps}/${p.vbr}`;
    if (snapTimer && key === snapKey) return;
    stopSnap();
    snapKey = key;
    const fps = snapFps(p);
    const target = p.vbr / 8 / fps; // fotoğraf başına hedef bayt
    snapTimer = setInterval(() => sendSnap(p, target), 1000 / fps);
  }
  // Fotoğraf başına en az ~1,5 KB kalsın; yoksa kare hızını düşür (daha küçüğü okunmaz ve hedefi aşar)
  function snapFps(p) { return Math.max(0.25, Math.min(p.fps, p.vbr / 8 / 1500)); }
  function stopSnap() { clearInterval(snapTimer); snapTimer = null; snapKey = ''; }
  function sendSnap(p, target) {
    if (snapBusy || !(conn && conn.open) || !localVideo.videoWidth) return;
    const vt = localStream && localStream.getVideoTracks()[0];
    if (!vt || !vt.enabled) return;
    snapBusy = true;
    const vw = localVideo.videoWidth, vh = localVideo.videoHeight;
    const portrait = vh > vw;
    const cw = portrait ? p.h : p.w, ch = portrait ? p.w : p.h;
    if (snapCanvas.width !== cw || snapCanvas.height !== ch) { snapCanvas.width = cw; snapCanvas.height = ch; }
    const sc = Math.max(cw / vw, ch / vh);
    snapCtx.drawImage(localVideo, (cw - vw * sc) / 2, (ch - vh * sc) / 2, vw * sc, vh * sc);
    snapCanvas.toBlob(async (b) => {
      try {
        if (!b || !(conn && conn.open)) return;
        const buf = await b.arrayBuffer();
        conn.send({ type: 'frame', data: buf, mime: b.type });
        snapTx += buf.byteLength;
        if (buf.byteLength > target * 1.1) snapQ = Math.max(0.05, snapQ - 0.05);
        else if (buf.byteLength < target * 0.8) snapQ = Math.min(0.92, snapQ + 0.03);
      } catch (e) { console.warn('foto', e); }
      finally { snapBusy = false; }
    }, SNAP_TYPE, snapQ);
  }
  function showSnap(msg) {
    if (!msg.data) return;
    const blob = new Blob([msg.data], { type: msg.mime || 'image/jpeg' });
    snapRx += blob.size;
    lastSnapAt = Date.now();
    const url = URL.createObjectURL(blob);
    const img = $('remoteSnap');
    img.onload = () => { if (snapUrl && snapUrl !== url) URL.revokeObjectURL(snapUrl); snapUrl = url; };
    img.src = url;
    img.classList.remove('hidden');
  }

  // ---------- İstatistik ----------
  function startStats() { if (!statsTimer) statsTimer = setInterval(pollStats, 2000); }
  function stopStats() { clearInterval(statsTimer); statsTimer = null; }

  const mb = (b) => (b / 1e6).toFixed(1) + ' MB';
  const kbps = (bytes, ms) => Math.round((bytes * 8) / ms) + ' kbps';

  async function pollStats() {
    if (!pc) return;
    const report = await pc.getStats();
    const byId = new Map();
    report.forEach((s) => byId.set(s.id, s));
    let pair = null, res = '-', codec = '-';
    report.forEach((s) => {
      if (s.type === 'transport' && s.selectedCandidatePairId) pair = byId.get(s.selectedCandidatePairId);
    });
    if (!pair) report.forEach((s) => { if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pair = s; });
    report.forEach((s) => {
      if (s.type === 'inbound-rtp' && s.kind === 'video') {
        res = `${s.frameWidth || '?'}×${s.frameHeight || '?'} @ ${Math.round(s.framesPerSecond || 0)} fps`;
        if (s.codecId && byId.get(s.codecId)) codec = byId.get(s.codecId).mimeType.replace('video/', '');
      }
    });
    if (!pair) return;
    if (Date.now() - lastSnapAt < 5000) res = `Fotoğraf modu ${$('remoteSnap').naturalWidth}×${$('remoteSnap').naturalHeight}`;
    const now = Date.now();
    // Bazı tarayıcılar bağlantı sayacını güncellemiyor; medya sayaçlarıyla da hesapla, büyük olanı al
    let txR = 0, rxR = 0;
    report.forEach((s) => {
      if (s.type === 'outbound-rtp') txR += (s.bytesSent || 0) + (s.headerBytesSent || 0);
      if (s.type === 'inbound-rtp') rxR += (s.bytesReceived || 0) + (s.headerBytesReceived || 0);
    });
    txR += snapTx; rxR += snapRx;
    const tx = Math.max(pair.bytesSent || 0, txR), rx = Math.max(pair.bytesReceived || 0, rxR);
    if (prevStats) {
      const dt = now - prevStats.t;
      $('sOut').textContent = kbps(tx - prevStats.tx, dt);
      $('sIn').textContent = kbps(rx - prevStats.rx, dt);
    }
    prevStats = { t: now, tx, rx };
    const local = byId.get(pair.localCandidateId), remote = byId.get(pair.remoteCandidateId);
    const relay = (local && local.candidateType === 'relay') || (remote && remote.candidateType === 'relay');
    $('sPath').textContent = relay ? 'TURN sunucusu üzerinden' : 'Doğrudan (P2P)';
    $('sRes').textContent = res;
    $('sCodec').textContent = codec;
    const elapsed = Math.max(1, (now - callStart) / 1000);
    $('sTotal').textContent = `${mb(tx + rx)} (${Math.floor(elapsed / 60)} dk)`;
    // Saatlik tahmin: ayar her değiştiğinde sıfırlanır, sadece mevcut ayarın tüketimini gösterir
    if (!hourBase) hourBase = { t: now, tx, rx };
    const hEl = (now - hourBase.t) / 1000;
    if (hEl >= 10) {
      const perH = (b) => Math.round(b / hEl * 3600 / 1e6);
      const dtx = tx - hourBase.tx, drx = rx - hourBase.rx;
      $('sHour').textContent = `${perH(dtx + drx)} MB/sa (gönd. ${perH(dtx)} · alınan ${perH(drx)})`;
    } else $('sHour').textContent = 'ölçülüyor…';
    $('sGpu').textContent = enhancer && enhancer.enabled ? (enhancer.lastMs ? enhancer.lastMs.toFixed(1) + ' ms/kare' : '-') : 'kapalı';
  }

  // ---------- Kontroller ----------
  $('micBtn').onclick = (e) => {
    const t = localStream.getAudioTracks()[0]; t.enabled = !t.enabled;
    e.currentTarget.classList.toggle('off', !t.enabled);
  };
  $('camBtn').onclick = (e) => {
    const t = localStream.getVideoTracks()[0]; t.enabled = !t.enabled;
    e.currentTarget.classList.toggle('off', !t.enabled);
  };
  $('enhanceBtn').onclick = (e) => {
    if (!enhancer || !enhancer.supported) { setStatus('Bu cihazda netleştirme desteklenmiyor'); return; }
    enhancer.setEnabled(!enhancer.enabled);
    e.currentTarget.classList.toggle('on', enhancer.enabled);
  };
  $('statsBtn').onclick = () => $('stats').classList.toggle('hidden');

  // ---------- Sohbet ----------
  let unread = 0;
  function addChat(text, who) {
    if (!text) return;
    const row = document.createElement('div');
    row.className = 'msg ' + who;
    row.textContent = text;
    const time = document.createElement('small');
    time.textContent = new Date().toTimeString().slice(0, 5);
    row.appendChild(time);
    $('chatLog').appendChild(row);
    $('chatLog').scrollTop = $('chatLog').scrollHeight;
    if (who === 'them' && $('chat').classList.contains('hidden')) {
      unread++; $('chatBadge').textContent = unread; $('chatBadge').classList.remove('hidden');
    }
  }
  $('chatBtn').onclick = () => {
    $('chat').classList.toggle('hidden');
    if (!$('chat').classList.contains('hidden')) { unread = 0; $('chatBadge').classList.add('hidden'); $('chatInput').focus(); }
  };
  $('chatClose').onclick = () => $('chat').classList.add('hidden');
  $('chatForm').onsubmit = (e) => {
    e.preventDefault();
    const text = $('chatInput').value.trim();
    if (!text) return;
    if (!(conn && conn.open)) { addChat('Mesaj gönderilemedi: karşı taraf bağlı değil', 'sys'); return; }
    signal({ type: 'chat', text: text.slice(0, 1000) });
    addChat(text, 'me');
    $('chatInput').value = '';
  };
  $('profile').onchange = (e) => {
    profile = e.target.value;
    syncCustomUi();
    applyProfile();
    signal({ type: 'profile', value: profile, custom: profile === 'ozel' ? PROFILES.ozel : undefined });
  };

  // ---------- Özel ayar: fps ve bit hızı kaydırma çubukları ----------
  const FPS_STEPS = [0.5, 1, 2, 3, 5, 8, 10, 12, 15, 20, 24, 30];
  const RES_STEPS = [[160, 120], [192, 144], [240, 180], [320, 240], [480, 360], [640, 480], [960, 540], [1280, 720]];
  const kbpsFromSlider = (x) => Math.round(5 * Math.pow(300, x / 100));          // 5 … 1500 kbps
  const sliderFromKbps = (k) => Math.round(100 * Math.log(k / 5) / Math.log(300));
  // Seçilen bit hızı ve fps için netliği koruyan en büyük çözünürlük
  function autoRes(vbr, fps, snap) {
    const need = snap ? 0.9 : 0.07; // piksel başına bit (fotoğraf / video)
    let best = RES_STEPS[0];
    for (const r of RES_STEPS) if (vbr / (r[0] * r[1] * fps) >= need) best = r;
    return best;
  }
  function autoAudio(vbr) { return vbr < 30000 ? 8000 : vbr < 200000 ? 10000 : vbr < 600000 ? 16000 : 24000; }
  function estimate(p) {
    if (p.audioOnly) return (p.abr / 1000 + 6) * 0.9;
    const snap = p.snap || p.vbr < 30000;
    const v = snap ? p.vbr : Math.max(p.vbr, 30000);
    return (p.abr / 1000 + v / 1000 + 6 + (snap ? 1 : p.fps * 0.35)) * 2 * 0.45; // telefon başına MB/saat
  }
  function buildCustom(fps, vbr) {
    const snap = vbr < 30000;
    const [w, h] = autoRes(vbr, snap ? Math.max(0.25, Math.min(fps, vbr / 8 / 1500)) : fps, snap);
    return { w, h, fps, vbr, abr: autoAudio(vbr), capW: w > 480 ? w : undefined, capH: w > 480 ? h : undefined };
  }
  function describe(p) {
    if (p.audioOnly) return `≈ ${Math.round(estimate(p))} MB/saat · sadece ses`;
    const snap = p.snap || p.vbr < 30000;
    const bpp = p.vbr / (p.w * p.h * (snap ? snapFps(p) : p.fps));
    const q = snap ? (bpp < 0.6 ? 'düşük' : bpp < 1.2 ? 'orta' : 'iyi') : (bpp < 0.04 ? 'düşük' : bpp < 0.08 ? 'orta' : 'iyi');
    const f = snap ? snapFps(p) : p.fps;
    const fTxt = f < p.fps ? ` · ${+f.toFixed(2)} kare/sn'ye düşürüldü` : '';
    return `≈ ${Math.round(estimate(p))} MB/saat · ${p.w}×${p.h} · netlik ${q}${snap ? ' · fotoğraf modu' : ''}${fTxt}`;
  }
  function syncCustomUi() {
    const p = PROFILES[profile];
    $('custom').classList.toggle('hidden', profile !== 'ozel');
    if (!p.audioOnly) {
      $('fpsRange').value = Math.max(0, FPS_STEPS.indexOf(p.fps) !== -1 ? FPS_STEPS.indexOf(p.fps) : FPS_STEPS.findIndex((f) => f >= p.fps));
      $('bitRange').value = sliderFromKbps(p.vbr / 1000);
    }
    $('fpsVal').textContent = p.audioOnly ? '-' : `${p.fps} kare/sn`;
    $('bitVal').textContent = p.audioOnly ? '-' : `${Math.round(p.vbr / 1000)} kbps`;
    $('estimate').textContent = describe(p);
  }
  let customTimer = null;
  function onCustomInput() {
    const fps = FPS_STEPS[Number($('fpsRange').value)];
    const vbr = kbpsFromSlider(Number($('bitRange').value)) * 1000;
    PROFILES.ozel = buildCustom(fps, vbr);
    profile = 'ozel';
    $('profile').value = 'ozel';
    syncCustomUi();
    // Kaydırırken her adımda değil, parmak durunca uygula
    clearTimeout(customTimer);
    customTimer = setTimeout(() => { applyProfile(); signal({ type: 'profile', value: 'ozel', custom: PROFILES.ozel }); }, 350);
  }
  $('fpsRange').max = FPS_STEPS.length - 1;
  $('fpsRange').oninput = onCustomInput;
  $('bitRange').oninput = onCustomInput;
  $('customBtn').onclick = () => {
    // Mevcut profilden başlayarak özel ayara geç
    const p = PROFILES[profile];
    if (profile !== 'ozel' && !p.audioOnly) PROFILES.ozel = buildCustom(p.fps, p.vbr);
    profile = 'ozel'; $('profile').value = 'ozel';
    syncCustomUi(); applyProfile();
    signal({ type: 'profile', value: 'ozel', custom: PROFILES.ozel });
  };
  syncCustomUi();

  // ---------- Codec seçimi ----------
  function supports(mime) {
    const caps = RTCRtpReceiver.getCapabilities && RTCRtpReceiver.getCapabilities('video');
    return !!(caps && caps.codecs.some((c) => c.mimeType === mime));
  }
  function setCodec(value, fromMe) {
    if (!['auto', 'av1', 'vp9', 'h264'].includes(value)) return;
    codecPref = value;
    $('codec').value = value;
    resetHourly();
    if (value === 'av1' && !supports('video/AV1')) {
      setStatus('Bu cihaz AV1 desteklemiyor, en yakın codec kullanılacak');
      setTimeout(() => setStatus(''), 3000);
    }
    if (fromMe) signal({ type: 'codec', value });
    // Görüşme açıksa codec'i değiştirmek için bağlantıyı yeniden anlaştır (teklifi hep "a" yapar)
    if (pc && myRole === 'a' && pc.signalingState === 'stable') {
      for (const tr of pc.getTransceivers()) {
        if (tr.receiver.track && tr.receiver.track.kind === 'video') preferCodecs(tr);
      }
      makeOffer();
    }
  }
  $('codec').onchange = (e) => setCodec(e.target.value, true);
  if (!supports('video/AV1')) {
    const o = $('codec').querySelector('option[value="av1"]');
    if (o) o.textContent += ' (bu cihazda yok)';
  }
  $('shareBtn').onclick = async () => {
    const url = `${location.origin}${location.pathname}?oda=${encodeURIComponent(room)}`;
    try {
      if (navigator.share) await navigator.share({ title: 'DusukMB Call', text: 'Görüntülü görüşmeye katıl', url });
      else { await navigator.clipboard.writeText(url); setStatus('Link kopyalandı'); setTimeout(() => setStatus(''), 1500); }
    } catch {}
  };
  $('hangBtn').onclick = () => {
    leaving = true;
    signal({ type: 'bye' });
    resetPc();
    if (peer) peer.destroy();
    localStream.getTracks().forEach((t) => t.stop());
    location.href = location.pathname;
  };
  window.addEventListener('pagehide', () => { if (!leaving) signal({ type: 'bye' }); });
  // iOS: otomatik oynatma engellenirse ilk dokunuşta başlat
  document.addEventListener('click', () => { if (remoteVideo.paused && remoteVideo.srcObject) remoteVideo.play().catch(() => {}); });

  if (enhancer && !enhancer.supported) $('enhanceBtn').classList.remove('on');
})();

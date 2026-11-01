// DusukMB Call - istemci
(() => {
  // Bit hızları "kablodaki" toplamı ~hedefe oturtacak şekilde seçildi (RTP/UDP başlıkları ~15-20 kbps ekler)
  const PROFILES = {
    // Hedefler telefon başına TOPLAM (gönderilen + alınan)
    // (Chrome videoyu 30 kbps altına indirmiyor; daha düşüğü için "sadece ses")
    ses:    { audioOnly: true, abr: 10000 },                     // ~15 MB/saat
    normal: { w: 240, h: 180, fps: 12, vbr: 32000, abr: 10000 }, // ~47 MB/saat
    iyi:    { w: 320, h: 240, fps: 15, vbr: 70000, abr: 16000 }, // ~85 MB/saat
  };
  const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  const $ = (id) => document.getElementById(id);
  const lobby = $('lobby'), call = $('call');
  const localVideo = $('localVideo'), remoteVideo = $('remoteVideo'), remoteCanvas = $('remoteCanvas');
  const statusEl = $('status');

  let pc, localStream, room, iceConfig, profile = 'normal';
  let isOfferer = false, remoteIOS = false, pendingIce = [];
  let statsTimer = null, callStart = 0, prevStats = null, leaving = false;
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
    attachConn(peer.connect(otherId, { serialization: 'json', reliable: true }));
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
          ans.sdp = mungeOpus(ans.sdp, PROFILES[profile].abr);
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
      case 'profile':
        if (PROFILES[msg.value]) { profile = msg.value; $('profile').value = profile; applyProfile(); }
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
    pc.onicecandidate = (e) => { if (e.candidate) signal({ type: 'ice', candidate: e.candidate }); };
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
    offer.sdp = mungeOpus(offer.sdp, PROFILES[profile].abr);
    await pc.setLocalDescription(offer);
    signal({ type: 'offer', sdp: offer.sdp });
  }

  function resetPc() {
    if (pc) { pc.close(); pc = null; }
    pendingIce = []; remoteVideo.srcObject = null; callStart = 0; prevStats = null;
    if (enhancer) enhancer.stop();
    stopStats();
  }

  // Düşük bit hızında VP9 en verimli; iPhone tarafında donanım H.264 daha az pil yer
  function preferCodecs(transceiver) {
    if (!transceiver.setCodecPreferences || !RTCRtpReceiver.getCapabilities) return;
    const caps = RTCRtpReceiver.getCapabilities('video');
    if (!caps) return;
    const order = (IS_IOS || remoteIOS) ? ['video/H264', 'video/VP8', 'video/VP9'] : ['video/VP9', 'video/VP8', 'video/H264'];
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

  // getParameters/setParameters çağrıları üst üste binmesin diye sıraya al
  let profileQueue = Promise.resolve();
  function applyProfile() { profileQueue = profileQueue.then(applyProfileNow, applyProfileNow); return profileQueue; }

  async function applyProfileNow() {
    const p = PROFILES[profile];
    const vt = localStream && localStream.getVideoTracks()[0];
    if (vt && !p.audioOnly) {
      try { await vt.applyConstraints({ frameRate: { ideal: p.fps, max: p.fps } }); } catch {}
    }
    localVideo.classList.toggle('dim', !!p.audioOnly);
    if (pc && pc.connectionState === 'connected') setStatus(p.audioOnly ? '🔈 Sadece ses modu' : '');
    if (!pc) return;
    for (const tr of pc.getTransceivers()) {
      const s = tr.sender;
      const kind = tr.receiver.track && tr.receiver.track.kind;
      if (kind === 'video') {
        // Sadece ses: kamerayı göndermeyi tamamen durdur (siyah kare bile gitmesin)
        if (p.audioOnly) { if (s.track) { try { await s.replaceTrack(null); } catch {} } continue; }
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
    const now = Date.now();
    const tx = pair.bytesSent || 0, rx = pair.bytesReceived || 0;
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
    if (elapsed > 20) {
      $('sHour').textContent = `${Math.round((tx + rx) / elapsed * 3600 / 1e6)} MB/sa (gönd. ${Math.round(tx / elapsed * 3600 / 1e6)} · alınan ${Math.round(rx / elapsed * 3600 / 1e6)})`;
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
  $('profile').onchange = (e) => { profile = e.target.value; applyProfile(); signal({ type: 'profile', value: profile }); };
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

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
    fhd:    { w: 1920, h: 1080, fps: 30, vbr: 2500000, abr: 32000, capW: 1920, capH: 1080 }, // 1080p, ~2,2 GB/saat
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
  let remoteHidden = false, remoteSendsVideo = true, sentMode = null, peerPresent = false, userProfile = 'normal', autoDown = false;
  let statsTimer = null, callStart = 0, prevStats = null, leaving = false, hourBase = null, frozenSince = 0, lastFrames = -1;
  function resetHourly() { hourBase = null; if ($('sHour')) $('sHour').textContent = 'ölçülüyor…'; }
  window.__dusukmb = { get pc() { return pc; }, get conn() { return conn; }, get peer() { return peer; }, get enhancer() { return enhancer; } }; // hata ayıklama için
  const enhancer = window.Enhancer ? window.Enhancer.create(remoteVideo, remoteCanvas) : null;

  // ---------- Lobi ----------
  const params = new URLSearchParams(location.search);
  // Sunucu ayarı (sinyal sunucusu + kullanıcı adıyla arama aynı Cloudflare adresinde)
  const cfgP = fetch('config.json', { cache: 'no-store' }).then((r) => r.ok ? r.json() : {}).catch(() => ({}));
  let createdByMe = false;
  const newRoomCode = () => {
    const a = 'abcdefghjkmnpqrstuvwxyz23456789'; let s = '';
    const r = crypto.getRandomValues(new Uint8Array(7));
    for (const x of r) s += a[x % a.length];
    return s;
  };
  $('startBtn').onclick = () => { createdByMe = true; start(newRoomCode()); };
  $('codeToggle').onclick = () => { $('codeRow').classList.toggle('hidden'); $('room').focus(); };
  $('joinBtn').onclick = () => start($('room').value.trim().toLowerCase());
  $('room').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('joinBtn').click(); });

  function setStatus(t) { statusEl.textContent = t; statusEl.classList.toggle('hidden', !t); }
  let toastTimer = null;
  function toast(t, ms = 2500) {
    const el = $('toast'); el.textContent = t; el.classList.remove('hidden');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.add('hidden'), ms);
  }

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
      // Kamera yoksa/izin yoksa sadece sesle dene
      try {
        localStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
        profile = userProfile = 'ses'; $('profile').value = 'ses'; syncCustomUi();
      } catch (e2) {
        alertInline('Kamera/mikrofon izni gerekli. Adres çubuğundaki kilit simgesinden izin verip sayfayı yenile. (' + e2.message + ')');
        $('lobbyMsg').textContent = '';
        return;
      }
    }
    localStream.getTracks().forEach(watchTrack);
    localVideo.srcObject = localStream;
    loadChat();
    lobby.classList.add('hidden');
    call.classList.remove('hidden');
    $('topBar').classList.remove('hidden');
    syncQuick();
    setStatus('Sunucuya bağlanıyor…');
    // Kendi sunucumuz varsa config.json'dan okunur; yoksa (GitHub Pages) ücretsiz PeerJS sinyal sunucusu kullanılır
    const cfg = await cfgP;
    signalCfg = cfg.signal || { host: '0.peerjs.com', port: 443, secure: true, path: '/', key: 'peerjs' };
    iceConfig = { iceServers: cfg.iceServers || [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun.cloudflare.com:3478' }] };
    startSignal();
  }

  function alertInline(t) { $('lobbyErr').textContent = t; }

  // ---------- Sinyal (resmi PeerJS kütüphanesi) ----------
  // Odaya ilk giren "a", ikinci giren "b" kimliğini alır. "b", "a"ya küçük bir veri kanalı açar;
  // görüşme kurulum mesajları (offer/answer/ice) bu kanaldan gider. Görüntü/ses ayrı bağlantıdan akar.
  let signalCfg, myRole = null, myId = '', otherId = '', peer = null, conn = null, retryTimer = null;
  let myToken = '', triedRoles = new Set(), fullTimer = null, fullSince = 0;
  function roomKey(r) {
    let h = 0x811c9dc5;
    for (const ch of r) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
    return `dusukmb-${r.replace(/[^a-z0-9]/g, '').slice(0, 16)}-${h.toString(16)}`;
  }
  // Sayfa yenilenince aynı kimlik + aynı gizli anahtarla dön: sunucu eski oturumu bize geri verir
  // (yoksa eski kimlik ~1 dk "dolu" görünür ve oda dolu sanılır)
  const sessKey = () => 'dusukmb:' + roomKey(room);
  function loadSess() { try { return JSON.parse(sessionStorage.getItem(sessKey()) || 'null'); } catch { return null; } }
  function saveSess() { try { sessionStorage.setItem(sessKey(), JSON.stringify({ role: myRole, token: myToken })); } catch {} }
  function clearSess() { try { sessionStorage.removeItem(sessKey()); } catch {} }
  function startSignal() {
    const s = loadSess();
    triedRoles = new Set();
    if (s && (s.role === 'a' || s.role === 'b') && s.token) connectSignal(s.role, s.token);
    else connectSignal('a');
  }
  function connectSignal(role, token) {
    if (peer && !peer.destroyed) { try { peer.destroy(); } catch {} }
    const base = roomKey(room);
    myRole = role; myToken = token || Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    myId = `${base}-${role}`; otherId = `${base}-${role === 'a' ? 'b' : 'a'}`;
    triedRoles.add(role);
    const c = signalCfg;
    const p = new Peer(myId, { host: c.host, port: Number(c.port), secure: c.secure, path: c.path, key: c.key, token: myToken, config: iceConfig, debug: 0 });
    peer = p;
    p.on('open', () => {
      saveSess();
      clearTimeout(fullTimer); fullSince = 0;
      if (myRole === 'a') {
        if (!pc) {
          setStatus('Karşı taraf bekleniyor… Linki gönder 🔗');
          if (createdByMe) { createdByMe = false; openInvite(); }
        }
      }
      else { if (!pc) setStatus('Bağlanıyor…'); connectToA(); }
    });
    p.on('connection', (c2) => { if (c2.peer === otherId) attachConn(c2); else c2.close(); });
    p.on('disconnected', () => { if (!leaving && !p.destroyed) { try { p.reconnect(); } catch {} } });
    p.on('error', (e) => {
      if (p !== peer) return;
      if (e.type === 'unavailable-id') {
        // Bu rol dolu: diğerini dene. İkisi de doluysa eski oturumlar düşene kadar bekle, sonra tekrar dene.
        const other = role === 'a' ? 'b' : 'a';
        if (!triedRoles.has(other)) { connectSignal(other); return; }
        onSignal({ type: 'full' });
      } else if (e.type === 'peer-unavailable') {
        scheduleRetry(); // "a" henüz/artık yok
      } else if (['network', 'server-error', 'socket-error', 'socket-closed', 'disconnected'].includes(e.type)) {
        if (leaving) return;
        if (!pc || pc.connectionState !== 'connected') setStatus('Sunucuya ulaşılamıyor, tekrar deneniyor…');
        clearTimeout(retryTimer);
        // Aynı rol ve anahtarla yeniden bağlan (kimlik kaybolmasın)
        retryTimer = setTimeout(() => { triedRoles = new Set(); connectSignal(myRole, myToken); }, 2500);
      } else console.warn('sinyal', e.type, e);
    });
  }
  function scheduleRetry(ms = 3000) {
    clearTimeout(retryTimer);
    if (!leaving && myRole === 'b') retryTimer = setTimeout(connectToA, ms);
  }
  function connectToA() {
    if (!peer || peer.destroyed || leaving) return;
    if (peer.disconnected) { try { peer.reconnect(); } catch {} scheduleRetry(2000); return; }
    if (conn && conn.open) return;
    attachConn(peer.connect(otherId, { serialization: 'binary', reliable: true }));
    // Açılmazsa (ağ değişimi vb.) kendiliğinden yeniden dene
    const c = conn;
    setTimeout(() => { if (conn === c && !c.open && !leaving) { try { c.close(); } catch {} if (conn === c) conn = null; connectToA(); } }, 8000);
  }
  function attachConn(c) {
    if (conn && conn !== c) { const old = conn; conn = c; try { old.close(); } catch {} }
    conn = c;
    c.on('open', () => {
      if (conn !== c) return;
      if (myRole === 'b') { isOfferer = false; signal({ type: 'hello', ios: IS_IOS }); }
      chatOnConnect();
    });
    c.on('data', (m) => { if (conn === c && m && m.type) onSignal(m); });
    c.on('close', () => {
      if (conn !== c) return;
      conn = null;
      refreshPeerStatus();
      if (!leaving) { onSignal({ type: 'bye', local: true }); scheduleRetry(1500); }
    });
    c.on('error', () => scheduleRetry(1500));
  }
  // Bağlantıyı baştan kur (ağ değişti, görüntü dondu…). "b" yeniden bağlanır, "a" bekler.
  let lastRecover = 0;
  function recover(reason) {
    if (leaving || Date.now() - lastRecover < 4000) return;
    lastRecover = Date.now();
    console.log('yeniden bağlanılıyor:', reason);
    setStatus('Bağlantı yenileniyor…');
    if (peer && peer.disconnected && !peer.destroyed) { try { peer.reconnect(); } catch {} }
    if (myRole === 'b') {
      const old = conn; conn = null;
      if (old) { try { old.close(); } catch {} }
      resetPc();
      scheduleRetry(800);
    } else {
      signal({ type: 'restart' }); // veri kanalı hâlâ açıksa "b"ye haber ver
    }
  }
  window.addEventListener('online', () => recover('online'));
  if (navigator.connection && navigator.connection.addEventListener) navigator.connection.addEventListener('change', () => recover('ağ değişti'));
  function signal(msg) { if (conn && conn.open) conn.send(msg); }

  async function onSignal(msg) {
    switch (msg.type) {
      case 'full':
        // İki kimlik de dolu. Eski (kapanmış) bir oturum olabilir: sunucu onu ~1 dk içinde düşürür.
        if (!fullSince) fullSince = Date.now();
        if (Date.now() - fullSince > 75000) {
          setStatus('Bu oda dolu (en fazla 2 kişi). Başka bir oda kodu dene.');
          if (peer) peer.destroy();
          break;
        }
        setStatus('Oda dolu görünüyor, bekleniyor…');
        clearTimeout(fullTimer);
        fullTimer = setTimeout(() => { triedRoles = new Set(); connectSignal('a'); }, 5000);
        break;
      case 'restart':
        if (myRole === 'b') { lastRecover = 0; recover('karşı taraf istedi'); }
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
        if (PROFILES[msg.value]) { profile = userProfile = msg.value; autoDown = false; syncQuick(); $('profile').value = profile; syncCustomUi(); applyProfile(); }
        break;
      case 'frame':
        showSnap(msg);
        break;
      case 'chat':
        onChatMessage(msg);
        break;
      case 'chat-ack':
        onChatAck([msg.id], 'delivered');
        break;
      case 'chat-read':
        onChatAck(Array.isArray(msg.ids) ? msg.ids : [], 'read');
        break;
      case 'typing':
        showTyping(true);
        break;
      case 'mode':
        remoteSendsVideo = !!msg.video; frozenSince = 0;
        break;
      case 'vis':
        // Karşı taraf uygulamadan çıktı/döndü: görmediği görüntüyü boşuna gönderme
        if (remoteHidden !== !!msg.hidden) {
          remoteHidden = !!msg.hidden;
          applyProfile();
          if (remoteHidden) toast('Karşı taraf arka planda · görüntü duraklatıldı, ses sürüyor', 3500);
        }
        break;
      case 'bye':
        setStatus('Karşı taraf ayrıldı. Bekleniyor…');
        remoteHidden = false;
        resetPc();
        if (peerPresent && !msg.local) { peerPresent = false; alertUser('left'); }
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
    const thisPc = pc;
    let discTimer = null;
    pc.onconnectionstatechange = () => {
      if (pc !== thisPc) return;
      const s = pc.connectionState;
      clearTimeout(discTimer);
      if (s === 'connected') {
        setStatus(PROFILES[profile].audioOnly ? '🔈 Sadece ses modu' : '');
        if (!callStart) callStart = Date.now();
        frozenSince = 0; startStats(); applyProfile(); keepAwake();
        signal({ type: 'vis', hidden: document.visibilityState === 'hidden' });
        if (!peerPresent) { peerPresent = true; closeSheets(); alertUser('joined'); }
      }
      else if (s === 'disconnected') {
        setStatus('Bağlantı zayıf…');
        // Ağ değişiminde tarayıcı "failed" demeden önce 20-30 sn bekleyebilir; 4 sn sonra kendimiz yenileyelim
        discTimer = setTimeout(() => { if (pc === thisPc && pc.connectionState !== 'connected') recover('bağlantı koptu'); }, 4000);
      } else if (s === 'failed') {
        recover('bağlantı başarısız');
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
    carried += lastTotal; lastTotal = 0; snapTx = 0; snapRx = 0; prevLoss = null;
    pendingIce = []; sentMode = null; remoteSendsVideo = true; remoteVideo.srcObject = null; callStart = 0; prevStats = null; hourBase = null; frozenSince = 0; lastFrames = -1;
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
    const noVideo = p.audioOnly || remoteHidden; // karşı taraf görmüyorsa görüntü gönderme
    const vt = localStream && localStream.getVideoTracks()[0];
    if (vt && !p.audioOnly) {
      // Kamerayı en az 480×360 aç (HD için 1280×720); küçültmeyi kodlayıcı yapar
      const capW = p.capW || Math.max(480, p.w), capH = p.capH || Math.max(360, p.h);
      const wantFps = Math.max(Math.ceil(p.fps), 15);
      try { await vt.applyConstraints({ width: { ideal: capW }, height: { ideal: capH }, frameRate: { ideal: wantFps, max: wantFps } }); } catch {}
    }
    localVideo.classList.toggle('dim', !!p.audioOnly);
    if (snap && !noVideo) startSnap(p); else stopSnap();
    if (!snap) $('remoteSnap').classList.add('hidden');
    if (pc && pc.connectionState === 'connected') {
      setStatus(p.audioOnly ? '🔈 Sadece ses modu' : '');
    }
    if (!pc) return;
    const sendsVideo = !noVideo && !snap && !!vt;
    if (sentMode !== sendsVideo && conn && conn.open) { sentMode = sendsVideo; signal({ type: 'mode', video: sendsVideo }); }
    for (const tr of pc.getTransceivers()) {
      const s = tr.sender;
      const kind = tr.receiver.track && tr.receiver.track.kind;
      if (kind === 'video') {
        // Sadece ses / fotoğraf modu: video akışını tamamen durdur (siyah kare bile gitmesin)
        if (noVideo || snap) { if (s.track) { try { await s.replaceTrack(null); } catch {} } continue; }
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

  // ---------- Bağlantı kalitesi + otomatik düşürme ----------
  // Gönderdiğim görüntüde kayıp ya da gecikme yüksekse bir alt seviyeye in; 30 sn iyi giderse seçilene geri çık.
  const LADDER = ['cokdusuk', 'normal', 'iyi', 'hd', 'fhd'];
  let carried = 0, lastTotal = 0, prevLoss = null, badN = 0, goodN = 0;
  function checkQuality(report, pair) {
    let outLoss = 0, rtt = pair.currentRoundTripTime || 0, lost = 0, recv = 0;
    report.forEach((s) => {
      if (s.type === 'remote-inbound-rtp') {
        if (typeof s.fractionLost === 'number') outLoss = Math.max(outLoss, s.fractionLost);
        if (!rtt && s.roundTripTime) rtt = s.roundTripTime;
      }
      if (s.type === 'inbound-rtp') { lost += s.packetsLost || 0; recv += s.packetsReceived || 0; }
    });
    let inLoss = 0;
    if (prevLoss) { const dl = lost - prevLoss.lost, dr = recv - prevLoss.recv; if (dl + dr > 0) inLoss = Math.max(0, dl) / (dl + dr); }
    prevLoss = { lost, recv };
    const worst = Math.max(outLoss, inLoss);
    const q = (worst > 0.1 || rtt > 0.8) ? 1 : (worst > 0.03 || rtt > 0.35) ? 2 : 3;
    $('qBars').className = 'qbars q' + q;
    $('sLoss').textContent = `%${Math.round(outLoss * 100)} giden · %${Math.round(inLoss * 100)} gelen · ${Math.round(rtt * 1000)} ms`;
    // Otomatik düşürme sadece basit seçeneklerde
    const i = LADDER.indexOf(profile), ui = LADDER.indexOf(userProfile);
    if (!$('autoQ').checked || i === -1 || ui === -1) { badN = goodN = 0; return; }
    if (outLoss > 0.08 || rtt > 1.0) { badN++; goodN = 0; } else if (outLoss < 0.02 && rtt < 0.45) { goodN++; badN = 0; } else { badN = 0; goodN = 0; }
    if (badN >= 3 && i > 0) {
      badN = 0; setLocalProfile(LADDER[i - 1]); autoDown = true;
      toast(`Bağlantı zayıf · ${LABELS[profile]} moduna geçildi`);
    } else if (goodN >= 15 && i < ui) {
      goodN = 0; setLocalProfile(LADDER[i + 1]); autoDown = profile !== userProfile;
      toast(`Bağlantı düzeldi · ${LABELS[profile]}`);
    }
  }
  const LABELS = { ses: 'Sadece ses', endusuk: 'En düşük', cokdusuk: 'Tasarruf', normal: 'Normal', iyi: 'Net', hd: '720p', fhd: '1080p', ozel: 'Özel' };
  function setLocalProfile(p) { profile = p; $('profile').value = p; syncCustomUi(); syncQuick(); applyProfile(); }

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
        // Görüntü donmuş mu? (kare sayısı artmıyor)
        const p = PROFILES[profile];
        const expectVideo = !p.audioOnly && !(p.snap || p.vbr < 30000) && !remoteHidden && document.visibilityState === 'visible' && remoteSendsVideo && Date.now() - lastSnapAt > 5000;
        const fd = s.framesDecoded || 0;
        if (expectVideo && pc.connectionState === 'connected' && fd === lastFrames) {
          if (!frozenSince) frozenSince = Date.now();
          else if (Date.now() - frozenSince > 8000) { frozenSince = 0; recover('görüntü dondu'); }
        } else frozenSince = 0;
        lastFrames = fd;
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
    lastTotal = tx + rx;
    const perHour = hEl >= 10 ? Math.round((tx - hourBase.tx + rx - hourBase.rx) / hEl * 3600 / 1e6) : 0;
    $('mbBadge').textContent = mb(carried + lastTotal) + (perHour ? ` · ~${perHour} MB/sa` : '');
    checkQuality(report, pair);
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
  $('statsBtn').onclick = () => { closeSheets(); $('stats').classList.remove('hidden'); };
  $('statsClose').onclick = () => $('stats').classList.add('hidden');

  // ---------- Alt sayfalar: ayarlar ve davet ----------
  function closeSheets() { document.querySelectorAll('.sheet').forEach((el) => el.classList.add('hidden')); }
  document.querySelectorAll('.sheet').forEach((el) => el.addEventListener('click', (e) => { if (e.target === el) closeSheets(); }));
  document.querySelectorAll('[data-close]').forEach((b) => b.onclick = closeSheets);
  $('setBtn').onclick = () => { const open = !$('setSheet').classList.contains('hidden'); closeSheets(); if (!open) { syncQuick(); syncNotifyUi(); $('setSheet').classList.remove('hidden'); } };
  function syncQuick() {
    document.querySelectorAll('#quick button').forEach((b) => b.classList.toggle('sel', b.dataset.p === profile));
  }
  document.querySelectorAll('#quick button').forEach((b) => b.onclick = () => {
    const v = b.dataset.p;
    if (v !== 'ses' && !(localStream && localStream.getVideoTracks()[0])) { toast('Kamera yok, sadece ses kullanılabilir'); return; }
    profile = userProfile = v; autoDown = false; badN = goodN = 0;
    $('profile').value = v; syncCustomUi(); syncQuick(); applyProfile();
    signal({ type: 'profile', value: v });
  });

  function inviteUrl() { return `${location.origin}${location.pathname}?oda=${encodeURIComponent(room)}`; }
  function openInvite() {
    const url = inviteUrl();
    $('inviteLink').textContent = url;
    if (window.qrcode) {
      const q = window.qrcode(0, 'M'); q.addData(url); q.make();
      $('qr').innerHTML = q.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
    }
    $('waBtn').href = 'https://wa.me/?text=' + encodeURIComponent('Görüntülü görüşmeye katıl: ' + url);
    $('nativeShare').classList.toggle('hidden', !navigator.share);
    syncNotifyUi();
    closeSheets();
    $('inviteSheet').classList.remove('hidden');
  }
  $('copyBtn').onclick = async () => {
    try { await navigator.clipboard.writeText(inviteUrl()); toast('Link kopyalandı ✓'); }
    catch { const r = document.createRange(); r.selectNodeContents($('inviteLink')); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); toast('Linki seçip kopyala'); }
  };
  $('nativeShare').onclick = async () => { try { await navigator.share({ title: 'DusukMB Call', text: 'Görüntülü görüşmeye katıl', url: inviteUrl() }); } catch {} };

  // ---------- Bildirim, titreşim, zil ----------
  // Sayfa arka plandayken (tarayıcı açık) karşı taraf katılınca/ayrılınca ya da mesaj gelince haber verir.
  // Android: bildirim + titreşim. iPhone: sadece Ana Ekrana eklenmiş uygulamada (iOS 16.4+).
  const IS_STANDALONE = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  let swReg = null, unread = 0;
  const baseTitle = document.title;
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').then((r) => { swReg = r; }).catch(() => {});
  const notifyState = () => !('Notification' in window) ? 'none' : Notification.permission;
  function syncNotifyUi() {
    const st = notifyState();
    $('notifyBtn').classList.toggle('on', st === 'granted');
    $('notifyBtn').textContent = st === 'granted' ? '🔔 Bildirim açık' : st === 'denied' ? '🔕 Bildirim engelli' : '🔔 Bildirim';
    $('notifyAsk').classList.toggle('hidden', st !== 'default');
    $('iosTip').classList.toggle('hidden', !(IS_IOS && !IS_STANDALONE));
  }
  async function askNotify() {
    const st = notifyState();
    if (st === 'none') { toast(IS_IOS ? 'iPhone: önce Ana Ekrana Ekle' : 'Bu tarayıcı bildirim desteklemiyor', 3500); return; }
    if (st === 'denied') { toast('Bildirim engellenmiş: adres çubuğundaki kilitten izin ver', 3500); return; }
    if (st === 'granted') { toast('Bildirimler zaten açık'); return; }
    try { await Notification.requestPermission(); } catch {}
    syncNotifyUi();
    if (notifyState() === 'granted') toast('Tamam, arka plandayken haber vereceğim 🔔');
  }
  $('notifyBtn').onclick = askNotify;
  $('notifyAsk').onclick = askNotify;
  let actx = null;
  function ring(kind) {
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume();
      const notes = kind === 'joined' ? [660, 880] : kind === 'msg' ? [880] : [520, 390];
      notes.forEach((f, i) => {
        const o = actx.createOscillator(), g = actx.createGain();
        const t = actx.currentTime + i * 0.16;
        o.frequency.value = f; o.type = 'sine';
        g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.18, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
        o.connect(g).connect(actx.destination); o.start(t); o.stop(t + 0.15);
      });
    } catch {}
  }
  async function showNote(title, body, tag) {
    if (notifyState() !== 'granted') return;
    const opts = { body, tag, renotify: true, icon: 'icon.svg', badge: 'icon.svg', vibrate: [200, 100, 200], data: { url: inviteUrl() } };
    try {
      const reg = swReg || (navigator.serviceWorker && await navigator.serviceWorker.getRegistration());
      if (reg) { await reg.showNotification(title, opts); return; }
      const n = new Notification(title, opts); n.onclick = () => { window.focus(); n.close(); };
    } catch (e) { console.warn('bildirim', e); }
  }
  function alertUser(kind, text) {
    const hidden = document.visibilityState === 'hidden';
    ring(kind);
    if (navigator.vibrate) { try { navigator.vibrate(kind === 'msg' ? 120 : [200, 100, 200]); } catch {} }
    if (kind === 'msg' && hidden) { unread++; document.title = `(${unread}) ${baseTitle}`; }
    if (!hidden) return;
    if (kind === 'joined') showNote('Karşı taraf katıldı', 'Görüşmeye dönmek için dokun', 'dusukmb-peer');
    else if (kind === 'left') showNote('Karşı taraf ayrıldı', 'Görüşme bitti ya da bağlantı koptu', 'dusukmb-peer');
    else if (kind === 'msg') showNote('Yeni mesaj', text || '', 'dusukmb-msg');
  }

  // ---------- Telefonda sağlamlık ----------
  // Ekran kararmasın (görüşme sürerken)
  let wakeLock = null;
  async function keepAwake() {
    if (!('wakeLock' in navigator) || document.visibilityState !== 'visible' || leaving) return;
    if (wakeLock && !wakeLock.released) return;
    try { wakeLock = await navigator.wakeLock.request('screen'); } catch {}
  }
  // Kamera/mikrofon başka uygulama yüzünden ya da arka planda kapanırsa yeniden aç
  function watchTrack(t) { t.addEventListener('ended', () => { if (!leaving) reacquire(t.kind); }); }
  let reacquiring = {};
  async function reacquire(kind) {
    if (reacquiring[kind] || leaving || !localStream) return;
    reacquiring[kind] = true;
    try {
      const old = kind === 'audio' ? localStream.getAudioTracks()[0] : localStream.getVideoTracks()[0];
      const wasEnabled = old ? old.enabled : true;
      const ns = await navigator.mediaDevices.getUserMedia(kind === 'audio'
        ? { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } }
        : { video: { facingMode: 'user', width: { ideal: 480 }, height: { ideal: 360 }, frameRate: { ideal: 15, max: 15 } } });
      const nt = ns.getTracks()[0];
      nt.enabled = wasEnabled;
      if (old) { localStream.removeTrack(old); try { old.stop(); } catch {} }
      localStream.addTrack(nt);
      watchTrack(nt);
      if (kind === 'video') { localVideo.srcObject = localStream; localVideo.play().catch(() => {}); }
      if (pc) {
        for (const tr of pc.getTransceivers()) {
          const k = tr.receiver.track && tr.receiver.track.kind;
          if (k === kind && (tr.sender.track || kind === 'audio')) { try { await tr.sender.replaceTrack(nt); } catch {} }
        }
        applyProfile();
      }
    } catch (e) {
      console.warn('yeniden açılamadı', kind, e);
      setTimeout(() => { reacquiring[kind] = false; if (document.visibilityState === 'visible') reacquire(kind); }, 4000);
      return;
    }
    reacquiring[kind] = false;
  }
  document.addEventListener('visibilitychange', () => {
    if (!room || leaving) return;
    const hidden = document.visibilityState === 'hidden';
    signal({ type: 'vis', hidden });
    if (!hidden) {
      unread = 0; document.title = baseTitle;
      keepAwake();
      if (localStream) for (const t of localStream.getTracks()) if (t.readyState === 'ended') reacquire(t.kind);
    }
  });

  // ---------- Sohbet (YouTube canlı sohbeti gibi, video üstünde) ----------
  // Gelen/giden mesajlar videonun üstünde belirir ve birkaç saniye sonra kaybolur.
  // 💬 ile yazma çubuğu ve geçmiş açılır. Mesajlar doğrudan telefondan telefona gider;
  // bağlantı yokken yazılanlar sıraya alınır. Geçmiş bu telefonda (localStorage) saklanır.
  const SHOW_MS = 8000; // kapalıyken bir mesajın ekranda kalma süresi
  let chat = [], typingTimer = null, lastTypingSent = 0, fadeTimer = null;
  const chatKey = () => 'dusukmb-chat:' + roomKey(room);
  const chatOpen = () => $('chat').classList.contains('open');
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  function saveChat() { try { localStorage.setItem(chatKey(), JSON.stringify(chat.slice(-200))); } catch {} }
  function loadChat() {
    try { chat = JSON.parse(localStorage.getItem(chatKey()) || '[]'); } catch { chat = []; }
    for (const m of chat) m.shownAt = 0; // eski mesajlar video üstünde tekrar belirmesin
    renderChat();
  }
  const tick = (st) => st === 'pending' ? '<span class="tick">🕓</span>'
    : st === 'sent' ? '<span class="tick">✓</span>'
    : st === 'read' ? '<span class="tick read">✓✓</span>' : '<span class="tick">✓✓</span>';
  function renderChat() {
    const log = $('chatLog');
    const open = chatOpen();
    const now = Date.now();
    // Açıkken son 50 mesaj; kapalıyken sadece yeni gelenler (birkaç saniye görünür)
    const list = open ? chat.slice(-50) : chat.filter((m) => m.shownAt && now - m.shownAt < SHOW_MS + 700).slice(-5);
    log.textContent = '';
    for (const m of list) {
      const row = document.createElement('div');
      row.className = `cmsg ${m.who}`;
      if (!open) { row.classList.add('fade'); row.style.setProperty('--fade', Math.max(0, SHOW_MS - (now - m.shownAt)) + 'ms'); }
      const name = document.createElement('b'); name.textContent = m.who === 'me' ? 'Sen' : 'Karşı taraf';
      const txt = document.createElement('span'); txt.textContent = m.text;
      row.append(name, txt);
      if (m.who === 'me') row.insertAdjacentHTML('beforeend', tick(m.status));
      log.appendChild(row);
    }
    log.scrollTop = log.scrollHeight;
    // Kapalıyken süresi dolan mesajları ekrandan kaldır
    clearTimeout(fadeTimer);
    if (!open && list.length) fadeTimer = setTimeout(renderChat, 1000);
  }
  function showTyping(on) {
    $('chatTyping').classList.toggle('hidden', !on);
    clearTimeout(typingTimer);
    if (on) typingTimer = setTimeout(() => showTyping(false), 3500);
  }
  function refreshPeerStatus() {
    $('chatInput').placeholder = conn && conn.open ? 'Mesaj yaz…' : 'Mesaj yaz… (bağlanınca gönderilir)';
  }
  function sendChatMsg(m) { signal({ type: 'chat', id: m.id, text: m.text, t: m.t }); m.status = 'sent'; }
  // Bağlantı (yeniden) açılınca bekleyen mesajları gönder
  function chatOnConnect() {
    refreshPeerStatus();
    let changed = false;
    // İletildi onayı gelmemiş her mesajı (yolda kaybolmuş olabilir) tekrar gönder; karşı taraf kimlikten tanıyıp çiftlemez
    for (const m of chat) if (m.who === 'me' && (m.status === 'pending' || m.status === 'sent')) { sendChatMsg(m); changed = true; }
    if (changed) { saveChat(); renderChat(); }
    sendReadReceipts();
  }
  // Video üstünde göründüğü için gelen mesaj okunmuş sayılır (sayfa açıksa)
  function sendReadReceipts() {
    if (document.visibilityState !== 'visible') return;
    const ids = chat.filter((m) => m.who === 'them' && !m.readSent).map((m) => m.id);
    if (!ids.length || !(conn && conn.open)) return;
    signal({ type: 'chat-read', ids });
    for (const m of chat) if (ids.includes(m.id)) m.readSent = true;
    saveChat();
  }
  document.addEventListener('visibilitychange', () => { if (room) sendReadReceipts(); });
  function onChatMessage(msg) {
    const text = String(msg.text || '').slice(0, 500);
    if (!text) return;
    if (!chat.some((m) => m.id === msg.id)) {
      chat.push({ id: msg.id || newId(), text, who: 'them', t: Number(msg.t) || Date.now(), shownAt: Date.now() });
      saveChat(); renderChat();
      alertUser('msg', text);
    }
    signal({ type: 'chat-ack', id: msg.id });
    sendReadReceipts();
    showTyping(false);
  }
  function onChatAck(ids, status) {
    let changed = false;
    for (const m of chat) {
      if (m.who === 'me' && ids.includes(m.id) && m.status !== 'read') { m.status = status; changed = true; }
    }
    if (changed) { saveChat(); renderChat(); }
  }
  function setChatOpen(on) {
    $('chat').classList.toggle('open', on);
    $('chatForm').classList.toggle('hidden', !on);
    $('chatBtn').classList.toggle('on', on);
    renderChat();
    if (on) { refreshPeerStatus(); $('chatInput').focus(); }
  }
  $('chatBtn').onclick = () => setChatOpen(!chatOpen());
  $('chatInput').addEventListener('input', () => {
    $('chatSend').classList.toggle('ready', !!$('chatInput').value.trim());
    if (Date.now() - lastTypingSent > 2500 && $('chatInput').value) { lastTypingSent = Date.now(); signal({ type: 'typing' }); }
  });
  $('chatInput').addEventListener('keydown', (e) => { if (e.key === 'Escape') setChatOpen(false); });
  $('chatForm').onsubmit = (e) => {
    e.preventDefault();
    const text = $('chatInput').value.trim().slice(0, 500);
    if (!text) return;
    const m = { id: newId(), text, who: 'me', t: Date.now(), status: 'pending', shownAt: Date.now() };
    if (conn && conn.open) sendChatMsg(m);
    chat.push(m);
    saveChat(); renderChat();
    $('chatInput').value = ''; $('chatSend').classList.remove('ready');
    $('chatInput').focus();
  };
  $('profile').onchange = (e) => {
    profile = userProfile = e.target.value; autoDown = false; syncQuick();
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
  $('shareBtn').onclick = () => { if ($('inviteSheet').classList.contains('hidden')) openInvite(); else closeSheets(); };
  $('hangBtn').onclick = () => {
    leaving = true;
    clearSess();
    signal({ type: 'bye' });
    resetPc();
    if (peer) peer.destroy();
    localStream.getTracks().forEach((t) => t.stop());
    try { if (wakeLock) wakeLock.release(); } catch {}
    location.href = location.pathname;
  };
  window.addEventListener('pagehide', (e) => {
    if (leaving || e.persisted) return; // persisted: sayfa önbellekte duruyor (uygulama değişimi), görüşmeyi kesme
    signal({ type: 'bye' });
    try { if (peer) peer.destroy(); } catch {}
  });
  // Uygulamaya geri dönülünce bağlantı ölmüşse toparla
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || leaving || !room) return;
    if (peer && (peer.disconnected || peer.destroyed)) recover('uygulamaya dönüldü');
    else if (pc && ['failed', 'disconnected'].includes(pc.connectionState)) recover('uygulamaya dönüldü');
  });
  // iOS: otomatik oynatma engellenirse ilk dokunuşta başlat
  document.addEventListener('click', () => { if (remoteVideo.paused && remoteVideo.srcObject) remoteVideo.play().catch(() => {}); });

  if (enhancer && !enhancer.supported) $('enhanceBtn').classList.remove('on');
  // ---------- Kullanıcı adıyla arama ----------
  // "Çevrimiçi ol": bu sayfa sunucuya küçük bir bağlantıyla bağlı kalır (neredeyse hiç veri harcamaz).
  // Biri adınla arayınca: ekran açıksa gelen arama ekranı + zil + titreşim; arka plandaysa bildirim.
  // Bildirim izni verildiyse tarayıcı kapalı/uyuyorken bile (Web Push) telefon uyandırılır.
  const NAME_RE = /^[a-z0-9_.-]{3,20}$/;
  const ME_KEY = 'dusukmb-me', ONLINE_KEY = 'dusukmb-online', CONTACTS_KEY = 'dusukmb-contacts';
  const lsGet = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  let me = lsGet(ME_KEY, null), phoneWs = null, phoneRetry = 0, phoneTimer = null, phonePing = null, inRing = null;
  let apiBase = '', wsBase = '';
  const apiReady = cfgP.then((cfg) => {
    const host = cfg.signal && cfg.signal.host ? cfg.signal.host : location.host;
    const secure = cfg.signal ? cfg.signal.secure !== false : location.protocol === 'https:';
    const port = cfg.signal && cfg.signal.port && ![443, 80].includes(Number(cfg.signal.port)) ? ':' + cfg.signal.port : '';
    apiBase = `${secure ? 'https' : 'http'}://${host}${port}`; wsBase = `${secure ? 'wss' : 'ws'}://${host}${port}`;
  });
  const api = async (path, body) => {
    await apiReady;
    const r = await fetch(apiBase + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
    return r.json().catch(() => ({}));
  };
  const nameQ = (n) => 'name=' + encodeURIComponent(n);
  // Service worker'ın arka planda okuyabilmesi için kimlik bilgisini önbelleğe yaz
  async function shareMeWithSw() {
    try {
      const c = await caches.open('dusukmb');
      if (me) await c.put('me', new Response(JSON.stringify({ name: me.name, token: me.token, api: apiBase })));
      else await c.delete('me');
    } catch {}
  }

  function renderMe() {
    const online = !!me && lsGet(ONLINE_KEY, false);
    $('meOff').classList.toggle('hidden', online);
    $('meOn').classList.toggle('hidden', !online);
    if (me) { $('myName').value = me.name; $('meName').textContent = '@' + me.name; }
    if (online) {
      const st = notifyState();
      const live = phoneWs && phoneWs.readyState === 1;
      $('meState').textContent = live ? 'çevrimiçi' : 'bağlanıyor…';
      $('meState').style.color = live ? '' : '#ffc94d';
      $('meNotify').classList.toggle('hidden', st !== 'default');
      $('meHint').textContent = st === 'granted'
        ? 'Seni arayan olunca telefon çalar. Sayfayı kapatma; arka plana atabilirsin.'
        : IS_IOS && !IS_STANDALONE ? 'iPhone\'da arkadayken çalması için: Paylaş → Ana Ekrana Ekle, uygulamayı oradan aç.'
        : st === 'denied' ? 'Bildirim engelli: sadece ekran açıkken çalar. Adres çubuğundaki kilitten izin verebilirsin.'
        : 'Ekran açıkken çalar. Arkadayken de çalması için bildirimleri aç.';
    }
  }

  async function goOnline() {
    const name = $('myName').value.trim().toLowerCase().replace(/^@/, '');
    if (!NAME_RE.test(name)) { toast('Kullanıcı adı 3-20 karakter: harf, rakam, . _ -', 3500); return; }
    if (!me || me.name !== name) {
      const token = me && me.token ? me.token : [...crypto.getRandomValues(new Uint8Array(24))].map((x) => x.toString(16).padStart(2, '0')).join('');
      const r = await api('/phone/claim?' + nameQ(name), { token });
      if (!r.ok) { toast(r.error || 'Sunucuya ulaşılamadı', 3500); return; }
      me = { name, token }; lsSet(ME_KEY, me);
    }
    lsSet(ONLINE_KEY, true);
    // Bildirim izni bu dokunuşla istenir (tarayıcılar dokunuş olmadan izin penceresini göstermiyor)
    if (notifyState() === 'default') { try { await Notification.requestPermission(); } catch {} }
    connectPhone(); subscribePush(); shareMeWithSw(); renderMe();
  }
  $('goOnline').onclick = goOnline;
  $('myName').addEventListener('keydown', (e) => { if (e.key === 'Enter') goOnline(); });
  $('goOffline').onclick = async () => {
    lsSet(ONLINE_KEY, false);
    if (phoneWs) { phoneWs.onclose = null; phoneWs.close(); phoneWs = null; }
    clearTimeout(phoneTimer); clearInterval(phonePing);
    try { const reg = await navigator.serviceWorker.getRegistration(); const sub = reg && await reg.pushManager.getSubscription();
      if (sub) { await api('/phone/unsub?' + nameQ(me.name), { token: me.token, sub: sub.toJSON() }); } } catch {}
    renderMe();
  };
  $('meNotify').onclick = async () => { await askNotify(); subscribePush(); renderMe(); };

  async function connectPhone() {
    await apiReady;
    if (!me || !lsGet(ONLINE_KEY, false)) return;
    if (phoneWs && phoneWs.readyState <= 1) return;
    clearTimeout(phoneTimer);
    const ws = new WebSocket(`${wsBase}/phone/ws?${nameQ(me.name)}&role=owner&token=${encodeURIComponent(me.token)}`);
    phoneWs = ws;
    ws.onopen = () => {
      phoneRetry = 0; renderMe();
      clearInterval(phonePing); phonePing = setInterval(() => { if (ws.readyState === 1) ws.send('{"t":"ping"}'); }, 25000);
    };
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.t === 'auth') { lsSet(ONLINE_KEY, false); toast('Kullanıcı adı doğrulanamadı, tekrar çevrimiçi ol', 4000); me = null; lsSet(ME_KEY, null); renderMe(); }
      else if (m.t === 'hello' && m.ring) incoming(m.ring);
      else if (m.t === 'ring') incoming(m);
      else if ((m.t === 'cancel' || m.t === 'handled') && inRing && inRing.id === m.id) {
        const who = inRing.from; stopIncoming();
        if (m.t === 'cancel') toast(`@${who} aradı, cevapsız kaldı`, 4000);
      }
    };
    ws.onclose = () => {
      if (phoneWs !== ws) return;
      phoneWs = null; clearInterval(phonePing); renderMe();
      if (!lsGet(ONLINE_KEY, false)) return;
      phoneTimer = setTimeout(connectPhone, Math.min(30000, 1000 * 2 ** phoneRetry++));
    };
  }
  window.addEventListener('online', () => { phoneRetry = 0; connectPhone(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { phoneRetry = 0; connectPhone(); refreshContacts(); } });

  // Web Push aboneliği: tarayıcı arka planda uyurken bile arama bildirimini getirir
  async function subscribePush() {
    try {
      if (!me || notifyState() !== 'granted' || !('PushManager' in window)) return;
      const reg = swReg || await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        const { key } = await api('/phone/vapid');
        const raw = Uint8Array.from(atob(key.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
        sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: raw });
      }
      await api('/phone/sub?' + nameQ(me.name), { token: me.token, sub: sub.toJSON() });
    } catch (e) { console.warn('push', e); }
  }

  // ----- Gelen arama -----
  let ringLoop = null;
  function incoming(r) {
    if (inRing && inRing.id === r.id) return;
    // Başka bir görüşmedeyken: meşgul
    if (room) { answerRing(r, false); toast(`@${r.from} aradı (görüşmede olduğun için meşgul dendi)`, 4000); return; }
    inRing = { id: r.id, from: r.from, room: r.room };
    $('inName').textContent = '@' + r.from;
    $('inAvatar').textContent = (r.from[0] || '?').toUpperCase();
    $('incoming').classList.remove('hidden');
    const tickRing = () => { ringTone(); if (navigator.vibrate) { try { navigator.vibrate([700, 400, 700]); } catch {} } };
    tickRing(); clearInterval(ringLoop); ringLoop = setInterval(tickRing, 2500);
    showCallNote(r);
  }
  function stopIncoming() {
    clearInterval(ringLoop); ringLoop = null;
    if (navigator.vibrate) { try { navigator.vibrate(0); } catch {} }
    $('incoming').classList.add('hidden');
    closeCallNote();
    inRing = null;
  }
  function ringTone() {
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume();
      [0, 0.35, 1.0, 1.35].forEach((d, i) => {
        const o = actx.createOscillator(), g = actx.createGain(), t = actx.currentTime + d;
        o.type = 'sine'; o.frequency.value = i % 2 ? 640 : 800;
        g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.25, t + 0.03); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
        o.connect(g).connect(actx.destination); o.start(t); o.stop(t + 0.32);
      });
    } catch {}
  }
  async function showCallNote(r) {
    if (notifyState() !== 'granted' || document.visibilityState === 'visible') return;
    try {
      const reg = swReg || await navigator.serviceWorker.getRegistration();
      if (!reg) return;
      await reg.showNotification(`📞 @${r.from} arıyor`, {
        body: 'Görüntülü arama · açmak için dokun', tag: 'dusukmb-call', renotify: true, requireInteraction: true,
        icon: 'icon.svg', badge: 'icon.svg', vibrate: [700, 400, 700, 400, 700, 400, 700],
        actions: [{ action: 'accept', title: '📞 Aç' }, { action: 'decline', title: '✕ Reddet' }],
        data: { ring: r, url: location.origin + location.pathname },
      });
    } catch (e) { console.warn(e); }
  }
  async function closeCallNote() {
    try { const reg = swReg || await navigator.serviceWorker.getRegistration(); if (reg) (await reg.getNotifications({ tag: 'dusukmb-call' })).forEach((n) => n.close()); } catch {}
  }
  async function answerRing(r, accept) {
    if (phoneWs && phoneWs.readyState === 1) { phoneWs.send(JSON.stringify({ t: 'answer', id: r.id, accept })); return true; }
    if (!me) return false;
    const res = await api('/phone/answer?' + nameQ(me.name), { token: me.token, id: r.id, accept });
    return !!res.ok;
  }
  $('inYes').onclick = () => { const r = inRing; if (!r) return; answerRing(r, true); stopIncoming(); start(r.room); };
  $('inNo').onclick = () => { const r = inRing; if (!r) return; answerRing(r, false); stopIncoming(); };
  // Bildirimdeki düğmeler (sayfa zaten açıksa service worker buraya haber verir)
  if (navigator.serviceWorker) navigator.serviceWorker.addEventListener('message', (e) => {
    const m = e.data || {};
    if (m.t !== 'notif' || !m.ring) return;
    if (m.action === 'decline') { answerRing(m.ring, false); stopIncoming(); return; }
    if (m.action === 'accept') { answerRing(m.ring, true); stopIncoming(); if (!room) start(m.ring.room); return; }
    if (!room) incoming(m.ring); // bildirime dokundu: gelen arama ekranını göster
  });

  // ----- Arama yap -----
  let callWs = null, ringback = null, calling = '';
  function contacts() { return lsGet(CONTACTS_KEY, []); }
  function addContact(n) { lsSet(CONTACTS_KEY, [n, ...contacts().filter((x) => x !== n)].slice(0, 8)); }
  function renderContacts(st = {}) {
    const box = $('contacts'); box.textContent = '';
    for (const n of contacts()) {
      const b = document.createElement('button'); b.className = 'chip';
      const s = st[n] || {};
      const d = document.createElement('span'); d.className = 'dot' + (s.online ? ' on' : s.push ? ' push' : '');
      d.title = s.online ? 'çevrimiçi' : s.push ? 'bildirimle ulaşılabilir' : 'çevrimdışı';
      b.append(d, document.createTextNode('@' + n));
      b.onclick = () => callUser(n);
      box.appendChild(b);
    }
  }
  async function refreshContacts() {
    const list = contacts();
    renderContacts();
    if (!list.length || room) return;
    try { renderContacts(await api('/phone/status?names=' + list.join(','))); } catch {}
  }
  setInterval(() => { if (!room && document.visibilityState === 'visible') refreshContacts(); }, 20000);

  async function callUser(n) {
    n = String(n || '').trim().toLowerCase().replace(/^@/, '');
    if (!NAME_RE.test(n)) { toast('Geçerli bir kullanıcı adı yaz'); return; }
    if (me && n === me.name) { toast('Kendini arayamazsın 🙂'); return; }
    addContact(n);
    calling = n;
    const code = newRoomCode();
    await start(code);
    if (!room) return; // kamera/mikrofon izni yok
    await apiReady;
    setStatus(`📞 @${n} aranıyor…`);
    const ws = new WebSocket(`${wsBase}/phone/ws?${nameQ(n)}&role=caller&room=${code}&from=${encodeURIComponent(me ? me.name : 'misafir')}`);
    callWs = ws;
    const end = (text, ms = 3000, invite = false) => {
      stopRingback(); setStatus(text);
      if (invite) openInvite();
      else setTimeout(() => { if (!peerPresent) $('hangBtn').click(); }, ms);
    };
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.t === 'ringing') { setStatus(`📞 @${n} ${m.online ? 'çalıyor…' : 'aranıyor… (bildirim gönderildi)'}`); startRingback(); }
      else if (m.t === 'answer') { stopRingback(); if (m.accept) setStatus('Açtı, bağlanıyor…'); else end(`@${n} aramayı reddetti`); try { ws.close(); } catch {} }
      else if (m.t === 'noanswer') end(`@${n} cevap vermedi`);
      else if (m.t === 'offline') end(`@${n} şu an çevrimdışı. Davet linki gönderebilirsin 👇`, 0, true);
      else if (m.t === 'nouser') end(`@${n} diye bir kullanıcı yok`);
      else if (m.t === 'busy') end(`@${n} şu an başka bir aramada`);
    };
    ws.onerror = () => { if (!peerPresent) setStatus('Arama sunucusuna ulaşılamadı. Davet linki gönderebilirsin 🔗'); };
  }
  function startRingback() {
    stopRingback();
    const beep = () => {
      try {
        actx = actx || new (window.AudioContext || window.webkitAudioContext)();
        const o = actx.createOscillator(), g = actx.createGain(), t = actx.currentTime;
        o.frequency.value = 425; g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.08, t + 0.05);
        g.gain.setValueAtTime(0.08, t + 1.0); g.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);
        o.connect(g).connect(actx.destination); o.start(t); o.stop(t + 1.15);
      } catch {}
    };
    beep(); ringback = setInterval(beep, 4000);
  }
  function stopRingback() { clearInterval(ringback); ringback = null; }
  // Karşı taraf bağlanınca arama sinyalini kapat
  setInterval(() => { if (peerPresent && (callWs || ringback)) { stopRingback(); if (callWs) { try { callWs.close(); } catch {} callWs = null; } } }, 500);
  $('callBtn').onclick = () => callUser($('callName').value);
  $('callName').addEventListener('keydown', (e) => { if (e.key === 'Enter') callUser($('callName').value); });

  renderMe(); refreshContacts(); shareMeWithSw();
  apiReady.then(() => { shareMeWithSw(); if (me && lsGet(ONLINE_KEY, false)) { connectPhone(); subscribePush(); } });

  // Bildirimden "Aç" ile gelindiyse (sayfa kapalıydı): aramayı kabul et ve görüşmeye gir
  if (params.get('cevap') && params.get('oda')) {
    const r = { id: params.get('cevap'), room: params.get('oda').trim().toLowerCase(), from: params.get('kimden') || '' };
    history.replaceState(null, '', location.pathname);
    (async () => {
      if (params.get('islem') === 'gor') { incoming(r); return; } // sadece dokundu: gelen arama ekranı
      const ok = await answerRing(r, true);
      if (ok) start(r.room); else toast('Arama sona ermiş', 3500);
    })();
  } else
  // Davet linkiyle açıldıysa tıklamadan doğrudan katıl
  if (params.get('oda')) {
    const r = params.get('oda').trim().toLowerCase();
    $('room').value = r;
    $('lobbyMsg').textContent = 'Görüşmeye katılıyorsun… Kamera/mikrofon iznine "İzin ver" de.';
    start(r);
  }
})();

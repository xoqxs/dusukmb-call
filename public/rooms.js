// DusukMB Call - Topluluk ve odalar (Discord / TeamSpeak gibi)
// - Topluluk kodu = Discord sunucusu. İçinde kalıcı odalar, kim hangi odada görünür.
// - Odada en fazla 4 kişi; herkes herkese doğrudan (P2P) bağlanır, sunucudan görüntü geçmez.
// - Varsayılan: kamera + ses açık (görüntülü odalar). Kamera kapatılırsa sadece sesle devam edilir.
(() => {
  const $ = (id) => document.getElementById(id);
  const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  // Görüntü kalitesi (kamera açıkken, her karşı tarafa gönderilen)
  const QUALITY = {
    dusuk:  { w: 160, h: 120, fps: 8,  vbr: 30000 },
    normal: { w: 240, h: 180, fps: 12, vbr: 32000 },
    iyi:    { w: 320, h: 240, fps: 15, vbr: 70000 },
  };
  const AUDIO_BR = 12000;
  const COLORS = ['#ffd279', '#8ec5ff', '#a7f3a0', '#ffb3c7', '#c9b6ff', '#ffc38a', '#7fe0d6'];
  const colorOf = (id) => { let h = 0; for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0; return COLORS[h % COLORS.length]; };
  const initial = (n) => (n || '?').trim().charAt(0).toLocaleUpperCase('tr-TR') || '?';

  let cfg = {}, wsBase = '', httpBase = '', iceConfig = { iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }] };
  let community = '', nick = '', myId = '', myToken = '', password = '', passKey = '', locked = false;
  let sock = null, sockTimer = null, pingTimer = null, leavingCommunity = false;
  let state = { rooms: [], online: 0, lobby: [] };
  let myRoom = null, wantRoom = null;            // içinde olduğum oda / girmek istediğim oda
  let localStream = null, micOn = true, camOn = true, quality = 'normal';
  const peers = new Map();                        // id -> { pc, name, tile, video, pendingIce, analyser, failTimer }
  let audioCtx = null, speakTimer = null, statsTimer = null, statsPrev = null;
  let chatOpen = false, unread = 0;

  // ---------- Yardımcılar ----------
  function toast(t, ms = 2500) {
    const el = $('toast'); el.textContent = t; el.classList.remove('hidden');
    clearTimeout(toast.tm); toast.tm = setTimeout(() => el.classList.add('hidden'), ms);
  }
  function show(id) { for (const s of ['entry', 'community-view', 'room-view']) $(s).classList.toggle('hidden', s !== id); }
  function rnd(n = 12) { const a = new Uint8Array(n); crypto.getRandomValues(a); return [...a].map((b) => b.toString(36).padStart(2, '0')).join('').slice(0, n * 2); }
  function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch {} }
  function ssGet(k) { try { return sessionStorage.getItem(k); } catch { return null; } }
  function ssSet(k, v) { try { if (v == null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v); } catch {} }

  // Parolanın kendisi sunucuya gitmez; topluluk koduyla birlikte SHA-256 özeti gönderilir
  async function keyOf(comm, pass) {
    if (!pass) return '';
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('dusukmb:' + comm + ':' + pass));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  const passStoreKey = () => 'dusukmb-pass:' + community;

  // ---------- Giriş ----------
  const params = new URLSearchParams(location.search);
  $('community').value = params.get('topluluk') || lsGet('dusukmb-community') || '';
  // Davet linki: ?topluluk=X&oda=Y#p=parola  (parola # sonrasında: sunuculara gönderilmez, tarayıcıda kalır)
  const hashP = new URLSearchParams(location.hash.slice(1)).get('p');
  if (hashP) $('pass').value = hashP;
  const linkRoom = params.get('oda');
  $('nick').value = lsGet('dusukmb-nick') || '';
  $('enterBtn').onclick = enter;
  for (const id of ['community', 'nick']) $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') enter(); });

  async function loadConfig() {
    try { const r = await fetch('config.json', { cache: 'no-store' }); if (r.ok) cfg = await r.json(); } catch {}
    const s = cfg.signal;
    if (s) {
      wsBase = `${s.secure ? 'wss' : 'ws'}://${s.host}:${s.port}`;
      httpBase = `${s.secure ? 'https' : 'http'}://${s.host}:${s.port}`;
    } else {
      // Site sunucuyla aynı yerden açıldıysa
      wsBase = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
      httpBase = location.origin;
    }
    try {
      const ctl = new AbortController(); setTimeout(() => ctl.abort(), 3000);
      const r = await fetch(httpBase + '/ice', { signal: ctl.signal, cache: 'no-store' });
      if (r.ok) { const j = await r.json(); if (Array.isArray(j.iceServers) && j.iceServers.length) iceConfig = { iceServers: j.iceServers }; }
    } catch {}
  }

  async function enter() {
    community = $('community').value.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '');
    nick = $('nick').value.trim().slice(0, 24);
    if (community.length < 2) { $('entryErr').textContent = 'Topluluk kodu en az 2 harf olmalı (harf, rakam, - ve _).'; return; }
    if (!nick) { $('entryErr').textContent = 'Bir takma ad yaz.'; $('nick').focus(); return; }
    $('entryErr').textContent = '';
    lsSet('dusukmb-community', community); lsSet('dusukmb-nick', nick);
    password = $('pass').value || lsGet(passStoreKey()) || '';
    passKey = await keyOf(community, password);
    // Parolayı adres çubuğundan sil (ekran görüntüsünde/geçmişte görünmesin); bu telefonda hatırlanır
    history.replaceState(null, '', `?topluluk=${encodeURIComponent(community)}`);
    // Kimlik bu telefonda saklanır; yenilemede aynı kişi olarak döner
    myId = lsGet('dusukmb-cid') || ('u' + rnd(10)); lsSet('dusukmb-cid', myId);
    myToken = lsGet('dusukmb-ctok') || rnd(16); lsSet('dusukmb-ctok', myToken);
    $('cName').textContent = community;
    show('community-view');
    await loadConfig();
    leavingCommunity = false;
    connect();
    // Davet linkindeki oda ya da yenilemeden önce içinde olunan oda: bağlanınca doğrudan oraya gir
    const prev = linkRoom || ssGet('dusukmb-room:' + community);
    if (prev) wantRoom = prev;
  }

  // ---------- Topluluk bağlantısı ----------
  function connect() {
    clearTimeout(sockTimer);
    const url = `${wsBase}/community?c=${encodeURIComponent(community)}&id=${myId}&token=${myToken}&name=${encodeURIComponent(nick)}${passKey ? '&k=' + passKey : ''}`;
    const s = new WebSocket(url);
    sock = s;
    $('cOnline').textContent = 'bağlanıyor…';
    s.onopen = () => {
      clearInterval(pingTimer);
      pingTimer = setInterval(() => { if (s.readyState === 1) s.send('ping'); }, 20000);
    };
    s.onmessage = (ev) => {
      if (ev.data === 'pong') return;
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      onServer(m);
    };
    s.onclose = () => {
      clearInterval(pingTimer);
      if (sock !== s || leavingCommunity) return;
      $('cOnline').textContent = 'bağlantı koptu, tekrar deneniyor…';
      if (myRoom) setStatus('Sunucu bağlantısı koptu, tekrar deneniyor…');
      sockTimer = setTimeout(connect, 2000);
    };
  }
  function send(obj) { if (sock && sock.readyState === 1) sock.send(JSON.stringify(obj)); }

  function onServer(m) {
    switch (m.t) {
      case 'auth':
        // Parola gerekli/yanlış: giriş ekranına dön, parola iste
        leavingCommunity = true;
        try { sock.close(); } catch {}
        try { localStorage.removeItem(passStoreKey()); } catch {}
        show('entry');
        $('entryErr').textContent = m.msg + '. Parolayı yaz ya da davet linkini kullan.';
        $('pass').value = ''; $('pass').focus();
        break;
      case 'welcome':
        if (password) lsSet(passStoreKey(), password); // doğru parola: bu telefonda hatırla
        state = m.state; renderRooms();
        // Bağlantı koptuysa ve odadaysak (ya da yenilemeden önce odadaysak) odaya geri gir
        if (myRoom || wantRoom) joinRoom(myRoom || wantRoom, true);
        break;
      case 'state':
        state = m; renderRooms();
        if (myRoom) syncPeers();
        break;
      case 'joined':
        myRoom = m.room; wantRoom = null;
        ssSet('dusukmb-room:' + community, myRoom);
        enterRoomView();
        break;
      case 'signal':
        onSignal(m.from, m.data);
        break;
      case 'chat':
        addChat(m);
        break;
      case 'error':
        toast(m.msg);
        if (!myRoom) { wantRoom = null; show('community-view'); stopMedia(); }
        break;
    }
  }

  // ---------- Oda listesi ----------
  function renderRooms() {
    locked = !!state.locked;
    $('lockBtn').textContent = locked ? '🔒' : '🔓';
    $('lockBtn').classList.toggle('locked', locked);
    $('cOnline').textContent = `${state.online} kişi çevrimiçi${locked ? ' · parolalı' : ''}`;
    const list = $('roomList');
    list.textContent = '';
    for (const r of state.rooms) {
      const el = document.createElement('div');
      el.className = 'room' + (r.name === myRoom ? ' mine' : '');
      const head = document.createElement('div'); head.className = 'room-head';
      const rn = document.createElement('span'); rn.className = 'rn'; rn.textContent = r.name;
      const cnt = document.createElement('span'); cnt.className = 'cnt'; cnt.textContent = `${r.members.length}/4`;
      head.append(rn, cnt);
      if (!r.members.length) {
        const del = document.createElement('button'); del.className = 'ghost'; del.title = 'Odayı sil'; del.textContent = '🗑';
        del.onclick = () => { if (confirmDelete(r.name)) send({ t: 'delete', room: r.name }); };
        head.appendChild(del);
      }
      const btn = document.createElement('button');
      if (r.name === myRoom) { btn.textContent = 'Odadasın'; btn.onclick = () => show('room-view'); }
      else { btn.textContent = r.members.length >= 4 ? 'Dolu' : 'Katıl'; btn.disabled = r.members.length >= 4; btn.onclick = () => joinRoom(r.name); }
      head.appendChild(btn);
      el.appendChild(head);
      if (r.members.length) {
        const ppl = document.createElement('div'); ppl.className = 'people';
        for (const p of r.members) {
          const chip = document.createElement('span'); chip.className = 'person'; chip.dataset.id = p.id;
          const av = document.createElement('span'); av.className = 'av'; av.style.background = colorOf(p.id); av.textContent = initial(p.name);
          const nm = document.createElement('span'); nm.textContent = p.name + (p.id === myId ? ' (sen)' : '') + (p.muted ? ' 🔇' : '') + (p.cam ? ' 📷' : '');
          chip.append(av, nm); ppl.appendChild(chip);
        }
        el.appendChild(ppl);
      }
      list.appendChild(el);
    }
    const lob = state.lobby || [];
    $('lobbyPeople').textContent = lob.length ? `Odalarda değil: ${lob.map((p) => p.name).join(', ')}` : '';
    // Oda içindeysek başlık bilgisini de güncelle
    if (myRoom) {
      const r = state.rooms.find((x) => x.name === myRoom);
      $('rInfo').textContent = r ? `${r.members.length}/4 kişi` : '';
    }
  }
  // Basit onay (tarayıcı confirm'ü bazı ortamlarda engelli): ikinci dokunuşta sil
  function confirmDelete(name) {
    if (confirmDelete.last === name && Date.now() - confirmDelete.at < 3000) { confirmDelete.last = null; return true; }
    confirmDelete.last = name; confirmDelete.at = Date.now();
    toast(`"${name}" silinsin mi? Onaylamak için 🗑'e tekrar dokun.`);
    return false;
  }
  $('createForm').onsubmit = (e) => {
    e.preventDefault();
    const name = $('newRoom').value.trim();
    if (!name) return;
    send({ t: 'create', room: name });
    $('newRoom').value = '';
  };
  // Davet linki: parola # sonrasında (tıklayan kişi bir şey yazmadan girer), oda verilirse doğrudan o odaya
  function inviteUrl(room) {
    let u = `${location.origin}${location.pathname}?topluluk=${encodeURIComponent(community)}`;
    if (room) u += `&oda=${encodeURIComponent(room)}`;
    if (locked && password) u += `#p=${encodeURIComponent(password)}`;
    return u;
  }
  async function share(room) {
    const url = inviteUrl(room);
    const text = room ? `"${room}" görüntülü odasına katıl` : `"${community}" topluluğuna katıl`;
    try {
      if (navigator.share) await navigator.share({ title: 'DusukMB', text, url });
      else { await navigator.clipboard.writeText(url); toast(locked ? 'Davet linki (parolalı) kopyalandı' : 'Davet linki kopyalandı'); }
    } catch {}
  }
  $('shareBtn').onclick = () => share(myRoom);
  $('roomShareBtn').onclick = () => share(myRoom);

  // Parola paneli
  $('lockBtn').onclick = () => {
    $('lockPanel').classList.toggle('hidden');
    $('lockInfo').textContent = locked
      ? 'Bu topluluk parolalı. Parolayı değiştirebilir ya da kaldırabilirsin. İçeridekiler bağlı kalır.'
      : 'Parola koyarsan sadece parolayı (ya da davet linkini) bilenler girebilir.';
    $('clearPass').classList.toggle('hidden', !locked);
    $('newPass').value = locked ? password : '';
  };
  $('genPass').onclick = () => {
    const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
    const a = new Uint8Array(8); crypto.getRandomValues(a);
    $('newPass').value = [...a].map((b) => abc[b % abc.length]).join('');
  };
  $('savePass').onclick = async () => {
    const p = $('newPass').value.trim();
    if (p.length < 4) { toast('Parola en az 4 karakter olmalı'); return; }
    password = p; passKey = await keyOf(community, p);
    lsSet(passStoreKey(), p);
    send({ t: 'setpass', key: passKey });
    $('lockPanel').classList.add('hidden');
    toast('Parola kaydedildi. Davet linki parolayı içerir 🔗');
  };
  $('clearPass').onclick = () => {
    password = ''; passKey = '';
    try { localStorage.removeItem(passStoreKey()); } catch {}
    send({ t: 'setpass', key: '' });
    $('lockPanel').classList.add('hidden');
    toast('Parola kaldırıldı');
  };

  $('exitBtn').onclick = () => {
    leaveRoom();
    leavingCommunity = true;
    if (sock) sock.close();
    show('entry');
  };

  // ---------- Odaya giriş / çıkış ----------
  async function joinRoom(name, isRejoin = false) {
    if (myRoom && myRoom !== name && !isRejoin) leaveRoom();
    wantRoom = name;
    try { await ensureMedia(); } catch (e) {
      toast('Mikrofon izni gerekli: ' + e.message, 4000); wantRoom = null; return;
    }
    send({ t: 'join', room: name, muted: !micOn, cam: camOn });
  }

  function leaveRoom() {
    if (!myRoom && !wantRoom) return;
    send({ t: 'leave' });
    for (const id of [...peers.keys()]) closePeer(id);
    myRoom = null; wantRoom = null;
    ssSet('dusukmb-room:' + community, null);
    stopMedia();
    clearInterval(statsTimer); statsTimer = null; statsPrev = null;
    $('rchatLog').textContent = '';
    show('community-view');
    renderRooms();
  }
  $('leaveBtn').onclick = leaveRoom;
  $('hangBtn').onclick = leaveRoom;

  function enterRoomView() {
    $('rName').textContent = myRoom;
    show('room-view');
    ensureLocalTile();
    layoutTiles();
    renderRooms();
    syncPeers();
    if (!statsTimer) statsTimer = setInterval(pollStats, 3000);
    setStatus(peers.size ? '' : 'Odada şimdilik yalnızsın. Davet için ← ve 🔗');
  }

  function setStatus(t) { $('rstatus').textContent = t; $('rstatus').classList.toggle('hidden', !t); }

  // ---------- Yerel ses/görüntü ----------
  async function ensureMedia() {
    if (!localStream) {
      const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 };
      const q = QUALITY[quality];
      const video = { facingMode: 'user', width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: q.fps, max: 15 } };
      try {
        // Kamera ve mikrofon için tek izin penceresi
        localStream = await navigator.mediaDevices.getUserMedia(camOn ? { audio, video } : { audio });
      } catch (e) {
        if (!camOn) throw e;
        // Kamera yok/izin yoksa sesle devam et
        localStream = await navigator.mediaDevices.getUserMedia({ audio });
        camOn = false; $('camBtn').classList.add('off');
        toast('Kamera açılamadı, sesle devam ediliyor');
      }
      localStream.getAudioTracks()[0].enabled = micOn;
    }
    if (camOn && !localStream.getVideoTracks().length) await startCamera();
    if (!audioCtx) { try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch {} }
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    if (!speakTimer) speakTimer = setInterval(detectSpeaking, 150);
  }
  async function startCamera() {
    const q = QUALITY[quality];
    const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: q.fps, max: 15 } } });
    const vt = s.getVideoTracks()[0];
    localStream.addTrack(vt);
    for (const p of peers.values()) await attachLocalTracks(p);
  }
  function stopCamera() {
    for (const t of (localStream ? localStream.getVideoTracks() : [])) { t.stop(); localStream.removeTrack(t); }
    for (const p of peers.values()) attachLocalTracks(p);
  }
  function stopMedia() {
    if (localStream) for (const t of localStream.getTracks()) t.stop();
    localStream = null;
    clearInterval(speakTimer); speakTimer = null;
    const me = $('tiles').querySelector('.tile.me'); if (me) me.remove();
  }

  $('micBtn').onclick = () => {
    micOn = !micOn;
    if (localStream) localStream.getAudioTracks().forEach((t) => (t.enabled = micOn));
    $('micBtn').classList.toggle('off', !micOn);
    send({ t: 'meta', muted: !micOn, cam: camOn });
    updateLocalTile();
  };
  $('camBtn').onclick = async () => {
    camOn = !camOn;
    $('camBtn').classList.toggle('off', !camOn);
    try { if (camOn) await startCamera(); else stopCamera(); }
    catch (e) { camOn = false; $('camBtn').classList.add('off'); toast('Kamera açılamadı: ' + e.message, 4000); }
    send({ t: 'meta', muted: !micOn, cam: camOn });
    updateLocalTile();
  };
  $('quality').onchange = (e) => {
    quality = e.target.value;
    for (const p of peers.values()) applyBitrates(p);
  };

  // ---------- Çok kişili bağlantı (herkes herkese) ----------
  // Kural: iki kişiden kimliği alfabetik olarak küçük olan teklifi (offer) yapar. Böylece çakışma olmaz.
  function syncPeers() {
    const r = state.rooms.find((x) => x.name === myRoom);
    if (!r) return;
    if (!r.members.some((m) => m.id === myId)) {
      // Sunucu bizi odada görmüyor (yeniden başlatma vb.): tekrar gir
      if (sock && sock.readyState === 1) send({ t: 'join', room: myRoom, muted: !micOn, cam: camOn });
      return;
    }
    const others = r.members.filter((m) => m.id !== myId);
    for (const m of others) {
      const p = peers.get(m.id);
      if (!p) { if (myId < m.id) createPeer(m.id, m.name, true); else ensurePeerTile(m.id, m.name); }
      else { p.name = m.name; p.cam = m.cam; p.muted = m.muted; updateTile(m.id); }
    }
    for (const id of [...peers.keys()]) if (!others.some((m) => m.id === id)) closePeer(id);
    // Henüz bağlantısı olmayan (karşıdan teklif beklenen) kişilerin kutucukları
    for (const t of [...$('tiles').querySelectorAll('.tile.waiting')]) if (!others.some((m) => m.id === t.dataset.id)) t.remove();
    layoutTiles();
    setStatus(others.length ? '' : 'Odada şimdilik yalnızsın. Davet için ← ve 🔗');
  }

  function ensurePeerTile(id, name) {
    let t = $('tiles').querySelector(`.tile[data-id="${id}"]`);
    if (!t) {
      t = makeTile(id, name, false);
      t.classList.add('waiting');
      $('tiles').appendChild(t);
    }
    return t;
  }

  async function createPeer(id, name, offerer) {
    if (peers.has(id)) closePeer(id);
    const pc = new RTCPeerConnection(iceConfig);
    const tile = ensurePeerTile(id, name);
    tile.classList.remove('waiting');
    const p = { id, pc, name, tile, video: tile.querySelector('video'), pendingIce: [], cam: false, muted: false, offerer };
    peers.set(id, p);
    const member = (state.rooms.find((x) => x.name === myRoom) || { members: [] }).members.find((m) => m.id === id);
    if (member) { p.cam = member.cam; p.muted = member.muted; }

    pc.onicecandidate = (e) => { if (e.candidate) send({ t: 'signal', to: id, data: { ice: e.candidate.toJSON() } }); };
    pc.ontrack = (e) => {
      const stream = e.streams[0] || new MediaStream([e.track]);
      if (p.video.srcObject !== stream) p.video.srcObject = stream;
      playVideo(p.video);
      if (e.track.kind === 'audio') attachAnalyser(p, stream);
      updateTile(id);
    };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      updateTile(id);
      clearTimeout(p.failTimer);
      if (s === 'failed' || s === 'disconnected') {
        // 5 sn içinde düzelmezse bu kişiyle bağlantıyı baştan kur
        p.failTimer = setTimeout(() => {
          if (peers.get(id) !== p || pc.connectionState === 'connected') return;
          closePeer(id);
          syncPeers();
        }, s === 'failed' ? 500 : 5000);
      }
    };

    if (offerer) {
      pc.addTransceiver('audio', { direction: 'sendrecv' });
      const vtr = pc.addTransceiver('video', { direction: 'sendrecv' });
      preferCodecs(vtr);
      await attachLocalTracks(p);
      try {
        const offer = await pc.createOffer();
        offer.sdp = mungeOpus(offer.sdp);
        await pc.setLocalDescription(offer);
        send({ t: 'signal', to: id, data: { sdp: pc.localDescription.toJSON() } });
      } catch (e) { console.warn('teklif', e); }
    }
    return p;
  }

  // Oynat: ses+görüntü art arda gelince ilk istek yarıda kesilebilir (AbortError) → tekrar dene.
  // Sadece tarayıcı gerçekten engellerse (NotAllowedError) kullanıcıdan dokunmasını iste.
  function playVideo(v, tries = 0) {
    if (!v.paused) return;
    v.play().catch((e) => {
      if (e && e.name === 'NotAllowedError') toast('Sesi açmak için ekrana dokun', 4000);
      else if (tries < 5) setTimeout(() => playVideo(v, tries + 1), 300);
    });
  }

  async function onSignal(from, data) {
    if (!myRoom || !data) return;
    let p = peers.get(from);
    if (data.sdp && data.sdp.type === 'offer') {
      const member = (state.rooms.find((x) => x.name === myRoom) || { members: [] }).members.find((m) => m.id === from);
      p = await createPeer(from, member ? member.name : '…', false);
      await p.pc.setRemoteDescription(data.sdp);
      for (const tr of p.pc.getTransceivers()) {
        tr.direction = 'sendrecv';
        if (tr.receiver.track && tr.receiver.track.kind === 'video') preferCodecs(tr);
      }
      await attachLocalTracks(p);
      const ans = await p.pc.createAnswer();
      ans.sdp = mungeOpus(ans.sdp);
      await p.pc.setLocalDescription(ans);
      send({ t: 'signal', to: from, data: { sdp: p.pc.localDescription.toJSON() } });
      await flushIce(p);
    } else if (data.sdp && data.sdp.type === 'answer' && p) {
      try { await p.pc.setRemoteDescription(data.sdp); await flushIce(p); applyBitrates(p); } catch (e) { console.warn('cevap', e); }
    } else if (data.ice) {
      if (!p) return;
      if (p.pc.remoteDescription) { try { await p.pc.addIceCandidate(data.ice); } catch {} }
      else p.pendingIce.push(data.ice);
    }
  }
  async function flushIce(p) { for (const c of p.pendingIce) { try { await p.pc.addIceCandidate(c); } catch {} } p.pendingIce = []; }

  // Ses ve (varsa) görüntü izlerini bu kişiye giden kanallara bağla; yeniden anlaşma gerekmez
  async function attachLocalTracks(p) {
    if (!localStream) return;
    const at = localStream.getAudioTracks()[0] || null;
    const vt = localStream.getVideoTracks()[0] || null;
    for (const tr of p.pc.getTransceivers()) {
      const kind = tr.receiver.track && tr.receiver.track.kind;
      const want = kind === 'audio' ? at : kind === 'video' ? vt : null;
      if (tr.sender.track !== want) { try { await tr.sender.replaceTrack(want); } catch {} }
    }
    applyBitrates(p);
  }
  async function applyBitrates(p) {
    const q = QUALITY[quality];
    for (const s of p.pc.getSenders()) {
      if (!s.track) continue;
      const params = s.getParameters();
      if (!params.encodings || !params.encodings.length) continue;
      const e = params.encodings[0];
      if (s.track.kind === 'audio') e.maxBitrate = AUDIO_BR;
      else {
        const st = s.track.getSettings();
        const big = Math.max(st.width || q.w, st.height || q.h);
        e.scaleResolutionDownBy = Math.max(1, big / Math.max(q.w, q.h));
        e.maxBitrate = q.vbr; e.maxFramerate = q.fps;
      }
      try { await s.setParameters(params); } catch {}
    }
  }
  function closePeer(id) {
    const p = peers.get(id);
    if (!p) return;
    clearTimeout(p.failTimer);
    try { p.pc.close(); } catch {}
    if (p.source) { try { p.source.disconnect(); } catch {} }
    p.tile.remove();
    peers.delete(id);
    layoutTiles();
  }

  function preferCodecs(tr) {
    if (!tr.setCodecPreferences || !RTCRtpReceiver.getCapabilities) return;
    const caps = RTCRtpReceiver.getCapabilities('video'); if (!caps) return;
    const order = IS_IOS ? ['video/H264', 'video/VP8', 'video/VP9'] : ['video/VP9', 'video/VP8', 'video/H264'];
    const rank = (c) => { const i = order.indexOf(c.mimeType); return i === -1 ? 99 : i; };
    try { tr.setCodecPreferences([...caps.codecs].sort((a, b) => rank(a) - rank(b))); } catch {}
  }
  // Opus: mono, konuşma bandı, düşük bit hızı, sessizlikte veri kesme, 60 ms paket
  function mungeOpus(sdp) {
    const m = sdp.match(/a=rtpmap:(\d+) opus\/48000\/2/i);
    if (!m) return sdp;
    const pt = m[1];
    const want = `maxaveragebitrate=${AUDIO_BR};usedtx=1;stereo=0;sprop-stereo=0;maxplaybackrate=16000;useinbandfec=1;minptime=40`;
    const drop = /^(maxaveragebitrate|usedtx|stereo|sprop-stereo|maxplaybackrate|useinbandfec|minptime)=/;
    if (!/a=ptime:/.test(sdp)) sdp = sdp.replace(/(m=audio[^\r\n]*\r\n)/, '$1a=ptime:60\r\n');
    const re = new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`);
    if (re.test(sdp)) return sdp.replace(re, (_, p) => `a=fmtp:${pt} ${[...p.split(';').filter((x) => x && !drop.test(x.trim())), want].join(';')}`);
    return sdp.replace(m[0], `${m[0]}\r\na=fmtp:${pt} ${want}`);
  }

  // ---------- Kutucuklar ----------
  function makeTile(id, name, me) {
    const t = document.createElement('div');
    t.className = 'tile nocam' + (me ? ' me' : '');
    t.dataset.id = id;
    const v = document.createElement('video'); v.autoplay = true; v.playsInline = true; if (me) v.muted = true;
    const av = document.createElement('div'); av.className = 'avatar';
    const circle = document.createElement('span'); circle.style.background = colorOf(id); circle.textContent = initial(name);
    av.appendChild(circle);
    const label = document.createElement('div'); label.className = 'label'; label.textContent = me ? `${name} (sen)` : name;
    const conn = document.createElement('div'); conn.className = 'conn hidden';
    t.append(v, av, label, conn);
    return t;
  }
  function ensureLocalTile() {
    let t = $('tiles').querySelector('.tile.me');
    if (!t) { t = makeTile(myId, nick, true); $('tiles').prepend(t); }
    t.querySelector('video').srcObject = localStream;
    updateLocalTile();
  }
  function updateLocalTile() {
    const t = $('tiles').querySelector('.tile.me'); if (!t) return;
    t.querySelector('video').srcObject = localStream;
    t.classList.toggle('nocam', !camOn);
    t.querySelector('.label').textContent = `${nick} (sen)${micOn ? '' : ' 🔇'}`;
  }
  function updateTile(id) {
    const p = peers.get(id); if (!p) return;
    p.tile.classList.toggle('nocam', !p.cam);
    p.tile.querySelector('.label').textContent = p.name + (p.muted ? ' 🔇' : '');
    p.tile.querySelector('.avatar span').textContent = initial(p.name);
    const conn = p.tile.querySelector('.conn');
    const s = p.pc.connectionState;
    conn.textContent = s === 'connected' ? '' : s === 'new' || s === 'connecting' ? 'bağlanıyor…' : 'bağlantı zayıf';
    conn.classList.toggle('hidden', s === 'connected');
  }
  function layoutTiles() {
    const n = $('tiles').children.length;
    $('tiles').className = 'tiles n' + Math.min(4, Math.max(1, n));
  }

  // ---------- Kim konuşuyor (yeşil çerçeve) ----------
  function attachAnalyser(p, stream) {
    if (!audioCtx || p.source) return;
    try {
      p.source = audioCtx.createMediaStreamSource(stream);
      p.analyser = audioCtx.createAnalyser(); p.analyser.fftSize = 512;
      p.source.connect(p.analyser);
    } catch {}
  }
  let localAnalyser = null, localSource = null;
  function detectSpeaking() {
    const level = (an) => { if (!an) return 0; const d = new Uint8Array(an.fftSize); an.getByteTimeDomainData(d); let s = 0; for (const x of d) { const v = (x - 128) / 128; s += v * v; } return Math.sqrt(s / d.length); };
    if (localStream && audioCtx && !localAnalyser && localStream.getAudioTracks().length) {
      try { localSource = audioCtx.createMediaStreamSource(localStream); localAnalyser = audioCtx.createAnalyser(); localAnalyser.fftSize = 512; localSource.connect(localAnalyser); } catch {}
    }
    if (!localStream) { localAnalyser = null; localSource = null; }
    const speaking = new Set();
    if (micOn && level(localAnalyser) > 0.04) speaking.add(myId);
    for (const p of peers.values()) if (!p.muted && level(p.analyser) > 0.04) speaking.add(p.id);
    for (const t of $('tiles').querySelectorAll('.tile')) t.classList.toggle('speaking', speaking.has(t.dataset.id));
    for (const c of $('roomList').querySelectorAll('.person')) c.classList.toggle('speaking', speaking.has(c.dataset.id));
  }

  // ---------- Veri ölçümü ----------
  async function pollStats() {
    let tx = 0, rx = 0;
    for (const p of peers.values()) {
      try {
        const r = await p.pc.getStats();
        r.forEach((s) => {
          if (s.type === 'outbound-rtp') tx += (s.bytesSent || 0) + (s.headerBytesSent || 0);
          if (s.type === 'inbound-rtp') rx += (s.bytesReceived || 0) + (s.headerBytesReceived || 0);
        });
      } catch {}
    }
    const now = Date.now();
    if (statsPrev && now > statsPrev.t) {
      const dt = (now - statsPrev.t) / 1000;
      const dtx = Math.max(0, tx - statsPrev.tx), drx = Math.max(0, rx - statsPrev.rx);
      const perH = (dtx + drx) / dt * 3600 / 1e6;
      $('rData').textContent = peers.size ? `≈ ${Math.round(perH)} MB/sa` : '-';
    }
    statsPrev = { t: now, tx, rx };
  }

  // ---------- Oda sohbeti (video üstünde) ----------
  const SHOW_MS = 8000;
  function addChat(m) {
    const row = document.createElement('div');
    row.className = 'cmsg';
    const b = document.createElement('b'); b.style.color = colorOf(m.from); b.textContent = m.from === myId ? 'Sen' : m.name;
    const s = document.createElement('span'); s.textContent = m.text;
    row.append(b, s);
    if (!chatOpen) { row.classList.add('fade'); row.style.setProperty('--fade', SHOW_MS + 'ms'); setTimeout(() => { if (!chatOpen) row.classList.add('gone'); }, SHOW_MS + 700); }
    $('rchatLog').appendChild(row);
    while ($('rchatLog').children.length > 60) $('rchatLog').firstChild.remove();
    $('rchatLog').scrollTop = $('rchatLog').scrollHeight;
    if (!chatOpen && m.from !== myId && document.visibilityState !== 'visible') { unread++; $('chatBadge').textContent = unread; $('chatBadge').classList.remove('hidden'); }
  }
  function setChatOpen(on) {
    chatOpen = on;
    $('rchat').classList.toggle('open', on);
    $('rchatForm').classList.toggle('hidden', !on);
    $('chatBtn').classList.toggle('on', on);
    for (const r of $('rchatLog').children) { r.classList.toggle('fade', !on); if (on) r.classList.remove('gone'); }
    if (on) { unread = 0; $('chatBadge').classList.add('hidden'); $('rchatInput').focus(); $('rchatLog').scrollTop = $('rchatLog').scrollHeight; }
  }
  $('chatBtn').onclick = () => setChatOpen(!chatOpen);
  $('rchatForm').onsubmit = (e) => {
    e.preventDefault();
    const text = $('rchatInput').value.trim();
    if (!text) return;
    send({ t: 'chat', text, id: rnd(6) });
    $('rchatInput').value = '';
  };
  const style = document.createElement('style'); style.textContent = '.cmsg.gone{display:none}'; document.head.appendChild(style);

  // ---------- Telefon uyku/uygulama değişimi ----------
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !community || leavingCommunity) return;
    if (!sock || sock.readyState > 1) connect();
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  });
  window.addEventListener('online', () => { if (community && !leavingCommunity && (!sock || sock.readyState > 1)) connect(); });
  // iOS: otomatik oynatma engellenirse ilk dokunuşta başlat
  document.addEventListener('click', () => {
    for (const p of peers.values()) if (p.video.srcObject) playVideo(p.video);
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  });

  // Davet linkiyle gelindiyse: takma ad kayıtlıysa doğrudan odaya; değilse sadece adını sor
  if (params.get('topluluk')) {
    if ($('nick').value) enter();
    else {
      $('enterBtn').textContent = linkRoom ? `"${linkRoom}" odasına katıl` : 'Katıl';
      if (hashP) { $('pass').classList.add('hidden'); $('passLabel').classList.add('hidden'); }
      $('nick').focus();
    }
  }

  window.__rooms = { get peers() { return peers; }, get state() { return state; }, get myId() { return myId; }, get myRoom() { return myRoom; } };
})();

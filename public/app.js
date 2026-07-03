// public/app.js
// Polaroid Love — client logic.
//
// Two devices, one photo:
//  - The "host" picks the frame + creates a short room code.
//  - The "guest" enters that code on their own device.
//  - Both browsers open a direct WebRTC connection (video call + data
//    channel) through our self-hosted PeerJS signaling server.
//  - When both people tap "I'm ready", the host drives a shared countdown
//    over the data channel, and at zero, BOTH devices independently draw
//    their own camera frame + their partner's live video frame onto a
//    canvas — so each person ends up with an identical keepsake, without
//    any photo ever passing through a server.
(function () {
  'use strict';

  /* ============ SMALL DOM HELPERS ============ */
  const $ = (id) => document.getElementById(id);
  const screens = {
    home: $('screen-home'),
    design: $('screen-design'),
    lobby: $('screen-lobby'),
    capture: $('screen-capture'),
    result: $('screen-result')
  };
  function goToScreen(name) {
    Object.values(screens).forEach((s) => s.classList.remove('active'));
    screens[name].classList.add('active');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /* ============ STATE ============ */
  const state = {
    role: 'host',            // 'host' | 'guest'
    roomCode: null,
    shape: 'washi',          // 'washi' | 'filmstrip' | 'scrapbook' | 'heart'
    accent: 'pink',          // 'pink' | 'sky' | 'leaf'
    split: 'side',           // 'side' | 'top'  (ignored for 'washi'/'filmstrip')
    peer: null,
    dataConn: null,
    localStream: null,
    remoteStream: null,
    myReady: false,
    peerReady: false,
    peerConnected: false,
    caption: '',
    showDate: true
  };

  const ACCENTS = {
    pink: '#B23A5A',
    sky: '#2E93AD',
    leaf: '#3F8A2E'
  };

  const ROOM_WORDS = ['TULIP', 'CORAL', 'PETAL', 'CLAY', 'BLOOM', 'LEAF', 'GLAZE', 'KILN', 'VASE', 'PINK', 'SKY', 'ROSE', 'FERN', 'MOSS', 'SAGE'];
  function generateRoomCode() {
    const word = ROOM_WORDS[Math.floor(Math.random() * ROOM_WORDS.length)];
    const num = Math.floor(10 + Math.random() * 90);
    return `${word}-${num}`;
  }

  /* ============ TOPBAR STATUS ============ */
  function setStatus(kind, label) {
    const bar = $('topbar-status');
    bar.hidden = false;
    bar.className = 'topbar-status' + (kind ? ' ' + kind : '');
    $('conn-label').textContent = label;
  }

  /* ============ HOME SCREEN ============ */
  $('mode-host').addEventListener('click', () => setMode('host'));
  $('mode-guest').addEventListener('click', () => setMode('guest'));
  function setMode(mode) {
    state.role = mode;
    $('mode-host').classList.toggle('selected', mode === 'host');
    $('mode-guest').classList.toggle('selected', mode === 'guest');
    $('guest-code-row').hidden = mode !== 'guest';
  }

  // Prefill a join code from a shared link, e.g. ?room=TULIP-84
  const urlRoom = new URLSearchParams(location.search).get('room');
  if (urlRoom) {
    setMode('guest');
    $('join-code-input').value = urlRoom.toUpperCase();
  }

  $('continue-btn').addEventListener('click', () => {
    if (state.role === 'host') {
      goToScreen('design');
    } else {
      const code = $('join-code-input').value.trim().toUpperCase();
      if (!code) {
        $('join-code-input').focus();
        return;
      }
      state.roomCode = code;
      goToScreen('lobby');
      startGuestConnection();
    }
  });

  /* ============ DESIGN SCREEN (host only) ============ */
  $('design-back-btn').addEventListener('click', () => goToScreen('home'));

  document.querySelectorAll('.shape-card').forEach((card) => {
    card.addEventListener('click', () => {
      state.shape = card.dataset.shape;
      document.querySelectorAll('.shape-card').forEach((c) => c.classList.remove('selected'));
      card.classList.add('selected');
      $('split-row').style.display = state.shape === 'heart' ? '' : 'none';
    });
  });

  document.querySelectorAll('.color-swatch').forEach((sw) => {
    sw.addEventListener('click', () => {
      state.accent = sw.dataset.color;
      document.querySelectorAll('.color-swatch').forEach((s) => s.classList.remove('selected'));
      sw.classList.add('selected');
    });
  });

  document.querySelectorAll('.split-opt').forEach((opt) => {
    opt.addEventListener('click', () => {
      state.split = opt.dataset.split;
      document.querySelectorAll('.split-opt').forEach((o) => o.classList.remove('selected'));
      opt.classList.add('selected');
    });
  });

  $('design-continue-btn').addEventListener('click', () => {
    state.roomCode = generateRoomCode();
    goToScreen('lobby');
    $('host-code-card').hidden = false;
    $('join-status-card').hidden = true;
    $('room-code-display').textContent = state.roomCode;
    startHostConnection();
  });

  /* ============ ICE CONFIG ============ */
  async function getIceServers() {
    try {
      const res = await fetch('/ice-config');
      const data = await res.json();
      return data.iceServers;
    } catch (e) {
      return [{ urls: 'stun:stun.l.google.com:19302' }];
    }
  }

  function peerJsOptions(iceServers) {
    const secure = location.protocol === 'https:';
    return {
      host: location.hostname,
      port: location.port ? Number(location.port) : (secure ? 443 : 80),
      path: '/peerjs',
      secure,
      config: { iceServers }
    };
  }

  /* ============ CAMERA ============ */
  async function openCamera() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
      state.localStream = stream;
      $('local-video').srcObject = stream;
      $('local-video-2').srcObject = stream;
      $('camera-error').classList.remove('show');
      return stream;
    } catch (e) {
      $('camera-error').classList.add('show');
      throw e;
    }
  }

  function attachRemoteStream(stream) {
    state.remoteStream = stream;
    $('remote-video').srcObject = stream;
    $('remote-video-2').srcObject = stream;
    $('remote-video-tag').textContent = 'Them';
    $('lobby-waiting').style.display = 'none';
    state.peerConnected = true;
    $('ready-row').hidden = false;
    setStatus('connected', 'Connected');
  }

  function handlePartnerLeft() {
    state.peerConnected = false;
    state.peerReady = false;
    state.remoteStream = null;
    $('remote-video').srcObject = null;
    $('remote-video-2').srcObject = null;
    $('remote-video-tag').textContent = 'Waiting…';
    $('lobby-waiting').style.display = 'flex';
    $('ready-row').hidden = true;
    setStatus('', 'Partner disconnected');
    if (screens.capture.classList.contains('active') || screens.result.classList.contains('active')) {
      goToScreen('lobby');
    }
  }

  /* ============ HOST CONNECTION ============ */
  async function startHostConnection(attempt = 0) {
    setStatus('connecting', 'Waiting for them to join…');
    await openCamera().catch(() => {});
    const iceServers = await getIceServers();
    const peer = new Peer(state.roomCode, peerJsOptions(iceServers));
    state.peer = peer;

    peer.on('open', () => {
      console.log('[host] room open:', state.roomCode);
    });

    peer.on('call', (call) => {
      call.answer(state.localStream);
      call.on('stream', (remoteStream) => attachRemoteStream(remoteStream));
      call.on('close', handlePartnerLeft);
    });

    peer.on('connection', (conn) => {
      state.dataConn = conn;
      conn.on('open', () => {
        conn.send({ type: 'config', shape: state.shape, accent: state.accent, split: state.split });
      });
      conn.on('data', handleData);
      conn.on('close', handlePartnerLeft);
    });

    peer.on('error', (err) => {
      if (err.type === 'unavailable-id' && attempt < 5) {
        // Someone already owns this code — mint a new one and retry.
        state.roomCode = generateRoomCode();
        $('room-code-display').textContent = state.roomCode;
        peer.destroy();
        startHostConnection(attempt + 1);
      } else {
        console.error('[host] peer error', err);
        setStatus('', 'Connection error — try reloading');
      }
    });
  }

  /* ============ GUEST CONNECTION ============ */
  async function startGuestConnection() {
    $('host-code-card').hidden = true;
    $('join-status-card').hidden = false;
    $('joining-code-display').textContent = state.roomCode;
    setStatus('connecting', 'Connecting…');

    await openCamera().catch(() => {});
    const iceServers = await getIceServers();
    const peer = new Peer(undefined, peerJsOptions(iceServers));
    state.peer = peer;

    peer.on('open', () => {
      const call = peer.call(state.roomCode, state.localStream);
      call.on('stream', (remoteStream) => attachRemoteStream(remoteStream));
      call.on('close', handlePartnerLeft);

      const conn = peer.connect(state.roomCode);
      state.dataConn = conn;
      conn.on('data', handleData);
      conn.on('close', handlePartnerLeft);
    });

    peer.on('error', (err) => {
      if (err.type === 'peer-unavailable') {
        setStatus('', 'Room not found — check the code');
      } else {
        console.error('[guest] peer error', err);
        setStatus('', 'Connection error — try reloading');
      }
    });
  }

  /* ============ DATA CHANNEL MESSAGES ============ */
  function sendData(msg) {
    if (state.dataConn && state.dataConn.open) state.dataConn.send(msg);
  }

  function handleData(msg) {
    if (!msg || !msg.type) return;
    switch (msg.type) {
      case 'config':
        // Guest mirrors the host's chosen frame so both sides agree.
        state.shape = msg.shape;
        state.accent = msg.accent;
        state.split = msg.split;
        break;
      case 'ready':
        state.peerReady = !!msg.value;
        updateReadyHint();
        if (state.role === 'host') maybeStartCountdown();
        break;
      case 'countdown':
        runCountdownStep(msg.value, false);
        break;
      default:
        break;
    }
  }

  /* ============ READY / COUNTDOWN SYNC ============ */
  $('ready-btn').addEventListener('click', () => {
    state.myReady = true;
    $('ready-btn').disabled = true;
    $('ready-btn').textContent = 'Waiting for them…';
    sendData({ type: 'ready', value: true });
    updateReadyHint();
    if (state.role === 'host') maybeStartCountdown();
  });

  function updateReadyHint() {
    if (state.myReady && state.peerReady) {
      $('ready-hint').textContent = "Get close together — here we go!";
    } else if (state.myReady) {
      $('ready-hint').textContent = 'Waiting for them to hit ready too…';
    } else {
      $('ready-hint').textContent = 'Waiting for both of you to be ready…';
    }
  }

  let countdownRunning = false;
  function maybeStartCountdown() {
    // Only the host ever drives the countdown, so both sides never race
    // to lead it at the same time.
    if (countdownRunning) return;
    if (!(state.myReady && state.peerReady)) return;
    countdownRunning = true;
    const seq = ['3', '2', '1', 'capture'];
    let i = 0;
    (function tick() {
      const value = seq[i];
      sendData({ type: 'countdown', value });
      runCountdownStep(value, true);
      i++;
      if (i < seq.length) setTimeout(tick, 700);
    })();
  }

  function runCountdownStep(value, isSelf) {
    if (!screens.capture.classList.contains('active')) goToScreen('capture');
    const overlay = $('countdown-overlay');
    if (value === 'capture') {
      overlay.classList.remove('show');
      const flash = $('flash');
      flash.classList.remove('go');
      void flash.offsetWidth;
      flash.classList.add('go');
      captureBoth();
      countdownRunning = false;
      return;
    }
    overlay.textContent = value;
    overlay.classList.remove('show');
    void overlay.offsetWidth;
    overlay.classList.add('show');
  }

  /* ============ CAPTURE + CANVAS COMPOSITION ============ */
  function squareCropFromVideo(videoEl, size) {
    const c = document.createElement('canvas');
    c.width = size; c.height = size;
    const ctx = c.getContext('2d');
    const vw = videoEl.videoWidth || size, vh = videoEl.videoHeight || size;
    const side = Math.min(vw, vh);
    const sx = (vw - side) / 2, sy = (vh - side) / 2;
    // No mirroring here: both peers must draw each person in the same
    // "true" orientation, or the two independently-rendered keepsakes
    // would not match.
    ctx.drawImage(videoEl, sx, sy, side, side, 0, 0, size, size);
    return c;
  }

  function captureBoth() {
    const PHOTO_SIZE = 640;
    const localShot = squareCropFromVideo($('local-video-2'), PHOTO_SIZE);
    const remoteShot = state.remoteStream
      ? squareCropFromVideo($('remote-video-2'), PHOTO_SIZE)
      : localShot; // fallback so a solo test run doesn't crash

    // Host is always slot A (left/top), guest is always slot B — fixed by
    // role, so both people's renders place each other identically.
    const slotA = state.role === 'host' ? localShot : remoteShot;
    const slotB = state.role === 'host' ? remoteShot : localShot;

    renderResult(slotA, slotB);
    setTimeout(() => goToScreen('result'), 550);
  }

  function roundRectPath(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // A fixed, hand-tuned heart path (normalized to a 0..1 box), reused every
  // render so host and guest always draw the identical shape.
  function heartPath(ctx, x, y, w, h) {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(w / 100, h / 100);
    ctx.beginPath();
    ctx.moveTo(50, 88);
    ctx.bezierCurveTo(50, 88, 6, 58, 6, 30);
    ctx.bezierCurveTo(6, 10, 22, 2, 36, 2);
    ctx.bezierCurveTo(44, 2, 50, 8, 50, 16);
    ctx.bezierCurveTo(50, 8, 56, 2, 64, 2);
    ctx.bezierCurveTo(78, 2, 94, 10, 94, 30);
    ctx.bezierCurveTo(94, 58, 50, 88, 50, 88);
    ctx.closePath();
    ctx.restore();
  }

  function drawTapePiece(ctx, cx, cy, w, h, rotDeg, hex) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate((rotDeg * Math.PI) / 180);
    ctx.globalAlpha = 0.82;
    ctx.fillStyle = hex;
    ctx.fillRect(-w / 2, -h / 2, w, h);
    ctx.globalAlpha = 0.14;
    ctx.fillStyle = '#FFFFFF';
    for (let i = -w / 2; i < w / 2; i += 7) {
      ctx.fillRect(i, -h / 2, 2, h);
    }
    ctx.restore();
  }

  function drawScriptCaption(ctx, cx, y, accentHex) {
    const captionText = (state.caption && state.caption.trim()) ? state.caption.trim() : 'us, together';
    ctx.save();
    ctx.fillStyle = '#1A1310';
    ctx.font = "400 44px 'Beau Rivage', cursive";
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(captionText, cx, y);
    ctx.restore();

    if (state.showDate) {
      ctx.save();
      ctx.fillStyle = accentHex;
      ctx.font = "700 15px 'Nunito Sans', sans-serif";
      ctx.textAlign = 'center';
      ctx.letterSpacing = '0.06em';
      const today = new Date();
      const dateStr = today.toLocaleDateString('en-US', { day: '2-digit', month: '2-digit', year: '2-digit' });
      ctx.fillText(dateStr, cx, y + 30);
      ctx.restore();
    }
  }

  function drawCaptionBar(ctx, x, y, w, h, accentHex) {
    ctx.save();
    ctx.fillStyle = accentHex;
    ctx.beginPath();
    ctx.arc(x + 26, y + h / 2, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.fillStyle = '#1A1310';
    ctx.font = "600 26px 'Poppins', sans-serif";
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    const captionText = (state.caption && state.caption.trim()) ? state.caption.trim() : 'us, together';
    ctx.fillText(captionText, x + 46, y + h * 0.42, w - 90);
    ctx.restore();

    if (state.showDate) {
      ctx.save();
      ctx.fillStyle = 'rgba(26,19,16,0.55)';
      ctx.font = "500 15px 'Nunito Sans', sans-serif";
      ctx.textAlign = 'left';
      const today = new Date();
      const dateStr = today.toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric' });
      ctx.fillText(dateStr, x + 46, y + h * 0.72);
      ctx.restore();
    }
  }

  // A little 5-point star, used as a cute sticker accent on the scrapbook frame.
  function drawStar(ctx, cx, cy, r, hex, rotDeg) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate((rotDeg * Math.PI) / 180);
    ctx.beginPath();
    for (let i = 0; i < 5; i++) {
      const outer = (i * 2 * Math.PI) / 5 - Math.PI / 2;
      const inner = outer + Math.PI / 5;
      const ox = Math.cos(outer) * r, oy = Math.sin(outer) * r;
      const ix = Math.cos(inner) * r * 0.42, iy = Math.sin(inner) * r * 0.42;
      if (i === 0) ctx.moveTo(ox, oy); else ctx.lineTo(ox, oy);
      ctx.lineTo(ix, iy);
    }
    ctx.closePath();
    ctx.fillStyle = hex;
    ctx.fill();
    ctx.restore();
  }

  /* ---------- 1. WASHI STRIP ----------
     A tall photo-booth strip: two frames stacked full-bleed inside a white
     card, a torn piece of washi tape at the top, and a flowing script
     caption underneath — the "dinner party" strip look. */
  function renderWashiStrip(ctx, W, H, photoA, photoB, accentHex) {
    const margin = 24;
    const photoW = W - margin * 2;
    const gap = 10;
    const photoH = (H - margin * 2 - gap * 3 - 118) / 2;

    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.18)';
    ctx.shadowBlur = 2;
    roundRectPath(ctx, 0, 0, W, H, 4);
    ctx.fillStyle = '#FFFFFF';
    ctx.fill();
    ctx.restore();

    [photoA, photoB].forEach((photo, i) => {
      const y = margin + i * (photoH + gap);
      ctx.save();
      ctx.beginPath();
      ctx.rect(margin, y, photoW, photoH);
      ctx.clip();
      const side = Math.min(photo.width, photo.height);
      const sx = (photo.width - side) / 2, sy = (photo.height - side) / 2;
      const scale = Math.max(photoW / side, photoH / side);
      const dw = side * scale, dh = side * scale;
      ctx.drawImage(photo, sx, sy, side, side, margin + (photoW - dw) / 2, y + (photoH - dh) / 2, dw, dh);
      ctx.restore();
    });

    // torn washi tape across the top edge
    drawTapePiece(ctx, W / 2, margin - 2, 150, 34, -3, accentHex);

    drawScriptCaption(ctx, W / 2, H - 62, accentHex);
  }

  /* ---------- 2. FILMSTRIP ----------
     Black film-reel bands with sprocket holes running along the top and
     bottom, two frames side by side in the middle, and a circled "TEXT"
     style stamped caption — the retro filmstrip collage look. */
  function drawSprocketBand(ctx, x, y, w, h) {
    ctx.save();
    ctx.fillStyle = '#171310';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = '#FFFBF2';
    const holeW = 15, holeH = h * 0.5, gap = 26;
    let hx = x + 14;
    while (hx < x + w - 8) {
      roundRectPath(ctx, hx, y + (h - holeH) / 2, holeW, holeH, 3);
      ctx.fill();
      hx += holeW + gap;
    }
    ctx.restore();
  }

  function renderFilmstrip(ctx, W, H, photoA, photoB, accentHex) {
    const bandH = 30;
    const margin = 0;
    const photoAreaY = bandH;
    const photoAreaH = H - bandH * 2 - 110;
    const gap = 6;
    const photoW = (W - gap) / 2;

    ctx.save();
    roundRectPath(ctx, 0, 0, W, H, 10);
    ctx.fillStyle = '#EFE7D8';
    ctx.fill();
    ctx.restore();

    [photoA, photoB].forEach((photo, i) => {
      const x = i * (photoW + gap);
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, photoAreaY, photoW, photoAreaH);
      ctx.clip();
      ctx.filter = 'grayscale(0.35) contrast(1.05)';
      const side = Math.min(photo.width, photo.height);
      const sx = (photo.width - side) / 2, sy = (photo.height - side) / 2;
      const scale = Math.max(photoW / side, photoAreaH / side);
      const dw = side * scale, dh = side * scale;
      ctx.drawImage(photo, sx, sy, side, side, x + (photoW - dw) / 2, photoAreaY + (photoAreaH - dh) / 2, dw, dh);
      ctx.filter = 'none';
      ctx.restore();
    });

    // center seam
    ctx.save();
    ctx.strokeStyle = 'rgba(23,19,16,0.5)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(photoW + gap / 2, photoAreaY);
    ctx.lineTo(photoW + gap / 2, photoAreaY + photoAreaH);
    ctx.stroke();
    ctx.restore();

    drawSprocketBand(ctx, 0, 0, W, bandH);
    drawSprocketBand(ctx, 0, photoAreaY + photoAreaH, W, bandH);

    // small stamped circle bullet + caption in a mono/stamp style, echoing
    // the "TEXT" motif, with the date stacked below so long captions fit
    const capY = photoAreaY + photoAreaH + bandH + 32;
    const captionText = (state.caption && state.caption.trim()) ? state.caption.trim() : 'us, together';
    ctx.save();
    ctx.strokeStyle = accentHex;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.ellipse(40, capY, 16, 16, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = accentHex;
    ctx.font = "700 14px 'Poppins', sans-serif";
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('♡', 40, capY + 1);
    ctx.restore();

    ctx.save();
    ctx.fillStyle = '#1A1310';
    ctx.font = "700 20px 'Poppins', sans-serif";
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(captionText, 66, capY + 1, W - 92);
    ctx.restore();

    if (state.showDate) {
      ctx.save();
      ctx.fillStyle = 'rgba(26,19,16,0.55)';
      ctx.font = "600 13px 'Nunito Sans', sans-serif";
      ctx.textAlign = 'left';
      const dateStr = new Date().toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric' });
      ctx.fillText(dateStr, 66, capY + 26);
      ctx.restore();
    }
  }

  /* ---------- 3. SCRAPBOOK POP ----------
     Two slightly-tilted white-bordered polaroid snapshots overlapping on a
     soft tinted card, with a star sticker and a scalloped-edge caption
     patch — the cute mixed-media collage look. */
  function drawTiltedPolaroid(ctx, cx, cy, size, rotDeg, photo, borderW) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate((rotDeg * Math.PI) / 180);
    ctx.shadowColor = 'rgba(26,19,16,0.28)';
    ctx.shadowBlur = 14;
    ctx.shadowOffsetY = 6;
    ctx.fillStyle = '#FFFFFF';
    const total = size + borderW * 2;
    roundRectPath(ctx, -total / 2, -total / 2 - borderW * 0.6, total, total + borderW * 1.2, 6);
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.beginPath();
    ctx.rect(-size / 2, -size / 2 - borderW * 0.6, size, size);
    ctx.clip();
    const side = Math.min(photo.width, photo.height);
    const sx = (photo.width - side) / 2, sy = (photo.height - side) / 2;
    ctx.drawImage(photo, sx, sy, side, side, -size / 2, -size / 2 - borderW * 0.6, size, size);
    ctx.restore();
  }

  function renderScrapbookPop(ctx, W, H, photoA, photoB, accentHex) {
    roundRectPath(ctx, 0, 0, W, H, 26);
    ctx.fillStyle = '#FBF3DE';
    ctx.fill();

    // faint gingham-style grid, echoing the blue-check moodboard backdrop
    ctx.save();
    ctx.strokeStyle = 'rgba(26,19,16,0.05)';
    ctx.lineWidth = 1;
    for (let gx = 0; gx <= W; gx += 26) { ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, H); ctx.stroke(); }
    for (let gy = 0; gy <= H; gy += 26) { ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(W, gy); ctx.stroke(); }
    ctx.restore();

    const size = W * 0.62;
    drawTiltedPolaroid(ctx, W * 0.40, H * 0.36, size, -6, photoA, 14);
    drawTiltedPolaroid(ctx, W * 0.62, H * 0.58, size, 5, photoB, 14);

    drawStar(ctx, W * 0.86, H * 0.16, 15, accentHex, -10);
    drawStar(ctx, W * 0.13, H * 0.82, 11, accentHex, 18);
    ctx.save();
    ctx.fillStyle = accentHex;
    ctx.font = "700 26px 'Poppins', sans-serif";
    ctx.textAlign = 'center';
    ctx.fillText('♡', W * 0.14, H * 0.14);
    ctx.restore();

    // scalloped caption patch near the bottom
    const patchY = H - 96, patchH = 76, patchW = W - 76;
    const patchX = (W - patchW) / 2;
    ctx.save();
    ctx.shadowColor = 'rgba(26,19,16,0.18)';
    ctx.shadowBlur = 10;
    ctx.shadowOffsetY = 4;
    ctx.beginPath();
    const scallopR = 9;
    const n = Math.round(patchW / (scallopR * 2));
    const step = patchW / n;
    ctx.moveTo(patchX, patchY);
    for (let i = 0; i < n; i++) ctx.arc(patchX + step * (i + 0.5), patchY, scallopR, Math.PI, 0, false);
    ctx.lineTo(patchX + patchW, patchY + patchH);
    for (let i = n; i > 0; i--) ctx.arc(patchX + step * (i - 0.5), patchY + patchH, scallopR, 0, Math.PI, false);
    ctx.lineTo(patchX, patchY);
    ctx.closePath();
    ctx.fillStyle = '#FFFBF2';
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.fillStyle = '#1A1310';
    ctx.font = "400 32px 'Beau Rivage', cursive";
    ctx.textAlign = 'center';
    const captionText = (state.caption && state.caption.trim()) ? state.caption.trim() : 'us, together';
    ctx.fillText(captionText, W / 2, patchY + patchH * 0.52);
    ctx.restore();
    if (state.showDate) {
      ctx.save();
      ctx.fillStyle = accentHex;
      ctx.font = "700 13px 'Nunito Sans', sans-serif";
      ctx.textAlign = 'center';
      const dateStr = new Date().toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric' });
      ctx.fillText(dateStr, W / 2, patchY + patchH * 0.82);
      ctx.restore();
    }
  }

  /* ---------- 4. HEART CUTOUT ----------
     The merged photo cropped into a heart shape with a dotted "stitched"
     outline and a little bow above it — cute rather than merely modern. */
  function renderHeartCutout(ctx, W, H, photoA, photoB, accentHex) {
    const margin = 22;
    const boxSize = W - margin * 2;
    const capGap = 18;
    const capBarH = 84;

    roundRectPath(ctx, 0, 0, W, H, 26);
    ctx.fillStyle = '#FFFBF2';
    ctx.fill();

    const combined = document.createElement('canvas');
    combined.width = boxSize; combined.height = boxSize;
    const cctx = combined.getContext('2d');
    if (state.split === 'top') {
      cctx.drawImage(photoA, 0, 0, photoA.width, photoA.height / 2, 0, 0, boxSize, boxSize / 2);
      cctx.drawImage(photoB, 0, photoB.height / 2, photoB.width, photoB.height / 2, 0, boxSize / 2, boxSize, boxSize / 2);
    } else {
      cctx.drawImage(photoA, 0, 0, photoA.width / 2, photoA.height, 0, 0, boxSize / 2, boxSize);
      cctx.drawImage(photoB, photoB.width / 2, 0, photoB.width / 2, photoB.height, boxSize / 2, 0, boxSize / 2, boxSize);
    }

    ctx.save();
    heartPath(ctx, margin, margin, boxSize, boxSize);
    ctx.clip();
    ctx.drawImage(combined, margin, margin, boxSize, boxSize);
    ctx.restore();

    ctx.save();
    heartPath(ctx, margin, margin, boxSize, boxSize);
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 6;
    ctx.stroke();
    ctx.restore();
    ctx.save();
    heartPath(ctx, margin, margin, boxSize, boxSize);
    ctx.strokeStyle = accentHex;
    ctx.lineWidth = 3;
    ctx.setLineDash([2, 8]);
    ctx.lineCap = 'round';
    ctx.stroke();
    ctx.restore();

    drawCaptionBar(ctx, margin, margin + boxSize + capGap, boxSize, capBarH, accentHex);
  }

  const FRAME_RENDERERS = {
    washi: { render: renderWashiStrip, height: (W) => Math.round(W * 1.62) },
    filmstrip: { render: renderFilmstrip, height: (W) => Math.round(W * 0.72) },
    scrapbook: { render: renderScrapbookPop, height: (W) => Math.round(W * 1.18) },
    heart: { render: renderHeartCutout, height: (W) => Math.round(W * 1.18) }
  };

  function renderResult(photoA, photoB) {
    state.lastPhotoA = photoA;
    state.lastPhotoB = photoB;
    const canvas = $('final-canvas');
    const accentHex = ACCENTS[state.accent] || ACCENTS.pink;

    const config = FRAME_RENDERERS[state.shape] || FRAME_RENDERERS.washi;
    const W = 620;
    const H = config.height(W);

    const p = document.createElement('canvas');
    p.width = W; p.height = H;
    const ctx = p.getContext('2d');
    config.render(ctx, W, H, photoA, photoB, accentHex);

    // soft shadow + tiny rotation, exported with transparent padding
    const pad = 50;
    canvas.width = W + pad * 2;
    canvas.height = H + pad * 2;
    const ectx = canvas.getContext('2d');
    ectx.clearRect(0, 0, canvas.width, canvas.height);
    ectx.save();
    ectx.translate(canvas.width / 2, canvas.height / 2);
    ectx.rotate((-1.6 * Math.PI) / 180);
    ectx.shadowColor = 'rgba(122,31,61,0.30)';
    ectx.shadowBlur = 24;
    ectx.shadowOffsetY = 12;
    ectx.drawImage(p, -W / 2, -H / 2);
    ectx.restore();
  }

  $('caption-input').addEventListener('input', (e) => {
    state.caption = e.target.value;
    if (state.lastPhotoA) renderResult(state.lastPhotoA, state.lastPhotoB);
  });
  $('date-toggle').addEventListener('change', (e) => {
    state.showDate = e.target.checked;
    if (state.lastPhotoA) renderResult(state.lastPhotoA, state.lastPhotoB);
  });

  $('download-btn').addEventListener('click', () => {
    const canvas = $('final-canvas');
    const link = document.createElement('a');
    link.download = 'polaroid-love.png';
    link.href = canvas.toDataURL('image/png');
    link.click();
  });

  /* ============ COPY CODE / LINK ============ */
  $('copy-code-btn').addEventListener('click', () => {
    navigator.clipboard.writeText(state.roomCode).catch(() => {});
    flashChipLabel('copy-code-btn', 'Copied!');
  });
  $('copy-link-btn').addEventListener('click', () => {
    const link = `${location.origin}${location.pathname}?room=${encodeURIComponent(state.roomCode)}`;
    navigator.clipboard.writeText(link).catch(() => {});
    flashChipLabel('copy-link-btn', 'Link copied!');
  });
  function flashChipLabel(id, text) {
    const el = $(id);
    const original = el.textContent;
    el.textContent = text;
    setTimeout(() => { el.textContent = original; }, 1400);
  }

  /* ============ LEAVE / RESET ============ */
  function teardownConnection() {
    if (state.dataConn) { try { state.dataConn.close(); } catch (e) {} }
    if (state.peer) { try { state.peer.destroy(); } catch (e) {} }
    if (state.localStream) { state.localStream.getTracks().forEach((t) => t.stop()); }
    state.peer = null;
    state.dataConn = null;
    state.localStream = null;
    state.remoteStream = null;
    state.myReady = false;
    state.peerReady = false;
    state.peerConnected = false;
    countdownRunning = false;
    $('ready-btn').disabled = false;
    $('ready-btn').textContent = "I'm ready 📸";
    $('topbar-status').hidden = true;
  }

  $('lobby-leave-btn').addEventListener('click', () => {
    teardownConnection();
    goToScreen('home');
  });
  $('new-session-btn').addEventListener('click', () => {
    teardownConnection();
    goToScreen('home');
  });

  window.addEventListener('beforeunload', teardownConnection);
})();

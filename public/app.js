// public/app.js
// Together Booth — client logic.
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
    shape: 'classic',        // 'classic' | 'duo' | 'bloom'
    accent: 'pink',          // 'pink' | 'sky' | 'leaf'
    split: 'side',           // 'side' | 'top'  (ignored for 'duo')
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
      $('split-row').style.display = state.shape === 'duo' ? 'none' : '';
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

  // A fixed, hand-tuned organic blob path (normalized to a 0..1 box),
  // reused every render so host and guest always draw the identical shape.
  const BLOB_POINTS = [
    [0.50, 0.02], [0.78, 0.08], [0.95, 0.32], [0.94, 0.60],
    [0.80, 0.85], [0.52, 0.97], [0.22, 0.90], [0.05, 0.66],
    [0.06, 0.36], [0.24, 0.10]
  ];
  function blobPath(ctx, x, y, w, h) {
    const pts = BLOB_POINTS.map(([px, py]) => [x + px * w, y + py * h]);
    ctx.beginPath();
    ctx.moveTo((pts[0][0] + pts[pts.length - 1][0]) / 2, (pts[0][1] + pts[pts.length - 1][1]) / 2);
    for (let i = 0; i < pts.length; i++) {
      const cur = pts[i];
      const next = pts[(i + 1) % pts.length];
      const midX = (cur[0] + next[0]) / 2;
      const midY = (cur[1] + next[1]) / 2;
      ctx.quadraticCurveTo(cur[0], cur[1], midX, midY);
    }
    ctx.closePath();
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
      const dateStr = today.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
      ctx.fillText(dateStr, x + 46, y + h * 0.72);
      ctx.restore();
    }
  }

  function composeSplitSquare(photoA, photoB, size, split) {
    const c = document.createElement('canvas');
    c.width = size; c.height = size;
    const ctx = c.getContext('2d');
    if (split === 'side') {
      ctx.drawImage(photoA, 0, 0, size / 2, size, 0, 0, size / 2, size);
      ctx.drawImage(photoB, size / 2, 0, size / 2, size, size / 2, 0, size / 2, size);
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 4;
      ctx.setLineDash([12, 10]);
      ctx.beginPath(); ctx.moveTo(size / 2, 0); ctx.lineTo(size / 2, size); ctx.stroke();
      ctx.restore();
    } else {
      ctx.drawImage(photoA, 0, 0, size, size / 2, 0, 0, size, size / 2);
      ctx.drawImage(photoB, 0, size / 2, size, size / 2, 0, size / 2, size, size);
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 4;
      ctx.setLineDash([12, 10]);
      ctx.beginPath(); ctx.moveTo(0, size / 2); ctx.lineTo(size, size / 2); ctx.stroke();
      ctx.restore();
    }
    return c;
  }

  function renderClassicModern(ctx, W, H, photoA, photoB, accentHex) {
    const margin = 26;
    const photoSize = W - margin * 2;
    const capGap = 14;
    const capBarH = 66;

    roundRectPath(ctx, 0, 0, W, H, 26);
    ctx.fillStyle = '#FFFBF2';
    ctx.fill();

    const combined = composeSplitSquare(photoA, photoB, photoSize, state.split);
    roundRectPath(ctx, margin, margin, photoSize, photoSize, 16);
    ctx.save();
    ctx.clip();
    ctx.drawImage(combined, margin, margin);
    ctx.restore();

    // thin double ring
    roundRectPath(ctx, margin, margin, photoSize, photoSize, 16);
    ctx.save();
    ctx.strokeStyle = accentHex;
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.restore();
    roundRectPath(ctx, margin + 6, margin + 6, photoSize - 12, photoSize - 12, 12);
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();

    drawCaptionBar(ctx, margin, margin + photoSize + capGap, photoSize, capBarH, accentHex);
  }

  function renderBloomCutout(ctx, W, H, photoA, photoB, accentHex) {
    const margin = 22;
    const blobBoxSize = W - margin * 2;
    const capGap = 14;
    const capBarH = 66;

    roundRectPath(ctx, 0, 0, W, H, 26);
    ctx.fillStyle = '#FFFBF2';
    ctx.fill();

    const combined = composeSplitSquare(photoA, photoB, blobBoxSize, state.split);
    ctx.save();
    blobPath(ctx, margin, margin, blobBoxSize, blobBoxSize);
    ctx.clip();
    ctx.drawImage(combined, margin, margin, blobBoxSize, blobBoxSize);
    ctx.restore();

    ctx.save();
    blobPath(ctx, margin, margin, blobBoxSize, blobBoxSize);
    ctx.strokeStyle = accentHex;
    ctx.lineWidth = 4;
    ctx.stroke();
    ctx.restore();

    drawCaptionBar(ctx, margin, margin + blobBoxSize + capGap, blobBoxSize, capBarH, accentHex);
  }

  // Stacked vertically, like a real two-frame photobooth strip — this is
  // also what keeps its width identical to the other two card styles,
  // rather than an oddly squat side-by-side layout.
  function renderStudioDuo(ctx, W, H, photoA, photoB, accentHex) {
    const margin = 26;
    const gap = 16;
    const capGap = 14;
    const capBarH = 66;
    const frameSize = W - margin * 2;

    roundRectPath(ctx, 0, 0, W, H, 26);
    ctx.fillStyle = '#FFFBF2';
    ctx.fill();

    [photoA, photoB].forEach((photo, i) => {
      const y = margin + i * (frameSize + gap);
      roundRectPath(ctx, margin, y, frameSize, frameSize, 16);
      ctx.save();
      ctx.clip();
      ctx.drawImage(photo, 0, 0, photo.width, photo.height, margin, y, frameSize, frameSize);
      ctx.restore();
      roundRectPath(ctx, margin, y, frameSize, frameSize, 16);
      ctx.save();
      ctx.strokeStyle = accentHex;
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.restore();
    });

    // perforated seam between the two frames, like a tear-off photo strip
    ctx.save();
    ctx.strokeStyle = 'rgba(26,19,16,0.25)';
    ctx.lineWidth = 2;
    ctx.setLineDash([3, 6]);
    ctx.beginPath();
    const seamY = margin + frameSize + gap / 2;
    ctx.moveTo(margin + 10, seamY);
    ctx.lineTo(margin + frameSize - 10, seamY);
    ctx.stroke();
    ctx.restore();

    const capY = margin + frameSize * 2 + gap + capGap;
    drawCaptionBar(ctx, margin, capY, frameSize, capBarH, accentHex);
  }

  function renderResult(photoA, photoB) {
    state.lastPhotoA = photoA;
    state.lastPhotoB = photoB;
    const canvas = $('final-canvas');
    const accentHex = ACCENTS[state.accent] || ACCENTS.pink;

    // Each frame shape gets its own canvas size — the duo strip is
    // naturally taller since it stacks two full square frames.
    let W, H;
    if (state.shape === 'duo') {
      W = 620; H = 26 + (620 - 52) * 2 + 16 + 14 + 66 + 26;
    } else {
      W = 620; H = 700;
    }

    const p = document.createElement('canvas');
    p.width = W; p.height = H;
    const ctx = p.getContext('2d');

    if (state.shape === 'duo') {
      renderStudioDuo(ctx, W, H, photoA, photoB, accentHex);
    } else if (state.shape === 'bloom') {
      renderBloomCutout(ctx, W, H, photoA, photoB, accentHex);
    } else {
      renderClassicModern(ctx, W, H, photoA, photoB, accentHex);
    }

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
    link.download = 'together-polaroid.png';
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

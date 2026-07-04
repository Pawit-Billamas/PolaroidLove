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
    mode: 'together',        // 'together' | 'solo'
    role: 'host',            // 'host' | 'guest'
    roomCode: null,
    shape: 'washi',          // 'washi' | 'filmstrip' | 'scrapbook' | 'heart'
    accent: 'pink',          // 'pink' | 'sky' | 'leaf'
    split: 'side',           // 'side' | 'top'  (only meaningful for 'heart')
    grid: 'strip2',          // key into GRID_LAYOUTS
    filter: 'none',          // key into FILTER_PRESETS
    peer: null,
    dataConn: null,
    localStream: null,
    remoteStream: null,
    myReady: false,
    peerReady: false,
    peerConnected: false,
    caption: '',
    showDate: true,

    // multi-shot capture runtime state
    shotIndex: 0,
    myShots: [],
    peerShots: [],
    lastPhotos: null,        // array of N HTMLCanvasElements, slot-ordered

    // sticker decoration (result screen only)
    stickers: []
  };

  const isSolo = () => state.mode === 'solo';

  const ACCENTS = {
    pink: '#B23A5A',
    sky: '#2E93AD',
    leaf: '#3F8A2E'
  };

  const FILTER_PRESETS = {
    none:    { label: 'None',    css: 'none' },
    vintage: { label: 'Vintage', css: 'sepia(0.35) saturate(1.15) contrast(1.05) brightness(1.02)' },
    bw:      { label: 'B & W',   css: 'grayscale(1) contrast(1.08)' },
    warm:    { label: 'Warm',    css: 'sepia(0.18) saturate(1.3) hue-rotate(-6deg) brightness(1.03)' },
    cool:    { label: 'Cool',    css: 'saturate(1.1) hue-rotate(10deg) brightness(1.02) contrast(1.02)' }
  };

  function build3x3Cells() {
    const cells = [];
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) cells.push({ x: c / 3, y: r / 3, w: 1 / 3, h: 1 / 3 });
    }
    return cells;
  }

  const GRID_LAYOUTS = {
    solo1:  { label: '1 photo',  count: 1, aspect: 1,    cells: [{ x: 0, y: 0, w: 1, h: 1 }] },
    strip2: { label: '2 photos', count: 2, aspect: 0.62, cells: [
      { x: 0, y: 0,   w: 1, h: 0.5 },
      { x: 0, y: 0.5, w: 1, h: 0.5 }
    ]},
    side2:  { label: '2 photos, side by side', count: 2, aspect: 1.5, cells: [
      { x: 0,   y: 0, w: 0.5, h: 1 },
      { x: 0.5, y: 0, w: 0.5, h: 1 }
    ]},
    strip3: { label: '3 photos', count: 3, aspect: 0.42, cells: [
      { x: 0, y: 0,     w: 1, h: 1 / 3 },
      { x: 0, y: 1 / 3, w: 1, h: 1 / 3 },
      { x: 0, y: 2 / 3, w: 1, h: 1 / 3 }
    ]},
    strip4: { label: '4 photos', count: 4, aspect: 0.32, cells: [
      { x: 0, y: 0,    w: 1, h: 0.25 },
      { x: 0, y: 0.25, w: 1, h: 0.25 },
      { x: 0, y: 0.5,  w: 1, h: 0.25 },
      { x: 0, y: 0.75, w: 1, h: 0.25 }
    ]},
    grid9:  { label: '9 photos', count: 9, aspect: 1, cells: build3x3Cells() }
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
  $('mode-solo').addEventListener('click', () => setMode('solo'));
  function setMode(mode) {
    state.mode = mode === 'solo' ? 'solo' : 'together';
    if (mode !== 'solo') state.role = mode;
    $('mode-host').classList.toggle('selected', mode === 'host');
    $('mode-guest').classList.toggle('selected', mode === 'guest');
    $('mode-solo').classList.toggle('selected', mode === 'solo');
    $('guest-code-row').hidden = mode !== 'guest';
  }

  // Prefill a join code from a shared link, e.g. ?room=TULIP-84
  const urlRoom = new URLSearchParams(location.search).get('room');
  if (urlRoom) {
    setMode('guest');
    $('join-code-input').value = urlRoom.toUpperCase();
  }

  $('continue-btn').addEventListener('click', () => {
    if (isSolo() || state.role === 'host') {
      $('design-continue-btn').textContent = isSolo() ? 'Start' : 'Create my room';
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

  /* ============ DESIGN SCREEN (host/solo only) ============ */
  $('design-back-btn').addEventListener('click', () => goToScreen('home'));

  function refreshShapeAvailability() {
    document.querySelectorAll('.shape-card').forEach((card) => {
      const shape = card.dataset.shape;
      const allow = FRAME_RENDERERS[shape].grids;
      const ok = allow === 'any' || allow.includes(state.grid);
      card.classList.toggle('unavailable', !ok);
      card.disabled = !ok;
    });
    if (FRAME_RENDERERS[state.shape].grids !== 'any' &&
        !FRAME_RENDERERS[state.shape].grids.includes(state.grid)) {
      state.shape = 'washi';
      document.querySelectorAll('.shape-card').forEach((c) => c.classList.remove('selected'));
      document.querySelector('.shape-card[data-shape="washi"]').classList.add('selected');
      $('split-row').style.display = 'none';
    }
  }

  document.querySelectorAll('.grid-card').forEach((card) => {
    card.addEventListener('click', () => {
      state.grid = card.dataset.grid;
      document.querySelectorAll('.grid-card').forEach((c) => c.classList.remove('selected'));
      card.classList.add('selected');
      refreshShapeAvailability();
    });
  });

  document.querySelectorAll('.shape-card').forEach((card) => {
    card.addEventListener('click', () => {
      if (card.disabled) return;
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
    if (isSolo()) {
      goToScreen('lobby');
      startSoloSession();
    } else {
      state.roomCode = generateRoomCode();
      goToScreen('lobby');
      $('host-code-card').hidden = false;
      $('join-status-card').hidden = true;
      $('room-code-display').textContent = state.roomCode;
      startHostConnection();
    }
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
    shotRunToken++; // abort any in-flight capture run's scheduled callbacks
    countdownRunning = false;
    if (screens.capture.classList.contains('active') || screens.result.classList.contains('active')) {
      goToScreen('lobby');
    }
  }

  /* ============ HOST CONNECTION ============ */
  async function startHostConnection(attempt = 0) {
    // Hard guard: solo mode must never open a room / PeerJS connection,
    // no matter how this is reached. Belt-and-suspenders against any
    // future code path accidentally calling this while in solo mode.
    if (isSolo()) { startSoloSession(); return; }
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
        conn.send({ type: 'config', shape: state.shape, accent: state.accent, split: state.split, grid: state.grid });
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
    if (isSolo()) { startSoloSession(); return; }
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

  /* ============ SOLO SESSION (no PeerJS, no room code) ============ */
  async function startSoloSession() {
    $('lobby-title').textContent = 'Get ready';
    $('host-code-card').hidden = true;
    $('join-status-card').hidden = true;
    $('remote-video-box').hidden = true;
    $('topbar-status').hidden = true;
    await openCamera().catch(() => {});
    $('ready-row').hidden = false;
    $('ready-hint').textContent = "Whenever you're ready…";
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
        state.grid = msg.grid || state.grid;
        break;
      case 'filter':
        // Either side can change the filter after capture; keep both
        // people's result screens showing an identical final image.
        state.filter = msg.filter;
        document.querySelectorAll('.filter-pill').forEach((p) => p.classList.toggle('selected', p.dataset.filter === state.filter));
        if (state.lastPhotos) renderResult(state.lastPhotos);
        break;
      case 'ready':
        state.peerReady = !!msg.value;
        updateReadyHint();
        if (state.role === 'host') maybeStartShot();
        break;
      case 'takeshot':
        runOneShot(msg);
        break;
      default:
        break;
    }
  }

  /* ============ READY / PER-SHOT SYNC ============ */
  // Every shot — the first and every subsequent one in a multi-photo grid —
  // requires a fresh "ready" from both sides (or from the solo photographer)
  // before its own countdown starts. Nobody is auto-advanced through a
  // burst; each shot is its own deliberate beat.
  function clickReady() {
    state.myReady = true;
    setReadyButtonsDisabled(true);
    setReadyButtonsLabel(isSolo() ? 'Starting…' : 'Waiting for them…');
    if (isSolo()) {
      runOneShot({ countdownMs: 700, t0: performance.now() });
    } else {
      sendData({ type: 'ready', value: true });
      updateReadyHint();
      if (state.role === 'host') maybeStartShot();
    }
  }
  $('ready-btn').addEventListener('click', clickReady);
  $('ready-btn-capture').addEventListener('click', clickReady);

  function setReadyButtonsDisabled(disabled) {
    $('ready-btn').disabled = disabled;
    $('ready-btn-capture').disabled = disabled;
  }
  function setReadyButtonsLabel(text) {
    $('ready-btn').textContent = text;
    $('ready-btn-capture').textContent = text;
  }

  function updateReadyHint() {
    const hint = state.myReady && state.peerReady
      ? 'Get close together — here we go!'
      : state.myReady
        ? 'Waiting for them to hit ready too…'
        : 'Waiting for both of you to be ready…';
    $('ready-hint').textContent = hint;
    $('ready-hint-capture').textContent = hint;
  }

  let countdownRunning = false;
  function maybeStartShot() {
    // Only the host ever drives a shot, so both sides never race to lead
    // the same countdown.
    if (countdownRunning) return;
    if (!(state.myReady && state.peerReady)) return;
    const plan = { type: 'takeshot', countdownMs: 700, t0: performance.now() };
    sendData(plan);
    runOneShot(plan);
  }

  // Shared entry point for BOTH together-mode (networked, one 'takeshot'
  // message drives both sides for this single shot) and solo-mode (built
  // locally, no network). Each side anchors timing to ITS OWN clock read
  // here rather than trying to translate the sender's t0 onto its own
  // clock — the guest's shot lands roughly one network-hop-latency later
  // than the host's, imperceptible for a couples photo, avoiding NTP-style
  // offset correlation entirely.
  // Bumped every time a run is aborted (partner disconnect) so any already-
  // scheduled setTimeout callbacks from a stale run can recognize they're
  // stale and no-op instead of forcing the screen forward after the fact.
  let shotRunToken = 0;

  function runOneShot(plan) {
    countdownRunning = true;
    const myToken = ++shotRunToken;
    if (!screens.capture.classList.contains('active')) goToScreen('capture');
    if (isSolo()) $('capture-stage').classList.add('solo'); else $('capture-stage').classList.remove('solo');
    updateShotProgress();

    const ticks = ['3', '2', '1'];
    ticks.forEach((label, i) => {
      setTimeout(() => { if (myToken === shotRunToken) showCountdownTick(label); }, i * plan.countdownMs);
    });

    const captureDelay = ticks.length * plan.countdownMs;
    setTimeout(() => {
      if (myToken !== shotRunToken) return;
      captureOneShot(state.shotIndex, GRID_LAYOUTS[state.grid].count);
      state.shotIndex++;
      state.myReady = false;
      state.peerReady = false;
      countdownRunning = false;

      const total = GRID_LAYOUTS[state.grid].count;
      setTimeout(() => {
        if (myToken !== shotRunToken) return;
        if (state.shotIndex >= total) {
          finalizeShots(total);
        } else {
          // More shots left in this grid — reset for the next ready beat
          // instead of auto-advancing.
          setReadyButtonsDisabled(false);
          setReadyButtonsLabel("I'm ready 📸");
          updateReadyHint();
          $('ready-row-capture').hidden = false;
          updateShotProgress();
        }
      }, 550);
    }, captureDelay);
  }

  function updateShotProgress() {
    const total = GRID_LAYOUTS[state.grid].count;
    const current = Math.min(state.shotIndex + 1, total);
    const el = $('shot-progress');
    if (total > 1) {
      el.hidden = false;
      el.textContent = `Photo ${current} of ${total}`;
    } else {
      el.hidden = true;
    }
  }

  function showCountdownTick(label) {
    const overlay = $('countdown-overlay');
    overlay.textContent = label;
    overlay.classList.remove('show');
    void overlay.offsetWidth;
    overlay.classList.add('show');
  }

  /* ============ CAPTURE + CANVAS COMPOSITION ============ */
  // Captures are always taken raw/unfiltered — the filter is a post-capture
  // choice applied at render time (see applyFilterToPhoto), so changing it
  // later can be redone non-destructively against the original shots.
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

  function captureOneShot(index, total) {
    if (index === 0) $('countdown-overlay').classList.remove('show');
    const flash = $('flash');
    flash.classList.remove('go');
    void flash.offsetWidth;
    flash.classList.add('go');

    const PHOTO_SIZE = 640;
    state.myShots[index] = squareCropFromVideo($('local-video-2'), PHOTO_SIZE);

    if (!isSolo()) {
      // Purely local — no pixel data ever crosses the wire, we just grab
      // the already-live remote <video> the same way we grab our own.
      state.peerShots[index] = state.remoteStream
        ? squareCropFromVideo($('remote-video-2'), PHOTO_SIZE)
        : state.myShots[index]; // fallback so a solo-ish test run doesn't crash
    }
  }

  function finalizeShots(total) {
    const gridDef = GRID_LAYOUTS[state.grid];
    let ordered;

    if (isSolo()) {
      ordered = state.myShots.slice(0, total);
    } else {
      // Host is always first-in-pair, guest second — generalized from the
      // old fixed 2-slot convention so both people appear equally often
      // and in temporal order across N shots.
      ordered = [];
      for (let i = 0; i < total; i++) {
        const mine = state.myShots[i];
        const theirs = state.peerShots[i];
        const pair = state.role === 'host' ? [mine, theirs] : [theirs, mine];
        ordered.push(pair[0], pair[1]);
      }
      ordered = ordered.slice(0, gridDef.count);
    }

    $('ready-row-capture').hidden = true;
    $('shot-progress').hidden = true;
    renderResult(ordered);
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

  // Shared helper: draw `photos` into the cells described by `gridDef`,
  // where cells are normalized 0..1 coords relative to the (areaX, areaY,
  // areaW, areaH) box. Used by every frame renderer that lays photos out
  // in a literal grid (washi, filmstrip); scrapbook/heart have bespoke,
  // non-grid compositions and don't use this helper.
  function drawGridCells(ctx, areaX, areaY, areaW, areaH, gap, gridDef, photos) {
    gridDef.cells.forEach((cell, i) => {
      const photo = photos[i];
      if (!photo) return;
      const cx = areaX + cell.x * areaW + gap / 2;
      const cy = areaY + cell.y * areaH + gap / 2;
      const cw = cell.w * areaW - gap;
      const ch = cell.h * areaH - gap;
      ctx.save();
      ctx.beginPath();
      ctx.rect(cx, cy, cw, ch);
      ctx.clip();
      const side = Math.min(photo.width, photo.height);
      const sx = (photo.width - side) / 2, sy = (photo.height - side) / 2;
      const scale = Math.max(cw / side, ch / side);
      const dw = side * scale, dh = side * scale;
      ctx.drawImage(photo, sx, sy, side, side, cx + (cw - dw) / 2, cy + (ch - dh) / 2, dw, dh);
      ctx.restore();
    });
  }

  const CAPTION_ALLOWANCE = { washi: 118, filmstrip: 110, scrapbook: 0, heart: 0 };

  /* ---------- 1. WASHI STRIP ----------
     A tall photo-booth strip: N frames stacked full-bleed inside a white
     card, a torn piece of washi tape at the top, and a flowing script
     caption underneath — the "dinner party" strip look. */
  function renderWashiStrip(ctx, W, H, photos, gridDef, accentHex) {
    const margin = 24;
    const gap = 10;
    const areaW = W - margin * 2;
    const areaH = H - margin * 2 - CAPTION_ALLOWANCE.washi;

    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.18)';
    ctx.shadowBlur = 2;
    roundRectPath(ctx, 0, 0, W, H, 4);
    ctx.fillStyle = '#FFFFFF';
    ctx.fill();
    ctx.restore();

    drawGridCells(ctx, margin, margin, areaW, areaH, gap, gridDef, photos);

    // torn washi tape across the top edge
    drawTapePiece(ctx, W / 2, margin - 2, 150, 34, -3, accentHex);

    drawScriptCaption(ctx, W / 2, H - 62, accentHex);
  }

  /* ---------- 2. FILMSTRIP ----------
     Black film-reel bands with sprocket holes running along the top and
     bottom, N frames arranged in a grid in the middle, and a circled
     "TEXT" style stamped caption — the retro filmstrip collage look. */
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

  function renderFilmstrip(ctx, W, H, photos, gridDef, accentHex) {
    const bandH = 30;
    const photoAreaY = bandH;
    const photoAreaH = H - bandH * 2 - CAPTION_ALLOWANCE.filmstrip;
    const gap = 6;

    ctx.save();
    roundRectPath(ctx, 0, 0, W, H, 10);
    ctx.fillStyle = '#EFE7D8';
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.filter = 'grayscale(0.35) contrast(1.05)';
    drawGridCells(ctx, 0, photoAreaY, W, photoAreaH, gap, gridDef, photos);
    ctx.restore();

    // seam lines at every internal cell boundary (looks like a contact
    // sheet for grids bigger than a single 2-up split)
    const xBoundaries = new Set();
    const yBoundaries = new Set();
    gridDef.cells.forEach((cell) => {
      if (cell.x > 0) xBoundaries.add(cell.x);
      if (cell.y > 0) yBoundaries.add(cell.y);
    });
    ctx.save();
    ctx.strokeStyle = 'rgba(23,19,16,0.5)';
    ctx.lineWidth = 3;
    xBoundaries.forEach((fx) => {
      ctx.beginPath();
      ctx.moveTo(fx * W, photoAreaY);
      ctx.lineTo(fx * W, photoAreaY + photoAreaH);
      ctx.stroke();
    });
    yBoundaries.forEach((fy) => {
      ctx.beginPath();
      ctx.moveTo(0, photoAreaY + fy * photoAreaH);
      ctx.lineTo(W, photoAreaY + fy * photoAreaH);
      ctx.stroke();
    });
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

  function renderScrapbookPop(ctx, W, H, photos, gridDef, accentHex) {
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
    if (photos.length > 1) {
      drawTiltedPolaroid(ctx, W * 0.40, H * 0.36, size, -6, photos[0], 14);
      drawTiltedPolaroid(ctx, W * 0.62, H * 0.58, size, 5, photos[1], 14);
    } else {
      drawTiltedPolaroid(ctx, W * 0.5, H * 0.42, size, -3, photos[0], 14);
    }

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
  function renderHeartCutout(ctx, W, H, photos, gridDef, accentHex) {
    const [photoA, photoB] = photos;
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
    washi:     { render: renderWashiStrip,   height: (W, g) => Math.round(W / g.aspect + CAPTION_ALLOWANCE.washi),     grids: 'any' },
    filmstrip: { render: renderFilmstrip,    height: (W, g) => Math.round(W / g.aspect + CAPTION_ALLOWANCE.filmstrip), grids: 'any' },
    scrapbook: { render: renderScrapbookPop, height: (W, g) => Math.round(W * 1.18),                                   grids: ['solo1', 'strip2', 'side2'] },
    heart:     { render: renderHeartCutout,  height: (W, g) => Math.round(W * 1.18),                                   grids: ['strip2', 'side2'] }
  };

  // Non-destructively re-applies the currently chosen filter to a raw
  // (always-unfiltered) captured photo — called fresh every render so
  // switching filters after the fact never compounds onto a previous pass.
  function applyFilterToPhoto(photo) {
    const css = FILTER_PRESETS[state.filter].css;
    if (css === 'none') return photo;
    const c = document.createElement('canvas');
    c.width = photo.width; c.height = photo.height;
    const ctx = c.getContext('2d');
    ctx.filter = css;
    ctx.drawImage(photo, 0, 0);
    return c;
  }

  function renderResult(photos) {
    state.lastPhotos = photos;
    const canvas = $('final-canvas');
    const accentHex = ACCENTS[state.accent] || ACCENTS.pink;

    const gridDef = GRID_LAYOUTS[state.grid] || GRID_LAYOUTS.strip2;
    const config = FRAME_RENDERERS[state.shape] || FRAME_RENDERERS.washi;
    const W = 620;
    const H = config.height(W, gridDef);

    const filteredPhotos = photos.map(applyFilterToPhoto);

    const p = document.createElement('canvas');
    p.width = W; p.height = H;
    const ctx = p.getContext('2d');
    config.render(ctx, W, H, filteredPhotos, gridDef, accentHex);
    drawStickers(ctx, W, H, state.stickers);

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

    renderStickerLayer();
  }

  $('caption-input').addEventListener('input', (e) => {
    state.caption = e.target.value;
    if (state.lastPhotos) renderResult(state.lastPhotos);
  });
  $('date-toggle').addEventListener('change', (e) => {
    state.showDate = e.target.checked;
    if (state.lastPhotos) renderResult(state.lastPhotos);
  });

  // Filter is chosen AFTER the photos are captured, applied at render time
  // to the raw (unfiltered) shots — never baked in during capture. In
  // together-mode this syncs to the partner so both keep an identical
  // final image, matching how the frame/grid choices synced before capture.
  document.querySelectorAll('.filter-pill').forEach((pill) => {
    pill.addEventListener('click', () => {
      state.filter = pill.dataset.filter;
      document.querySelectorAll('.filter-pill').forEach((p) => p.classList.remove('selected'));
      pill.classList.add('selected');
      if (!isSolo()) sendData({ type: 'filter', filter: state.filter });
      if (state.lastPhotos) renderResult(state.lastPhotos);
    });
  });

  $('download-btn').addEventListener('click', () => {
    const canvas = $('final-canvas');
    const link = document.createElement('a');
    link.download = 'polaroid-love.png';
    link.href = canvas.toDataURL('image/png');
    link.click();
  });

  /* ============ STICKER DECORATION (result screen) ============ */
  // A wide, curated emoji set stands in for a "sticker pack" here — it
  // renders natively and identically across browsers/OSes with zero extra
  // asset files, network requests, or licensing to track, which matters
  // for an app whose whole design premise is running fully self-hosted.
  const STICKER_CATEGORIES = [
    { key: 'love', label: 'Love', emojis: ['❤️', '🩷', '🧡', '💛', '💚', '💙', '💜', '🤍', '💕', '💞', '💓', '💗', '💖', '💘', '💝', '😍', '🥰', '😘', '💋', '💌'] },
    { key: 'party', label: 'Party', emojis: ['🎉', '🎊', '🥳', '🎈', '🎁', '🥂', '🍾', '✨', '🎇', '🎆', '🪩', '🎶', '🎵', '📸', '💃', '🕺'] },
    { key: 'cute', label: 'Cute', emojis: ['🌸', '🌷', '🌻', '🌈', '⭐', '🌟', '💫', '☁️', '🦋', '🐰', '🐻', '🐶', '🐱', '🐼', '🦄', '🐣'] },
    { key: 'food', label: 'Food', emojis: ['🍰', '🧁', '🍓', '🍒', '🍑', '🍩', '🍪', '🍫', '🍦', '🍿', '☕', '🍹', '🍕', '🍉'] },
    { key: 'fun', label: 'Fun', emojis: ['😂', '😎', '🤪', '😜', '🥹', '😆', '🙈', '👀', '👍', '🤙', '✌️', '👑', '💯', '🔥'] }
  ];
  let selectedStickerCategory = STICKER_CATEGORIES[0].key;
  let selectedStickerId = null;
  const clamp01 = (v) => Math.max(0, Math.min(1, v));

  function renderStickerCategoryTabs() {
    const wrap = $('sticker-categories');
    wrap.innerHTML = '';
    STICKER_CATEGORIES.forEach((cat) => {
      const btn = document.createElement('button');
      btn.className = 'sticker-cat' + (cat.key === selectedStickerCategory ? ' selected' : '');
      btn.textContent = cat.label;
      btn.dataset.cat = cat.key;
      btn.addEventListener('click', () => {
        selectedStickerCategory = cat.key;
        renderStickerCategoryTabs();
        renderStickerPickerGrid();
      });
      wrap.appendChild(btn);
    });
  }

  function renderStickerPickerGrid() {
    const picker = $('sticker-picker');
    picker.innerHTML = '';
    const cat = STICKER_CATEGORIES.find((c) => c.key === selectedStickerCategory) || STICKER_CATEGORIES[0];
    cat.emojis.forEach((emoji) => {
      const btn = document.createElement('button');
      btn.className = 'sticker-pick';
      btn.textContent = emoji;
      btn.dataset.emoji = emoji;
      btn.addEventListener('click', () => addSticker(emoji));
      picker.appendChild(btn);
    });
  }

  renderStickerCategoryTabs();
  renderStickerPickerGrid();

  function drawStickers(ctx, W, H, stickers) {
    stickers.forEach((s) => {
      ctx.save();
      ctx.translate(s.x * W, s.y * H);
      ctx.rotate((s.rotation * Math.PI) / 180);
      ctx.scale(s.scale, s.scale);
      ctx.font = "40px 'Poppins', sans-serif";
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(s.emoji, 0, 0);
      ctx.restore();
    });
  }

  function renderStickerLayer() {
    const layer = $('sticker-layer');
    const canvas = $('final-canvas');
    layer.innerHTML = '';
    const rect = canvas.getBoundingClientRect();
    const wrapRect = layer.parentElement.getBoundingClientRect();
    // Canvas is padded/rotated for export; stickers are authored in the
    // pre-padding W×H space, so anchor the overlay to the canvas's own
    // rendered box (which already accounts for that padding via CSS sizing).
    state.stickers.forEach((s) => {
      const el = document.createElement('div');
      el.className = 'sticker-el';
      el.dataset.id = s.id;
      el.textContent = s.emoji;
      el.style.left = `${(rect.left - wrapRect.left) + s.x * rect.width}px`;
      el.style.top = `${(rect.top - wrapRect.top) + s.y * rect.height}px`;
      el.style.transform = `translate(-50%,-50%) rotate(${s.rotation}deg) scale(${s.scale})`;
      el.classList.toggle('selected', s.id === selectedStickerId);
      layer.appendChild(el);
    });
    renderStickerToolbar();
  }

  function renderStickerToolbar() {
    const toolbar = $('sticker-toolbar');
    if (!selectedStickerId || !state.stickers.find((s) => s.id === selectedStickerId)) {
      toolbar.hidden = true;
      return;
    }
    const layer = $('sticker-layer');
    const el = layer.querySelector(`.sticker-el[data-id="${selectedStickerId}"]`);
    if (!el) { toolbar.hidden = true; return; }
    toolbar.hidden = false;
    toolbar.style.left = el.style.left;
    toolbar.style.top = `calc(${el.style.top} - 44px)`;
  }

  function addSticker(emoji) {
    const id = `stk-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
    // Nudge each new sticker's spawn point so a run of taps doesn't stack
    // every sticker exactly on top of the last (which made the selected
    // one's floating toolbar cover, and block clicks to, the one beneath it).
    const n = state.stickers.length;
    const x = clamp01(0.5 + ((n % 3) - 1) * 0.12);
    const y = clamp01(0.4 + Math.floor(n / 3) * 0.1);
    state.stickers.push({ id, emoji, x, y, scale: 1, rotation: 0 });
    selectedStickerId = id;
    renderResult(state.lastPhotos);
  }

  let dragState = null;
  $('sticker-layer').addEventListener('pointerdown', (e) => {
    const el = e.target.closest('.sticker-el');
    if (!el) return;
    el.setPointerCapture(e.pointerId);
    selectedStickerId = el.dataset.id;
    const s = state.stickers.find((x) => x.id === selectedStickerId);
    dragState = { id: s.id, startClientX: e.clientX, startClientY: e.clientY, origX: s.x, origY: s.y };
    renderStickerLayer();
  });
  $('sticker-layer').addEventListener('pointermove', (e) => {
    if (!dragState) return;
    const rect = $('final-canvas').getBoundingClientRect();
    const dxNorm = (e.clientX - dragState.startClientX) / rect.width;
    const dyNorm = (e.clientY - dragState.startClientY) / rect.height;
    const s = state.stickers.find((x) => x.id === dragState.id);
    if (!s) return;
    s.x = clamp01(dragState.origX + dxNorm);
    s.y = clamp01(dragState.origY + dyNorm);
    renderStickerLayer();
  });
  $('sticker-layer').addEventListener('pointerup', () => {
    if (dragState) { dragState = null; renderResult(state.lastPhotos); }
  });

  $('sticker-toolbar').addEventListener('click', (e) => {
    const action = e.target.closest('button')?.dataset.action;
    if (!action) return;
    const s = state.stickers.find((x) => x.id === selectedStickerId);
    if (!s) return;
    if (action === 'grow') s.scale = Math.min(3, s.scale + 0.15);
    if (action === 'shrink') s.scale = Math.max(0.3, s.scale - 0.15);
    if (action === 'rotate-ccw') s.rotation -= 15;
    if (action === 'rotate-cw') s.rotation += 15;
    if (action === 'delete') {
      state.stickers = state.stickers.filter((x) => x.id !== selectedStickerId);
      selectedStickerId = null;
    }
    renderResult(state.lastPhotos);
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
    state.mode = 'together';
    state.shotIndex = 0;
    state.myShots = [];
    state.peerShots = [];
    state.lastPhotos = null;
    state.stickers = [];
    countdownRunning = false;
    shotRunToken++;
    setReadyButtonsDisabled(false);
    setReadyButtonsLabel("I'm ready 📸");
    $('ready-row-capture').hidden = true;
    $('shot-progress').hidden = true;
    $('topbar-status').hidden = true;
    $('remote-video-box').hidden = false;
    $('capture-stage').classList.remove('solo');
    $('lobby-title').textContent = 'Your room code';
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

// Solo-mode regression tests.
//
// Guards the core promise of solo mode: picking ANY grid layout (1, 2, 3, 4,
// or 9 photos) must run a purely local session — never create a room, open a
// PeerJS signaling connection, show a room code, or reveal the partner video
// slot. This exists because a stale/older build once leaked together-mode
// room UI into solo mode; these tests fail loudly if that ever regresses.
//
// Run with:  npm test        (starts the server automatically)
// or:        node test/solo-mode.test.js   (server must already be on :3000)

const { chromium } = require('playwright');

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const GRIDS = ['solo1', 'strip2', 'side2', 'strip3', 'strip4', 'grid9'];

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}  ${detail || ''}`); }
}

async function runSoloGrid(browser, grid) {
  console.log(`\n[solo mode, grid=${grid}]`);
  const page = await browser.newPage({ viewport: { width: 500, height: 900 } });

  const signalingHits = [];
  page.on('request', (req) => {
    // The PeerJS *library* loads from unpkg (fine); the *signaling* endpoint
    // is same-origin /peerjs. Only the latter means a room was opened.
    if (req.url().includes(`${BASE}/peerjs`)) signalingHits.push(req.url());
  });
  page.on('websocket', (ws) => { if (ws.url().includes('/peerjs')) signalingHits.push('WS ' + ws.url()); });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await page.goto(BASE, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);

  // Home -> solo -> design
  await page.click('#mode-solo');
  await page.click('#continue-btn');
  await page.waitForSelector('#screen-design.active');

  // The action button must say "Start", not "Create my room"
  const btnLabel = await page.evaluate(() => document.getElementById('design-continue-btn').textContent.trim());
  check('action button says "Start"', btnLabel === 'Start', `got "${btnLabel}"`);

  // Pick the grid
  await page.click(`.grid-card[data-grid="${grid}"]`);
  await page.click('#design-continue-btn');
  await page.waitForSelector('#screen-lobby.active', { timeout: 5000 });
  await page.waitForTimeout(1500);

  const dom = await page.evaluate(() => ({
    hostCodeVisible: getComputedStyle(document.getElementById('host-code-card')).display !== 'none',
    joinStatusVisible: getComputedStyle(document.getElementById('join-status-card')).display !== 'none',
    remoteBoxVisible: getComputedStyle(document.getElementById('remote-video-box')).display !== 'none',
    topbarVisible: getComputedStyle(document.getElementById('topbar-status')).display !== 'none',
    roomCode: document.getElementById('room-code-display').textContent.trim(),
    title: document.getElementById('lobby-title').textContent.trim(),
    readyVisible: !document.getElementById('ready-row').hidden,
  }));

  check('no PeerJS signaling opened', signalingHits.length === 0, `hits=${signalingHits.length}`);
  check('room-code card hidden', !dom.hostCodeVisible);
  check('join-status card hidden', !dom.joinStatusVisible);
  check('partner video slot hidden', !dom.remoteBoxVisible);
  check('"Not connected" pill hidden', !dom.topbarVisible);
  check('no room code shown', dom.roomCode === '' || dom.roomCode === '—', `code="${dom.roomCode}"`);
  check('lobby title is not "Your room code"', dom.title !== 'Your room code', `title="${dom.title}"`);
  check('ready button shown for solo', dom.readyVisible);
  check('no page errors', pageErrors.length === 0, pageErrors.join('; '));

  await page.close();
}

(async () => {
  const browser = await chromium.launch({
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  });
  try {
    for (const grid of GRIDS) await runSoloGrid(browser, grid);
  } finally {
    await browser.close();
  }
  console.log(`\n==================== ${passed} passed, ${failed} failed ====================`);
  process.exit(failed === 0 ? 0 : 1);
})();

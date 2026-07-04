// Together-mode multi-shot composition tests.
//
// Regression guard for the bug where a multi-photo grid only used the FIRST
// shot from each person and discarded the rest (e.g. heart-cutout / strip4
// threw away everyone's 2nd-round photos). Asserts that every grid cell is
// filled by a DISTINCT captured photo, and that the number of ready-rounds
// is ceil(count/2) in together-mode (two cells per shutter, you + partner).
//
// The app exposes window.__finalizeInfo when window.__DEBUG is set (dev-only).
// We rely on that structural report rather than pixel-diffing the canvas,
// because the fake test camera renders an identical feed to both browser
// contexts, so distinct-but-identical-looking photos can't be told apart by
// color alone.

const { chromium } = require('playwright');

const BASE = process.env.BASE_URL || 'http://localhost:3000';
let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + '  ' + (detail || '')); }
}

async function setup(browser) {
  const hostCtx = await browser.newContext({ viewport: { width: 500, height: 1000 } });
  const guestCtx = await browser.newContext({ viewport: { width: 500, height: 1000 } });
  const host = await hostCtx.newPage();
  const guest = await guestCtx.newPage();
  await host.addInitScript(() => { window.__DEBUG = true; });
  await guest.addInitScript(() => { window.__DEBUG = true; });
  await host.goto(BASE); await guest.goto(BASE);
  await host.evaluate(() => document.fonts.ready);
  return { hostCtx, guestCtx, host, guest };
}

async function joinRoom(host, guest, grid, shape) {
  await host.click('#mode-host');
  await host.click('#continue-btn');
  await host.waitForSelector('#screen-design.active');
  await host.click(`.grid-card[data-grid="${grid}"]`);
  if (shape) await host.click(`.shape-card[data-shape="${shape}"]`);
  await host.click('#design-continue-btn');
  await host.waitForSelector('#screen-lobby.active');
  const code = (await host.locator('#room-code-display').textContent()).trim();
  await guest.click('#mode-guest');
  await guest.fill('#join-code-input', code);
  await guest.click('#continue-btn');
  await host.waitForSelector('#ready-row:not([hidden])', { timeout: 15000 });
  await guest.waitForSelector('#ready-row:not([hidden])', { timeout: 15000 });
}

async function round(host, guest, first) {
  const btn = first ? '#ready-btn' : '#ready-btn-capture';
  await host.click(btn);
  await guest.click(btn);
  await host.waitForTimeout(3300);
}

async function testCase(browser, { grid, shape, expectRounds, expectCells }) {
  const label = `together / ${grid}${shape ? ' / ' + shape : ''}`;
  console.log(`\n[${label}] expect ${expectRounds} round(s), ${expectCells} distinct cells`);
  const { hostCtx, guestCtx, host, guest } = await setup(browser);
  try {
    await joinRoom(host, guest, grid, shape);
    for (let r = 0; r < expectRounds; r++) {
      await round(host, guest, r === 0);
      if (r < expectRounds - 1) {
        const screen = await host.evaluate(() => document.querySelector('.screen.active').id);
        ok(`still capturing after round ${r + 1}`, screen === 'screen-capture', screen);
      }
    }
    await host.waitForSelector('#screen-result.active', { timeout: 8000 });
    await guest.waitForSelector('#screen-result.active', { timeout: 8000 });
    await host.waitForTimeout(200);

    const info = await host.evaluate(() => window.__finalizeInfo);
    ok('rounds needed matches expected', info.rounds === expectRounds, JSON.stringify(info));
    ok('each person took `rounds` shots', info.myShots === expectRounds && info.peerShots === expectRounds, JSON.stringify(info));
    ok(`grid filled with ${expectCells} photos`, info.orderedLen === expectCells, `orderedLen=${info.orderedLen}`);
    ok('every cell is a DISTINCT photo (no discarded shots / duplicates)', info.distinct === expectCells, `distinct=${info.distinct} of ${info.orderedLen}`);
  } finally {
    await hostCtx.close(); await guestCtx.close();
  }
}

(async () => {
  const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  try {
    await testCase(browser, { grid: 'strip2', shape: 'heart',     expectRounds: 1, expectCells: 2 });
    await testCase(browser, { grid: 'strip2', shape: 'washi',     expectRounds: 1, expectCells: 2 });
    await testCase(browser, { grid: 'strip4', shape: 'washi',     expectRounds: 2, expectCells: 4 });
    await testCase(browser, { grid: 'grid9',  shape: 'filmstrip', expectRounds: 5, expectCells: 9 });
  } finally {
    await browser.close();
  }
  console.log(`\n==================== ${pass} passed, ${fail} failed ====================`);
  process.exit(fail ? 1 : 0);
})();

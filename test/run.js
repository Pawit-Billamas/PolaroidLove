// Test runner: boots the app server on an ephemeral port, waits for it to be
// reachable, runs every *.test.js in this folder against it, then shuts the
// server down. Keeps `npm test` a single self-contained command.

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3100;
const BASE_URL = `http://localhost:${PORT}`;

function waitForServer(url, timeoutMs = 15000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    (function poll() {
      http.get(url, (res) => { res.resume(); resolve(); })
        .on('error', () => {
          if (Date.now() - start > timeoutMs) reject(new Error('server did not start in time'));
          else setTimeout(poll, 300);
        });
    })();
  });
}

function run(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', ...opts });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
    p.on('error', reject);
  });
}

(async () => {
  const server = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore',
    shell: process.platform === 'win32',
  });

  let failed = false;
  try {
    await waitForServer(BASE_URL);
    const tests = fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js'));
    for (const t of tests) {
      console.log(`\n########## ${t} ##########`);
      await run('node', [path.join(__dirname, t)], { env: { ...process.env, BASE_URL } });
    }
  } catch (e) {
    failed = true;
    console.error('\nTEST RUN FAILED:', e.message);
  } finally {
    server.kill();
  }
  process.exit(failed ? 1 : 0);
})();

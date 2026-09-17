// Integration tests for ticket S18 (server/safemode.js wired into server/index.js): guarded
// refusing a new anonymous player while accepting a token holder and a kiosk, locked closing
// with 4503 while an existing socket keeps playing, the settings row surviving a restart, and
// /status carrying the level. Same harness as test/integration-box/server.test.mjs - a live
// database, the server started in-process with a stubbed feed.
//
//   bash db/run-tests.sh --keep
//   DATABASE_URL=postgresql://postgres:test@localhost:55432/postgres npm run test:server
//
// The escalation state machine's own timing (thresholds, half-threshold de-escalation) is
// covered without a server or a database in test/unit/safemode.test.mjs; this file only proves
// that server/index.js enforces whatever level server/safemode.js reports, and that the level
// itself round-trips through public.settings the way scripts/safe-mode.mjs and a restart need.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import pg from 'pg';

if (!process.env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL is not set. Start a throwaway database first:\n' +
      '  bash db/run-tests.sh --keep\n' +
      'then export the DATABASE_URL it prints and re-run npm run test:server.',
  );
}
process.env.PLAYER_TOKEN_SECRET ??= 'dev-secret';
process.env.TRUST_PROXY = '1';
delete process.env.ELASTIC_API_KEY;

const { createApp } = await import('../../server/index.js');

const DEV_KIOSK_SECRET = 'dev-kiosk-secret-0001';
const SAFE_MODE_KEY = 'safe_mode';

let app;
let port;
let wsUrl;
let httpUrl;
let pool;
let ipCounter = 0;

before(async () => {
  app = createApp({ finnhubToken: null });
  port = await app.start(0, { startFeed: false });
  wsUrl = `ws://localhost:${port}/ws`;
  httpUrl = `http://localhost:${port}`;
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  app.feed._injectTick('okx', 3000, Date.now());
  // start() kicks off safeMode's first poll without awaiting it (fire-and-forget, same as
  // limits/alerts); wait for it explicitly so no test can race the baseline settings write.
  await app.safeMode._pollOnce();
});

after(async () => {
  await app.close();
  await pool.end();
});

function freshIp() {
  ipCounter += 1;
  return `10.88.${Math.floor(ipCounter / 256)}.${ipCounter % 256}`;
}

function connect(ip) {
  const ws = new WebSocket(wsUrl, { headers: { 'X-Forwarded-For': ip } });
  ws.inbox = [];
  ws.waiters = [];
  ws.on('message', (data) => {
    let frame;
    try {
      frame = JSON.parse(data.toString());
    } catch {
      return;
    }
    const waiterIdx = ws.waiters.findIndex((w) => w.predicate(frame));
    if (waiterIdx !== -1) {
      const [waiter] = ws.waiters.splice(waiterIdx, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(frame);
    } else {
      ws.inbox.push(frame);
    }
  });
  return ws;
}

function whenOpen(ws) {
  return new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
}

function whenClosed(ws) {
  return new Promise((resolve) => ws.once('close', (code) => resolve(code)));
}

function nextFrame(ws, predicate, timeoutMs = 2000) {
  const bufferedIdx = ws.inbox.findIndex(predicate);
  if (bufferedIdx !== -1) return Promise.resolve(ws.inbox.splice(bufferedIdx, 1)[0]);
  return new Promise((resolve, reject) => {
    const waiter = {
      predicate,
      resolve,
      timer: setTimeout(() => {
        ws.waiters = ws.waiters.filter((w) => w !== waiter);
        reject(new Error(`timed out after ${timeoutMs}ms waiting for a matching frame`));
      }, timeoutMs),
    };
    ws.waiters.push(waiter);
  });
}

function send(ws, frame) {
  ws.send(JSON.stringify(frame));
}

async function setSafeMode(level, extra = {}) {
  const value = JSON.stringify({ level, reason: 'manual', at: new Date().toISOString(), ...extra });
  await pool.query(
    `insert into public.settings (key, value, updated_at) values ($1, $2, now())
       on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at`,
    [SAFE_MODE_KEY, value],
  );
  // The server polls every 5 s in production; drive one poll directly instead of waiting.
  await app.safeMode._pollOnce();
}

// --- guarded ------------------------------------------------------------------------------

test('guarded refuses a brand-new anonymous player with code safe_mode and a retry hint', async () => {
  await setSafeMode('guarded');
  const ws = connect(freshIp());
  await whenOpen(ws);
  send(ws, { type: 'auth' });
  const refused = await nextFrame(ws, (f) => f.type === 'error' || f.type === 'welcome');
  assert.equal(refused.type, 'error');
  assert.equal(refused.code, 'safe_mode');
  assert.ok(refused.retry_ms > 0);
  ws.close();
  await setSafeMode('normal');
});

test('guarded accepts a socket presenting a valid, already-issued player token', async () => {
  const ip = freshIp();
  const bootstrap = connect(ip);
  await whenOpen(bootstrap);
  send(bootstrap, { type: 'auth' });
  const welcome = await nextFrame(bootstrap, (f) => f.type === 'welcome');
  bootstrap.close();

  await setSafeMode('guarded');
  const ws = connect(ip);
  await whenOpen(ws);
  send(ws, { type: 'auth', token: welcome.token });
  const result = await nextFrame(ws, (f) => f.type === 'welcome' || f.type === 'error');
  assert.equal(result.type, 'welcome', 'a returning player with a valid token is never new');
  ws.close();
  await setSafeMode('normal');
});

test('guarded accepts a new player whose device token is older than 10 minutes', async () => {
  const ip = freshIp();
  const bootstrap = connect(ip);
  await whenOpen(bootstrap);
  send(bootstrap, { type: 'auth' });
  const welcome = await nextFrame(bootstrap, (f) => f.type === 'welcome');
  bootstrap.close();

  // Back-date the device's created_at past the 10-minute trust window server/index.js checks.
  const deviceId = welcome.device.split('.')[0];
  await pool.query(
    "update public.devices set created_at = now() - interval '11 minutes' where id = $1",
    [deviceId],
  );

  await setSafeMode('guarded');
  const ws = connect(ip);
  await whenOpen(ws);
  // No player token (a cleared cookie, or a fresh browser tab), but the same old device token.
  send(ws, { type: 'auth', device: welcome.device });
  const result = await nextFrame(ws, (f) => f.type === 'welcome' || f.type === 'error');
  assert.equal(result.type, 'welcome', 'an old device exempts a new player from the guarded refusal');
  ws.close();
  await setSafeMode('normal');
});

test('guarded does not affect a kiosk auth', async () => {
  await setSafeMode('guarded');
  const ws = connect(freshIp());
  await whenOpen(ws);
  send(ws, { type: 'auth', kiosk: DEV_KIOSK_SECRET });
  const result = await nextFrame(ws, (f) => f.type === 'welcome' || f.type === 'error');
  assert.equal(result.type, 'welcome');
  assert.equal(result.kiosk, true);
  ws.close();
  await setSafeMode('normal');
});

// --- locked ---------------------------------------------------------------------------------

test('locked closes a brand-new anonymous connection with 4503, after the refusal frame', async () => {
  await setSafeMode('locked');
  const ws = connect(freshIp());
  await whenOpen(ws);
  const closed = whenClosed(ws);
  send(ws, { type: 'auth' });
  const refused = await nextFrame(ws, (f) => f.type === 'error');
  assert.equal(refused.code, 'safe_mode');
  const code = await closed;
  assert.equal(code, 4503);
  await setSafeMode('normal');
});

test('locked closes even a device-token-exempt new player (guarded\'s exemption does not apply)', async () => {
  const ip = freshIp();
  const bootstrap = connect(ip);
  await whenOpen(bootstrap);
  send(bootstrap, { type: 'auth' });
  const welcome = await nextFrame(bootstrap, (f) => f.type === 'welcome');
  bootstrap.close();
  const deviceId = welcome.device.split('.')[0];
  await pool.query("update public.devices set created_at = now() - interval '1 hour' where id = $1", [deviceId]);

  await setSafeMode('locked');
  const ws = connect(freshIp());
  await whenOpen(ws);
  const closed = whenClosed(ws);
  send(ws, { type: 'auth', device: welcome.device });
  await nextFrame(ws, (f) => f.type === 'error');
  assert.equal(await closed, 4503);
  await setSafeMode('normal');
});

test('locked still accepts a kiosk', async () => {
  await setSafeMode('locked');
  const ws = connect(freshIp());
  await whenOpen(ws);
  send(ws, { type: 'auth', kiosk: DEV_KIOSK_SECRET });
  const result = await nextFrame(ws, (f) => f.type === 'welcome' || f.type === 'error');
  assert.equal(result.type, 'welcome');
  ws.close();
  await setSafeMode('normal');
});

test('locked accepts a player token issued before the lock, and keeps an existing socket playing through the lock', async () => {
  const ip = freshIp();
  const returning = connect(ip);
  await whenOpen(returning);
  send(returning, { type: 'auth' });
  const welcome = await nextFrame(returning, (f) => f.type === 'welcome');

  await setSafeMode('locked');

  // The already-open socket from before the lock: still fully playable.
  send(returning, { type: 'get_me' });
  const me = await nextFrame(returning, (f) => f.type === 'me' || f.type === 'error');
  assert.equal(me.type, 'me', 'an existing socket is never affected by safe mode');
  returning.close();

  // A fresh socket presenting that same, pre-lock token: exempted by decision 2.
  const resumed = connect(freshIp());
  await whenOpen(resumed);
  send(resumed, { type: 'auth', token: welcome.token });
  const result = await nextFrame(resumed, (f) => f.type === 'welcome' || f.type === 'error');
  assert.equal(result.type, 'welcome');
  resumed.close();
  await setSafeMode('normal');
});

// --- settings persistence ---------------------------------------------------------------------

test('the settings row is honoured after a restart', async () => {
  await setSafeMode('guarded');
  assert.equal(app.safeMode.level(), 'guarded');

  // A fresh app instance, as if the process had restarted: nothing in memory carries over,
  // only the settings row server/safemode.js reads on its first poll.
  const restarted = createApp({ finnhubToken: null });
  await restarted.start(0, { startFeed: false });
  try {
    await restarted.safeMode._pollOnce();
    assert.equal(restarted.safeMode.level(), 'guarded', 'restored from public.settings, not defaulted to normal');
  } finally {
    await restarted.close();
  }
  await setSafeMode('normal');
});

// --- /status ----------------------------------------------------------------------------------

test('/status carries safe_mode.level and safe_mode.reason', async () => {
  await setSafeMode('guarded');
  const res = await fetch(`${httpUrl}/status`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.safe_mode);
  assert.equal(body.safe_mode.level, 'guarded');
  assert.equal(body.safe_mode.reason, 'manual');
  await setSafeMode('normal');
});

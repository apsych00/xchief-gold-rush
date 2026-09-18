// Integration tests for the open kiosk route (ticket K1): POST /api/kiosk/provision and the
// /status kiosk counts. Needs a live database exactly like test/integration-box/server.test.mjs -
// see that file's module doc for the recipe.

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
process.env.KIOSK_OPEN_PROVISION = '1';
process.env.KIOSK_OPEN_MAX = '50';
process.env.TRUST_PROXY = '1';
// Keep the per-minute HTTP connection budget well above the anonymous-auth budget so the
// provision route's own checkAnonAuth window is what we exercise, not the generic connection cap.
process.env.MAX_ANON_PLAYERS_PER_IP_PER_10MIN = '10';
process.env.MAX_CONNECTIONS_PER_IP_PER_MIN = '1000';
process.env.MAX_SOCKETS_PER_IP = '1000';

const { createApp } = await import('../../server/index.js');
const { LIMITS } = await import('../../server/limits.js');

let app;
let port;
let httpUrl;
let wsUrl;
let pool;
let ipCounter = 0;

before(async () => {
  app = createApp({ finnhubToken: null });
  port = await app.start(0, { startFeed: false });
  httpUrl = `http://localhost:${port}`;
  wsUrl = `ws://localhost:${port}/ws`;
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  // Each test in this file expects to start from a clean open-kiosk slate.
  await pool.query("delete from public.kiosks where label like 'open-%'");
});

after(async () => {
  await pool.query("delete from public.kiosks where label like 'open-%'");
  await app.close();
  await pool.end();
});

function freshIp() {
  ipCounter += 1;
  return `10.77.${Math.floor(ipCounter / 256)}.${ipCounter % 256}`;
}

function provision(ip) {
  return fetch(`${httpUrl}/api/kiosk/provision`, {
    method: 'POST',
    headers: { 'X-Forwarded-For': ip },
  });
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

test('provision on returns a 32-char secret that authenticates as a kiosk', async () => {
  const ip = freshIp();
  const res = await provision(ip);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.id, 'response carries kiosk id');
  assert.equal(typeof body.secret, 'string');
  assert.equal(body.secret.length, 32);
  assert.match(body.label, /^open-\d{8}-[A-Za-z0-9_-]{4}$/);

  const ws = connect(ip);
  await whenOpen(ws);
  send(ws, { type: 'auth', kiosk: body.secret });
  const welcome = await nextFrame(ws, (f) => f.type === 'welcome');
  assert.equal(welcome.kiosk, true);
  ws.close();
});

test('provision off returns 404 not_configured', async () => {
  process.env.KIOSK_OPEN_PROVISION = '0';
  const offApp = createApp({ finnhubToken: null });
  const offPort = await offApp.start(0, { startFeed: false });
  try {
    const res = await fetch(`http://localhost:${offPort}/api/kiosk/provision`, { method: 'POST' });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error, 'not_configured');
  } finally {
    process.env.KIOSK_OPEN_PROVISION = '1';
    await offApp.close();
  }
});

test('provision enforces KIOSK_OPEN_MAX', async () => {
  // Start from zero open kiosks (before hook already cleaned), then cap at 1.
  await pool.query("delete from public.kiosks where label like 'open-%'");
  process.env.KIOSK_OPEN_MAX = '1';
  const capApp = createApp({ finnhubToken: null });
  const capPort = await capApp.start(0, { startFeed: false });
  try {
    const first = await fetch(`http://localhost:${capPort}/api/kiosk/provision`, {
      method: 'POST',
      headers: { 'X-Forwarded-For': freshIp() },
    });
    assert.equal(first.status, 200);

    const second = await fetch(`http://localhost:${capPort}/api/kiosk/provision`, {
      method: 'POST',
      headers: { 'X-Forwarded-For': freshIp() },
    });
    assert.equal(second.status, 429);
    const body = await second.json();
    assert.equal(body.error, 'kiosk_cap');
  } finally {
    process.env.KIOSK_OPEN_MAX = '50';
    await capApp.close();
  }
});

test('provision counts against the anonymous-auth per-IP window', async () => {
  await pool.query("delete from public.kiosks where label like 'open-%'");
  const ip = freshIp();
  for (let i = 0; i < LIMITS.MAX_ANON_PLAYERS_PER_IP_PER_10MIN; i += 1) {
    const res = await provision(ip);
    assert.equal(res.status, 200, `provision ${i + 1} should succeed`);
    const body = await res.json();
    await pool.query('delete from public.kiosks where id = $1', [body.id]);
  }
  const over = await provision(ip);
  assert.equal(over.status, 429);
  const body = await over.json();
  assert.equal(body.error, 'rate_limited');
  assert.ok(body.retry_ms > 0);
});

test('/status reports seeded and open kiosk counts', async () => {
  await pool.query("delete from public.kiosks where label like 'open-%'");
  const before = await (await fetch(`${httpUrl}/status`)).json();
  assert.ok(typeof before.kiosks.seeded === 'number');
  assert.ok(typeof before.kiosks.open === 'number');

  await provision(freshIp());
  const after = await (await fetch(`${httpUrl}/status`)).json();
  assert.equal(after.kiosks.open, before.kiosks.open + 1, 'status reflects the newly provisioned open kiosk');
  assert.equal(after.kiosks.seeded, before.kiosks.seeded, 'seeded count is unchanged');
});

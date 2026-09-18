// Socket + HTTP integration for the share flow (ticket U4).
// Needs a live database exactly like test/integration-box/server.test.mjs.

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
process.env.PUBLIC_URL ??= 'http://localhost:5359';
process.env.MAX_ANON_PLAYERS_PER_IP_PER_10MIN ??= '1000';
process.env.MAX_CONNECTIONS_PER_IP_PER_MIN ??= '1000';
process.env.MAX_SOCKETS_PER_IP ??= '1000';

const { createApp } = await import('../../server/index.js');
let app;
let port;
let wsUrl;
let priceTimer;
let currentPrice = 3000;
let pool;

before(async () => {
  app = createApp({ finnhubToken: null });
  port = await app.start(0, { startFeed: false });
  wsUrl = `ws://localhost:${port}/ws`;
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

  priceTimer = setInterval(() => {
    app.feed._injectTick('okx', currentPrice, Date.now());
  }, 200);
  await new Promise((resolve) => {
    const check = setInterval(() => {
      if (app.feed.latest()) {
        clearInterval(check);
        resolve();
      }
    }, 20);
  });
});

after(async () => {
  clearInterval(priceTimer);
  await app.close();
  await pool.end();
});

function connect(url = wsUrl) {
  const ws = new WebSocket(url);
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

async function authPlayer(ws) {
  send(ws, { type: 'auth' });
  const welcome = await nextFrame(ws, (f) => f.type === 'welcome');
  return welcome.me.id;
}

test('share_link frame shape and budget', async () => {
  const ws = connect();
  await whenOpen(ws);
  const playerId = await authPlayer(ws);
  await pool.query('update public.players set record = 2500 where id = $1', [playerId]);

  send(ws, { type: 'share_link' });
  const frame = await nextFrame(ws, (f) => f.type === 'share_link');
  assert.ok(frame.url, 'share_link carries a url');
  assert.ok(frame.url.startsWith(process.env.PUBLIC_URL), 'url is built from PUBLIC_URL');
  assert.ok(frame.url.includes('/s/'), 'url uses the /s/<token> path');
  assert.equal(typeof frame.record, 'number');
  assert.equal(frame.record, 2500);
  assert.equal(frame.display, 'Guest', 'anonymous player display is Guest');
  assert.ok(Object.hasOwn(frame, 'rank'));
  assert.ok(Object.hasOwn(frame, 'tier'));

  // Token was minted and stored.
  const { rows } = await pool.query('select share_token from public.players where id = $1', [playerId]);
  assert.ok(rows[0].share_token);
  assert.ok(frame.url.endsWith(rows[0].share_token), 'url ends with the stored token');

  // 1/s budget: immediate second request is rate limited.
  send(ws, { type: 'share_link' });
  const err = await nextFrame(ws, (f) => f.type === 'error');
  assert.equal(err.code, 'rate_limited');
  assert.ok(err.retry_ms > 0);

  ws.close();
});

test('GET /api/share/<token> for a known token', async () => {
  const ws = connect();
  await whenOpen(ws);
  const playerId = await authPlayer(ws);
  await pool.query('update public.players set record = 3200 where id = $1', [playerId]);

  send(ws, { type: 'share_link' });
  const frame = await nextFrame(ws, (f) => f.type === 'share_link');
  const token = frame.url.split('/s/').pop();

  const res = await fetch(`http://localhost:${port}/api/share/${token}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.display, 'Guest');
  assert.equal(body.record, 3200);
  assert.ok(Object.hasOwn(body, 'rank'));
  assert.ok(Object.hasOwn(body, 'tier'));
  assert.ok(Object.hasOwn(body, 'tournament_title'));
  assert.ok(!Object.hasOwn(body, 'email'), 'raw email is never in the public response');
  ws.close();
});

test('GET /api/share/<token> for a verified player masks the email', async () => {
  const email = `share-verified-${Date.now()}@example.com`;
  const playerId = (await pool.query('select gen_random_uuid() as id')).rows[0].id;
  await pool.query(
    'insert into auth.users (id, email, email_confirmed_at, created_at) values ($1, $2, now(), now())',
    [playerId, email],
  );
  await pool.query(
    'insert into public.players (id, email, record) values ($1, $2, 4000)',
    [playerId, email],
  );
  const { rows } = await pool.query('select public.get_or_create_share_token($1) as token', [playerId]);
  const token = rows[0].token;

  const res = await fetch(`http://localhost:${port}/api/share/${token}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.match(body.display, /^s\*+[\w-]+@example\.com$/, 'display is the masked email');
  assert.equal(body.record, 4000);
  assert.ok(!body.display.includes(email.split('@')[0].slice(1, -1)), 'local part middle is hidden');
});

test('GET /api/share/<unknown token> answers 404', async () => {
  const res = await fetch(`http://localhost:${port}/api/share/this-token-was-never-issued`);
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error, 'not_found');
});

test('a kiosk socket cannot request share_link', async () => {
  const { rows } = await pool.query('select secret_hash from public.kiosks where status = $1 limit 1', ['active']);
  assert.ok(rows.length, 'seed kiosk exists');
  // We do not know the raw secret from the hash, but the dev seed has a known one.
  const secret = 'dev-kiosk-secret-0001';

  const ws = connect();
  await whenOpen(ws);
  send(ws, { type: 'auth', kiosk: secret });
  await nextFrame(ws, (f) => f.type === 'welcome');

  send(ws, { type: 'share_link' });
  const err = await nextFrame(ws, (f) => f.type === 'error');
  assert.equal(err.code, 'not_available');
  ws.close();
});

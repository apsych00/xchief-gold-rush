// OTP integration tests for the box game server (ticket 4: server/otp.js, the request_otp /
// verify_otp frames in server/index.js, request_otp_code/verify_otp_code in db/schema.sql). Same harness as
// test/integration-box/server.test.mjs - a live database, the server started in-process with a
// stubbed feed.
//
//   bash db/run-tests.sh --keep
//   DATABASE_URL=postgresql://postgres:test@localhost:55432/postgres npm run test:server
//
// ELASTIC_API_KEY is left unset so every code lands in public.dev_otps instead of being mailed
// (docs/box-plan.md 1.5) - this suite reads it back from there exactly as npm run otp:peek does.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
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
delete process.env.ELASTIC_API_KEY; // force the dev-capture path: codes land in dev_otps

const { createApp } = await import('../../server/index.js');

const DEV_KIOSK_SECRET = 'dev-kiosk-secret-0001';

let app;
let port;
let wsUrl;
let pool;

before(async () => {
  app = createApp({ finnhubToken: null });
  port = await app.start(0, { startFeed: false });
  wsUrl = `ws://localhost:${port}/ws`;
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
});

after(async () => {
  await app.close();
  await pool.end();
});

// Same buffered-inbox connection helper as server.test.mjs: a welcome/hello pair (or an error
// right after auth) can both arrive before the next await attaches a listener, so every
// connection gets one persistent 'message' listener that buffers into an inbox.
function connect() {
  const ws = new WebSocket(wsUrl);
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

function freshDeviceToken() {
  const id = crypto.randomUUID();
  const sig = crypto.createHmac('sha256', process.env.PLAYER_TOKEN_SECRET).update(id).digest('hex');
  return `${id}.${sig}`;
}

async function authAnonymous(ws) {
  // Ticket B13: give every test player a device token so the shared no-device reward cap
  // does not leak between tests.
  send(ws, { type: 'auth', device: freshDeviceToken() });
  return nextFrame(ws, (f) => f.type === 'welcome');
}

async function latestDevOtp(email) {
  const { rows } = await pool.query(
    'select token from public.dev_otps where email = $1 order by created_at desc limit 1',
    [email],
  );
  return rows[0]?.token;
}

test('request_otp then verify_otp with the dev-captured code sets email and releases the email + signup task rewards', async () => {
  const ws = connect();
  await whenOpen(ws);
  const welcome = await authAnonymous(ws);
  assert.equal(welcome.me.coins, 1000);

  const email = `otp-${Date.now()}@example.com`;
  send(ws, { type: 'request_otp', email });
  const sent = await nextFrame(ws, (f) => f.type === 'otp_sent' || f.type === 'error');
  assert.equal(sent.type, 'otp_sent');

  const code = await latestDevOtp(email);
  assert.ok(code, 'the dev-captured code is readable from dev_otps');
  assert.match(code, /^[0-9]{8}$/);

  send(ws, { type: 'verify_otp', email, code });
  const me = await nextFrame(ws, (f) => f.type === 'me' || f.type === 'error');
  assert.equal(me.type, 'me');
  assert.equal(me.email, email);
  assert.equal(me.email_verified, true);
  // ticket B6+B7+B9 decision 4: verify_otp_code success releases the `email` task itself, and -
  // this being the first verification on this device - the `signup` task too, both server-side,
  // never a client claim_task call (which now refuses both as not_claimable). db/seed.sql: email
  // = 200, signup = 1000.
  assert.equal(me.reward, 1200, 'the me reply carries the combined email + signup reward');
  assert.equal(me.coins, 1000 + 1200, 'both rewards are applied to the balance');

  const { rows } = await pool.query(
    "select task_id from public.task_claims where player_id = $1 order by task_id",
    [welcome.me.id],
  );
  assert.deepEqual(
    rows.map((r) => r.task_id),
    ['email', 'signup'],
    'both task_claims rows exist for this player',
  );
  ws.close();
});

test('five wrong codes in a row locks the code out with too_many_attempts', async () => {
  const ws = connect();
  await whenOpen(ws);
  await authAnonymous(ws);

  const email = `otp-wrong-${Date.now()}@example.com`;
  send(ws, { type: 'request_otp', email });
  await nextFrame(ws, (f) => f.type === 'otp_sent');

  for (let i = 0; i < 4; i++) {
    send(ws, { type: 'verify_otp', email, code: '00000000' });
    const err = await nextFrame(ws, (f) => f.type === 'error');
    assert.equal(err.code, 'invalid_code', `guess ${i + 1} of 5`);
  }
  send(ws, { type: 'verify_otp', email, code: '00000000' });
  const locked = await nextFrame(ws, (f) => f.type === 'error');
  assert.equal(locked.code, 'too_many_attempts');
  ws.close();
});

test('a second socket verifying an email already confirmed on another player is switched into that player (re-login), not email_taken', async () => {
  const email = `otp-shared-${Date.now()}@example.com`;

  const ws1 = connect();
  await whenOpen(ws1);
  const welcome1 = await authAnonymous(ws1);
  send(ws1, { type: 'request_otp', email });
  await nextFrame(ws1, (f) => f.type === 'otp_sent');
  const code1 = await latestDevOtp(email);
  send(ws1, { type: 'verify_otp', email, code: code1 });
  const me1 = await nextFrame(ws1, (f) => f.type === 'me');
  assert.equal(me1.email, email);
  ws1.close();

  const ws2 = connect();
  await whenOpen(ws2);
  const welcome2 = await authAnonymous(ws2);
  assert.notEqual(welcome2.me.id, welcome1.me.id, 'ws2 starts as its own, separate anonymous player');

  send(ws2, { type: 'request_otp', email }); // request_otp on a known email must still be allowed
  await nextFrame(ws2, (f) => f.type === 'otp_sent');
  const code2 = await latestDevOtp(email);
  send(ws2, { type: 'verify_otp', email, code: code2 });
  const result = await nextFrame(ws2, (f) => f.type === 'me' || f.type === 'error');
  assert.equal(result.type, 'me');
  assert.equal(result.id, welcome1.me.id, 'the socket is switched to the existing, verified player - not merged, not refused');
  assert.equal(result.email, email);
  assert.equal(result.email_verified, true);
  assert.ok(result.token, 'the switch carries a fresh token for the player being logged into');

  // The switch is real, not cosmetic: further requests on this socket now act as player 1.
  send(ws2, { type: 'get_me' });
  const me = await nextFrame(ws2, (f) => f.type === 'me');
  assert.equal(me.id, welcome1.me.id);

  // The anonymous player ws2 started as is left untouched - no merge, no delete.
  const { rows } = await pool.query('select email from public.players where id = $1', [welcome2.me.id]);
  assert.equal(rows[0].email, null);

  ws2.close();
});

test('a kiosk connection gets not_available for request_otp and verify_otp', async () => {
  const ws = connect();
  await whenOpen(ws);
  send(ws, { type: 'auth', kiosk: DEV_KIOSK_SECRET });
  await nextFrame(ws, (f) => f.type === 'welcome');

  send(ws, { type: 'request_otp', email: 'kiosk@example.com' });
  const err1 = await nextFrame(ws, (f) => f.type === 'error');
  assert.equal(err1.code, 'not_available');

  send(ws, { type: 'verify_otp', email: 'kiosk@example.com', code: '00000000' });
  const err2 = await nextFrame(ws, (f) => f.type === 'error');
  assert.equal(err2.code, 'not_available');
  ws.close();
});

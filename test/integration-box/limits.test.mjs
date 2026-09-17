// Integration tests for ticket S2 (server/limits.js wired into server/index.js): per-IP socket
// and connection-rate limits, per-socket play/query/frame budgets, the OTP IP limit, the
// superseded-OTP-code fix (red team D3), the HTTP body cap (red team D4), and /status.limits.
// Same harness as test/integration-box/server.test.mjs - a live database, the server started
// in-process with a stubbed feed.
//
//   bash db/run-tests.sh --keep
//   DATABASE_URL=postgresql://postgres:test@localhost:55432/postgres npm run test:server
//
// TRUST_PROXY is forced on here (server/limits.js reads it once at import) so each test can
// hand the server a distinct fake IP over X-Forwarded-For and exercise per-IP limits without
// waiting on real sliding windows or stepping on other tests sharing one address.

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
delete process.env.ELASTIC_API_KEY; // force the dev-capture path: codes land in dev_otps

const { createApp } = await import('../../server/index.js');
const { LIMITS } = await import('../../server/limits.js');

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
});

after(async () => {
  await app.close();
  await pool.end();
});

/** A fresh fake IP per call, so tests never contend over one IP's sliding windows. */
function freshIp() {
  ipCounter += 1;
  return `10.77.${Math.floor(ipCounter / 256)}.${ipCounter % 256}`;
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

/** Resolves when the server rejects the upgrade itself (429 before any 'open'), rather than
 * completing the handshake. */
function whenUpgradeRejected(ws) {
  return new Promise((resolve, reject) => {
    ws.once('unexpected-response', (_req, res) => resolve(res.statusCode));
    ws.once('open', () => reject(new Error('expected the upgrade to be rejected, but it opened')));
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

async function authAnonymous(ws) {
  send(ws, { type: 'auth' });
  return nextFrame(ws, (f) => f.type === 'welcome');
}

async function latestDevOtp(email) {
  const { rows } = await pool.query(
    'select token from public.dev_otps where email = $1 order by created_at desc limit 1',
    [email],
  );
  return rows[0]?.token;
}

// --- per-IP: open sockets -------------------------------------------------------------------

test(`the ${LIMITS.MAX_SOCKETS_PER_IP + 1}th open socket from one IP is refused; the ${LIMITS.MAX_SOCKETS_PER_IP}th is not`, async () => {
  const ip = freshIp();
  const sockets = [];
  try {
    for (let i = 0; i < LIMITS.MAX_SOCKETS_PER_IP; i++) {
      const ws = connect(ip);
      await whenOpen(ws);
      sockets.push(ws);
    }
    const rejected = connect(ip);
    const status = await whenUpgradeRejected(rejected);
    assert.equal(status, 429);
  } finally {
    for (const ws of sockets) ws.close();
  }
});

// --- per-IP: connection rate ------------------------------------------------------------------

test(`the ${LIMITS.MAX_CONNECTIONS_PER_IP_PER_MIN + 1}th connection in a minute from one IP is refused`, async () => {
  const ip = freshIp();
  // Open and close each one immediately, so this only ever tests the per-minute connection
  // window and never trips MAX_SOCKETS_PER_IP.
  for (let i = 0; i < LIMITS.MAX_CONNECTIONS_PER_IP_PER_MIN; i++) {
    const ws = connect(ip);
    await whenOpen(ws);
    ws.close();
    await whenClosed(ws);
  }
  const rejected = connect(ip);
  const status = await whenUpgradeRejected(rejected);
  assert.equal(status, 429);
});

// --- per-socket: play cadence ------------------------------------------------------------------

test('play twice inside PLAY_MIN_INTERVAL_MS gives rate_limited with retry_ms; round_opened still arrives for the first', async () => {
  const ws = connect(freshIp());
  await whenOpen(ws);
  await authAnonymous(ws);

  send(ws, { type: 'play', dir: 'up', lever: 1 });
  const opened = await nextFrame(ws, (f) => f.type === 'round_opened');
  assert.ok(opened.round_id);

  send(ws, { type: 'play', dir: 'down', lever: 1 });
  const refused = await nextFrame(ws, (f) => f.type === 'error');
  assert.equal(refused.code, 'rate_limited');
  assert.ok(refused.retry_ms > 0 && refused.retry_ms <= LIMITS.PLAY_MIN_INTERVAL_MS);

  ws.close();
});

// --- per-socket: frame flood -------------------------------------------------------------------

test(`flooding a socket past ${LIMITS.MAX_FRAMES_PER_SOCKET_PER_MIN} frames/min closes it with 4429`, async () => {
  const ws = connect(freshIp());
  await whenOpen(ws);
  const closed = whenClosed(ws);
  for (let i = 0; i < LIMITS.MAX_FRAMES_PER_SOCKET_PER_MIN + 5; i++) {
    ws.send(JSON.stringify({ type: 'noop' }));
  }
  const code = await closed;
  assert.equal(code, 4429);
});

// --- oversize frame --------------------------------------------------------------------------

test(`a frame over MAX_FRAME_BYTES (${LIMITS.MAX_FRAME_BYTES}) closes the socket`, async () => {
  const ws = connect(freshIp());
  await whenOpen(ws);
  const closed = whenClosed(ws);
  ws.send('x'.repeat(LIMITS.MAX_FRAME_BYTES + 1024));
  await closed; // maxPayload closes the connection itself; any close code counts as "closed"
});

// --- OTP: per-IP limit -------------------------------------------------------------------------

test(`the ${LIMITS.MAX_OTP_REQUESTS_PER_IP_PER_10MIN + 1}th request_otp from one IP in 10 minutes is rate_limited`, async () => {
  const ws = connect(freshIp());
  await whenOpen(ws);
  await authAnonymous(ws);

  for (let i = 0; i < LIMITS.MAX_OTP_REQUESTS_PER_IP_PER_10MIN; i++) {
    send(ws, { type: 'request_otp', email: `otp-ip-${i}-${Date.now()}@example.com` });
    const sent = await nextFrame(ws, (f) => f.type === 'otp_sent' || f.type === 'error');
    assert.equal(sent.type, 'otp_sent', `request ${i + 1} of ${LIMITS.MAX_OTP_REQUESTS_PER_IP_PER_10MIN}`);
  }
  send(ws, { type: 'request_otp', email: `otp-ip-over-${Date.now()}@example.com` });
  const refused = await nextFrame(ws, (f) => f.type === 'error');
  assert.equal(refused.code, 'rate_limited');
  assert.ok(refused.retry_ms > 0);
  ws.close();
});

// --- OTP: superseded code (red team D3) ---------------------------------------------------

test('requesting a new OTP code for the same email invalidates the earlier unused code', async () => {
  const ws = connect(freshIp());
  await whenOpen(ws);
  await authAnonymous(ws);

  const email = `otp-supersede-${Date.now()}@example.com`;
  send(ws, { type: 'request_otp', email });
  await nextFrame(ws, (f) => f.type === 'otp_sent');
  const firstCode = await latestDevOtp(email);
  assert.ok(firstCode);

  send(ws, { type: 'request_otp', email });
  await nextFrame(ws, (f) => f.type === 'otp_sent');
  const secondCode = await latestDevOtp(email);
  assert.notEqual(secondCode, firstCode);

  // The first code is superseded: its row now has used_at set, so verify_otp_code's "newest
  // unused" lookup returns the second row instead - the old code just mismatches that row's
  // hash and reads as a wrong guess (one of the second code's five attempts), not as its own
  // distinct "expired" outcome. Either way, the old code can never verify again.
  send(ws, { type: 'verify_otp', email, code: firstCode });
  const err = await nextFrame(ws, (f) => f.type === 'error');
  assert.equal(err.code, 'invalid_code', 'a superseded code can never verify');

  // The latest code still works.
  send(ws, { type: 'verify_otp', email, code: secondCode });
  const me = await nextFrame(ws, (f) => f.type === 'me' || f.type === 'error');
  assert.equal(me.type, 'me');
  assert.equal(me.email, email);
  ws.close();
});

// --- HTTP: body cap (red team D4) -----------------------------------------------------------

test('a 5 KB POST to /api/lead gets 413 and is never processed', async () => {
  const body = JSON.stringify({ type: 'email', email: 'oversize@example.com', page: 'x'.repeat(5 * 1024) });
  assert.ok(Buffer.byteLength(body) > LIMITS.MAX_HTTP_BODY_BYTES);
  const res = await fetch(`${httpUrl}/api/lead`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': freshIp() },
    body,
  });
  assert.equal(res.status, 413);
});

// --- /status.limits -------------------------------------------------------------------------

test('/status carries a limits object with ips_active, refusals_1m and blocked_ips', async () => {
  const ws = connect(freshIp());
  await whenOpen(ws);
  const res = await fetch(`${httpUrl}/status`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.limits, '/status.limits is present');
  assert.equal(typeof body.limits.ips_active, 'number');
  assert.equal(typeof body.limits.refusals_1m, 'number');
  assert.equal(typeof body.limits.blocked_ips, 'number');
  ws.close();
});

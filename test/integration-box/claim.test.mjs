// Socket + HTTP integration for the QR claim flow (ticket C9, docs/tickets/c9-qr-claim.md).
// Needs a live database exactly like test/integration-box/server.test.mjs - see that file's own
// header for the exact recipe (bash db/run-tests.sh --keep, export DATABASE_URL, npm run
// test:server).

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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

async function createTestKiosk(label, secret) {
  await pool.query("update public.kiosks set status = 'revoked' where label = $1 and status = 'active'", [label]);
  const { rows } = await pool.query(
    `insert into public.kiosks (label, secret_hash)
     values ($1, extensions.crypt($2, extensions.gen_salt('bf')))
     returning id`,
    [label, secret],
  );
  return rows[0].id;
}

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

/** Drives a kiosk from streak 4 to its 5th win over the real socket, returning the winning
 * round_settled frame - the one place claim_url/claim_expires_at actually get minted. */
async function winFifthRound(secret) {
  const kioskId = await createTestKiosk(`claim-${secret}`, secret);
  await pool.query(
    "update public.kiosks set streak = 4, session_state = 'playing', session_coins = 1000, last_round_at = now() where id = $1",
    [kioskId],
  );
  const ws = connect();
  await whenOpen(ws);
  send(ws, { type: 'auth', kiosk: secret });
  await nextFrame(ws, (f) => f.type === 'welcome');
  await nextFrame(ws, (f) => f.type === 'kiosk_session');

  currentPrice = 3000;
  await sleep(250);
  send(ws, { type: 'play', dir: 'up' });
  await nextFrame(ws, (f) => f.type === 'round_opened');
  currentPrice = 3100; // dir up, end > start: a win

  const settled = await nextFrame(ws, (f) => f.type === 'round_settled', 5500);
  const session = await nextFrame(ws, (f) => f.type === 'kiosk_session', 2000);
  ws.close();
  return { settled, session, kioskId };
}

test('a 5th win carries claim_url and claim_expires_at, and no coupon code anywhere in the frame', async () => {
  const { settled, session } = await winFifthRound('claim-flow-secret-0000000001');
  assert.equal(settled.state, 'won');
  assert.equal(settled.streak, 0, 'the win resets the streak');
  assert.ok(settled.claim_url, 'round_settled carries an absolute claim_url');
  assert.ok(settled.claim_url.startsWith(process.env.PUBLIC_URL), 'claim_url is built from PUBLIC_URL');
  assert.ok(settled.claim_expires_at, 'round_settled carries the claim link expiry');
  assert.equal(settled.coupon, undefined, 'the code itself never rides on round_settled');
  assert.equal(settled.code, undefined);

  assert.equal(session.claim_url, settled.claim_url, "kiosk_session mirrors round_settled's own claim_url");
  assert.equal(session.streak_target, 5, 'kiosk_session reports the default streak target');
  assert.equal(session.coupon, undefined);
});

test('GET /api/claim/<token> answers ready, then claimed after a successful POST', async () => {
  const { settled } = await winFifthRound('claim-flow-secret-0000000002');
  const token = new URL(settled.claim_url).pathname.split('/').pop();

  const readyRes = await fetch(`http://localhost:${port}/api/claim/${token}`);
  assert.equal(readyRes.status, 200);
  const ready = await readyRes.json();
  assert.equal(ready.state, 'ready');
  assert.ok(ready.expires_at);

  const postRes = await fetch(`http://localhost:${port}/api/claim/${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'integration-claim@example.com' }),
  });
  assert.equal(postRes.status, 200);
  const claimed = await postRes.json();
  assert.equal(claimed.ok, true);
  assert.ok(claimed.code, 'the successful claim returns the coupon code, exactly once');

  const secondPost = await fetch(`http://localhost:${port}/api/claim/${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'someone-else@example.com' }),
  });
  assert.equal(secondPost.status, 409);
  const secondBody = await secondPost.json();
  assert.equal(secondBody.error, 'already_claimed');

  const reopenRes = await fetch(`http://localhost:${port}/api/claim/${token}`);
  const reopened = await reopenRes.json();
  assert.equal(reopened.state, 'claimed');
  assert.match(reopened.email_masked, /^int\*+aim@e\*\*\.com$/, 'the masked email never reveals the full address');
});

test('GET /api/claim/<unknown token> answers invalid, never a 500', async () => {
  const res = await fetch(`http://localhost:${port}/api/claim/this-token-was-never-issued`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.state, 'invalid');
});

test('POST /api/claim/<token> with a bad email is refused before touching the database', async () => {
  const { settled } = await winFifthRound('claim-flow-secret-0000000003');
  const token = new URL(settled.claim_url).pathname.split('/').pop();
  const res = await fetch(`http://localhost:${port}/api/claim/${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'not-an-email' }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, 'invalid_email');

  const status = await fetch(`http://localhost:${port}/api/claim/${token}`).then((r) => r.json());
  assert.equal(status.state, 'ready', 'the link is still open for a real email after the rejection');
});

test('an expired claim link is refused, and the sweep releases its coupon back to available', async () => {
  const { settled, kioskId } = await winFifthRound('claim-flow-secret-0000000004');
  const token = new URL(settled.claim_url).pathname.split('/').pop();

  await pool.query("update public.claim_links set expires_at = now() - interval '1 minute' where token = $1", [
    token,
  ]);

  const res = await fetch(`http://localhost:${port}/api/claim/${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'too-late@example.com' }),
  });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.error, 'expired');

  const { rows: beforeRows } = await pool.query(
    "select c.status from public.coupons c join public.claim_links cl on cl.coupon_id = c.id where cl.token = $1",
    [token],
  );
  assert.equal(beforeRows[0].status, 'reserved', 'a refused expired POST does not itself release the coupon');

  const released = await (await import('../../server/ledger.js')).releaseExpiredClaims();
  assert.ok(released >= 1, "the sweep function releases at least this test's own stale reservation");

  const { rows: afterRows } = await pool.query(
    "select c.status from public.coupons c join public.claim_links cl on cl.coupon_id = c.id where cl.token = $1",
    [token],
  );
  assert.equal(afterRows[0].status, 'available', 'the coupon is available again once the sweep runs');

  const statusRes = await fetch(`http://localhost:${port}/api/claim/${token}`);
  const status = await statusRes.json();
  assert.equal(status.state, 'expired');

  await pool.query("update public.kiosks set status = 'active' where id = $1", [kioskId]);
});

test('POST /api/claim/* is rate limited at 5 per 10 minutes per IP (LIMITS.MAX_CLAIM_REQUESTS_PER_IP_PER_10MIN)', async () => {
  // A fresh app so this test's own attempts start from an empty budget, independent of every
  // other test in this file that has already posted to this same server instance's shared IP
  // window. LIMITS itself is read once at import time (server/limits.js's own module doc), so
  // the production default (5) is what this exercises, not an env override set this late.
  const rateApp = createApp({ finnhubToken: null });
  const ratePort = await rateApp.start(0, { startFeed: false });
  const { LIMITS } = await import('../../server/limits.js');
  try {
    const attempt = () =>
      fetch(`http://localhost:${ratePort}/api/claim/whatever-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'x@example.com' }),
      });
    for (let i = 0; i < LIMITS.MAX_CLAIM_REQUESTS_PER_IP_PER_10MIN; i++) {
      const res = await attempt();
      assert.notEqual(res.status, 429, `attempt ${i + 1} should not be rate limited yet`);
    }
    const overBudget = await attempt();
    assert.equal(overBudget.status, 429);
    const body = await overBudget.json();
    assert.equal(body.error, 'rate_limited');
  } finally {
    await rateApp.close();
  }
});

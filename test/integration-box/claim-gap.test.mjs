// Gap cases for the post-win kiosk/claim flow (TICKET.md).
//
// These live in their own file so they can run against a fresh app with a generous
// claim-attempt budget, independent of the rate-limit test in claim.test.mjs.

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
process.env.MAX_CLAIM_REQUESTS_PER_IP_PER_10MIN ??= '1000';

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

async function mintClaimLink(secret, code, token, expiresAt) {
  const kioskId = await createTestKiosk(`claim-gap-${secret}`, secret);
  const { rows: couponRows } = await pool.query(
    "insert into public.coupons (code, status) values ($1, 'reserved') returning id",
    [code],
  );
  await pool.query(
    'insert into public.claim_links (token, coupon_id, kiosk_id, expires_at) values ($1, $2, $3, $4)',
    [token, couponRows[0].id, kioskId, expiresAt],
  );
  return { kioskId, couponId: couponRows[0].id };
}

async function winAtStreak(secret, startStreak) {
  const kioskId = await createTestKiosk(`claim-streak-${secret}`, secret);
  await pool.query(
    "update public.kiosks set streak = $2, session_state = 'playing', session_coins = 1000, last_round_at = now() where id = $1",
    [kioskId, startStreak],
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
  currentPrice = 3100;

  const settled = await nextFrame(ws, (f) => f.type === 'round_settled', 5500);
  const session = await nextFrame(ws, (f) => f.type === 'kiosk_session', 2000);
  ws.close();
  return { settled, session, kioskId };
}

test('N1. an ordinary win that is not the third in a row mints no claim link and no coupon code', async () => {
  const { settled, session } = await winAtStreak('not-third-win-00000000000001', 1);
  assert.equal(settled.state, 'playing', 'a non-target win keeps the session in play');
  assert.equal(settled.streak, 2);
  assert.ok(!settled.claim_url, 'a second-in-a-row win must not mint a claim_url');
  assert.ok(!settled.coupon);
  assert.ok(!session.claim_url);
});

test('C1. the code shown belongs to that link and no other', async () => {
  const suffix = Date.now();
  const tokenA = `c1-token-a-${suffix}`;
  const tokenB = `c1-token-b-${suffix}`;
  const codeA = `C1-CODE-A-${suffix}`;
  const codeB = `C1-CODE-B-${suffix}`;
  const expiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  await mintClaimLink('c1-kiosk-a', codeA, tokenA, expiry);
  await mintClaimLink('c1-kiosk-b', codeB, tokenB, expiry);

  const postA = await fetch(`http://localhost:${port}/api/claim/${tokenA}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'c1-a@example.com' }),
  });
  assert.equal(postA.status, 200);
  const bodyA = await postA.json();
  assert.equal(bodyA.code, codeA, 'claiming link A returns coupon A');

  const postB = await fetch(`http://localhost:${port}/api/claim/${tokenB}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'c1-b@example.com' }),
  });
  assert.equal(postB.status, 200);
  const bodyB = await postB.json();
  assert.equal(bodyB.code, codeB, 'claiming link B returns coupon B');
});

test('C2. a second claim on the same link never issues a second code', async () => {
  const suffix = Date.now();
  const token = `c2-token-${suffix}`;
  const code = `C2-CODE-${suffix}`;
  const expiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  await mintClaimLink('c2-kiosk', code, token, expiry);

  const first = await fetch(`http://localhost:${port}/api/claim/${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'c2-first@example.com' }),
  });
  assert.equal(first.status, 200);
  const firstBody = await first.json();
  assert.equal(firstBody.code, code);

  const second = await fetch(`http://localhost:${port}/api/claim/${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'c2-second@example.com' }),
  });
  assert.equal(second.status, 409);
  const secondBody = await second.json();
  assert.equal(secondBody.error, 'already_claimed');

  const status = await fetch(`http://localhost:${port}/api/claim/${token}`).then((r) => r.json());
  assert.equal(status.state, 'claimed');
  assert.match(status.email_masked, /^c2\*+st@e\*\*\.com$/, 'the reopen shows the original email masked');

  const { rows } = await pool.query('select email from public.claim_links where token = $1', [token]);
  assert.equal(rows[0].email, 'c2-first@example.com', 'the stored email stays the first one');
});

test('C3. two simultaneous claims on the same link yield exactly one code', async () => {
  const suffix = Date.now();
  const token = `c3-token-${suffix}`;
  const code = `C3-CODE-${suffix}`;
  const expiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  await mintClaimLink('c3-kiosk', code, token, expiry);

  const emails = ['c3-a@example.com', 'c3-b@example.com'];
  const results = await Promise.all(
    emails.map((email) =>
      fetch(`http://localhost:${port}/api/claim/${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      }),
    ),
  );

  const bodies = await Promise.all(results.map((r) => r.json()));
  const okResults = results.filter((r) => r.status === 200);
  const refusedResults = results.filter((r) => r.status === 409);
  assert.equal(okResults.length, 1, 'exactly one concurrent claim succeeds');
  assert.equal(refusedResults.length, 1, 'the other concurrent claim is refused');
  assert.equal(bodies.filter((b) => b.ok).length, 1, 'exactly one body carries the code');
  assert.equal(bodies.filter((b) => b.error === 'already_claimed').length, 1);

  const { rows } = await pool.query('select status from public.coupons where code = $1', [code]);
  assert.equal(rows[0].status, 'claimed', 'exactly one coupon moved to claimed');
});

test('N2. claiming one link leaves every other live link untouched and still claimable', async () => {
  const suffix = Date.now();
  const tokenA = `n2-token-a-${suffix}`;
  const tokenB = `n2-token-b-${suffix}`;
  const codeA = `N2-CODE-A-${suffix}`;
  const codeB = `N2-CODE-B-${suffix}`;
  const expiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  await mintClaimLink('n2-kiosk-a', codeA, tokenA, expiry);
  await mintClaimLink('n2-kiosk-b', codeB, tokenB, expiry);

  const claimA = await fetch(`http://localhost:${port}/api/claim/${tokenA}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'n2-a@example.com' }),
  });
  assert.equal(claimA.status, 200);

  const statusB = await fetch(`http://localhost:${port}/api/claim/${tokenB}`).then((r) => r.json());
  assert.equal(statusB.state, 'ready', 'link B is still ready after link A was claimed');

  const claimB = await fetch(`http://localhost:${port}/api/claim/${tokenB}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'n2-b@example.com' }),
  });
  assert.equal(claimB.status, 200);
  const bodyB = await claimB.json();
  assert.equal(bodyB.code, codeB);
});

test('C7. a mail failure does not cost the winner their code', async () => {
  const originalFetch = global.fetch;
  const originalEnv = process.env.ELASTIC_API_KEY;
  process.env.ELASTIC_API_KEY = 'fake-key-for-test';

  let elasticCallCount = 0;
  global.fetch = async (url, init) => {
    if (String(url).includes('api.elasticemail.com')) {
      elasticCallCount += 1;
      throw new Error('forced elastic failure');
    }
    return originalFetch(url, init);
  };

  const suffix = Date.now();
  const token = `c7-token-${suffix}`;
  const code = `C7-CODE-${suffix}`;
  const expiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  await mintClaimLink('c7-kiosk', code, token, expiry);

  let logError = '';
  const originalConsoleError = console.error;
  console.error = (...args) => {
    logError += args.map(String).join(' ');
  };

  try {
    const res = await fetch(`http://localhost:${port}/api/claim/${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'c7-winner@example.com' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.code, code, 'the successful claim still returns the code even though the mailer failed');
    assert.ok(elasticCallCount >= 1, 'the mailer was called');

    const status = await fetch(`http://localhost:${port}/api/claim/${token}`).then((r) => r.json());
    assert.equal(status.state, 'claimed');

    const { rows } = await pool.query('select status from public.coupons where code = $1', [code]);
    assert.equal(rows[0].status, 'claimed', 'the coupon stayed claimed');
    assert.match(logError, /sendClaimCode failed/, 'the failure is logged, not silent');
  } finally {
    global.fetch = originalFetch;
    console.error = originalConsoleError;
    if (originalEnv === undefined) delete process.env.ELASTIC_API_KEY;
    else process.env.ELASTIC_API_KEY = originalEnv;
  }
});

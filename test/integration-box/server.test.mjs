// Socket integration tests for the box game server (ticket 3: server/index.js, rounds.js,
// ledger.js). Written by the same agent that built the server against the acceptance criteria
// in docs/box-plan.md and docs/box-spec.md - not a substitute for the blind acceptance pass
// the project's working agreements call for from an agent that has not seen this code.
//
// Needs a live database: run
//   bash db/run-tests.sh --keep
// and export the DATABASE_URL it prints before running this suite.
//
//   DATABASE_URL=postgresql://postgres:test@localhost:55432/postgres npm run test:server
//
// The server is started in-process on a random port with a stubbed feed (no Finnhub token,
// so only the PAXG sources exist); the feed is driven directly with feed._injectTick so the
// tests control price without a network dependency.

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

const { createApp, signToken } = await import('../../server/index.js');
const DAY = 24 * 60 * 60;

const DEV_KIOSK_SECRET = 'dev-kiosk-secret-0001';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let app;
let port;
let wsUrl;
let priceTimer;
let currentPrice = 3000;
let pool;

before(async () => {
  app = createApp({ finnhubToken: null });
  // startFeed: false - no real OKX/Binance socket ever opens; every tick in this suite comes
  // from feed._injectTick, so prices are fully test-controlled and never race live ticks.
  port = await app.start(0, { startFeed: false });
  wsUrl = `ws://localhost:${port}/ws`;
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

  priceTimer = setInterval(() => {
    app.feed._injectTick('okx', currentPrice, Date.now());
  }, 200);

  // Wait for the first published tick so feed.latest() is non-null before any test plays.
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

/** A fresh kiosk row for tests that need to control a session's starting state directly,
 * independent of the shared DEV_KIOSK_SECRET kiosk other tests in this file also drive. */
async function createTestKiosk(label, secret) {
  // A kept database is reused across runs: retire any earlier kiosk with this label first so
  // exactly one active kiosk holds this secret and auth cannot land on a stale duplicate.
  await pool.query("update public.kiosks set status = 'revoked' where label = $1 and status = 'active'", [label]);
  const { rows } = await pool.query(
    `insert into public.kiosks (label, secret_hash)
     values ($1, extensions.crypt($2, extensions.gen_salt('bf')))
     returning id`,
    [label, secret],
  );
  return rows[0].id;
}

// A server reply can be followed immediately by another (welcome then hello, for example),
// both delivered inside the same synchronous flush of the client's socket. Attaching a fresh
// 'message' listener per nextFrame() call would lose whichever frame arrives before the next
// await gets a listener registered, so every connection instead gets ONE persistent listener
// that buffers frames into an inbox; nextFrame reads from that buffer first and only then
// waits for new arrivals.
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

/** Resolve with the next frame matching predicate (buffered or still to arrive); reject on timeout. */
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

// --- auth --------------------------------------------------------------------------------

test('a frame before auth gets unauthenticated', async () => {
  const ws = connect();
  await whenOpen(ws);
  send(ws, { type: 'get_me' });
  const frame = await nextFrame(ws, (f) => f.type === 'error');
  assert.equal(frame.code, 'unauthenticated');
  ws.close();
});

test('anonymous auth issues a token that re-authenticates to the same player', async () => {
  const ws1 = connect();
  await whenOpen(ws1);
  const welcome1 = await authAnonymous(ws1);
  assert.ok(welcome1.token, 'welcome carries a token');
  assert.equal(welcome1.me.coins, 1000);
  assert.equal(welcome1.me.record, 1000);
  assert.equal(welcome1.me.streak, 0);
  ws1.close();

  const ws2 = connect();
  await whenOpen(ws2);
  send(ws2, { type: 'auth', token: welcome1.token });
  const welcome2 = await nextFrame(ws2, (f) => f.type === 'welcome');
  assert.equal(welcome2.me.id, welcome1.me.id, 'same player id on re-auth');
  ws2.close();
});

test('a garbage token is treated as no token: a fresh player, not an error', async () => {
  const ws = connect();
  await whenOpen(ws);
  send(ws, { type: 'auth', token: 'not-a-real-token' });
  const welcome = await nextFrame(ws, (f) => f.type === 'welcome' || f.type === 'error');
  assert.equal(welcome.type, 'welcome');
  assert.equal(welcome.me.coins, 1000);
  ws.close();
});

test('hello follows welcome with the current price', async () => {
  const ws = connect();
  await whenOpen(ws);
  send(ws, { type: 'auth' });
  await nextFrame(ws, (f) => f.type === 'welcome');
  const hello = await nextFrame(ws, (f) => f.type === 'hello');
  assert.equal(typeof hello.price, 'number');
  ws.close();
});

// --- rounds --------------------------------------------------------------------------------

test('play opens fast and settles on time with economy-correct coins', async () => {
  const ws = connect();
  await whenOpen(ws);
  const welcome = await authAnonymous(ws);
  assert.equal(welcome.me.coins, 1000);

  currentPrice = 3000;
  await sleep(250); // let at least one tick at 3000 land before the round opens

  const t0 = Date.now();
  send(ws, { type: 'play', dir: 'up', lever: 1 });
  const opened = await nextFrame(ws, (f) => f.type === 'round_opened');
  const openMs = Date.now() - t0;
  assert.ok(openMs < 100, `round_opened took ${openMs}ms, want < 100ms`);
  assert.equal(opened.start_price, 3000);
  assert.ok(opened.round_id);
  assert.ok(opened.start_at);

  currentPrice = 3100; // dir up, end > start: a win

  const settled = await nextFrame(ws, (f) => f.type === 'round_settled', 5500);
  const settleMs = Date.now() - t0;
  assert.ok(settleMs >= 5000 && settleMs <= 5300, `round_settled took ${settleMs}ms, want 5000-5300ms`);
  assert.equal(settled.round_id, opened.round_id);
  assert.equal(settled.outcome, 'win');
  assert.equal(settled.start_price, 3000);
  assert.equal(settled.end_price, 3100);
  assert.equal(settled.mult, 1, 'streak was 0 before this round: 1x');
  assert.equal(settled.delta, 100, 'stake 100 x lever 1 x mult 1');
  assert.equal(settled.coins, 1100);
  assert.equal(settled.streak, 1);
  assert.equal(settled.record, 1100);
  assert.equal(settled.best_streak, 1);
  ws.close();
});

test('a lost round debits the stake and resets the streak', async () => {
  const ws = connect();
  await whenOpen(ws);
  await authAnonymous(ws);

  currentPrice = 5000;
  await sleep(250);
  send(ws, { type: 'play', dir: 'up', lever: 2 });
  const opened = await nextFrame(ws, (f) => f.type === 'round_opened');
  assert.equal(opened.start_price, 5000);

  currentPrice = 4900; // dir up, end < start: a loss

  const settled = await nextFrame(ws, (f) => f.type === 'round_settled', 5500);
  assert.equal(settled.outcome, 'lose');
  assert.equal(settled.coins, 800, '1000 - stake(200)');
  assert.equal(settled.streak, 0);
  ws.close();
});

test('two plays 500ms apart: the second is round_in_flight', async () => {
  const ws = connect();
  await whenOpen(ws);
  await authAnonymous(ws);

  currentPrice = 3000;
  await sleep(250);
  send(ws, { type: 'play', dir: 'up', lever: 1 });
  await nextFrame(ws, (f) => f.type === 'round_opened');

  await sleep(500);
  send(ws, { type: 'play', dir: 'down', lever: 1 });
  const second = await nextFrame(ws, (f) => f.type === 'round_opened' || f.type === 'error');
  assert.equal(second.type, 'error');
  assert.equal(second.code, 'round_in_flight');

  // Drain the first round's verdict so it does not leak into a later test.
  await nextFrame(ws, (f) => f.type === 'round_settled', 5500);
  ws.close();
});

test('disconnect right after round_opened still settles; reconnect delivers the missed verdict once, then a fresh me', async () => {
  const ws = connect();
  await whenOpen(ws);
  const welcome = await authAnonymous(ws);
  const token = welcome.token;
  const roundsBefore = welcome.me.rounds;

  currentPrice = 3000;
  await sleep(250);
  send(ws, { type: 'play', dir: 'up', lever: 1 });
  const opened = await nextFrame(ws, (f) => f.type === 'round_opened');
  currentPrice = 3100;
  ws.close();

  await sleep(6000); // well past the 5.0-5.3s settle window

  const ws2 = connect();
  await whenOpen(ws2);
  send(ws2, { type: 'auth', token });
  const welcome2 = await nextFrame(ws2, (f) => f.type === 'welcome');
  assert.equal(welcome2.me.id, welcome.me.id);

  const settled = await nextFrame(ws2, (f) => f.type === 'round_settled', 2000);
  assert.equal(settled.round_id, opened.round_id);
  assert.equal(settled.outcome, 'win');

  const me = await nextFrame(ws2, (f) => f.type === 'me', 2000);
  assert.equal(me.rounds, roundsBefore + 1);
  assert.equal(me.coins, settled.coins);

  // Exactly one verdict: nothing else round_settled-shaped should follow.
  await assert.rejects(nextFrame(ws2, (f) => f.type === 'round_settled', 600));
  ws2.close();
});

// --- kiosk -----------------------------------------------------------------------------

test('kiosk auth plays and settles with a streak field', async () => {
  const ws = connect();
  await whenOpen(ws);
  send(ws, { type: 'auth', kiosk: DEV_KIOSK_SECRET });
  const welcome = await nextFrame(ws, (f) => f.type === 'welcome');
  assert.equal(welcome.kiosk, true);
  assert.equal(typeof welcome.streak, 'number');

  currentPrice = 3000;
  await sleep(250);
  send(ws, { type: 'play', dir: 'up' }); // kiosk ignores lever
  const opened = await nextFrame(ws, (f) => f.type === 'round_opened');
  assert.equal(opened.start_price, 3000);

  currentPrice = 3100;
  const settled = await nextFrame(ws, (f) => f.type === 'round_settled', 5500);
  assert.equal(typeof settled.streak, 'number');
  assert.ok(['win', 'lose', 'flat'].includes(settled.outcome));
  ws.close();
});

test('a fake kiosk secret is kiosk_unauthorized', async () => {
  const ws = connect();
  await whenOpen(ws);
  send(ws, { type: 'auth', kiosk: 'this-is-not-a-real-kiosk-secret' });
  const frame = await nextFrame(ws, (f) => f.type === 'error');
  assert.equal(frame.code, 'kiosk_unauthorized');
  ws.close();
});

// --- kiosk session (ticket C1) ------------------------------------------------------------

test('a fresh kiosk welcome carries an idle kiosk_session, and a round reports the new coins/state', async () => {
  const secret = 'kiosk-session-flow-secret-01';
  await createTestKiosk('session-flow', secret);

  const ws = connect();
  await whenOpen(ws);
  send(ws, { type: 'auth', kiosk: secret });
  await nextFrame(ws, (f) => f.type === 'welcome');
  const session = await nextFrame(ws, (f) => f.type === 'kiosk_session');
  assert.deepEqual(
    { coins: session.coins, streak: session.streak, state: session.state },
    { coins: 1000, streak: 0, state: 'idle' },
    'a kiosk that has never played starts idle at 1000 coins',
  );

  currentPrice = 3000;
  await sleep(250);
  send(ws, { type: 'play', dir: 'up', lever: 1 });
  await nextFrame(ws, (f) => f.type === 'round_opened');
  currentPrice = 3100; // dir up, end > start: a win

  const settled = await nextFrame(ws, (f) => f.type === 'round_settled', 5500);
  assert.equal(settled.outcome, 'win');
  assert.equal(settled.delta, 100, 'stake 100 x mult 1 (streak was 0)');
  assert.equal(settled.coins, 1100, 'the idle session started fresh at 1000 before the win was applied');
  assert.equal(settled.streak, 1);
  assert.equal(settled.state, 'playing');

  const afterSettle = await nextFrame(ws, (f) => f.type === 'kiosk_session');
  assert.deepEqual(
    { coins: afterSettle.coins, streak: afterSettle.streak, state: afterSettle.state },
    { coins: 1100, streak: 1, state: 'playing' },
    'kiosk_session mirrors round_settled after every kiosk round',
  );
  ws.close();
});

test('kiosk_reset (Claim/Done) returns the session to idle with coins and streak cleared', async () => {
  // Same kiosk as the previous test: left at coins 1100, streak 1, playing.
  const secret = 'kiosk-session-flow-secret-01';
  const ws = connect();
  await whenOpen(ws);
  send(ws, { type: 'auth', kiosk: secret });
  await nextFrame(ws, (f) => f.type === 'welcome');
  const before = await nextFrame(ws, (f) => f.type === 'kiosk_session');
  assert.deepEqual(
    { coins: before.coins, streak: before.streak, state: before.state },
    { coins: 1100, streak: 1, state: 'playing' },
  );

  send(ws, { type: 'kiosk_reset' });
  const reset = await nextFrame(ws, (f) => f.type === 'kiosk_session');
  assert.deepEqual(
    { coins: reset.coins, streak: reset.streak, state: reset.state },
    { coins: 1000, streak: 0, state: 'idle' },
    'kiosk_reset clears the session back to attract mode',
  );
  ws.close();
});

test('a lever the session cannot cover ends it as broke; the session then refuses play until reset', async () => {
  const secret = 'kiosk-session-broke-secret-01';
  const kioskId = await createTestKiosk('session-broke', secret);
  await pool.query(
    "update public.kiosks set session_coins = 150, session_state = 'playing', last_round_at = now() where id = $1",
    [kioskId],
  );

  const ws = connect();
  await whenOpen(ws);
  send(ws, { type: 'auth', kiosk: secret });
  await nextFrame(ws, (f) => f.type === 'welcome');
  await nextFrame(ws, (f) => f.type === 'kiosk_session');

  send(ws, { type: 'play', dir: 'up', lever: 5 }); // stake 500, the session only has 150
  const err = await nextFrame(ws, (f) => f.type === 'error' || f.type === 'round_opened');
  assert.equal(err.type, 'error');
  assert.equal(err.code, 'insufficient_coins');
  const broke = await nextFrame(ws, (f) => f.type === 'kiosk_session');
  assert.equal(broke.state, 'broke', 'the refusal is followed by the session state so the screen can react');

  send(ws, { type: 'play', dir: 'up', lever: 1 });
  const err2 = await nextFrame(ws, (f) => f.type === 'error' || f.type === 'round_opened');
  assert.equal(err2.type, 'error');
  assert.equal(err2.code, 'session_over', 'the failed lever already ended the session as broke');
  ws.close();
});

test('the idle sweep resets a stale kiosk session and pushes kiosk_session without a client action', async () => {
  const secret = 'kiosk-idle-sweep-secret-01';
  const kioskId = await createTestKiosk('idle-sweep', secret);

  // A separate app instance with a small, injectable idle threshold and sweep interval
  // (docs/layers.md C1), on its own port, so this fast sweep only ever touches this test's own
  // kiosk - never a kiosk another test in this file has mid-round on the shared app.
  const sweepApp = createApp({ finnhubToken: null, kioskIdleMs: 300, kioskSweepIntervalMs: 100 });
  const sweepPort = await sweepApp.start(0, { startFeed: false });
  try {
    const ws = connect(`ws://localhost:${sweepPort}/ws`);
    await whenOpen(ws);
    send(ws, { type: 'auth', kiosk: secret });
    await nextFrame(ws, (f) => f.type === 'welcome');
    await nextFrame(ws, (f) => f.type === 'kiosk_session');

    await pool.query(
      "update public.kiosks set session_coins = 777, streak = 3, session_state = 'playing', " +
        "last_round_at = now() - interval '1 second' where id = $1",
      [kioskId],
    );

    const swept = await nextFrame(ws, (f) => f.type === 'kiosk_session', 2000);
    assert.deepEqual(
      { coins: swept.coins, streak: swept.streak, state: swept.state },
      { coins: 1000, streak: 0, state: 'idle' },
      "the sweep pushes the reset session to the kiosk's live socket",
    );

    const { rows } = await pool.query(
      'select session_coins, streak, session_state from public.kiosks where id = $1',
      [kioskId],
    );
    assert.deepEqual(
      { coins: rows[0].session_coins, streak: rows[0].streak, state: rows[0].session_state },
      { coins: 1000, streak: 0, state: 'idle' },
      'the kiosk row itself is reset, not only the pushed frame',
    );
    ws.close();
  } finally {
    await sweepApp.close();
  }
});

// --- session policy (ticket C3a) --------------------------------------------------------

test('a token issued more than 7 days ago is renewed on welcome; a younger one is sent back unchanged', async () => {
  const ws1 = connect();
  await whenOpen(ws1);
  const welcome1 = await authAnonymous(ws1);
  const playerId = welcome1.me.id;
  ws1.close();

  const nowSeconds = Math.floor(Date.now() / 1000);

  const staleToken = signToken(playerId, 1, nowSeconds - 8 * DAY);
  const wsStale = connect();
  await whenOpen(wsStale);
  send(wsStale, { type: 'auth', token: staleToken });
  const staleWelcome = await nextFrame(wsStale, (f) => f.type === 'welcome');
  assert.equal(staleWelcome.me.id, playerId, 'still the same player');
  assert.notEqual(staleWelcome.token, staleToken, 'a token over 7 days old is replaced');
  wsStale.close();

  const freshToken = signToken(playerId, 1, nowSeconds - 3 * DAY);
  const wsFresh = connect();
  await whenOpen(wsFresh);
  send(wsFresh, { type: 'auth', token: freshToken });
  const freshWelcome = await nextFrame(wsFresh, (f) => f.type === 'welcome');
  assert.equal(freshWelcome.me.id, playerId, 'still the same player');
  assert.equal(freshWelcome.token, freshToken, 'a token under 7 days old is sent back unchanged');
  wsFresh.close();
});

test('an expired token, a tampered signature, and the old two-field format all yield a fresh player, never an error', async () => {
  const ws0 = connect();
  await whenOpen(ws0);
  const welcome0 = await authAnonymous(ws0);
  const originalId = welcome0.me.id;
  ws0.close();

  const nowSeconds = Math.floor(Date.now() / 1000);
  const expiredToken = signToken(originalId, 1, nowSeconds - 31 * DAY);

  const validToken = signToken(originalId, 1, nowSeconds);
  const lastChar = validToken.at(-1);
  const tamperedToken = validToken.slice(0, -1) + (lastChar === '0' ? '1' : '0');

  const oldFormatToken = `${originalId}.${'a'.repeat(64)}`;

  for (const token of [expiredToken, tamperedToken, oldFormatToken]) {
    const ws = connect();
    await whenOpen(ws);
    send(ws, { type: 'auth', token });
    const welcome = await nextFrame(ws, (f) => f.type === 'welcome' || f.type === 'error');
    assert.equal(welcome.type, 'welcome', `token should yield a fresh player, not an error: ${token}`);
    assert.notEqual(welcome.me.id, originalId, 'a bad token never resumes the original player');
    assert.equal(welcome.me.coins, 1000, 'a fresh anonymous player');
    ws.close();
  }
});

test('revoke_player_sessions invalidates every token already issued for that player', async () => {
  const ws1 = connect();
  await whenOpen(ws1);
  const welcome1 = await authAnonymous(ws1);
  const token = welcome1.token;
  const playerId = welcome1.me.id;
  ws1.close();

  await pool.query('select public.revoke_player_sessions($1)', [playerId]);

  const ws2 = connect();
  await whenOpen(ws2);
  send(ws2, { type: 'auth', token });
  const welcome2 = await nextFrame(ws2, (f) => f.type === 'welcome' || f.type === 'error');
  assert.equal(welcome2.type, 'welcome');
  assert.notEqual(welcome2.me.id, playerId, 'the revoked token no longer resumes the original player');
  assert.equal(welcome2.me.coins, 1000, 'a fresh anonymous player, not an error');
  ws2.close();
});

// --- http --------------------------------------------------------------------------------

test('GET /health is 200 with feed and db status', async () => {
  const res = await fetch(`http://localhost:${port}/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.db, true);
  assert.ok(body.feed && typeof body.feed === 'object');
});

test('POST /api/lead is 204', async () => {
  const res = await fetch(`http://localhost:${port}/api/lead`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'email', email: 'player@example.com', source: 'integration-test' }),
  });
  assert.equal(res.status, 204);
});

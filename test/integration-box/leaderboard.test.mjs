// Live leaderboard push (ticket C4, docs/layers.md): the server recomputes the top 10 after
// every player round settles and pushes a `leaderboard` frame to every WEB socket whenever
// those rows change - never to a kiosk, which has no email and is never ranked. Same harness as
// test/integration-box/server.test.mjs and otp.test.mjs - a live database, the server started
// in-process with a stubbed feed.
//
//   bash db/run-tests.sh --keep
//   DATABASE_URL=postgresql://postgres:test@localhost:55432/postgres npm run test:server
//
// This suite runs its own app instance with a short leaderboardDebounceMs so a push does not
// sit behind the production 1-second debounce for the length of a test run.

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
delete process.env.ELASTIC_API_KEY; // force the dev-capture path: codes land in dev_otps

const { createApp } = await import('../../server/index.js');

const DEV_KIOSK_SECRET = 'dev-kiosk-secret-0001';

let app;
let port;
let wsUrl;
let priceTimer;
let currentPrice = 3000;
let pool;

before(async () => {
  app = createApp({ finnhubToken: null, leaderboardDebounceMs: 50 });
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

// Same buffered-inbox connection helper as server.test.mjs and otp.test.mjs.
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

/** Resolves true if `predicate` matches within timeoutMs, false if it never does - for
 * asserting the ABSENCE of a frame, where nextFrame's rejection would also be a passing
 * result but reads backwards at the call site. */
function neverFrame(ws, predicate, timeoutMs) {
  return nextFrame(ws, predicate, timeoutMs).then(
    () => true,
    () => false,
  );
}

function send(ws, frame) {
  ws.send(JSON.stringify(frame));
}

/** Independent re-implementation of db/schema.sql's mask_email(), so this suite is not just
 * checking that the server agrees with itself: first and last character of the local part,
 * three to four asterisks between them, full domain (docs/layers.md C3, C4). */
function maskEmail(email) {
  const at = email.indexOf('@');
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (local.length <= 2) return `${local[0]}***@${domain}`;
  const stars = '*'.repeat(Math.min(Math.max(local.length - 2, 3), 4));
  return `${local[0]}${stars}${local.at(-1)}@${domain}`;
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

async function verifyFreshPlayer(ws, email) {
  const welcome = await authAnonymous(ws);
  send(ws, { type: 'request_otp', email });
  await nextFrame(ws, (f) => f.type === 'otp_sent');
  const code = await latestDevOtp(email);
  send(ws, { type: 'verify_otp', email, code });
  const me = await nextFrame(ws, (f) => f.type === 'me');
  assert.equal(me.email_verified, true);
  return { welcome, me };
}

async function playOneRound(ws, dir) {
  send(ws, { type: 'play', dir, lever: 1 });
  await nextFrame(ws, (f) => f.type === 'round_opened');
  return nextFrame(ws, (f) => f.type === 'round_settled', 5500);
}

// This suite's own kept database persists across runs (db/run-tests.sh --keep never wipes
// player rows a previous run left behind), so a plain win's record - a few hundred coins - is
// not a safe way to force this specific test player into an unbounded, ever-growing top 10.
// Instead, park the player's record at a strictly-increasing sentinel (settle_round only ever
// raises record with `greatest()`, so a normal win's small coin gain never lowers it): the
// newest test run's sentinel is always larger than every previous run's, so it is always rank
// 1 regardless of how many old test players are sitting in the database.
// players.record is a 32-bit int, so the sentinel is epoch seconds (comfortably under the
// ~2.1 billion int4 ceiling for a very long time) plus a small counter to break ties between
// two sentinels parked inside the same second - not epoch milliseconds, which overflows it.
let sentinelCounter = 0;
function nextSentinelRecord() {
  sentinelCounter += 1;
  return Math.floor(Date.now() / 1000) + sentinelCounter;
}

// public.leaderboard() ranks tournament_scores for the currently running tournament (ticket
// B1), not players.record any more - park the sentinel there, for whichever tournament
// current_tournament() resolves right now. This suite runs inside db/seed.sql's own t1 window
// (16-21 September 2026), same assumption TICKET.md's own E2E work makes.
async function parkRecordAtSentinel(email) {
  const record = nextSentinelRecord();
  const { rowCount } = await pool.query(
    `insert into public.tournament_scores (tournament_id, player_id, record)
       select ct.id, p.id, $1 from public.current_tournament() ct, public.players p where p.email = $2
     on conflict (tournament_id, player_id) do update set record = excluded.record`,
    [record, email],
  );
  if (rowCount === 0) {
    throw new Error(
      "no tournament is currently running - this suite needs one of db/seed.sql's tournament windows to be live",
    );
  }
  return record;
}

test('an anonymous welcome carries email_verified false; verifying flips it to true (me always carries the field)', async () => {
  const ws = connect();
  await whenOpen(ws);
  const welcome = await authAnonymous(ws);
  assert.equal(welcome.me.email_verified, false, 'a fresh anonymous player is not email_verified');
  assert.equal(welcome.me.display, null, 'no email yet, so no masked display either');
  ws.close();
});

test('a settled round that changes the top 10 pushes a leaderboard frame to the verified web socket', async () => {
  const ws = connect();
  await whenOpen(ws);
  const email = `lb-web-${Date.now()}@example.com`;
  await verifyFreshPlayer(ws, email);
  const record = await parkRecordAtSentinel(email);

  currentPrice = 3000;
  await new Promise((r) => setTimeout(r, 250));
  currentPrice = 3100; // dir up, end > start: a win - settle_round still runs, record stays put

  const [, lb] = await Promise.all([playOneRound(ws, 'up'), nextFrame(ws, (f) => f.type === 'leaderboard', 6000)]);
  assert.ok(Array.isArray(lb.rows));
  assert.ok(
    lb.rows.some((r) => r.display === maskEmail(email) && r.record === record),
    'the leaderboard push includes this player, masked, at their record',
  );
  ws.close();
});

// public.leaderboard()'s own pgTAP suite (db/tests/85_leaderboard_paging.sql) already proves the
// page-size and boundary math directly against the database; this suite proves the same paging
// reaches the client over the socket, plus the per-socket `me`/`legend` shaping that only exists
// at the server/index.js layer (ticket B2, B3).
//
// Fixture players that never need a live socket (fill rows for paging, or "a stranger ranked
// above me") are created directly through the same tests.create_confirmed_player() SQL helper
// the pgTAP suites use (loaded once, outside a transaction, by db/tests/00_helpers.sql - it
// persists in this --keep database) rather than through a real OTP round-trip: this file's
// server instance enforces the same per-IP OTP budget (server/limits.js's
// MAX_OTP_REQUESTS_PER_IP_PER_10MIN) a
// real deployment would, and only the tests that actually assert what a specific authenticated
// socket receives need a real verified player behind one.
async function createScoredPlayer(email, record) {
  const { rows } = await pool.query('select tests.create_confirmed_player($1) as id', [email]);
  const playerId = rows[0].id;
  const { rowCount } = await pool.query(
    `insert into public.tournament_scores (tournament_id, player_id, record)
       select ct.id, $1, $2 from public.current_tournament() ct
     on conflict (tournament_id, player_id) do update set record = excluded.record`,
    [playerId, record],
  );
  if (rowCount === 0) {
    throw new Error(
      "no tournament is currently running - this suite needs one of db/seed.sql's tournament windows to be live",
    );
  }
  return playerId;
}

test('a `leaderboard` request carries page/pages/total and the badge legend; the unsolicited push never carries a legend', async () => {
  const ws = connect();
  await whenOpen(ws);
  await authAnonymous(ws); // legend/page/pages/total need no email verification, just an authenticated web socket

  send(ws, { type: 'leaderboard' });
  const requested = await nextFrame(ws, (f) => f.type === 'leaderboard');
  assert.equal(requested.page, 1);
  assert.ok(requested.pages >= 1);
  assert.ok(requested.total >= 0);
  assert.ok(Array.isArray(requested.legend) && requested.legend.length === 6, 'the request reply carries all six badge tiers');
  assert.deepEqual(
    requested.legend.map((l) => l.tier),
    ['gold', 'silver', 'bronze', 'top10', 'top100', 'player'],
    'the legend is ordered by sort',
  );

  currentPrice = 3000;
  await new Promise((r) => setTimeout(r, 250));
  currentPrice = 3100;
  const [, pushed] = await Promise.all([playOneRound(ws, 'up'), nextFrame(ws, (f) => f.type === 'leaderboard', 6000)]);
  assert.equal(pushed.legend, undefined, 'the unsolicited live push never carries a legend (ticket B3 decision 3)');
  ws.close();
});

test('a page-2 request returns the next 20 rows, none of which are on page 1', async () => {
  const ws = connect();
  await whenOpen(ws);
  await authAnonymous(ws); // this test never checks `me`, so no verified player is needed

  const emails = Array.from({ length: 25 }, (_, i) => `lb-page-fill-${Date.now()}-${i}@example.com`);
  for (const email of emails) {
    await createScoredPlayer(email, 4000 + Math.floor(Math.random() * 1000));
  }

  send(ws, { type: 'leaderboard', page: 1 });
  const page1 = await nextFrame(ws, (f) => f.type === 'leaderboard');
  assert.equal(page1.rows.length, 20);
  assert.equal(page1.page, 1);

  send(ws, { type: 'leaderboard', page: 2 });
  const page2 = await nextFrame(ws, (f) => f.type === 'leaderboard');
  assert.equal(page2.page, 2);
  assert.ok(page2.rows.length >= 5, 'at least the 5 fill rows past the first page land on page 2');
  const page1Ranks = new Set(page1.rows.map((r) => r.rank));
  assert.ok(
    page2.rows.every((r) => !page1Ranks.has(r.rank)),
    'no rank on page 2 repeats a rank already shown on page 1',
  );
  ws.close();
});

test("`me` is computed per socket: two players settling together each see their own row, never the other's", async () => {
  const wsA = connect();
  const wsB = connect();
  await Promise.all([whenOpen(wsA), whenOpen(wsB)]);
  const emailA = `lb-me-a-${Date.now()}@example.com`;
  const emailB = `lb-me-b-${Date.now()}@example.com`;
  await verifyFreshPlayer(wsA, emailA);
  await verifyFreshPlayer(wsB, emailB);
  const recordA = await parkRecordAtSentinel(emailA);
  const recordB = await parkRecordAtSentinel(emailB);

  currentPrice = 3000;
  await new Promise((r) => setTimeout(r, 250));
  currentPrice = 3100;
  const [, , lbA, lbB] = await Promise.all([
    playOneRound(wsA, 'up'),
    playOneRound(wsB, 'up'),
    nextFrame(wsA, (f) => f.type === 'leaderboard', 6000),
    nextFrame(wsB, (f) => f.type === 'leaderboard', 6000),
  ]);
  assert.equal(lbA.me.display, maskEmail(emailA));
  assert.equal(lbA.me.record, recordA);
  assert.equal(lbB.me.display, maskEmail(emailB));
  assert.equal(lbB.me.record, recordB);
  wsA.close();
  wsB.close();
});

test('own-row identity is the player id, not the masked display string (closes gap G3)', async () => {
  // "ab" and "ac" both mask to "a***" (mask_email keeps only the first character when the local
  // part is 2 characters or shorter): two different real players, same domain (unique to this
  // test run so re-login never kicks in), an identical masked display between them.
  const ws = connect();
  await whenOpen(ws);
  const domain = `example-${Date.now()}.com`;
  const emailMine = `ab@${domain}`;
  const emailOther = `ac@${domain}`;
  await verifyFreshPlayer(ws, emailMine);
  const recordMine = await parkRecordAtSentinel(emailMine);
  await createScoredPlayer(emailOther, recordMine + 1000000); // a higher-ranked stranger with the same masked display

  send(ws, { type: 'leaderboard' });
  const lb = await nextFrame(ws, (f) => f.type === 'leaderboard');
  assert.equal(lb.me.display, maskEmail(emailMine));
  assert.equal(lb.me.record, recordMine, "my own record, not the same-masked stranger's higher one");
  ws.close();
});

test('a leaderboard push never reaches a kiosk socket', async () => {
  const kioskWs = connect();
  await whenOpen(kioskWs);
  send(kioskWs, { type: 'auth', kiosk: DEV_KIOSK_SECRET });
  await nextFrame(kioskWs, (f) => f.type === 'welcome');
  await nextFrame(kioskWs, (f) => f.type === 'kiosk_session');

  const webWs = connect();
  await whenOpen(webWs);
  const email = `lb-kiosk-guard-${Date.now()}@example.com`;
  await verifyFreshPlayer(webWs, email);
  await parkRecordAtSentinel(email);

  currentPrice = 3000;
  await new Promise((r) => setTimeout(r, 250));
  currentPrice = 3100;

  const [, gotOnWeb] = await Promise.all([
    playOneRound(webWs, 'up'),
    nextFrame(webWs, (f) => f.type === 'leaderboard', 6000),
  ]);
  assert.ok(gotOnWeb, 'sanity: the web socket did get the push for this settle');

  const gotOnKiosk = await neverFrame(kioskWs, (f) => f.type === 'leaderboard', 500);
  assert.equal(gotOnKiosk, false, 'the kiosk socket never receives a leaderboard frame');

  kioskWs.close();
  webWs.close();
});

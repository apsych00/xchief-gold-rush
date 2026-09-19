// Instagram follow reward integration tests (ticket K3, replacing B8's OAuth flow). Run against
// the box game server with the fake BoxAPI server in test/fakes/boxapi.mjs.
//
// Needs a live database:
//   bash db/run-tests.sh --keep
//   export DATABASE_URL=postgresql://postgres:test@localhost:55432/postgres
//   DATABASE_URL=... npm run test:server

import { test, before, beforeEach, after } from 'node:test';
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
process.env.MAX_ANON_PLAYERS_PER_IP_PER_10MIN ??= '1000';
process.env.MAX_CONNECTIONS_PER_IP_PER_MIN ??= '1000';
process.env.MAX_SOCKETS_PER_IP ??= '1000';
process.env.MAX_REWARD_CLAIMS_PER_IP_PER_HOUR_NO_DEVICE ??= '1000';

const { createApp } = await import('../../server/index.js');
const instagram = await import('../../server/instagram.js');
const { startFakeBoxApi } = await import('../fakes/boxapi.mjs');

let app;
let port;
let wsUrl;
let fake;
let pool;

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

function nextFrame(ws, predicate, timeoutMs = 4000) {
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// instagram_check also sits under the per-socket 1/s query budget (limits.checkQueryRate,
// ticket S2/K3 decision 3), unrelated to and unchanged by the per-player BoxAPI window this file
// tests. Every second-check case here waits past it first so what it observes is the BoxAPI
// window's own behaviour, not this unrelated per-socket budget.
const QUERY_BUDGET_CLEAR_MS = 1100;

async function authAnonymous(ws) {
  send(ws, { type: 'auth' });
  return nextFrame(ws, (f) => f.type === 'welcome');
}

// A fresh player who has entered `handle` and is ready to check.
async function startedPlayer(handle) {
  const ws = connect();
  await whenOpen(ws);
  const welcome = await authAnonymous(ws);
  send(ws, { type: 'instagram_start', handle });
  const started = await nextFrame(ws, (f) => f.type === 'instagram_started');
  return { ws, welcome, started };
}

before(async () => {
  fake = await startFakeBoxApi(0);
  process.env.BOXAPI_TOKEN = 'fake-token';
  process.env.BOXAPI_BASE = `${fake.url}/`;
  process.env.INSTAGRAM_HANDLE = 'xchief.global';
  // Run the freshness-retry loop instantly, and shrink the per-player check window so the
  // second-try grant test can make two genuine checks without a 20 s wait (both env vars are read
  // at call time by server/instagram.js and server/index.js). The grant delay (ticket K3 second
  // try) is zeroed too so the suite stays fast.
  process.env.INSTAGRAM_RETRY_DELAY_MS = '0';
  process.env.INSTAGRAM_CHECK_INTERVAL_MS = '50';
  process.env.INSTAGRAM_GRANT_DELAY_MS = '0';
  instagram.resetCache();

  app = createApp({ finnhubToken: null });
  port = await app.start(0, { startFeed: false });
  wsUrl = `ws://localhost:${port}/ws`;
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
});

beforeEach(async () => {
  // The kept database survives across test runs, so clear Instagram state before every test.
  await pool.query("delete from public.task_claims where task_id = 'instagram'");
  await pool.query('delete from public.instagram_accounts');
  fake.reset(); // also zeroes callCount() so "no BoxAPI call" assertions start from a clean slate
  instagram.resetCache();
});

after(async () => {
  await app.close();
  await pool.end();
  await fake.stop();
  delete process.env.BOXAPI_TOKEN;
  delete process.env.BOXAPI_BASE;
  delete process.env.INSTAGRAM_HANDLE;
  delete process.env.INSTAGRAM_RETRY_DELAY_MS;
  delete process.env.INSTAGRAM_CHECK_INTERVAL_MS;
  delete process.env.INSTAGRAM_GRANT_DELAY_MS;
});

test('happy path: a follower is verified and the reward is released once', async () => {
  const { ws, welcome, started } = await startedPlayer('follower');
  assert.ok(started.app_url && started.app_url.includes('instagram://'), 'instagram_started carries the app_url');
  assert.ok(started.profile_url, 'instagram_started carries the profile_url');
  assert.equal(started.our_handle, 'xchief.global', 'instagram_started carries the configured handle to follow');

  send(ws, { type: 'instagram_check' });
  const result = await nextFrame(ws, (f) => f.type === 'instagram_result');
  assert.equal(result.ok, true, 'the follow is verified');
  assert.equal(result.reward, 300, 'the reward is reported on the verifying check');

  const { rows: claims } = await pool.query(
    "select * from public.task_claims where player_id = $1 and task_id = 'instagram'",
    [welcome.me.id],
  );
  assert.equal(claims.length, 1, 'a task_claims row was created');

  const { rows: accounts } = await pool.query(
    'select check_attempts from public.instagram_accounts where player_id = $1 and verified_at is not null',
    [welcome.me.id],
  );
  assert.equal(accounts.length, 1, 'the instagram_accounts row is marked verified');
  assert.equal(accounts[0].check_attempts, 0, 'a first-check confirm grants without the attempt-based path');

  send(ws, { type: 'tasks' });
  const tasksFrame = await nextFrame(ws, (f) => f.type === 'tasks');
  const row = tasksFrame.rows.find((r) => r.id === 'instagram');
  assert.equal(row.claimed, true, 'the instagram row is marked claimed');
  ws.close();
});

test('a public non-follower is refused with not_following, and the attempt is recorded', async () => {
  const { ws, welcome } = await startedPlayer('nonfollower');
  send(ws, { type: 'instagram_check' });
  const result = await nextFrame(ws, (f) => f.type === 'instagram_result');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not_following');

  const { rows: claims } = await pool.query(
    "select * from public.task_claims where player_id = $1 and task_id = 'instagram'",
    [welcome.me.id],
  );
  assert.equal(claims.length, 0, 'no reward for a non-follower');

  const { rows: accounts } = await pool.query(
    'select check_attempts, verified_at from public.instagram_accounts where player_id = $1',
    [welcome.me.id],
  );
  assert.equal(accounts[0].check_attempts, 1, 'the first genuine check is recorded as one attempt');
  assert.equal(accounts[0].verified_at, null, 'not verified yet - only the second check grants');
  ws.close();
});

test('a private account is refused with private', async () => {
  const { ws } = await startedPlayer('privateuser');
  send(ws, { type: 'instagram_check' });
  const result = await nextFrame(ws, (f) => f.type === 'instagram_result');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'private');
  ws.close();
});

test('an unknown handle is refused with not_found', async () => {
  const { ws } = await startedPlayer('ghostaccount');
  send(ws, { type: 'instagram_check' });
  const result = await nextFrame(ws, (f) => f.type === 'instagram_result');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not_found');
  ws.close();
});

test('checking with no handle stored returns no_handle, never a reward', async () => {
  const ws = connect();
  await whenOpen(ws);
  const welcome = await authAnonymous(ws);
  send(ws, { type: 'instagram_check' });
  const result = await nextFrame(ws, (f) => f.type === 'instagram_result');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no_handle');

  const { rows: claims } = await pool.query(
    "select * from public.task_claims where player_id = $1 and task_id = 'instagram'",
    [welcome.me.id],
  );
  assert.equal(claims.length, 0, 'no reward without a stored handle');
  ws.close();
});

test('an invalid handle is refused before any BoxAPI call', async () => {
  const ws = connect();
  await whenOpen(ws);
  await authAnonymous(ws);
  send(ws, { type: 'instagram_start', handle: 'has space!' });
  const err = await nextFrame(ws, (f) => f.type === 'error');
  assert.equal(err.code, 'invalid_handle');
  ws.close();
});

test('a handle already held by another player is refused as instagram_handle_taken', async () => {
  const first = await startedPlayer('follower');
  first.ws.close();

  const ws2 = connect();
  await whenOpen(ws2);
  await authAnonymous(ws2);
  send(ws2, { type: 'instagram_start', handle: 'follower' });
  const err = await nextFrame(ws2, (f) => f.type === 'error');
  assert.equal(err.code, 'instagram_handle_taken');
  ws2.close();
});

test('the client cannot spoof a follow: instagram_check always reads the stored handle', async () => {
  // The player stores a non-follower handle, then tries to sneak a follower handle onto the
  // check frame. The server ignores the frame's handle and reads its own stored one.
  const { ws } = await startedPlayer('nonfollower');
  send(ws, { type: 'instagram_check', handle: 'follower', ok: true });
  const result = await nextFrame(ws, (f) => f.type === 'instagram_result');
  assert.equal(result.ok, false, 'the injected handle/ok fields are ignored');
  assert.equal(result.reason, 'not_following');
  ws.close();
});

test('a private player who is in our followers is verified (our-followers path, immune to privacy)', async () => {
  const { ws, welcome } = await startedPlayer('privatefollower');
  send(ws, { type: 'instagram_check' });
  const result = await nextFrame(ws, (f) => f.type === 'instagram_result');
  assert.equal(result.ok, true, 'a private account in our follower list still verifies');
  assert.equal(result.reward, 300);

  const { rows: claims } = await pool.query(
    "select * from public.task_claims where player_id = $1 and task_id = 'instagram'",
    [welcome.me.id],
  );
  assert.equal(claims.length, 1, 'the reward was released once');
  ws.close();
});

test('second-try grant: a first failed check is refused, the second grants the reward anyway', async () => {
  // Owner policy (ticket K3, second try): "if it errored out or did not find it ... on the check
  // again request, we wait 3 secs (fake) and grant them the reward, no more API calling to
  // verify." Here nonfollower never confirms, which is the strictest case the policy forgives.
  const { ws, welcome } = await startedPlayer('nonfollower');

  send(ws, { type: 'instagram_check' });
  const first = await nextFrame(ws, (f) => f.type === 'instagram_result');
  assert.equal(first.ok, false, 'the first genuine check is refused');
  assert.equal(first.reason, 'not_following');

  let claims = await pool.query(
    "select * from public.task_claims where player_id = $1 and task_id = 'instagram'",
    [welcome.me.id],
  );
  assert.equal(claims.rows.length, 0, 'no reward on the first check');

  const callsAfterFirst = fake.callCount();
  assert.ok(callsAfterFirst > 0, 'the first check made at least one genuine BoxAPI call');

  await sleep(QUERY_BUDGET_CLEAR_MS); // clear the unrelated per-socket 1/s query budget, not the BoxAPI window
  send(ws, { type: 'instagram_check' });
  const second = await nextFrame(ws, (f) => f.type === 'instagram_result');
  assert.equal(second.ok, true, 'the second check grants the reward');
  assert.equal(second.reward, 300);
  assert.equal(fake.callCount(), callsAfterFirst, 'the second check made no BoxAPI call at all');

  claims = await pool.query(
    "select * from public.task_claims where player_id = $1 and task_id = 'instagram'",
    [welcome.me.id],
  );
  assert.equal(claims.rows.length, 1, 'the reward was released once, on the second try');

  const { rows: accounts } = await pool.query(
    'select verified_at, check_attempts from public.instagram_accounts where player_id = $1',
    [welcome.me.id],
  );
  assert.equal(accounts[0].check_attempts, 1, 'only the one genuine BoxAPI read ever counted');
  assert.ok(accounts[0].verified_at, 'the row is marked verified by the grant');
  ws.close();
});

test('the second-try grant is never held by the per-player BoxAPI check window', async () => {
  const { ws } = await startedPlayer('nonfollower');

  send(ws, { type: 'instagram_check' });
  const first = await nextFrame(ws, (f) => f.type === 'instagram_result');
  assert.equal(first.ok, false);
  assert.equal(first.reason, 'not_following');

  // Widen the BoxAPI window back to its real default for this one test, then check again with no
  // wait at all - a second-or-later check must never be refused rate_limited by that window (it
  // never calls BoxAPI, so there is nothing left for the window to protect).
  const savedWindow = process.env.INSTAGRAM_CHECK_INTERVAL_MS;
  process.env.INSTAGRAM_CHECK_INTERVAL_MS = '20000';
  try {
    // Only the unrelated per-socket 1/s query budget needs clearing here - at 20 s the BoxAPI
    // window itself is nowhere close to elapsed, which is the whole point of this case.
    await sleep(QUERY_BUDGET_CLEAR_MS);
    send(ws, { type: 'instagram_check' });
    const second = await nextFrame(ws, (f) => f.type === 'error' || f.type === 'instagram_result');
    assert.equal(second.type, 'instagram_result', 'not refused rate_limited by the BoxAPI window');
    assert.equal(second.ok, true, 'the second check still grants immediately');
    assert.equal(second.reward, 300);
  } finally {
    process.env.INSTAGRAM_CHECK_INTERVAL_MS = savedWindow;
  }
  ws.close();
});

test('an upstream network error on the first check still records the attempt, so the second check grants', async () => {
  const { ws, welcome } = await startedPlayer('nonfollower');

  // Point the adapter at an unreachable port for this one read so verifyFollow fails transport-
  // side (server/instagram.js: a fetch failure is 'network_error'), without touching the token the
  // start step already used to create the account row.
  const savedBase = process.env.BOXAPI_BASE;
  process.env.BOXAPI_BASE = 'http://127.0.0.1:1/';
  instagram.resetCache();
  try {
    send(ws, { type: 'instagram_check' });
    const first = await nextFrame(ws, (f) => f.type === 'instagram_result');
    assert.equal(first.ok, false);
    assert.equal(first.reason, 'network_error');
  } finally {
    process.env.BOXAPI_BASE = savedBase;
    instagram.resetCache();
  }

  const { rows: midway } = await pool.query('select check_attempts from public.instagram_accounts where player_id = $1', [
    welcome.me.id,
  ]);
  assert.equal(midway[0].check_attempts, 1, 'an upstream error still counts as one genuine attempt');

  await sleep(QUERY_BUDGET_CLEAR_MS);
  send(ws, { type: 'instagram_check' });
  const second = await nextFrame(ws, (f) => f.type === 'instagram_result');
  assert.equal(second.ok, true, 'the second check grants even though the first never reached BoxAPI cleanly');
  assert.equal(second.reward, 300);
  ws.close();
});

test('not_configured on the first check behaves like any other upstream failure: attempt recorded, second check grants', async () => {
  // The account has to exist first, which needs the token present at instagram_start (K3 decision:
  // instagram_start's own not_configured "coming soon" gate is unrelated and untouched here).
  const { ws, welcome } = await startedPlayer('follower');

  const saved = process.env.BOXAPI_TOKEN;
  delete process.env.BOXAPI_TOKEN;
  instagram.resetCache();
  try {
    send(ws, { type: 'instagram_check' });
    const first = await nextFrame(ws, (f) => f.type === 'instagram_result');
    assert.equal(first.ok, false);
    assert.equal(first.reason, 'not_configured');

    const { rows: midway } = await pool.query(
      'select check_attempts from public.instagram_accounts where player_id = $1',
      [welcome.me.id],
    );
    assert.equal(midway[0].check_attempts, 1, 'not_configured still counts as one genuine attempt');
    assert.equal(fake.callCount(), 0, 'not_configured never called BoxAPI at all');

    await sleep(QUERY_BUDGET_CLEAR_MS);
    send(ws, { type: 'instagram_check' });
    const second = await nextFrame(ws, (f) => f.type === 'instagram_result');
    assert.equal(second.ok, true, 'the second check grants without ever needing BoxAPI configured');
    assert.equal(second.reward, 300);

    const { rows: claims } = await pool.query(
      "select * from public.task_claims where player_id = $1 and task_id = 'instagram'",
      [welcome.me.id],
    );
    assert.equal(claims.length, 1, 'the reward was released once');
  } finally {
    process.env.BOXAPI_TOKEN = saved;
    instagram.resetCache();
  }
  ws.close();
});

test('an auto/background check never bumps the attempt count and never takes the second-try grant', async () => {
  const { ws, welcome } = await startedPlayer('nonfollower');

  // A background check (tab focus, a rate-limit retry) may still take a first-attempt BoxAPI read,
  // but it must never record it as a genuine attempt.
  send(ws, { type: 'instagram_check', auto: true });
  const autoFirst = await nextFrame(ws, (f) => f.type === 'instagram_result');
  assert.equal(autoFirst.ok, false);

  let { rows: accounts } = await pool.query(
    'select check_attempts, verified_at from public.instagram_accounts where player_id = $1',
    [welcome.me.id],
  );
  assert.equal(accounts[0].check_attempts, 0, 'an auto check never records an attempt');
  assert.equal(accounts[0].verified_at, null);

  // The player's own explicit tap is the first genuine attempt.
  await sleep(QUERY_BUDGET_CLEAR_MS);
  send(ws, { type: 'instagram_check' });
  const explicitFirst = await nextFrame(ws, (f) => f.type === 'instagram_result');
  assert.equal(explicitFirst.ok, false);
  assert.equal(explicitFirst.reason, 'not_following');

  ({ rows: accounts } = await pool.query(
    'select check_attempts, verified_at from public.instagram_accounts where player_id = $1',
    [welcome.me.id],
  ));
  assert.equal(accounts[0].check_attempts, 1, 'the explicit tap recorded the one genuine attempt');

  // Now check_attempts is 1 (a real second-try grant is available), but a background check must
  // still never take that path on its own - the reward always traces back to a real tap.
  const callsBeforeAuto = fake.callCount();
  await sleep(QUERY_BUDGET_CLEAR_MS);
  send(ws, { type: 'instagram_check', auto: true });
  const autoSecond = await nextFrame(ws, (f) => f.type === 'instagram_result');
  assert.equal(autoSecond.ok, false, 'an auto check never takes the second-try grant');
  assert.equal(fake.callCount(), callsBeforeAuto, 'an auto check past the first attempt makes no BoxAPI call either');

  let claims = await pool.query(
    "select * from public.task_claims where player_id = $1 and task_id = 'instagram'",
    [welcome.me.id],
  );
  assert.equal(claims.rows.length, 0, 'the auto checks never granted the reward');

  // The player's own second tap still grants.
  await sleep(QUERY_BUDGET_CLEAR_MS);
  send(ws, { type: 'instagram_check' });
  const explicitSecond = await nextFrame(ws, (f) => f.type === 'instagram_result');
  assert.equal(explicitSecond.ok, true, 'the explicit second tap grants');
  assert.equal(explicitSecond.reward, 300);

  claims = await pool.query(
    "select * from public.task_claims where player_id = $1 and task_id = 'instagram'",
    [welcome.me.id],
  );
  assert.equal(claims.rows.length, 1, 'the reward was released once, on the explicit second tap');
  ws.close();
});

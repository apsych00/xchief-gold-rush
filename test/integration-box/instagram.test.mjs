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
  // at call time by server/instagram.js and server/index.js).
  process.env.INSTAGRAM_RETRY_DELAY_MS = '0';
  process.env.INSTAGRAM_CHECK_INTERVAL_MS = '50';
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
    'select * from public.instagram_accounts where player_id = $1 and verified_at is not null',
    [welcome.me.id],
  );
  assert.equal(accounts.length, 1, 'the instagram_accounts row is marked verified');

  send(ws, { type: 'tasks' });
  const tasksFrame = await nextFrame(ws, (f) => f.type === 'tasks');
  const row = tasksFrame.rows.find((r) => r.id === 'instagram');
  assert.equal(row.claimed, true, 'the instagram row is marked claimed');
  ws.close();
});

test('a public non-follower is refused with not_following and gets no reward', async () => {
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
  // Owner policy (ticket K3): a genuine follower can still fail our read (freshness lag, privacy,
  // paging). We count genuine attempts on the player's row and grant on the second, server-side.
  // Here nonfollower never confirms, which is the strictest case the policy is meant to forgive.
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

  // Wait past the 1/s query budget and the (shrunk) per-player check window so the next check is a
  // genuine second BoxAPI read, not a rate-limited no-op.
  await sleep(1100);

  send(ws, { type: 'instagram_check' });
  const second = await nextFrame(ws, (f) => f.type === 'instagram_result');
  assert.equal(second.ok, true, 'the second genuine check grants the reward');
  assert.equal(second.reward, 300);

  claims = await pool.query(
    "select * from public.task_claims where player_id = $1 and task_id = 'instagram'",
    [welcome.me.id],
  );
  assert.equal(claims.rows.length, 1, 'the reward was released once, on the second try');

  const { rows: accounts } = await pool.query(
    'select verified_at, check_attempts from public.instagram_accounts where player_id = $1',
    [welcome.me.id],
  );
  assert.equal(accounts[0].check_attempts, 2, 'both genuine attempts were counted on the row');
  assert.ok(accounts[0].verified_at, 'the row is marked verified by the grant');
  ws.close();
});

test('second-try grant needs two GENUINE attempts: rate-limited retries never count', async () => {
  const { ws, welcome } = await startedPlayer('nonfollower');

  send(ws, { type: 'instagram_check' });
  const first = await nextFrame(ws, (f) => f.type === 'instagram_result');
  assert.equal(first.ok, false);
  assert.equal(first.reason, 'not_following');

  // A second check inside the per-player window is a rate_limited no-op - it must not count as a
  // genuine attempt, so it neither grants nor increments check_attempts.
  send(ws, { type: 'instagram_check' });
  const rateLimited = await nextFrame(ws, (f) => f.type === 'error' || f.type === 'instagram_result');
  assert.equal(rateLimited.type, 'error');
  assert.equal(rateLimited.code, 'rate_limited');

  const claims = await pool.query(
    "select * from public.task_claims where player_id = $1 and task_id = 'instagram'",
    [welcome.me.id],
  );
  assert.equal(claims.rows.length, 0, 'a rate-limited retry never grants');

  const { rows: accounts } = await pool.query(
    'select check_attempts from public.instagram_accounts where player_id = $1',
    [welcome.me.id],
  );
  assert.equal(accounts[0].check_attempts, 1, 'only the one genuine read counted');
  ws.close();
});

test('not configured: instagram_start says not_configured and no reward is ever released', async () => {
  const saved = process.env.BOXAPI_TOKEN;
  delete process.env.BOXAPI_TOKEN;
  try {
    const ws = connect();
    await whenOpen(ws);
    const welcome = await authAnonymous(ws);

    send(ws, { type: 'instagram_start', handle: 'follower' });
    const started = await nextFrame(ws, (f) => f.type === 'instagram_started');
    assert.equal(started.status, 'not_configured', 'start reports not_configured');

    send(ws, { type: 'instagram_check' });
    const result = await nextFrame(ws, (f) => f.type === 'instagram_result');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'not_configured');

    const { rows: claims } = await pool.query(
      "select * from public.task_claims where player_id = $1 and task_id = 'instagram'",
      [welcome.me.id],
    );
    assert.equal(claims.length, 0, 'no reward when not configured');
    ws.close();
  } finally {
    process.env.BOXAPI_TOKEN = saved;
    instagram.resetCache();
  }
});

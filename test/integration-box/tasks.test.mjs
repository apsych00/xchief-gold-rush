// Socket integration tests for tasks and gifts (ticket C5, docs/layers.md): the `tasks` frame,
// and the `reward`/`task` fields the ledger's own claim_task/free_refill now carry on their
// `me` reply, computed server-side - never assembled by the client. Same harness as
// test/integration-box/server.test.mjs and leaderboard.test.mjs: a live database, the server
// started in-process with a stubbed feed.
//
//   bash db/run-tests.sh --keep
//   DATABASE_URL=postgresql://postgres:test@localhost:55432/postgres npm run test:server

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

// Same buffered-inbox connection helper as server.test.mjs, leaderboard.test.mjs and otp.test.mjs.
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
  // does not leak between tests. The device-identity tests below use explicit tokens.
  send(ws, { type: 'auth', device: freshDeviceToken() });
  return nextFrame(ws, (f) => f.type === 'welcome');
}

async function authKiosk(ws, secret = DEV_KIOSK_SECRET) {
  send(ws, { type: 'auth', kiosk: secret });
  return nextFrame(ws, (f) => f.type === 'welcome');
}

// --- tasks ---------------------------------------------------------------------------------

test('the tasks frame reports id/title/reward/claimed, computed server-side', async () => {
  const ws = connect();
  await whenOpen(ws);
  await authAnonymous(ws);

  send(ws, { type: 'tasks' });
  const frame = await nextFrame(ws, (f) => f.type === 'tasks');
  assert.ok(Array.isArray(frame.rows) && frame.rows.length > 0, 'the tasks frame carries at least one row');
  const email = frame.rows.find((r) => r.id === 'email');
  assert.ok(email, 'the seeded "email" task is present');
  assert.equal(typeof email.title, 'string', 'each row carries a title');
  assert.equal(typeof email.reward, 'number', 'each row carries a numeric reward');
  assert.equal(email.claimed, false, 'a task never claimed by this player reports claimed: false');

  ws.close();
});

// --- claim_task ------------------------------------------------------------------------------

test('claim_task grants the reward, reports it on the me reply, and rejects a repeat with already_claimed', async () => {
  // ticket B6+B7+B9 (db/schema.sql decision 5) restricted claim_task to kind='manual' tasks;
  // 'email' is released by verify_otp_code now (otp.test.mjs), not by a client claim_task call.
  // This suite exercises the still-live claim_task path against a manual fixture task instead.
  await pool.query(
    "insert into public.tasks (id, title, reward, kind) values ('test_manual_reward', 'Test manual reward task', 175, 'manual') on conflict (id) do update set kind = 'manual', reward = 175",
  );

  const ws = connect();
  await whenOpen(ws);
  const welcome = await authAnonymous(ws);
  const before = welcome.me.coins;

  send(ws, { type: 'claim_task', task_id: 'test_manual_reward' });
  const first = await nextFrame(ws, (f) => f.type === 'me');
  assert.equal(first.task, 'test_manual_reward', 'the me reply names which task was just claimed');
  assert.equal(typeof first.reward, 'number', 'the me reply carries the reward the ledger granted');
  assert.ok(first.reward > 0, 'the reward is a real, positive amount');
  assert.equal(first.coins, before + first.reward, 'the balance on the reply already reflects the reward');

  send(ws, { type: 'claim_task', task_id: 'test_manual_reward' });
  const err = await nextFrame(ws, (f) => f.type === 'error');
  assert.equal(err.code, 'already_claimed', 'a second claim of the same one-time task is rejected');

  const { rows } = await pool.query('select coins from public.players where id = $1', [welcome.me.id]);
  assert.equal(rows[0].coins, first.coins, 'the rejected repeat granted nothing on top of the first claim');

  ws.close();
});

test('claim_task refuses a non-manual task kind with not_claimable', async () => {
  const ws = connect();
  await whenOpen(ws);
  await authAnonymous(ws);

  send(ws, { type: 'claim_task', task_id: 'video' });
  const err = await nextFrame(ws, (f) => f.type === 'error');
  assert.equal(err.code, 'not_claimable', 'a video-kind task cannot be claimed by the client directly');

  ws.close();
});

// --- task_progress (ticket B6+B7+B9 decision 2, video watch) ----------------------------------

test('task_progress reports watch progress and the me reply carries reward only once 90% is crossed', async () => {
  const ws = connect();
  await whenOpen(ws);
  const welcome = await authAnonymous(ws);

  send(ws, { type: 'task_progress', task: 'video', seconds: 5, duration: 60 });
  const below = await nextFrame(ws, (f) => f.type === 'me');
  assert.equal(below.reward, undefined, 'no reward field on the me reply below 90%');

  // Crossing 90% releases the reward through report_video_progress itself (db/schema.sql), not
  // through a claim_task call - the too-fast check pgTAP already covers (db/tests/85), so this
  // integration test only needs the frame shape, not the anti-fraud arithmetic.
  await pool.query(
    "update public.video_progress set updated_at = now() - interval '60 seconds' where task_id = 'video' and player_id = $1",
    [welcome.me.id],
  );
  // task_progress shares the S2 1/s-per-socket query budget (ticket B13); wait it out before
  // the second send on this socket.
  await new Promise((r) => setTimeout(r, 1100));
  send(ws, { type: 'task_progress', task: 'video', seconds: 55, duration: 60 });
  const above = await nextFrame(ws, (f) => f.type === 'me');
  assert.equal(above.task, 'video', 'the me reply names the task once a reward was released');
  assert.equal(typeof above.reward, 'number', 'the me reply carries the reward report_video_progress released');
  assert.ok(above.reward > 0, 'the reward is a real, positive amount');

  ws.close();
});

test('claim_task("video") is still refused with not_claimable even after progress was reported', async () => {
  const ws = connect();
  await whenOpen(ws);
  await authAnonymous(ws);

  send(ws, { type: 'task_progress', task: 'video', seconds: 5, duration: 60 });
  await nextFrame(ws, (f) => f.type === 'me');

  send(ws, { type: 'claim_task', task_id: 'video' });
  const err = await nextFrame(ws, (f) => f.type === 'error');
  assert.equal(err.code, 'not_claimable', 'video stays a server-released task, never client-claimable');

  ws.close();
});

// --- task_start / task_return (ticket B6+B7+B9 decision 3, redirect and return) ---------------

test('task_start answers task_started with the window, task_return refuses before it and rewards after', async () => {
  const ws = connect();
  await whenOpen(ws);
  const welcome = await authAnonymous(ws);

  send(ws, { type: 'task_start', task: 'telegram' });
  const started = await nextFrame(ws, (f) => f.type === 'task_started');
  assert.equal(started.task, 'telegram', 'task_started names the task it opened a window for');
  assert.equal(started.window_ms, 5000, 'task_started reports the 5 s window');

  send(ws, { type: 'task_return', task: 'telegram' });
  const early = await nextFrame(ws, (f) => f.type === 'error');
  assert.equal(early.code, 'not_yet', 'returning before the window has passed is refused');
  assert.equal(typeof early.retry_ms, 'number', 'not_yet carries retry_ms so the client knows when to try again');

  await pool.query(
    "update public.task_visits set started_at = now() - interval '6 seconds' where player_id = $1 and task_id = 'telegram'",
    [welcome.me.id],
  );

  // task_return shares the S2 1/s-per-socket query budget (ticket B13); wait it out between
  // repeat sends on this socket.
  await new Promise((r) => setTimeout(r, 1100));
  send(ws, { type: 'task_return', task: 'telegram' });
  const rewarded = await nextFrame(ws, (f) => f.type === 'me');
  assert.equal(rewarded.task, 'telegram', 'the me reply names which task was rewarded');
  assert.equal(typeof rewarded.reward, 'number', 'past the window, the me reply carries the reward that was released');
  assert.ok(rewarded.reward > 0, 'the reward is a real, positive amount');

  await new Promise((r) => setTimeout(r, 1100));
  send(ws, { type: 'task_return', task: 'telegram' });
  const again = await nextFrame(ws, (f) => f.type === 'error');
  assert.equal(again.code, 'already_claimed', 'returning again after the reward already landed is refused');

  ws.close();
});

// --- free_refill -----------------------------------------------------------------------------

test('free_refill grants its reward once eligible, then rejects a second call with already_refilled', async () => {
  const ws = connect();
  await whenOpen(ws);
  const welcome = await authAnonymous(ws);

  // free_refill only applies below 100 coins (db/schema.sql); drive the player there directly
  // rather than re-deriving the round economy this suite is not testing.
  await pool.query('update public.players set coins = 50 where id = $1', [welcome.me.id]);

  send(ws, { type: 'free_refill' });
  const first = await nextFrame(ws, (f) => f.type === 'me');
  assert.equal(typeof first.reward, 'number', 'the me reply carries the reward the ledger granted');
  assert.equal(first.coins, 50 + first.reward, 'the balance on the reply already reflects the refill');

  send(ws, { type: 'free_refill' });
  const err = await nextFrame(ws, (f) => f.type === 'error');
  assert.equal(err.code, 'already_refilled', 'a second free_refill is rejected, even with coins still low enough to qualify otherwise');

  ws.close();
});

// --- kiosk denial ------------------------------------------------------------------------------

test('a kiosk gets not_available for claim_task, free_refill and tasks - never the player error shape', async () => {
  const ws = connect();
  await whenOpen(ws);
  await authKiosk(ws);

  send(ws, { type: 'tasks' });
  const tasksErr = await nextFrame(ws, (f) => f.type === 'error');
  assert.equal(tasksErr.code, 'not_available', 'a kiosk asking for tasks gets not_available');

  send(ws, { type: 'claim_task', task_id: 'email' });
  const claimErr = await nextFrame(ws, (f) => f.type === 'error');
  assert.equal(claimErr.code, 'not_available', 'a kiosk cannot claim_task');

  send(ws, { type: 'free_refill' });
  const refillErr = await nextFrame(ws, (f) => f.type === 'error');
  assert.equal(refillErr.code, 'not_available', 'a kiosk cannot free_refill');

  // ticket B6+B7+B9 decision 5: the three new frames go through handleFrame the same way.
  send(ws, { type: 'task_progress', task: 'video', seconds: 1, duration: 60 });
  const progressErr = await nextFrame(ws, (f) => f.type === 'error');
  assert.equal(progressErr.code, 'not_available', 'a kiosk cannot report task_progress');

  send(ws, { type: 'task_start', task: 'telegram' });
  const startErr = await nextFrame(ws, (f) => f.type === 'error');
  assert.equal(startErr.code, 'not_available', 'a kiosk cannot task_start');

  send(ws, { type: 'task_return', task: 'telegram' });
  const returnErr = await nextFrame(ws, (f) => f.type === 'error');
  assert.equal(returnErr.code, 'not_available', 'a kiosk cannot task_return');

  ws.close();
});

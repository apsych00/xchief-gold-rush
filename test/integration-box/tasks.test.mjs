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

async function authAnonymous(ws) {
  send(ws, { type: 'auth' });
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
  const ws = connect();
  await whenOpen(ws);
  const welcome = await authAnonymous(ws);
  const before = welcome.me.coins;

  send(ws, { type: 'claim_task', task_id: 'email' });
  const first = await nextFrame(ws, (f) => f.type === 'me');
  assert.equal(first.task, 'email', 'the me reply names which task was just claimed');
  assert.equal(typeof first.reward, 'number', 'the me reply carries the reward the ledger granted');
  assert.ok(first.reward > 0, 'the reward is a real, positive amount');
  assert.equal(first.coins, before + first.reward, 'the balance on the reply already reflects the reward');

  send(ws, { type: 'claim_task', task_id: 'email' });
  const err = await nextFrame(ws, (f) => f.type === 'error');
  assert.equal(err.code, 'already_claimed', 'a second claim of the same one-time task is rejected');

  const { rows } = await pool.query('select coins from public.players where id = $1', [welcome.me.id]);
  assert.equal(rows[0].coins, first.coins, 'the rejected repeat granted nothing on top of the first claim');

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

  ws.close();
});

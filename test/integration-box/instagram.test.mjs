// Instagram reward integration tests (ticket B8). Run against the box game server with the
// fake Instagram server in test/fakes/instagram.mjs.
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

const { createApp } = await import('../../server/index.js');
const { startFakeInstagram } = await import('../fakes/instagram.mjs');

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

function parseLocal(loc) {
  return new URL(loc, `http://localhost:${port}`);
}

async function startOAuth(ws) {
  const welcome = await authAnonymous(ws);
  const token = welcome.token;
  const startRes = await fetch(`http://localhost:${port}/api/instagram/start?token=${encodeURIComponent(token)}`, {
    redirect: 'manual',
  });
  const startLoc = startRes.headers.get('location');
  assert.ok(startLoc, '/api/instagram/start returned a redirect');
  const state = parseLocal(startLoc).searchParams.get('state');

  // Visit the fake Instagram authorize URL to receive the code.
  const authRes = await fetch(startLoc, { redirect: 'manual' });
  const authLoc = authRes.headers.get('location');
  assert.ok(authLoc, 'fake authorize returned a redirect');
  const igCode = parseLocal(authLoc).searchParams.get('code');
  assert.ok(igCode, 'fake redirect carried a code');

  return { welcome, token, igCode, state };
}

before(async () => {
  fake = await startFakeInstagram(0);
  process.env.INSTAGRAM_APP_ID = 'fake-app-id';
  process.env.INSTAGRAM_APP_SECRET = 'fake-app-secret';
  process.env.INSTAGRAM_API_BASE = fake.url;

  app = createApp({ finnhubToken: null });
  port = await app.start(0, { startFeed: false });
  process.env.INSTAGRAM_REDIRECT_URI = `http://localhost:${port}/api/instagram/callback`;
  wsUrl = `ws://localhost:${port}/ws`;
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
});

beforeEach(async () => {
  // The kept database survives across test runs, so clear Instagram state before every test.
  await pool.query("delete from public.task_claims where task_id = 'instagram'");
  await pool.query('delete from public.instagram_accounts');
});

after(async () => {
  await app.close();
  await pool.end();
  await fake.stop();
  delete process.env.INSTAGRAM_APP_ID;
  delete process.env.INSTAGRAM_APP_SECRET;
  delete process.env.INSTAGRAM_API_BASE;
  delete process.env.INSTAGRAM_REDIRECT_URI;
});

test('happy path: OAuth callback releases the instagram task once', async () => {
  const ws = connect();
  await whenOpen(ws);
  const { welcome, igCode, state } = await startOAuth(ws);

  // Follow the fake Instagram redirect chain to the local callback.
  const callback = `http://localhost:${port}/api/instagram/callback?code=${encodeURIComponent(igCode)}&state=${encodeURIComponent(state)}`;
  const res = await fetch(callback);
  const final = new URL(res.url);
  assert.equal(final.searchParams.get('ig'), 'done', 'callback redirects to ?ig=done on success');

  const { rows: claims } = await pool.query(
    "select * from public.task_claims where player_id = $1 and task_id = 'instagram'",
    [welcome.me.id],
  );
  assert.equal(claims.length, 1, 'a task_claims row was created for instagram');

  const { rows: accounts } = await pool.query('select * from public.instagram_accounts where player_id = $1', [
    welcome.me.id,
  ]);
  assert.equal(accounts.length, 1, 'an instagram_accounts row was created');

  send(ws, { type: 'tasks' });
  const tasksFrame = await nextFrame(ws, (f) => f.type === 'tasks');
  const instagramRow = tasksFrame.rows.find((r) => r.id === 'instagram');
  assert.ok(instagramRow, 'tasks frame contains the instagram row');
  assert.equal(instagramRow.claimed, true, 'the instagram row is marked claimed');
  ws.close();
});

test('same ig_user_id from a second player/device is refused as already_claimed', async () => {
  const ws1 = connect();
  await whenOpen(ws1);
  const { welcome: p1, igCode, state } = await startOAuth(ws1);
  const callback = `http://localhost:${port}/api/instagram/callback?code=${encodeURIComponent(igCode)}&state=${encodeURIComponent(state)}`;
  await fetch(callback);
  const p1Account = (
    await pool.query('select ig_user_id from public.instagram_accounts where player_id = $1', [p1.me.id])
  ).rows[0];
  ws1.close();

  // A second player with a pre-issued code for the same Instagram user_id.
  const ws2 = connect();
  await whenOpen(ws2);
  const welcome2 = await authAnonymous(ws2);
  const p2Token = welcome2.token;
  const startRes = await fetch(`http://localhost:${port}/api/instagram/start?token=${encodeURIComponent(p2Token)}`, {
    redirect: 'manual',
  });
  const startLoc = startRes.headers.get('location');
  assert.ok(startLoc, '/api/instagram/start returned a redirect for p2');
  const p2State = new URL(startLoc).searchParams.get('state');
  const { code: reusedCode } = fake.issueCode({ id: p1Account.ig_user_id, username: 'same_user' });

  const p2Callback = `http://localhost:${port}/api/instagram/callback?code=${encodeURIComponent(reusedCode)}&state=${encodeURIComponent(p2State)}`;
  const res = await fetch(p2Callback);
  const final = new URL(res.url);
  assert.equal(final.searchParams.get('ig'), 'already_claimed', 'duplicate ig_user_id redirects to already_claimed');

  const { rows: claims } = await pool.query(
    "select * from public.task_claims where player_id = $1 and task_id = 'instagram'",
    [welcome2.me.id],
  );
  assert.equal(claims.length, 0, 'the second player gets no instagram reward');
  ws2.close();
});

test('missing Instagram env makes /api/instagram/start redirect to ?ig=not_configured', async () => {
  // Temporarily remove the adapter config; it is read at call time, so a fresh request sees it gone.
  const saved = {
    appId: process.env.INSTAGRAM_APP_ID,
    secret: process.env.INSTAGRAM_APP_SECRET,
    redirect: process.env.INSTAGRAM_REDIRECT_URI,
    base: process.env.INSTAGRAM_API_BASE,
  };
  delete process.env.INSTAGRAM_APP_ID;
  delete process.env.INSTAGRAM_APP_SECRET;
  delete process.env.INSTAGRAM_REDIRECT_URI;
  delete process.env.INSTAGRAM_API_BASE;

  try {
    const ws = connect();
    await whenOpen(ws);
    const welcome = await authAnonymous(ws);
    const res = await fetch(`http://localhost:${port}/api/instagram/start?token=${encodeURIComponent(welcome.token)}`, {
      redirect: 'manual',
    });
    const loc = res.headers.get('location');
    assert.ok(loc, '/api/instagram/start returned a redirect');
    assert.equal(parseLocal(loc).searchParams.get('ig'), 'not_configured', 'start redirects to not_configured');

    send(ws, { type: 'tasks' });
    const tasksFrame = await nextFrame(ws, (f) => f.type === 'tasks');
    const instagramRow = tasksFrame.rows.find((r) => r.id === 'instagram');
    assert.ok(instagramRow, 'tasks frame still contains the instagram row');
    assert.equal(instagramRow.claimed, false, 'instagram task is not claimed when not configured');
    ws.close();
  } finally {
    process.env.INSTAGRAM_APP_ID = saved.appId;
    process.env.INSTAGRAM_APP_SECRET = saved.secret;
    process.env.INSTAGRAM_REDIRECT_URI = saved.redirect;
    process.env.INSTAGRAM_API_BASE = saved.base;
  }
});

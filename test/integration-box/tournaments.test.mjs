// Socket integration tests for tournaments as data (ticket B1: db/schema.sql, server/index.js's
// buildLeaderboardPayload, server/ledger.js). Same harness as server.test.mjs and
// leaderboard.test.mjs: a live database, the server started in-process with a stubbed feed.
//
//   bash db/run-tests.sh --keep
//   DATABASE_URL=postgresql://postgres:test@localhost:55432/postgres npm run test:server
//
// db/seed.sql's own tournaments carry real campaign dates (16-21 and 21-24 September 2026), so
// whether one of them is "current" depends on the wall clock this suite happens to run on. Every
// test here instead makes its own tournament rows with an explicit window and cleans them up
// afterwards, so the assertions hold regardless of when this runs.

import { test, before, after, beforeEach, afterEach } from 'node:test';
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

  // A previous, interrupted run of this suite against the same --keep container can leave its
  // own ad-hoc tournaments behind (a failed assertion still runs afterEach below, but a thrown
  // hook does not); start from a clean slate rather than let a stale row collide with a fresh
  // insert's exclusion constraint.
  await pool.query(`delete from public.tournaments where id not in ('t1', 't2')`);
});

after(async () => {
  clearInterval(priceTimer);
  await app.close();
  await pool.end();
});

// Other suites in this run (leaderboard.test.mjs, server.test.mjs) settle real rounds against
// whichever tournament db/seed.sql's own windows make current, so t1/t2 usually already have
// rounds and tournament_scores referencing them by the time this file runs - deleting them
// outright would violate rounds_tournament_id_fkey. Move their windows into the deep past
// instead (an UPDATE, never a DELETE) so current_tournament() resolves nothing without ever
// touching a referenced row, then put the real dates back afterwards. Every ad-hoc tournament a
// test inserts for itself (int-*, tt-*) has no rounds against it and is deleted outright.
const SEED_T1 = { starts_at: '2026-09-16 00:00:00+04', ends_at: '2026-09-21 00:00:00+04' };
const SEED_T2 = { starts_at: '2026-09-21 00:00:00+04', ends_at: '2026-09-24 00:00:00+04' };

beforeEach(async () => {
  await pool.query(
    `update public.tournaments set starts_at = '1990-01-01+00', ends_at = '1990-01-02+00' where id = 't1'`,
  );
  await pool.query(
    `update public.tournaments set starts_at = '1990-01-02+00', ends_at = '1990-01-03+00' where id = 't2'`,
  );
  await pool.query(`delete from public.tournaments where id not in ('t1', 't2')`);
});
afterEach(async () => {
  // Delete the test's own ad-hoc rows before moving t1/t2 back onto their real, live dates -
  // otherwise a row a test left behind (e.g. one covering "now", same as t1's real window)
  // collides with the restore itself.
  await pool.query(`delete from public.tournaments where id not in ('t1', 't2')`);
  await pool.query(`update public.tournaments set starts_at = $1, ends_at = $2 where id = 't1'`, [
    SEED_T1.starts_at,
    SEED_T1.ends_at,
  ]);
  await pool.query(`update public.tournaments set starts_at = $1, ends_at = $2 where id = 't2'`, [
    SEED_T2.starts_at,
    SEED_T2.ends_at,
  ]);
});

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

async function insertTournament(
  id,
  { title = id, startsAt, endsAt, prizeTitle = 'Prize', prizeImage = '/prizes/x.png', brokerBonus = null },
) {
  await pool.query(
    `insert into public.tournaments (id, title, starts_at, ends_at, prize_title, prize_image, broker_bonus)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [id, title, startsAt, endsAt, prizeTitle, prizeImage, brokerBonus],
  );
}

test('the leaderboard frame carries a null tournament and empty rows when none is running', async () => {
  const ws = connect();
  await whenOpen(ws);
  await authAnonymous(ws);

  send(ws, { type: 'leaderboard' });
  const lb = await nextFrame(ws, (f) => f.type === 'leaderboard');
  assert.equal(lb.tournament, null, 'no tournament resolved: the header is null');
  assert.deepEqual(lb.rows, [], 'no tournament resolved: the board is empty, not an error');
  ws.close();
});

test("the leaderboard frame carries the current tournament's full header shape", async () => {
  const now = Date.now();
  await insertTournament('int-now', {
    title: 'Integration Now',
    startsAt: new Date(now - 3600_000).toISOString(),
    endsAt: new Date(now + 3600_000).toISOString(),
    prizeTitle: 'First prize',
    prizeImage: '/prizes/now.png',
    brokerBonus: '20% deposit bonus',
  });

  const ws = connect();
  await whenOpen(ws);
  await authAnonymous(ws);
  send(ws, { type: 'leaderboard' });
  const lb = await nextFrame(ws, (f) => f.type === 'leaderboard');
  assert.deepEqual(Object.keys(lb.tournament).sort(), [
    'broker_bonus',
    'ends_at',
    'id',
    'prize_image',
    'prize_title',
    'starts_at',
    'title',
  ]);
  assert.equal(lb.tournament.id, 'int-now');
  assert.equal(lb.tournament.title, 'Integration Now');
  assert.equal(lb.tournament.prize_title, 'First prize');
  assert.equal(lb.tournament.prize_image, '/prizes/now.png');
  assert.equal(lb.tournament.broker_bonus, '20% deposit bonus');
  assert.equal(new Date(lb.tournament.starts_at).getTime(), now - 3600_000);
  assert.equal(new Date(lb.tournament.ends_at).getTime(), now + 3600_000);
  const entry = lb.tournaments.find((t) => t.id === 'int-now');
  assert.ok(entry, 'the switcher list includes this tournament');
  assert.equal(entry.status, 'live');
  ws.close();
});

test('the switcher list classifies past, live and upcoming tournaments correctly', async () => {
  const now = Date.now();
  await insertTournament('int-past', {
    title: 'Past',
    startsAt: new Date(now - 7 * 86400_000).toISOString(),
    endsAt: new Date(now - 3 * 86400_000).toISOString(),
  });
  await insertTournament('int-live', {
    title: 'Live',
    startsAt: new Date(now - 3600_000).toISOString(),
    endsAt: new Date(now + 3600_000).toISOString(),
  });
  await insertTournament('int-upcoming', {
    title: 'Upcoming',
    startsAt: new Date(now + 3 * 86400_000).toISOString(),
    endsAt: new Date(now + 7 * 86400_000).toISOString(),
  });

  const ws = connect();
  await whenOpen(ws);
  await authAnonymous(ws);
  send(ws, { type: 'leaderboard' });
  const lb = await nextFrame(ws, (f) => f.type === 'leaderboard');
  const byId = Object.fromEntries(lb.tournaments.map((t) => [t.id, t.status]));
  assert.equal(byId['int-past'], 'past');
  assert.equal(byId['int-live'], 'live');
  assert.equal(byId['int-upcoming'], 'upcoming');
  assert.equal(lb.tournament.id, 'int-live', 'the header still resolves whichever one is current');
  ws.close();
});

test("the `tournament` request frame reads back a specific (past or upcoming) tournament's own board", async () => {
  const now = Date.now();
  await insertTournament('int-closed', {
    title: 'Closed Week',
    startsAt: new Date(now - 7 * 86400_000).toISOString(),
    endsAt: new Date(now - 3 * 86400_000).toISOString(),
    prizeTitle: 'Closed prize',
    prizeImage: '/prizes/closed.png',
  });

  const ws = connect();
  await whenOpen(ws);
  await authAnonymous(ws);

  // The default (no id) leaderboard resolves nothing - no tournament is currently running.
  send(ws, { type: 'leaderboard' });
  const current = await nextFrame(ws, (f) => f.type === 'leaderboard');
  assert.equal(current.tournament, null);

  // Reading the closed tournament back explicitly returns its own header.
  send(ws, { type: 'tournament', id: 'int-closed' });
  const closed = await nextFrame(ws, (f) => f.type === 'leaderboard');
  assert.equal(closed.tournament.id, 'int-closed');
  assert.equal(closed.tournament.title, 'Closed Week');
  assert.deepEqual(closed.rows, [], 'no player scored in it: an empty board, not an error');

  // An id naming no tournament at all resolves to the same null-header, empty-rows shape.
  send(ws, { type: 'tournament', id: 'does-not-exist' });
  const missing = await nextFrame(ws, (f) => f.type === 'leaderboard');
  assert.equal(missing.tournament, null);
  assert.deepEqual(missing.rows, []);
  ws.close();
});

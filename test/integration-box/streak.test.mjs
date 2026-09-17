// Blind integration cases for the five-win streak contract in docs/test-contract.md.
// Prices are injected through the feed boundary, so the server still decides every outcome.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import pg from 'pg';

if (!process.env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL is not set. Start db/run-tests-b14.sh --keep and re-run npm run test:server.',
  );
}

process.env.PLAYER_TOKEN_SECRET ??= 'test-secret';

const { createApp } = await import('../../server/index.js');
const { LIMITS } = await import('../../server/limits.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let app;
let pool;
let wsUrl;
let currentPrice = 3000;
let priceTimer;

before(async () => {
  app = createApp({ finnhubToken: null });
  const port = await app.start(0, { startFeed: false });
  wsUrl = `ws://localhost:${port}/ws`;
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  priceTimer = setInterval(() => app.feed._injectTick('okx', currentPrice, Date.now()), 100);
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
    const index = ws.waiters.findIndex((waiter) => waiter.predicate(frame));
    if (index >= 0) {
      const [waiter] = ws.waiters.splice(index, 1);
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
  const index = ws.inbox.findIndex(predicate);
  if (index >= 0) return Promise.resolve(ws.inbox.splice(index, 1)[0]);
  return new Promise((resolve, reject) => {
    const waiter = {
      predicate,
      resolve,
      timer: setTimeout(() => {
        ws.waiters = ws.waiters.filter((candidate) => candidate !== waiter);
        reject(new Error(`timed out after ${timeoutMs}ms waiting for a frame`));
      }, timeoutMs),
    };
    ws.waiters.push(waiter);
  });
}

function send(ws, frame) {
  ws.send(JSON.stringify(frame));
}

async function createKiosk(label) {
  const secret = `${label}-secret-0001`;
  const { rows } = await pool.query(
    `insert into public.kiosks (label, secret_hash)
     values ($1, extensions.crypt($2, extensions.gen_salt('bf')))
     returning id`,
    [label, secret],
  );
  return { id: rows[0].id, secret };
}

async function playWin(ws, startPrice) {
  currentPrice = startPrice;
  await sleep(150);
  send(ws, { type: 'play', dir: 'up', lever: 1 });
  const opened = await nextFrame(ws, (frame) => frame.type === 'round_opened');
  assert.ok(opened.round_id);
  currentPrice = startPrice + 1;
  return nextFrame(ws, (frame) => frame.type === 'round_settled', 5500);
}

async function authKiosk(ws, secret) {
  await whenOpen(ws);
  send(ws, { type: 'auth', kiosk: secret });
  await nextFrame(ws, (frame) => frame.type === 'welcome');
  return nextFrame(ws, (frame) => frame.type === 'kiosk_session');
}

async function authWeb(ws) {
  await whenOpen(ws);
  send(ws, { type: 'auth' });
  return nextFrame(ws, (frame) => frame.type === 'welcome');
}

test('kiosk claims a coupon on the fifth win, ends, then reset starts a fresh session', async () => {
  const kiosk = await createKiosk('b14-kiosk-won');
  const ws = connect();
  try {
    const initial = await authKiosk(ws, kiosk.secret);
    assert.deepEqual(
      { coins: initial.coins, streak: initial.streak, state: initial.state },
      { coins: 1000, streak: 0, state: 'idle' },
    );

    let fifth;
    for (let round = 1; round <= 5; round += 1) {
      const settled = await playWin(ws, 3000 + round * 10);
      assert.equal(settled.outcome, 'win');
      if (round < 5) assert.equal(settled.streak, round);
      if (round === 5) fifth = settled;
      await nextFrame(ws, (frame) => frame.type === 'kiosk_session');
    }

    assert.equal(typeof fifth.coupon, 'string');
    assert.notEqual(fifth.coupon, '');
    assert.equal(fifth.state, 'won');
    assert.equal(fifth.streak, 0);

    const couponRows = await pool.query(
      'select status, claimed_by_kiosk from public.coupons where code = $1',
      [fifth.coupon],
    );
    assert.equal(couponRows.rows.length, 1);
    assert.deepEqual(couponRows.rows[0], { status: 'claimed', claimed_by_kiosk: kiosk.id });

    send(ws, { type: 'play', dir: 'up', lever: 1 });
    const refused = await nextFrame(ws, (frame) => frame.type === 'error');
    assert.equal(refused.code, 'session_over');

    send(ws, { type: 'kiosk_reset' });
    const reset = await nextFrame(ws, (frame) => frame.type === 'kiosk_session');
    assert.deepEqual(
      { coins: reset.coins, streak: reset.streak, state: reset.state },
      { coins: 1000, streak: 0, state: 'idle' },
    );

    // The refused play at line 163 already consumed this socket's play-cadence budget (ticket
    // S2 decision 3: at most 1 play per PLAY_MIN_INTERVAL_MS, regardless of outcome) - wait it
    // out so the post-reset replay gets round_opened rather than rate_limited.
    await sleep(LIMITS.PLAY_MIN_INTERVAL_MS + 50);
    const freshWin = await playWin(ws, 4000);
    assert.equal(freshWin.outcome, 'win');
    assert.equal(freshWin.coins, 1100);
    assert.equal(freshWin.streak, 1);
  } finally {
    ws.close();
  }
});

test('an empty coupon pool keeps the fifth-win streak and the kiosk playing', async () => {
  // open_kiosk_round now refuses a NEW round outright once the pool is empty (ticket C8,
  // docs/layers.md), so the pool cannot start this test already empty the way it used to - the
  // 5th round would never even open. It opens while a coupon is still there instead, and the
  // pool is emptied out from under it before it settles: the same race a concurrent kiosk's own
  // win would cause, and exactly the case docs/layers.md C8 says settles normally.
  const kiosk = await createKiosk('b14-kiosk-empty');
  const ws = connect();
  let claimed = { rows: [] };
  try {
    await authKiosk(ws, kiosk.secret);
    for (let round = 1; round <= 4; round += 1) {
      const settled = await playWin(ws, 5000 + round * 10);
      assert.equal(settled.outcome, 'win');
      assert.equal(settled.streak, round);
      await nextFrame(ws, (frame) => frame.type === 'kiosk_session');
    }

    currentPrice = 5050;
    await sleep(150);
    send(ws, { type: 'play', dir: 'up', lever: 1 });
    const opened = await nextFrame(ws, (frame) => frame.type === 'round_opened');
    assert.ok(opened.round_id);

    claimed = await pool.query(
      `update public.coupons
       set status = 'claimed', claimed_by_kiosk = $1, claimed_at = now()
       where status = 'available'
       returning id`,
      [kiosk.id],
    );

    currentPrice = 5051;
    const fifth = await nextFrame(ws, (frame) => frame.type === 'round_settled', 5500);

    assert.equal(fifth.outcome, 'win');
    assert.equal(fifth.coupons_exhausted, true);
    assert.equal(fifth.coupon, null);
    assert.equal(fifth.state, 'playing');
    assert.equal(fifth.streak, 5);
  } finally {
    ws.close();
    if (claimed.rows.length > 0) {
      await pool.query(
        `update public.coupons
         set status = 'available', claimed_by_kiosk = null, claimed_at = null
         where id = any($1::uuid[])`,
        [claimed.rows.map((row) => row.id)],
      );
    }
  }
});

test('a web player sees the fifth-win streak and multiplier and can play a sixth round', async () => {
  const ws = connect();
  try {
    const welcome = await authWeb(ws);
    assert.equal(welcome.me.streak, 0);
    let fifth;
    for (let round = 1; round <= 5; round += 1) {
      fifth = await playWin(ws, 6000 + round * 10);
    }

    assert.equal(fifth.outcome, 'win');
    assert.equal(fifth.streak, 5);
    assert.equal(fifth.mult, 3);
    assert.ok(!Object.hasOwn(fifth, 'coupon') || fifth.coupon === null);

    const sixth = await playWin(ws, 7000);
    assert.equal(sixth.outcome, 'win');
    assert.equal(sixth.streak, 6);
    assert.equal(sixth.mult, 3);
    assert.ok(!Object.hasOwn(sixth, 'coupon') || sixth.coupon === null);
  } finally {
    ws.close();
  }
});

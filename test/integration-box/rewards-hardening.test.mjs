// Integration tests for ticket B13: rewards hardening and device identity.
//
//   bash db/run-tests-b13.sh --keep
//   DATABASE_URL=postgresql://postgres:test@localhost:55461/postgres npm run test:server

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { WebSocket } from 'ws';
import pg from 'pg';

if (!process.env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL is not set. Start a throwaway database first:\n' +
      '  bash db/run-tests-b13.sh --keep\n' +
      'then export the DATABASE_URL it prints and re-run npm run test:server.',
  );
}
process.env.PLAYER_TOKEN_SECRET ??= 'dev-secret';
// This file mints more anonymous players from one IP (loopback) than the S2 per-IP-per-10min
// anon-player budget (server/limits.js, default 10) allows - R1+R2+R3+R4 alone already reach it.
// limits.js reads its env vars once, at import time, so this must be set before the dynamic
// import below pulls it in transitively through server/index.js.
process.env.MAX_ANON_PLAYERS_PER_IP_PER_10MIN ??= '1000';

const { createApp, signToken } = await import('../../server/index.js');

let app;
let port;
let wsUrl;
let pool;

before(async () => {
  app = createApp({ finnhubToken: null });
  port = await app.start(0, { startFeed: false });
  wsUrl = `ws://localhost:${port}/ws`;
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  app.limits._resetRewardClaimWindow();
  await pool.query(
    "insert into public.tasks (id, title, reward, kind) values ('b13_manual', 'B13 manual task', 250, 'manual') on conflict (id) do update set kind = 'manual', reward = 250",
  );
});

after(async () => {
  await app.close();
  await pool.end();
});

function signDeviceToken(deviceId) {
  const sig = crypto.createHmac('sha256', process.env.PLAYER_TOKEN_SECRET).update(deviceId).digest('hex');
  return `${deviceId}.${sig}`;
}

function freshDeviceToken() {
  const id = crypto.randomUUID();
  return signDeviceToken(id);
}

/** A returning player whose own row has never carried a device_id - a client from before device
 * identity existed, or one that lost its stored device token. Simulated directly in SQL (the
 * same insert + ensure_player(..., null) ledger.createPlayer itself runs, with a null device)
 * rather than by tampering a token: an invalid or absent device token on a *fresh* auth still
 * gets a device minted for it (server/index.js), so it cannot produce this state on its own. */
async function createDeviceLessPlayer() {
  const {
    rows: [{ id }],
  } = await pool.query('insert into auth.users default values returning id');
  await pool.query('select public.ensure_player($1, null)', [id]);
  return id;
}

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

function nextFrame(ws, predicate, timeoutMs = 9000) {
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

async function authAnonymous(ws, deviceToken, playerToken) {
  const auth = { type: 'auth' };
  if (deviceToken !== undefined) auth.device = deviceToken;
  if (playerToken !== undefined) auth.token = playerToken;
  send(ws, auth);
  return nextFrame(ws, (f) => f.type === 'welcome');
}

async function verifyEmail(ws, email) {
  send(ws, { type: 'request_otp', email });
  await nextFrame(ws, (f) => f.type === 'otp_sent');
  const code = await latestDevOtp(email);
  send(ws, { type: 'verify_otp', email, code });
  return nextFrame(ws, (f) => f.type === 'me');
}

async function latestDevOtp(email) {
  const { rows } = await pool.query(
    'select token from public.dev_otps where email = $1 order by created_at desc limit 1',
    [email],
  );
  return rows[0]?.token;
}

// --- R1: one device, two players --------------------------------------------------------------

test('two players sharing one device token cannot both claim the same manual task', async () => {
  const deviceId = (await pool.query("insert into public.devices (first_ip) values ('127.0.0.1'::inet) returning id")).rows[0].id;
  const token = signDeviceToken(deviceId);

  const ws1 = connect();
  await whenOpen(ws1);
  const w1 = await authAnonymous(ws1, token);
  const ws2 = connect();
  await whenOpen(ws2);
  const w2 = await authAnonymous(ws2, token);
  assert.notEqual(w1.me.id, w2.me.id);

  send(ws1, { type: 'claim_task', task_id: 'b13_manual' });
  const r1 = await nextFrame(ws1, (f) => f.type === 'me' || f.type === 'error');

  send(ws2, { type: 'claim_task', task_id: 'b13_manual' });
  const r2 = await nextFrame(ws2, (f) => f.type === 'me' || f.type === 'error');

  const meCount = [r1, r2].filter((f) => f.type === 'me').length;
  const alreadyCount = [r1, r2].filter((f) => f.type === 'error' && f.code === 'already_claimed').length;
  assert.equal(meCount, 1);
  assert.equal(alreadyCount, 1);

  const { rows } = await pool.query(
    "select count(*)::int as n from public.task_claims where task_id = 'b13_manual' and device_id = $1",
    [deviceId],
  );
  assert.equal(rows[0].n, 1);

  ws1.close();
  ws2.close();
});

// --- R2: one email, two devices ---------------------------------------------------------------

test('two players with the same verified email cannot both claim the same manual task', async () => {
  const d1 = (await pool.query("insert into public.devices (first_ip) values ('127.0.0.1'::inet) returning id")).rows[0].id;
  const d2 = (await pool.query("insert into public.devices (first_ip) values ('127.0.0.1'::inet) returning id")).rows[0].id;
  const email = `b13-r2-${Date.now()}@example.com`;

  const ws1 = connect();
  await whenOpen(ws1);
  const w1 = await authAnonymous(ws1, signDeviceToken(d1));
  await verifyEmail(ws1, email);

  const ws2 = connect();
  await whenOpen(ws2);
  await authAnonymous(ws2, signDeviceToken(d2));
  await verifyEmail(ws2, email); // server switches this socket to the already-verified player

  send(ws1, { type: 'claim_task', task_id: 'b13_manual' });
  const r1 = await nextFrame(ws1, (f) => f.type === 'me' || f.type === 'error');
  send(ws2, { type: 'claim_task', task_id: 'b13_manual' });
  const r2 = await nextFrame(ws2, (f) => f.type === 'me' || f.type === 'error');

  assert.equal([r1, r2].filter((f) => f.type === 'me').length, 1);

  // After re-login both sockets point at the same verified player; only one claim was written.
  const { rows } = await pool.query(
    'select count(*)::int as n from public.task_claims where task_id = $1 and player_id = $2',
    ['b13_manual', w1.me.id],
  );
  assert.equal(rows[0].n, 1);

  ws1.close();
  ws2.close();
});

// --- R3: no device token IP cap ---------------------------------------------------------------

// The real "old client" this budget targets is a returning player whose own row has never
// carried a device_id - not a fresh anonymous player, who always gets one minted for them
// during this same auth (see the "fresh socket" test below, which pins down the opposite case).
test('returning players with no device on file are capped at three reward claims per IP per hour', async () => {
  app.limits._resetRewardClaimWindow();
  const outcomes = [];
  const sockets = [];
  const playerIds = [];
  for (let i = 0; i < 5; i++) {
    const playerId = await createDeviceLessPlayer();
    const token = signToken(playerId);
    const ws = connect();
    await whenOpen(ws);
    sockets.push(ws);
    const welcome = await authAnonymous(ws, undefined, token); // no device token; a returning player
    assert.equal(welcome.me.id, playerId);
    assert.equal(welcome.device, undefined, 'a device-less returning player gets no device token on welcome');
    playerIds.push(playerId);
    send(ws, { type: 'claim_task', task_id: 'b13_manual' });
    const reply = await nextFrame(ws, (f) => f.type === 'me' || f.type === 'error');
    outcomes.push(reply);
  }

  const granted = outcomes.filter((f) => f.type === 'me').length;
  const limited = outcomes.filter((f) => f.type === 'error' && f.code === 'rate_limited').length;
  assert.equal(granted, 3, 'three no-device reward claims are allowed per IP per hour');
  assert.equal(limited, 2, 'further no-device claims from the same IP are rate_limited');

  // Scoped to this test's own players: other tests in this file also claim b13_manual from the
  // same loopback IP, so a bare claimed_ip filter would double-count their rows too.
  const { rows } = await pool.query(
    'select count(*)::int as n from public.task_claims where task_id = $1 and claimed_ip = $2::inet and player_id = any($3::uuid[])',
    ['b13_manual', '::1', playerIds],
  );
  assert.equal(rows[0].n, 3);

  for (const ws of sockets) ws.close();
});

// A fresh browser's very first connection never presents a device token (it has nowhere to have
// stored one yet), but the server still mints one for it during this same auth and binds it to
// the player row before `welcome` goes out - so this is not the "old client" case above, and
// must not draw on the same budget. One more claim than the cap, all from brand-new players.
test('a brand-new socket with no presented device token is not charged against the no-device reward budget', async () => {
  app.limits._resetRewardClaimWindow();
  const outcomes = [];
  const sockets = [];
  for (let i = 0; i < 4; i++) {
    const ws = connect();
    await whenOpen(ws);
    sockets.push(ws);
    const welcome = await authAnonymous(ws); // intentionally no device token presented
    assert.ok(welcome.device, 'the server must mint and return a device token for a brand-new player');
    send(ws, { type: 'claim_task', task_id: 'b13_manual' });
    const reply = await nextFrame(ws, (f) => f.type === 'me' || f.type === 'error');
    outcomes.push(reply);
  }

  assert.equal(
    outcomes.filter((f) => f.type === 'me').length,
    4,
    'every fresh player is granted its claim; none are refused rate_limited by the no-device IP budget',
  );

  for (const ws of sockets) ws.close();
});

// --- R4: video progress edge cases ------------------------------------------------------------

test('video progress refuses too-fast jumps and tasks of the wrong kind', async () => {
  const ws = connect();
  await whenOpen(ws);
  const welcome = await authAnonymous(ws, freshDeviceToken());

  // full jump crossing 90% releases the reward
  send(ws, { type: 'task_progress', task: 'video', seconds: 60, duration: 60 });
  const full = await nextFrame(ws, (f) => f.type === 'me' || f.type === 'error');
  assert.equal(full.type, 'me');
  assert.ok(full.reward != null);

  // reset progress and claim state, then try a jump faster than wall clock. task_progress
  // shares the S2 1/s-per-socket query budget (ticket B13) so each send on this socket must
  // wait out the previous one first.
  await pool.query("update public.video_progress set seconds_watched = 0, updated_at = now() where player_id = $1 and task_id = 'video'", [welcome.me.id]);
  await pool.query("delete from public.task_claims where player_id = $1 and task_id = 'video'", [welcome.me.id]);
  await new Promise((r) => setTimeout(r, 1100));
  send(ws, { type: 'task_progress', task: 'video', seconds: 50, duration: 60 });
  const fast = await nextFrame(ws, (f) => f.type === 'me' || f.type === 'error');
  assert.equal(fast.type, 'error');
  assert.equal(fast.code, 'progress_too_fast');

  // short duration below the 10 s minimum yields no reward
  await pool.query(
    "insert into public.tasks (id, title, reward, kind) values ('shortvideo', 'Short', 100, 'video') on conflict (id) do nothing",
  );
  await new Promise((r) => setTimeout(r, 1100));
  send(ws, { type: 'task_progress', task: 'shortvideo', seconds: 5, duration: 5 });
  const short = await nextFrame(ws, (f) => f.type === 'me' || f.type === 'error');
  assert.equal(short.type, 'me');
  assert.equal(short.reward, undefined);

  // progress for a redirect task is refused as unknown_task
  await new Promise((r) => setTimeout(r, 1100));
  send(ws, { type: 'task_progress', task: 'telegram', seconds: 10, duration: 60 });
  const wrong = await nextFrame(ws, (f) => f.type === 'me' || f.type === 'error');
  assert.equal(wrong.type, 'error');
  assert.equal(wrong.code, 'unknown_task');

  ws.close();
});

// --- R5: redirect edge cases ------------------------------------------------------------------

test('redirect-and-return windows are enforced and unseeded tasks are unknown', async () => {
  const ws = connect();
  await whenOpen(ws);
  await authAnonymous(ws, freshDeviceToken());

  await pool.query("delete from public.task_visits where task_id = 'telegram'");
  await pool.query("delete from public.task_claims where task_id = 'telegram'");

  // return without start
  send(ws, { type: 'task_return', task: 'telegram' });
  const noStart = await nextFrame(ws, (f) => f.type === 'me' || f.type === 'error');
  assert.equal(noStart.type, 'error');
  assert.equal(noStart.code, 'not_yet');
  assert.equal(noStart.retry_ms, 5000);

  // start, then return too early
  await new Promise((r) => setTimeout(r, 250));
  send(ws, { type: 'task_start', task: 'telegram' });
  await nextFrame(ws, (f) => f.type === 'task_started');
  await new Promise((r) => setTimeout(r, 1000));
  send(ws, { type: 'task_return', task: 'telegram' });
  const early = await nextFrame(ws, (f) => f.type === 'me' || f.type === 'error');
  assert.equal(early.type, 'error');
  assert.equal(early.code, 'not_yet');
  // A loose upper bound only, not a specific number: this checks that some time remains in the
  // 5 s window, not exactly how many ms of it a slow CI box burned on the round trip.
  assert.ok(early.retry_ms > 0 && early.retry_ms < 5000, `retry_ms was ${early.retry_ms}`);

  // double start then immediate return. Both task_start sends must clear the 1/s-per-socket
  // budget (ticket B13), so they are 1100ms apart - the second still lands inside the SQL
  // layer and resets the visit window, rather than being refused as rate_limited itself.
  await new Promise((r) => setTimeout(r, 1100));
  await pool.query("delete from public.task_visits where task_id = 'telegram'");
  await pool.query("delete from public.task_claims where task_id = 'telegram'");
  send(ws, { type: 'task_start', task: 'telegram' });
  await new Promise((r) => setTimeout(r, 1100));
  send(ws, { type: 'task_start', task: 'telegram' });
  await nextFrame(ws, (f) => f.type === 'task_started');
  send(ws, { type: 'task_return', task: 'telegram' });
  const double = await nextFrame(ws, (f) => f.type === 'me' || f.type === 'error');
  assert.equal(double.type, 'error');
  assert.equal(double.code, 'not_yet');

  // unseeded task
  await new Promise((r) => setTimeout(r, 1100));
  send(ws, { type: 'task_return', task: 'never-seeded-task-xyz' });
  const missing = await nextFrame(ws, (f) => f.type === 'me' || f.type === 'error');
  assert.equal(missing.type, 'error');
  assert.equal(missing.code, 'unknown_task');

  ws.close();
});

// --- R6: email reward idempotency -------------------------------------------------------------

test('email and signup rewards are granted only once per verified email', async () => {
  const email = `b13-r6-${Date.now()}@example.com`;
  const d1 = (await pool.query("insert into public.devices (first_ip) values ('127.0.0.1'::inet) returning id")).rows[0].id;

  const ws1 = connect();
  await whenOpen(ws1);
  const w1 = await authAnonymous(ws1, signDeviceToken(d1));

  send(ws1, { type: 'request_otp', email });
  await nextFrame(ws1, (f) => f.type === 'otp_sent');
  const code1 = await latestDevOtp(email);
  send(ws1, { type: 'verify_otp', email, code: code1 });
  const first = await nextFrame(ws1, (f) => f.type === 'me');
  assert.ok(first.reward > 0);

  // second OTP cycle on the same player
  send(ws1, { type: 'request_otp', email });
  await nextFrame(ws1, (f) => f.type === 'otp_sent');
  const code2 = await latestDevOtp(email);
  send(ws1, { type: 'verify_otp', email, code: code2 });
  const second = await nextFrame(ws1, (f) => f.type === 'me');
  assert.equal(second.reward, undefined);

  // same email from a different device
  const d2 = (await pool.query("insert into public.devices (first_ip) values ('127.0.0.1'::inet) returning id")).rows[0].id;
  const ws2 = connect();
  await whenOpen(ws2);
  await authAnonymous(ws2, signDeviceToken(d2));
  send(ws2, { type: 'request_otp', email });
  await nextFrame(ws2, (f) => f.type === 'otp_sent');
  const code3 = await latestDevOtp(email);
  send(ws2, { type: 'verify_otp', email, code: code3 });
  const other = await nextFrame(ws2, (f) => f.type === 'me');
  assert.equal(other.reward, undefined);
  assert.equal(other.id, w1.me.id); // re-login

  ws1.close();
  ws2.close();
});

// --- R7: replay on second socket --------------------------------------------------------------

test('replaying a reward frame on a second socket is idempotent', async () => {
  const d = (await pool.query("insert into public.devices (first_ip) values ('127.0.0.1'::inet) returning id")).rows[0].id;
  const ws1 = connect();
  await whenOpen(ws1);
  const welcome = await authAnonymous(ws1, signDeviceToken(d));

  send(ws1, { type: 'task_progress', task: 'video', seconds: 55, duration: 60 });
  const first = await nextFrame(ws1, (f) => f.type === 'me');
  assert.ok(first.reward != null);

  // Same player, second socket - the redteam attack is one player replaying a captured frame on
  // another tab, not a second player sharing the same device (that is R9's own concern).
  const ws2 = connect();
  await whenOpen(ws2);
  await authAnonymous(ws2, signDeviceToken(d), welcome.token);
  send(ws2, { type: 'task_progress', task: 'video', seconds: 55, duration: 60 });
  const replay = await nextFrame(ws2, (f) => f.type === 'me' || f.type === 'error');
  assert.equal(replay.type, 'me');
  assert.equal(replay.reward, undefined);

  await new Promise((r) => setTimeout(r, 250));
  send(ws1, { type: 'task_start', task: 'telegram' });
  await nextFrame(ws1, (f) => f.type === 'task_started');
  await pool.query("update public.task_visits set started_at = now() - interval '6 seconds' where player_id = $1 and task_id = 'telegram'", [welcome.me.id]);
  await new Promise((r) => setTimeout(r, 250));
  send(ws1, { type: 'task_return', task: 'telegram' });
  const ret = await nextFrame(ws1, (f) => f.type === 'me');
  assert.ok(ret.reward != null);

  await new Promise((r) => setTimeout(r, 250));
  send(ws2, { type: 'task_return', task: 'telegram' });
  const replayRet = await nextFrame(ws2, (f) => f.type === 'me' || f.type === 'error');
  assert.equal(replayRet.type, 'error');
  assert.equal(replayRet.code, 'already_claimed');

  const { rows } = await pool.query(
    'select task_id, count(*)::int as n from public.task_claims where player_id = $1 group by task_id order by task_id',
    [welcome.me.id],
  );
  assert.deepEqual(
    rows.map((r) => `${r.task_id}=${r.n}`),
    ['telegram=1', 'video=1'],
  );

  ws1.close();
  ws2.close();
});

// --- R8: frame flood on new frames ------------------------------------------------------------

test('flooding task_progress / task_start / task_return is rate_limited per socket', async () => {
  const ws = connect();
  await whenOpen(ws);
  const welcome = await authAnonymous(ws, freshDeviceToken());

  const floodAndCountErrors = async (frame) => {
    const before = ws.inbox.length + ws.waiters.length;
    for (let i = 0; i < 10; i++) send(ws, frame);
    await new Promise((r) => setTimeout(r, 500));
    return ws.inbox.slice(before).filter((f) => f.type === 'error' && f.code === 'rate_limited').length;
  };

  const progressErrors = await floodAndCountErrors({ type: 'task_progress', task: 'video', seconds: 1, duration: 60 });
  const startErrors = await floodAndCountErrors({ type: 'task_start', task: 'telegram' });
  const returnErrors = await floodAndCountErrors({ type: 'task_return', task: 'telegram' });

  assert.ok(progressErrors >= 8, `task_progress flood errors: ${progressErrors}`);
  assert.ok(startErrors >= 8, `task_start flood errors: ${startErrors}`);
  assert.ok(returnErrors >= 8, `task_return flood errors: ${returnErrors}`);

  // Scoped to this test's own player: other tests in this file also touch video/telegram, and
  // both tables upsert one row per player anyway, so an unscoped count would just measure how
  // many other tests ran before this one.
  const { rows: vp } = await pool.query(
    "select count(*)::int as n from public.video_progress where task_id = 'video' and player_id = $1",
    [welcome.me.id],
  );
  const { rows: tv } = await pool.query(
    "select count(*)::int as n from public.task_visits where task_id = 'telegram' and player_id = $1",
    [welcome.me.id],
  );
  assert.ok(vp[0].n <= 1, `video_progress rows after flood: ${vp[0].n}`);
  assert.ok(tv[0].n <= 1, `task_visits rows after flood: ${tv[0].n}`);

  ws.close();
});

// --- R9: device token tampering ---------------------------------------------------------------

test('a tampered or reused device token never authenticates as another player', async () => {
  const deviceId = (await pool.query("insert into public.devices (first_ip) values ('127.0.0.1'::inet) returning id")).rows[0].id;
  const goodToken = signDeviceToken(deviceId);

  const ws1 = connect();
  await whenOpen(ws1);
  const victim = await authAnonymous(ws1, goodToken);
  await pool.query('update public.players set coins = 77777 where id = $1', [victim.me.id]);

  const tampered = goodToken.slice(0, -1) + (goodToken.endsWith('a') ? 'b' : 'a');
  const ws2 = connect();
  await whenOpen(ws2);
  const t1 = await authAnonymous(ws2, tampered);
  assert.notEqual(t1.me.id, victim.me.id);

  const [idPart, sig] = goodToken.split('.');
  const forged = `${idPart.slice(0, -1) + (idPart.endsWith('a') ? 'b' : 'a')}.${sig}`;
  const ws3 = connect();
  await whenOpen(ws3);
  const t2 = await authAnonymous(ws3, forged);
  assert.notEqual(t2.me.id, victim.me.id);

  const { rows } = await pool.query('select coins from public.players where id = $1', [victim.me.id]);
  assert.equal(rows[0].coins, 77777);

  ws1.close();
  ws2.close();
  ws3.close();
});

#!/usr/bin/env node
/**
 * Red team: rewards and device identity hardening (ticket B13).
 *
 * Each function below is one attack against a running server. Every OBSERVED line came back
 * from a real socket or a real database query. Reuses the socket helper style from
 * demo/redteam.mjs.
 *
 * Run:
 *   bash db/run-tests-b13.sh --keep
 *   DATABASE_URL=postgresql://postgres:test@localhost:55461/postgres \
 *     PLAYER_TOKEN_SECRET=dev-secret npm run server
 *   DATABASE_URL=postgresql://postgres:test@localhost:55461/postgres \
 *     PLAYER_TOKEN_SECRET=dev-secret node demo/redteam-rewards.mjs
 *
 * Options: --only <id,id>  run a subset
 */

import crypto from 'node:crypto';
import pg from 'pg';
import { WebSocket } from 'ws';

const WS_URL = process.env.GAME_WS || 'ws://localhost:8787/ws';
const HTTP_URL = process.env.GAME_HTTP || 'http://localhost:8787';
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:test@localhost:55461/postgres';
const TOKEN_SECRET = process.env.PLAYER_TOKEN_SECRET || 'dev-secret';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pool = new pg.Pool({ connectionString: DATABASE_URL });
const q = async (sql, params = []) => (await pool.query(sql, params)).rows;

/* ------------------------------------------------------------------ socket helper -- */

class Rig {
  constructor(label = 'rig') {
    this.label = label;
    this.frames = [];
    this.ws = null;
    this.closed = false;
  }

  open() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(WS_URL);
      this.ws.on('message', (data) => {
        let frame;
        try {
          frame = JSON.parse(data.toString());
        } catch {
          this.frames.push({ type: '<unparseable>', raw: data.toString().slice(0, 80) });
          return;
        }
        this.frames.push(frame);
      });
      this.ws.on('open', resolve);
      this.ws.on('error', (err) => {
        if (!this.closed) reject(err);
      });
      this.ws.on('close', () => {
        this.closed = true;
      });
    });
  }

  send(frame) {
    this.ws.send(typeof frame === 'string' ? frame : JSON.stringify(frame));
  }

  async wait(pred, ms = 9000, since = 0) {
    const test = typeof pred === 'string' ? (f) => f.type === pred : pred;
    const deadline = Date.now() + ms;
    let i = since;
    while (Date.now() < deadline) {
      while (i < this.frames.length) {
        if (test(this.frames[i])) return this.frames[i];
        i += 1;
      }
      await sleep(25);
    }
    return null;
  }

  seen(pred) {
    const test = typeof pred === 'string' ? (f) => f.type === pred : pred;
    return this.frames.filter(test);
  }

  mark() {
    return this.frames.length;
  }

  async authPlayer(token, deviceToken) {
    await this.open();
    const auth = { type: 'auth' };
    if (token) auth.token = token;
    if (deviceToken !== undefined) auth.device = deviceToken;
    this.send(auth);
    const welcome = await this.wait('welcome');
    if (!welcome) throw new Error(`${this.label}: no welcome`);
    this.token = welcome.token;
    this.id = welcome.me && welcome.me.id;
    this.me = welcome.me;
    return welcome;
  }

  close() {
    this.closed = true;
    try {
      this.ws.close();
    } catch {
      /* already gone */
    }
  }
}

async function newPlayer(label = 'player', deviceToken, playerToken) {
  const rig = new Rig(label);
  await rig.authPlayer(playerToken || null, deviceToken);
  return rig;
}

function signDeviceToken(deviceId) {
  const sig = crypto.createHmac('sha256', TOKEN_SECRET).update(deviceId).digest('hex');
  return `${deviceId}.${sig}`;
}

/** A fresh, self-signed device token for attacks that are not R3's own no-device scenario -
 * without one, a rig shares R3's 3-per-IP-per-hour no-device reward budget (ticket B13) and
 * gets incidentally rate_limited by an earlier attack's own runs, not by anything this attack
 * is actually testing. */
function freshDeviceToken() {
  return signDeviceToken(crypto.randomUUID());
}

function tamperToken(token) {
  const last = token.slice(-1);
  return token.slice(0, -1) + (last === 'a' ? 'b' : 'a');
}

const TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60; // must match server/index.js's own TOKEN_TTL_SECONDS

/** A valid player token, signed the same way server/index.js's own signToken does (this script
 * has no access to that function - it only ever talks to the server over the wire). */
function signPlayerToken(playerId, version = 1) {
  const expiresAt = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;
  const payload = `${playerId}.${version}.${expiresAt}`;
  const sig = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

/* ------------------------------------------------------------------- db fixtures -- */

/** A manual task claim_task is still allowed to claim (ticket B6+B7+B9 decision 5). */
async function ensureManualTask() {
  await pool.query(
    "insert into public.tasks (id, title, reward, kind) values ('b13_manual', 'B13 manual task', 250, 'manual') on conflict (id) do update set kind = 'manual', reward = 250",
  );
}

/** A returning player whose own row has never carried a device_id - the real "old client" this
 * ticket's no-device budget targets, never a fresh anonymous player (who always gets a device
 * minted for it during its own auth - see the "fresh socket" check inside R3 below). */
async function createDeviceLessPlayer() {
  const [{ id }] = await q('insert into auth.users default values returning id');
  await pool.query('select public.ensure_player($1, null)', [id]);
  return id;
}

async function devOtp(email) {
  const rows = await q('select token from public.dev_otps where email = $1 order by created_at desc limit 1', [email]);
  return rows[0]?.token;
}

/** Runs a rig through one request_otp/verify_otp cycle and returns the resulting `me` frame. */
async function verifyEmail(rig, email) {
  let m = rig.mark();
  rig.send({ type: 'request_otp', email });
  await rig.wait('otp_sent', 8000, m);
  const code = await devOtp(email);
  m = rig.mark();
  rig.send({ type: 'verify_otp', email, code });
  return rig.wait('me', 8000, m);
}

/* ------------------------------------------------------------------ result plumbing -- */

const results = [];

function report({ id, title, attack, expected, observed, verdict, note }) {
  const lines = Array.isArray(observed) ? observed : [observed];
  console.log(`\n${'='.repeat(78)}`);
  console.log(`${id}  ${title}`);
  console.log('-'.repeat(78));
  console.log(`ATTACK    ${attack}`);
  console.log(`EXPECTED  ${expected}`);
  for (const [i, line] of lines.entries()) console.log(`${i === 0 ? 'OBSERVED  ' : '          '}${line}`);
  console.log(`VERDICT   ${verdict}${note ? ` - ${note}` : ''}`);
  results.push({ id, title, verdict, note: note || lines[0] });
  return { id, title, verdict };
}

/* ============================================================== the attacks ========= */

/** R1: one device, two players (clear the player token, keep the device token). */
async function r1OneDeviceTwoPlayers() {
  await ensureManualTask();
  const deviceRow = await q("insert into public.devices (first_ip) values ('127.0.0.1'::inet) returning id");
  const deviceId = deviceRow[0].id;
  const deviceToken = signDeviceToken(deviceId);

  const one = await newPlayer('r1-one', deviceToken);
  const two = await newPlayer('r1-two', deviceToken);

  const m1 = one.mark();
  const m2 = two.mark();
  one.send({ type: 'claim_task', task_id: 'b13_manual' });
  two.send({ type: 'claim_task', task_id: 'b13_manual' });
  await sleep(1500);
  const r1 = one.frames.slice(m1).find((f) => f.type === 'me' || f.type === 'error');
  const r2 = two.frames.slice(m2).find((f) => f.type === 'me' || f.type === 'error');

  const claims = await q(
    "select count(*)::int as n from public.task_claims where task_id = 'b13_manual' and device_id = $1",
    [deviceId],
  );
  one.close();
  two.close();

  const granted = [r1, r2].filter((f) => f && f.type === 'me').length;
  const already = [r1, r2].filter((f) => f && f.type === 'error' && f.code === 'already_claimed').length;
  return report({
    id: 'R1',
    title: 'One device, two players: claim the same task twice',
    attack: 'two fresh anonymous players on the same device token both claim the same manual task',
    expected: 'exactly one claim succeeds; the other is already_claimed; only one task_claims row for this device',
    observed: [
      `player 1: ${r1 ? (r1.type === 'error' ? `error:${r1.code}` : `me reward=${r1.reward}`) : 'no reply'}`,
      `player 2: ${r2 ? (r2.type === 'error' ? `error:${r2.code}` : `me reward=${r2.reward}`) : 'no reply'}`,
      `task_claims rows for this device and task: ${claims[0].n}`,
    ],
    verdict: granted === 1 && already === 1 && claims[0].n === 1 ? 'HELD' : 'LOOPHOLE',
    note: granted === 1 ? 'device-level idempotency held' : `${granted} grants for one device`,
  });
}

/** R2: one verified email on two devices. */
async function r2OneEmailTwoDevices() {
  await ensureManualTask();
  const deviceA = (await q("insert into public.devices (first_ip) values ('127.0.0.1'::inet) returning id"))[0].id;
  const deviceB = (await q("insert into public.devices (first_ip) values ('127.0.0.1'::inet) returning id"))[0].id;
  const email = `r2-shared-${Date.now()}@example.com`;

  const one = await newPlayer('r2-one', signDeviceToken(deviceA));
  const two = await newPlayer('r2-two', signDeviceToken(deviceB));
  // Verify the same email through the real OTP flow on both devices, not a raw SQL update -
  // auth.users.email is unique, so two players can never both hold it directly. The server's
  // own re-login path (docs/reports/redteam.md, otp.test.mjs) is what actually produces "one
  // verified email, two devices": the second verify switches that socket onto the first
  // player instead of erroring, which is the real shape this attack needs to test.
  await verifyEmail(one, email);
  await verifyEmail(two, email);

  const m1 = one.mark();
  const m2 = two.mark();
  one.send({ type: 'claim_task', task_id: 'b13_manual' });
  two.send({ type: 'claim_task', task_id: 'b13_manual' });
  await sleep(1500);
  const r1 = one.frames.slice(m1).find((f) => f.type === 'me' || f.type === 'error');
  const r2 = two.frames.slice(m2).find((f) => f.type === 'me' || f.type === 'error');

  const claims = await q(
    "select count(*)::int as n from public.task_claims where task_id = 'b13_manual' and player_id in ($1, $2)",
    [one.id, two.id],
  );
  one.close();
  two.close();

  const granted = [r1, r2].filter((f) => f && f.type === 'me').length;
  return report({
    id: 'R2',
    title: 'One verified email on two devices: claim the same task twice',
    attack: 'two players with different device tokens but the same verified email both claim the same task',
    expected: 'exactly one claim succeeds; the email-level backstop blocks the other',
    observed: [
      `player A: ${r1 ? (r1.type === 'error' ? `error:${r1.code}` : `me reward=${r1.reward}`) : 'no reply'}`,
      `player B: ${r2 ? (r2.type === 'error' ? `error:${r2.code}` : `me reward=${r2.reward}`) : 'no reply'}`,
      `task_claims rows for these two players: ${claims[0].n}`,
    ],
    verdict: granted === 1 && claims[0].n === 1 ? 'HELD' : 'LOOPHOLE',
    note: granted === 1 ? 'email-level idempotency held' : `${granted} grants for one email`,
  });
}

/** R3: no device on file at all - how many rewards can one IP farm in an hour, and does a fresh
 * browser's own first-ever claim get caught in the same net by mistake. The real "old client"
 * is a returning player whose row has never carried a device_id, not a fresh anonymous player:
 * the server mints and binds a device to a brand-new player during its own auth, before welcome
 * even goes out, so that player is never "no device" from the budget's point of view. */
async function r3NoDeviceTokenFarming() {
  await ensureManualTask();

  // Phase 1: five returning, device-less players (the real farming vector) share one IP.
  const rigs = [];
  const outcomes = [];
  for (let i = 0; i < 5; i++) {
    const playerId = await createDeviceLessPlayer();
    const rig = await newPlayer(`r3-${i}`, undefined, signPlayerToken(playerId));
    rigs.push(rig);
    const m = rig.mark();
    rig.send({ type: 'claim_task', task_id: 'b13_manual' });
    const reply = await rig.wait((f) => f.type === 'me' || f.type === 'error', 6000, m);
    outcomes.push(reply ? (reply.type === 'error' ? `error:${reply.code}` : `me reward=${reply.reward}`) : 'no reply');
  }
  const granted = outcomes.filter((o) => o.startsWith('me')).length;
  const limited = outcomes.filter((o) => o === 'error:rate_limited').length;

  // Phase 2: a brand-new anonymous player, no device token presented - must NOT be caught by
  // the same budget phase 1 just exhausted, because the server minted this one its own device.
  const freshRig = await newPlayer('r3-fresh'); // no device token presented
  const freshHasDevice = !!freshRig.me?.device_id;
  const fm = freshRig.mark();
  freshRig.send({ type: 'claim_task', task_id: 'b13_manual' });
  const freshReply = await freshRig.wait((f) => f.type === 'me' || f.type === 'error', 6000, fm);
  freshRig.close();

  for (const r of rigs) r.close();
  const held =
    granted === 3 &&
    limited === 2 &&
    freshHasDevice &&
    freshReply &&
    freshReply.type === 'me' &&
    freshReply.reward != null;
  return report({
    id: 'R3',
    title: 'No device on file: farm rewards from one IP, and a fresh browser must not share the cap',
    attack:
      'five returning, device-less players share one IP and all claim a reward; then one brand-new anonymous player (no device presented) claims too',
    expected:
      'only 3 rewards per IP per hour for device-less returning players, the rest rate_limited; the fresh player is unaffected and granted',
    observed: [
      `device-less outcomes: ${outcomes.join(' | ')}`,
      `device-less granted: ${granted}, rate_limited: ${limited}`,
      `fresh player device on welcome: ${freshHasDevice}`,
      `fresh player claim: ${freshReply ? (freshReply.type === 'error' ? `error:${freshReply.code}` : `me reward=${freshReply.reward}`) : 'no reply'}`,
    ],
    verdict: held ? 'HELD' : 'LOOPHOLE',
    note: held ? 'no-device IP cap targets the right players' : 'the cap is wrong for either the returning or the fresh player',
  });
}

/** R4: video progress edge cases. */
async function r4VideoEdgeCases() {
  const rig = await newPlayer('r4', freshDeviceToken());
  const observed = [];

  // seconds == duration in one frame, crossing 90%
  const m1 = rig.mark();
  rig.send({ type: 'task_progress', task: 'video', seconds: 60, duration: 60 });
  const full = await rig.wait((f) => f.type === 'me' || f.type === 'error', 6000, m1);
  observed.push(`seconds=duration (60/60): ${full ? (full.type === 'error' ? `error:${full.code}` : `me reward=${full.reward}`) : 'no reply'}`);

  // faster than wall clock. task_progress shares the S2 1/s-per-socket query budget (ticket
  // B13), so each send on this socket waits out the previous one first.
  await q("update public.video_progress set seconds_watched = 0, updated_at = now() where player_id = $1 and task_id = 'video'", [rig.id]);
  await q("delete from public.task_claims where player_id = $1 and task_id = 'video'", [rig.id]);
  await sleep(1100);
  const m2 = rig.mark();
  rig.send({ type: 'task_progress', task: 'video', seconds: 50, duration: 60 });
  const fast = await rig.wait((f) => f.type === 'me' || f.type === 'error', 6000, m2);
  observed.push(`50s jump instantly: ${fast ? (fast.type === 'error' ? `error:${fast.code}` : `me reward=${fast.reward}`) : 'no reply'}`);

  // 5s duration (under the 10s minimum)
  await q("delete from public.video_progress where player_id = $1 and task_id = 'shortvideo'", [rig.id]);
  await q("delete from public.task_claims where player_id = $1 and task_id = 'shortvideo'", [rig.id]);
  await pool.query(
    "insert into public.tasks (id, title, reward, kind) values ('shortvideo', 'Short', 100, 'video') on conflict (id) do nothing",
  );
  await sleep(1100);
  const m3 = rig.mark();
  rig.send({ type: 'task_progress', task: 'shortvideo', seconds: 5, duration: 5 });
  const short = await rig.wait((f) => f.type === 'me' || f.type === 'error', 6000, m3);
  observed.push(`5s duration at 100%: ${short ? (short.type === 'error' ? `error:${short.code}` : `me reward=${short.reward}`) : 'no reply'}`);

  // progress for a non-video task
  await sleep(1100);
  const m4 = rig.mark();
  rig.send({ type: 'task_progress', task: 'telegram', seconds: 10, duration: 60 });
  const wrongKind = await rig.wait((f) => f.type === 'me' || f.type === 'error', 6000, m4);
  observed.push(`progress for redirect task telegram: ${wrongKind ? (wrongKind.type === 'error' ? `error:${wrongKind.code}` : `me reward=${wrongKind.reward}`) : 'no reply'}`);

  rig.close();
  const held =
    full && full.type === 'me' && full.reward != null &&
    fast && fast.type === 'error' && fast.code === 'progress_too_fast' &&
    short && short.type === 'me' && short.reward == null &&
    wrongKind && wrongKind.type === 'error' && wrongKind.code === 'unknown_task';
  return report({
    id: 'R4',
    title: 'Video progress abuse: full jump, too fast, too short, wrong kind',
    attack: 'report seconds=duration; report a big jump instantly; report a 5s duration; report progress for a redirect task',
    expected: 'full jump releases if >=90%/>=10s; too-fast refused; too short releases no reward; wrong kind is unknown_task',
    observed,
    verdict: held ? 'HELD' : 'LOOPHOLE',
    note: held ? 'video guard held' : 'a video edge case escaped',
  });
}

/** R5: redirect-and-return edge cases. */
async function r5RedirectEdgeCases() {
  const rig = await newPlayer('r5', freshDeviceToken());
  const observed = [];

  // return without start
  await q("delete from public.task_visits where player_id = $1 and task_id = 'telegram'", [rig.id]);
  await q("delete from public.task_claims where player_id = $1 and task_id = 'telegram'", [rig.id]);
  const m1 = rig.mark();
  rig.send({ type: 'task_return', task: 'telegram' });
  const noStart = await rig.wait((f) => f.type === 'me' || f.type === 'error', 6000, m1);
  observed.push(`task_return without start: ${noStart ? (noStart.type === 'error' ? `error:${noStart.code} retry_ms=${noStart.retry_ms}` : `me reward=${noStart.reward}`) : 'no reply'}`);

  // start, then return after 1s. task_return shares the S2 1/s-per-socket query budget
  // (ticket B13), so each send on this socket waits out the previous one first.
  const m2 = rig.mark();
  rig.send({ type: 'task_start', task: 'telegram' });
  await rig.wait('task_started', 6000, m2);
  await sleep(1100);
  const m3 = rig.mark();
  rig.send({ type: 'task_return', task: 'telegram' });
  const early = await rig.wait((f) => f.type === 'me' || f.type === 'error', 6000, m3);
  observed.push(`task_return after 1s: ${early ? (early.type === 'error' ? `error:${early.code} retry_ms=${early.retry_ms}` : `me reward=${early.reward}`) : 'no reply'}`);

  // start twice then immediate return
  await q("delete from public.task_visits where player_id = $1 and task_id = 'telegram'", [rig.id]);
  await q("delete from public.task_claims where player_id = $1 and task_id = 'telegram'", [rig.id]);
  await sleep(1100);
  const m4 = rig.mark();
  rig.send({ type: 'task_start', task: 'telegram' });
  rig.send({ type: 'task_start', task: 'telegram' });
  await rig.wait('task_started', 6000, m4);
  await sleep(1100);
  const m5 = rig.mark();
  rig.send({ type: 'task_return', task: 'telegram' });
  const doubleStart = await rig.wait((f) => f.type === 'me' || f.type === 'error', 6000, m5);
  observed.push(`task_start twice then immediate return: ${doubleStart ? (doubleStart.type === 'error' ? `error:${doubleStart.code} retry_ms=${doubleStart.retry_ms}` : `me reward=${doubleStart.reward}`) : 'no reply'}`);

  // return for a task that does not exist
  await sleep(1100);
  const m6 = rig.mark();
  rig.send({ type: 'task_return', task: 'never-seeded-task-xyz' });
  const missing = await rig.wait((f) => f.type === 'me' || f.type === 'error', 6000, m6);
  observed.push(`task_return for unseeded task: ${missing ? (missing.type === 'error' ? `error:${missing.code}` : `me reward=${missing.reward}`) : 'no reply'}`);

  rig.close();
  const held =
    noStart && noStart.type === 'error' && noStart.code === 'not_yet' && noStart.retry_ms === 5000 &&
    early && early.type === 'error' && early.code === 'not_yet' && typeof early.retry_ms === 'number' && early.retry_ms > 0 &&
    doubleStart && doubleStart.type === 'error' && doubleStart.code === 'not_yet' &&
    missing && missing.type === 'error' && missing.code === 'unknown_task';
  return report({
    id: 'R5',
    title: 'Redirect-and-return abuse: no start, early return, double start, missing task',
    attack: 'task_return without task_start; task_return after 1s; task_start twice then return; task_return for an unseeded task',
    expected: 'no start -> not_yet 5000ms; early -> not_yet with remaining ms; double start resets timer -> not_yet; unseeded -> unknown_task',
    observed,
    verdict: held ? 'HELD' : 'LOOPHOLE',
    note: held ? 'redirect window held' : 'a redirect edge case escaped',
  });
}

/** R6: email reward idempotency across OTP cycles and devices. */
async function r6EmailRewardIdempotency() {
  const deviceA = (await q("insert into public.devices (first_ip) values ('127.0.0.1'::inet) returning id"))[0].id;
  const deviceB = (await q("insert into public.devices (first_ip) values ('127.0.0.1'::inet) returning id"))[0].id;
  const email = `r6-${Date.now()}@example.com`;

  // player on device A verifies the email
  const one = await newPlayer('r6-one', signDeviceToken(deviceA));
  let m = one.mark();
  one.send({ type: 'request_otp', email });
  await one.wait('otp_sent', 8000, m);
  const code1 = await devOtp(email);
  m = one.mark();
  one.send({ type: 'verify_otp', email, code: code1 });
  const firstVerify = await one.wait('me', 8000, m);

  // same player verifies the same email again (new OTP cycle)
  m = one.mark();
  one.send({ type: 'request_otp', email });
  await one.wait('otp_sent', 8000, m);
  const code2 = await devOtp(email);
  m = one.mark();
  one.send({ type: 'verify_otp', email, code: code2 });
  const secondVerify = await one.wait('me', 8000, m);

  // player on device B tries the same email
  const two = await newPlayer('r6-two', signDeviceToken(deviceB));
  m = two.mark();
  two.send({ type: 'request_otp', email });
  await two.wait('otp_sent', 8000, m);
  const code3 = await devOtp(email);
  m = two.mark();
  two.send({ type: 'verify_otp', email, code: code3 });
  const deviceBVerify = await two.wait('me', 8000, m);

  const claims = await q(
    'select task_id, count(*)::int as n from public.task_claims where player_id = $1 or player_id = $2 group by task_id order by task_id',
    [one.id, two.id],
  );
  one.close();
  two.close();

  const firstReward = (firstVerify?.reward || 0);
  const secondReward = (secondVerify?.reward || 0);
  const bReward = (deviceBVerify?.reward || 0);
  const held = firstReward > 0 && secondReward === 0 && bReward === 0;
  return report({
    id: 'R6',
    title: 'Email reward: verify twice and on a second device',
    attack: 'verify an email, verify it again with a fresh OTP, then verify the same email from a different device',
    expected: 'rewards only on the first verification; the second cycle and the other device get nothing extra',
    observed: [
      `first verify reward: ${firstReward}`,
      `second verify reward: ${secondReward}`,
      `device B verify reward: ${bReward}`,
      `task_claims per task for these players: ${claims.map((c) => `${c.task_id}=${c.n}`).join(', ')}`,
    ],
    verdict: held ? 'HELD' : 'LOOPHOLE',
    note: held ? 'email reward is once per verified email' : 'email reward was granted more than once',
  });
}

/** R7: replay a captured task_progress / task_return frame on a second socket. */
async function r7ReplayOnSecondSocket() {
  const device = (await q("insert into public.devices (first_ip) values ('127.0.0.1'::inet) returning id"))[0].id;
  const rig = await newPlayer('r7-main', signDeviceToken(device));

  // release the video reward once
  let m = rig.mark();
  rig.send({ type: 'task_progress', task: 'video', seconds: 55, duration: 60 });
  const first = await rig.wait('me', 8000, m);

  // second socket on the same player token
  const replay = new Rig('r7-replay');
  await replay.authPlayer(rig.token, signDeviceToken(device));

  // replay the same progress frame
  m = replay.mark();
  replay.send({ type: 'task_progress', task: 'video', seconds: 55, duration: 60 });
  const replayProgress = await replay.wait((f) => f.type === 'me' || f.type === 'error', 6000, m);

  // release the telegram reward once, then replay task_return
  m = rig.mark();
  rig.send({ type: 'task_start', task: 'telegram' });
  await rig.wait('task_started', 6000, m);
  await q("update public.task_visits set started_at = now() - interval '6 seconds' where player_id = $1 and task_id = 'telegram'", [rig.id]);
  m = rig.mark();
  rig.send({ type: 'task_return', task: 'telegram' });
  const retFirst = await rig.wait('me', 6000, m);

  m = replay.mark();
  replay.send({ type: 'task_return', task: 'telegram' });
  const replayReturn = await replay.wait((f) => f.type === 'me' || f.type === 'error', 6000, m);

  const claims = await q(
    'select task_id, count(*)::int as n from public.task_claims where player_id = $1 group by task_id order by task_id',
    [rig.id],
  );
  rig.close();
  replay.close();

  const held =
    first && first.reward != null &&
    replayProgress && replayProgress.type === 'me' && replayProgress.reward == null &&
    retFirst && retFirst.reward != null &&
    replayReturn && replayReturn.type === 'error' && replayReturn.code === 'already_claimed';
  return report({
    id: 'R7',
    title: 'Replay a captured task_progress / task_return on a second socket',
    attack: 'release a video reward and a redirect reward, then replay the same frames on another socket for the same player',
    expected: 'replaying a reward frame grants nothing extra; the second socket gets no reward or already_claimed',
    observed: [
      `first video progress reward: ${first?.reward}`,
      `replayed video progress: ${replayProgress ? (replayProgress.type === 'error' ? `error:${replayProgress.code}` : `me reward=${replayProgress.reward}`) : 'no reply'}`,
      `first telegram return reward: ${retFirst?.reward}`,
      `replayed telegram return: ${replayReturn ? (replayReturn.type === 'error' ? `error:${replayReturn.code}` : `me reward=${replayReturn.reward}`) : 'no reply'}`,
      `task_claims counts: ${claims.map((c) => `${c.task_id}=${c.n}`).join(', ')}`,
    ],
    verdict: held ? 'HELD' : 'LOOPHOLE',
    note: held ? 'reward frames are idempotent per player' : 'a replay granted an extra reward',
  });
}

/** R8: frame flood the three new frames against the per-socket budget. */
async function r8FrameFlood() {
  const rig = await newPlayer('r8', freshDeviceToken());

  const flood = async (frameType, frame) => {
    const m = rig.mark();
    for (let i = 0; i < 10; i++) rig.send(frame);
    await sleep(1200);
    const errors = rig.frames.slice(m).filter((f) => f.type === 'error');
    return errors.length;
  };

  const progressErrors = await flood('task_progress', { type: 'task_progress', task: 'video', seconds: 1, duration: 60 });
  const startErrors = await flood('task_start', { type: 'task_start', task: 'telegram' });
  const returnErrors = await flood('task_return', { type: 'task_return', task: 'telegram' });

  const progressRows = await q("select count(*)::int as n from public.video_progress where player_id = $1", [rig.id]);
  const visitRows = await q("select count(*)::int as n from public.task_visits where player_id = $1", [rig.id]);
  rig.close();

  const held = progressErrors >= 8 && startErrors >= 8 && returnErrors >= 8;
  return report({
    id: 'R8',
    title: 'Frame flood on task_progress / task_start / task_return',
    attack: 'send 10 of each new frame as fast as the socket allows',
    expected: 'the per-socket 1/s query budget returns rate_limited for the burst; no pile-up in video_progress or task_visits',
    observed: [
      `task_progress errors in 10-frame burst: ${progressErrors}`,
      `task_start errors in 10-frame burst: ${startErrors}`,
      `task_return errors in 10-frame burst: ${returnErrors}`,
      `video_progress rows for this player: ${progressRows[0].n}`,
      `task_visits rows for this player: ${visitRows[0].n}`,
    ],
    verdict: held ? 'HELD' : 'LOOPHOLE',
    note: held ? 'per-socket rate limit held and DB stayed clean' : 'the flood was accepted',
  });
}

/** R9: tamper with the device token. */
async function r9TamperDeviceToken() {
  const deviceRow = await q("insert into public.devices (first_ip) values ('127.0.0.1'::inet) returning id");
  const deviceId = deviceRow[0].id;
  const goodToken = signDeviceToken(deviceId);
  const tampered = tamperToken(goodToken);

  // player with the good token
  const good = await newPlayer('r9-good', goodToken);
  await q('update public.players set coins = 77777 where id = $1', [good.id]);

  // attacker with the tampered token
  const attacker = await newPlayer('r9-tamper', tampered);

  // attacker reuses another player's device token by flipping a byte in the id part
  const [prefix, sig] = goodToken.split('.');
  const flippedId = prefix.slice(0, -1) + (prefix.endsWith('a') ? 'b' : 'a');
  const forgedToken = `${flippedId}.${sig}`;
  const forged = await newPlayer('r9-forged', forgedToken);

  const goodCoins = (await q('select coins from public.players where id = $1', [good.id]))[0].coins;
  const observed = [
    `good player id: ${good.id.slice(0, 8)}, coins=${goodCoins}`,
    `tampered-token player id: ${attacker.id.slice(0, 8)}`,
    `forged-id player id: ${forged.id.slice(0, 8)}`,
  ];
  good.close();
  attacker.close();
  forged.close();

  const held = good.id !== attacker.id && good.id !== forged.id && goodCoins === 77777;
  return report({
    id: 'R9',
    title: 'Tamper with the device token',
    attack: 'flip a byte in the signature; reuse another player\'s device id with the original signature',
    expected: 'every tampered token mints a fresh anonymous player, never becomes the victim',
    observed,
    verdict: held ? 'HELD' : 'LOOPHOLE',
    note: held ? 'device token integrity held' : 'a tampered token authenticated as another player',
  });
}

/* ==================================================================== runner ======== */

const ATTACKS = [
  ['R1', r1OneDeviceTwoPlayers],
  ['R2', r2OneEmailTwoDevices],
  ['R3', r3NoDeviceTokenFarming],
  ['R4', r4VideoEdgeCases],
  ['R5', r5RedirectEdgeCases],
  ['R6', r6EmailRewardIdempotency],
  ['R7', r7ReplayOnSecondSocket],
  ['R8', r8FrameFlood],
  ['R9', r9TamperDeviceToken],
];

function parseArgs(argv) {
  const out = { only: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--only') out.only = new Set(argv[++i].split(',').map((s) => s.trim().toUpperCase()));
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const started = new Date();
  console.log('xChief Gold Rush - red team: rewards hardening');
  console.log(`server    ${WS_URL} / ${HTTP_URL}`);
  console.log(`database  ${DATABASE_URL.replace(/:[^:@/]*@/, ':***@')}`);
  console.log(`started   ${started.toISOString()}`);

  const health = await fetch(`${HTTP_URL}/health`).then((r) => r.json()).catch(() => null);
  if (!health || !health.ok) {
    console.error(`\nthe game server is not answering at ${HTTP_URL}/health - start it first`);
    process.exit(2);
  }

  for (const [id, fn] of ATTACKS) {
    if (args.only && !args.only.has(id)) continue;
    try {
      await fn();
    } catch (err) {
      console.log(`\n${'='.repeat(78)}\n${id}  CRASHED\n${'-'.repeat(78)}\n${err.stack}`);
      results.push({ id, title: fn.name, verdict: 'ERROR', note: err.message });
    }
  }

  console.log(`\n${'='.repeat(78)}`);
  console.log('SUMMARY');
  console.log('='.repeat(78));
  const width = Math.max(...results.map((r) => r.title.length), 6);
  console.log(`${'ID'.padEnd(4)} ${'ATTACK'.padEnd(width)} VERDICT`);
  for (const r of results) console.log(`${r.id.padEnd(4)} ${r.title.padEnd(width)} ${r.verdict}`);
  const counts = results.reduce((acc, r) => ({ ...acc, [r.verdict]: (acc[r.verdict] || 0) + 1 }), {});
  console.log(`\n${Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join('   ')}`);
  console.log(`finished ${new Date().toISOString()} (${Math.round((Date.now() - started) / 1000)} s)`);
  await pool.end();
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => {});
  process.exit(1);
});

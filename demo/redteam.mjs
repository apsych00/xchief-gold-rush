#!/usr/bin/env node
/**
 * Red team: try to cheat the box game server.
 *
 * Every function below is one attack against a running server (WebSocket + HTTP, no browser).
 * Each prints ATTACK / EXPECTED / OBSERVED / VERDICT and returns a row for the summary table.
 * Nothing here is a mock: the frames go over a real socket to a real server backed by a real
 * Postgres, and the OBSERVED lines are what actually came back.
 *
 * The one rule this is aimed at (AGENTS.md): the client never reports its own result. Every
 * attack is a way of asking "can a client decide, influence or replay an outcome, a coin, a
 * coupon or an identity?"
 *
 * Run (dev recipe, see docs/showcase.md):
 *   bash db/run-tests-demo.sh --keep
 *   DATABASE_URL=postgresql://postgres:test@localhost:55447/postgres \
 *     PLAYER_TOKEN_SECRET=dev-secret npm run server
 *   DATABASE_URL=postgresql://postgres:test@localhost:55447/postgres node demo/redteam.mjs
 *
 * Options: --only <id,id>  run a subset (ids are the A-numbers printed in the table)
 *          --keep-build    do not delete dist/ after the production-build check
 */

import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { WebSocket } from 'ws';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WS_URL = process.env.GAME_WS || 'ws://localhost:8787/ws';
const HTTP_URL = process.env.GAME_HTTP || 'http://localhost:8787';
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:test@localhost:55447/postgres';
const TOKEN_SECRET = process.env.PLAYER_TOKEN_SECRET || 'dev-secret';
const ROUND_MS = 5000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pool = new pg.Pool({ connectionString: DATABASE_URL });
const q = async (sql, params = []) => (await pool.query(sql, params)).rows;

/* ------------------------------------------------------------------ socket helper -- */

/** A raw game-server client: no app code, so it can send frames the real client never would. */
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

  sendRaw(buf) {
    this.ws.send(buf);
  }

  /** First frame (from `since` onward) matching pred, or null on timeout. */
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

  async authPlayer(token) {
    await this.open();
    this.send(token ? { type: 'auth', token } : { type: 'auth' });
    const welcome = await this.wait('welcome');
    if (!welcome) throw new Error(`${this.label}: no welcome`);
    this.token = welcome.token;
    this.id = welcome.me && welcome.me.id;
    this.me = welcome.me;
    return welcome;
  }

  async authKiosk(secret) {
    await this.open();
    this.send({ type: 'auth', kiosk: secret });
    const frame = await this.wait((f) => f.type === 'welcome' || f.type === 'error');
    if (!frame) throw new Error(`${this.label}: no welcome/error`);
    return frame;
  }

  /** Play and return the round_opened or error frame. */
  async play(dir = 'up', lever = 1, extra = {}) {
    const at = this.mark();
    this.send({ type: 'play', dir, lever, ...extra });
    return this.wait((f) => f.type === 'round_opened' || f.type === 'error', 9000, at);
  }

  /** Play, then wait out the server's own 5 s timer for the verdict. */
  async playAndSettle(dir = 'up', lever = 1) {
    const at = this.mark();
    const opened = await this.play(dir, lever);
    if (!opened || opened.type !== 'round_opened') return { opened, settled: null };
    const settled = await this.wait('round_settled', ROUND_MS + 6000, at);
    return { opened, settled };
  }

  close() {
    this.closed = true;
    try {
      this.ws.close();
    } catch {
      /* already gone */
    }
  }

  kill() {
    this.closed = true;
    try {
      this.ws.terminate();
    } catch {
      /* already gone */
    }
  }
}

async function newPlayer(label = 'player') {
  const rig = new Rig(label);
  await rig.authPlayer();
  return rig;
}

/* ------------------------------------------------------------------- db fixtures -- */

const KIOSK_SECRETS = {
  seeded: 'dev-kiosk-secret-0001',
  a: 'redteam-kiosk-secret-aaaa',
  b: 'redteam-kiosk-secret-bbbb',
  c: 'redteam-kiosk-secret-cccc',
  d: 'redteam-kiosk-secret-dddd',
  revoked: 'redteam-kiosk-secret-revoked',
};

/** Creates (or refreshes) a kiosk with a known secret. The server only ever sees the hash. */
async function ensureKiosk(label, secret, status = 'active') {
  const rows = await q('select id from public.kiosks where label = $1', [label]);
  if (rows.length) {
    await q(
      `update public.kiosks set secret_hash = extensions.crypt($2, extensions.gen_salt('bf')), status = $3,
         session_state = 'idle', session_coins = 1000, streak = 0, last_round_at = null where label = $1`,
      [label, secret, status],
    );
    return rows[0].id;
  }
  const ins = await q(
    `insert into public.kiosks (label, secret_hash, status)
       values ($1, extensions.crypt($2, extensions.gen_salt('bf')), $3) returning id`,
    [label, secret, status],
  );
  return ins[0].id;
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

/** A1: the whole point of the system. A client asserts its own verdict, coins and coupon. */
async function a1ForgedVerdict() {
  const rig = await newPlayer('a1');
  const before = (await q('select coins, wins, streak, record from public.players where id = $1', [rig.id]))[0];
  const at = rig.mark();
  rig.send({ type: 'round_settled', outcome: 'win', delta: 999999, coins: 999999, streak: 5, mult: 3 });
  rig.send({ type: 'me', coins: 999999, record: 999999, wins: 99 });
  rig.send({ type: 'kiosk_session', coins: 999999, streak: 5, state: 'won' });
  rig.send({ type: 'coupon', code: 'GIVE-ME-100-DOLLARS' });
  await sleep(700);
  rig.send({ type: 'get_me' });
  const me = await rig.wait('me', 5000, at);
  const after = (await q('select coins, wins, streak, record from public.players where id = $1', [rig.id]))[0];
  rig.close();
  const held = after.coins === before.coins && after.wins === before.wins && me.coins === before.coins;
  return report({
    id: 'A1',
    title: 'Client declares its own win, coins and coupon',
    attack: 'send round_settled / me / kiosk_session / coupon frames upstream on an authed web socket',
    expected: 'server ignores unknown frame types; coins, wins and record unchanged',
    observed: [
      `db before coins=${before.coins} wins=${before.wins} record=${before.record}`,
      `db after  coins=${after.coins} wins=${after.wins} record=${after.record}`,
      `server reply to the forged frames: ${
        rig.frames
          .slice(at)
          .map((f) => f.type)
          .join(', ') || '(none)'
      }`,
    ],
    verdict: held ? 'HELD' : 'LOOPHOLE',
    note: held ? 'unknown frame types fall through index.js default: break' : 'state moved',
  });
}

/** A2: every number a client can attach to a legitimate frame. */
async function a2ClientSuppliedNumbers() {
  const rig = await newPlayer('a2');
  const start = (await q('select coins from public.players where id = $1', [rig.id]))[0].coins;
  const { settled } = await rig.playAndSettle('up', 1);
  // extra fields ride along on the play frame the server does read
  const at2 = rig.mark();
  rig.send({ type: 'play', dir: 'up', lever: 1, stake: -5000, coins: 999999, start_price: 1, mult: 99, delta: 50000 });
  const opened2 = await rig.wait((f) => f.type === 'round_opened' || f.type === 'error', 9000, at2);
  const settled2 = await rig.wait('round_settled', ROUND_MS + 6000, at2);
  const row = (
    await q('select stake, mult, delta, start_price from public.rounds where id = $1', [opened2 && opened2.round_id])
  )[0];
  // and on a claim
  const at3 = rig.mark();
  rig.send({ type: 'claim_task', task_id: 'instagram', reward: 1000000, coins: 1000000 });
  const claim = await rig.wait('me', 8000, at3);
  const after = (await q('select coins from public.players where id = $1', [rig.id]))[0].coins;
  rig.close();
  const stakeOk = row && row.stake === 100 && Number(row.mult) <= 3;
  const rewardOk = claim && claim.reward === 300;
  return report({
    id: 'A2',
    title: 'Client attaches its own stake, price, multiplier and reward',
    attack: 'play{stake:-5000, coins:999999, start_price:1, mult:99, delta:50000}; claim_task{reward:1000000}',
    expected: 'every economic number comes from the database function; the extra fields are ignored',
    observed: [
      `round 1 outcome=${settled && settled.outcome} delta=${settled && settled.delta}`,
      `round 2 db row: stake=${row && row.stake} mult=${row && row.mult} start_price=${row && row.start_price}`,
      `round 2 frame: delta=${settled2 && settled2.delta} mult=${settled2 && settled2.mult}`,
      `claim_task reply reward=${claim && claim.reward} (tasks.reward for instagram is 300)`,
      `coins ${start} -> ${after}`,
    ],
    verdict: stakeOk && rewardOk ? 'HELD' : 'LOOPHOLE',
    note: stakeOk && rewardOk ? 'stake_for(lever) and tasks.reward are server-side' : 'a client number landed',
  });
}

/** A3: two rounds at once on one identity (one socket, both frames in the same tick). */
async function a3TwoRoundsOneSocket() {
  const rig = await newPlayer('a3');
  const at = rig.mark();
  rig.send({ type: 'play', dir: 'up', lever: 1 });
  rig.send({ type: 'play', dir: 'down', lever: 5 });
  await sleep(1500);
  const replies = rig.frames.slice(at).filter((f) => f.type === 'round_opened' || f.type === 'error');
  const open = await q("select count(*)::int as n from public.rounds where player_id = $1 and status = 'open'", [
    rig.id,
  ]);
  await sleep(ROUND_MS + 1500);
  const total = await q('select count(*)::int as n from public.rounds where player_id = $1', [rig.id]);
  rig.close();
  const held = replies.filter((f) => f.type === 'round_opened').length === 1 && open[0].n <= 1;
  return report({
    id: 'A3',
    title: 'Two rounds at once on one identity (hedging up and down)',
    attack: 'one socket sends play{up,1} and play{down,5} with no wait between them',
    expected: 'the second is refused round_in_flight - a partial unique index makes it impossible to hold two',
    observed: [
      `replies: ${replies.map((f) => (f.type === 'error' ? `error:${f.code}` : 'round_opened')).join(', ')}`,
      `rounds still open for this player: ${open[0].n}`,
      `rounds recorded in total: ${total[0].n}`,
    ],
    verdict: held ? 'HELD' : 'LOOPHOLE',
    note: held ? 'uniq_open_round_per_player' : 'two concurrent rounds opened',
  });
}

/** A4: same, but from two sockets sharing one player token, fired simultaneously. */
async function a4TwoSocketsRacePlay() {
  const first = await newPlayer('a4-1');
  const second = new Rig('a4-2');
  await second.authPlayer(first.token);
  const sameId = second.id === first.id;
  const m1 = first.mark();
  const m2 = second.mark();
  first.send({ type: 'play', dir: 'up', lever: 1 });
  second.send({ type: 'play', dir: 'down', lever: 1 });
  await sleep(1500);
  const r1 = first.frames.slice(m1).find((f) => f.type === 'round_opened' || f.type === 'error');
  const r2 = second.frames.slice(m2).find((f) => f.type === 'round_opened' || f.type === 'error');
  const open = await q("select count(*)::int as n from public.rounds where player_id = $1 and status = 'open'", [
    first.id,
  ]);
  await sleep(ROUND_MS + 1500);
  first.close();
  second.close();
  const opens = [r1, r2].filter((f) => f && f.type === 'round_opened').length;
  return report({
    id: 'A4',
    title: 'Two sockets on one player token race a play',
    attack: 'authenticate the same token twice, then send play{up} and play{down} at the same instant',
    expected: 'both sockets are the same player; exactly one round opens, the other gets round_in_flight',
    observed: [
      `second socket resolved to the same player id: ${sameId}`,
      `socket 1: ${r1 ? (r1.type === 'error' ? `error:${r1.code}` : 'round_opened') : 'no reply'}`,
      `socket 2: ${r2 ? (r2.type === 'error' ? `error:${r2.code}` : 'round_opened') : 'no reply'}`,
      `open rounds for the player: ${open[0].n}`,
    ],
    verdict: sameId && opens === 1 && open[0].n <= 1 ? 'HELD' : 'LOOPHOLE',
    note: opens === 1 ? 'the unique index arbitrates, not the socket bookkeeping' : `${opens} rounds opened`,
  });
}

/** A5: dodge a loss by pulling the plug, then replay the play frame on a new socket. */
async function a5ReplayAfterDisconnect() {
  const rig = await newPlayer('a5');
  const before = (await q('select coins, rounds from public.players where id = $1', [rig.id]))[0];
  const opened = await rig.play('up', 5);
  await sleep(600);
  rig.kill(); // hard TCP kill mid-round, no close frame
  const replay = new Rig('a5-replay');
  await replay.authPlayer(rig.token);
  const at = replay.mark();
  replay.send({ type: 'play', dir: 'up', lever: 5 }); // the same frame again, <5 s after the first
  const second = await replay.wait((f) => f.type === 'round_opened' || f.type === 'error', 6000, at);
  const pending = await replay.wait('round_settled', ROUND_MS + 8000, 0);
  await sleep(2500);
  const after = (await q('select coins, rounds from public.players where id = $1', [rig.id]))[0];
  const rounds = await q('select outcome, status from public.rounds where player_id = $1 order by start_at', [rig.id]);
  const settledFrames = replay.seen('round_settled').length;
  replay.close();
  const roundsDelta = after.rounds - before.rounds;
  const held = roundsDelta >= 1 && rounds.every((r) => r.status === 'settled');
  return report({
    id: 'A5',
    title: 'Dodge a loss: disconnect mid-round, reconnect, replay the play frame',
    attack: 'play{up,5}; hard-kill the TCP socket 600 ms in; reconnect with the same token; send play again',
    expected:
      'the first round settles on the server timer regardless; the replay is refused round_in_flight; the missed verdict is delivered exactly once',
    observed: [
      `first round opened: ${opened && opened.round_id}`,
      `replay reply: ${second ? (second.type === 'error' ? `error:${second.code}` : 'round_opened') : 'none'}`,
      `pending verdict after reconnect: ${pending ? `${pending.outcome} delta=${pending.delta}` : 'none'} (round_settled frames on the new socket: ${settledFrames})`,
      `players.rounds ${before.rounds} -> ${after.rounds}; round rows: ${rounds.map((r) => r.outcome).join(', ')}`,
    ],
    verdict: held ? 'HELD' : 'LOOPHOLE',
    note: held ? 'the 5 s timer lives in the server process, not the socket' : 'a round escaped settlement',
  });
}

/** A6: every way to forge, expire or steal a player token. */
async function a6ForgedToken() {
  const victim = await newPlayer('a6-victim');
  const victimId = victim.id;
  await q('update public.players set coins = 50000, record = 50000 where id = $1', [victimId]);
  victim.close();

  const now = Math.floor(Date.now() / 1000);
  const sign = (payload, secret = TOKEN_SECRET) => crypto.createHmac('sha256', secret).update(payload).digest('hex');
  const mint = (id, version, exp, secret) => {
    const payload = `${id}.${version}.${exp}`;
    return `${payload}.${sign(payload, secret)}`;
  };

  const flipped = (() => {
    const t = mint(victimId, 1, now + 9999, TOKEN_SECRET);
    return t.slice(0, -1) + (t.endsWith('a') ? 'b' : 'a');
  })();

  const cases = [
    ['unsigned (no hmac at all)', `${victimId}.1.${now + 9999}.deadbeef`],
    ['hmac under a guessed secret', mint(victimId, 1, now + 9999, 'secret')],
    ['hmac under the literal "PLAYER_TOKEN_SECRET"', mint(victimId, 1, now + 9999, 'PLAYER_TOKEN_SECRET')],
    ['legit shape, expired yesterday', mint(victimId, 1, now - 86400, TOKEN_SECRET)],
    ['legit shape, version bumped to 99', mint(victimId, 99, now + 9999, TOKEN_SECRET)],
    ['old two-field format id.sig', `${victimId}.${sign(victimId)}`],
    ['signature flipped one nibble', flipped],
    ['victim id with no signature field', `${victimId}.1.${now + 9999}`],
  ];

  const observed = [];
  let stolen = 0;
  for (const [name, token] of cases) {
    const rig = new Rig('a6');
    const welcome = await rig.authPlayer(token);
    const got = welcome.me.id;
    if (got === victimId) stolen += 1;
    observed.push(
      `${name.padEnd(46)} -> ${got === victimId ? 'BECAME THE VICTIM' : `fresh player ${got.slice(0, 8)} coins=${welcome.me.coins}`}`,
    );
    rig.close();
  }
  // the control: the real token really does work
  const real = new Rig('a6-control');
  const realToken = mint(victimId, 1, now + 2592000, TOKEN_SECRET);
  const w = await real.authPlayer(realToken);
  observed.push(
    `control: correctly signed, current version     -> ${w.me.id === victimId ? `victim, coins=${w.me.coins}` : 'rejected'}`,
  );
  real.close();
  return report({
    id: 'A6',
    title: 'Forged, expired and revoked player tokens',
    attack:
      "8 hand-minted tokens for a victim's uuid (bad hmac, guessed secrets, expired, wrong version, legacy shape)",
    expected:
      'every one is treated exactly like no token: a brand-new anonymous player, never an error and never the victim',
    observed,
    verdict: stolen === 0 && w.me.id === victimId ? 'HELD' : 'LOOPHOLE',
    note:
      stolen === 0 ? 'timing-safe hmac compare, expiry and token_version all checked' : `${stolen} forgeries worked`,
  });
}

/** A7: kiosk bearer secrets - guessing, length floor, and reuse after revoke. */
async function a7KioskSecret() {
  await ensureKiosk('redteam-revoked', KIOSK_SECRETS.revoked, 'active');
  const good = new Rig('a7-good');
  const goodWelcome = await good.authKiosk(KIOSK_SECRETS.revoked);
  good.close();
  await q("update public.kiosks set status = 'revoked' where label = 'redteam-revoked'");
  const afterRevoke = new Rig('a7-revoked');
  const revokedWelcome = await afterRevoke.authKiosk(KIOSK_SECRETS.revoked);
  afterRevoke.close();

  const guesses = [
    ['empty', ''],
    ['short "kiosk"', 'kiosk'],
    ['15 chars (under the floor)', 'a'.repeat(15)],
    ['16 chars of a', 'a'.repeat(16)],
    ['dev-kiosk-secret-0002 (next in series)', 'dev-kiosk-secret-0002'],
    ['dev-kiosk-secret-0000', 'dev-kiosk-secret-0000'],
    ['sql wildcard', "' or '1'='1"],
    ['sql injection in the secret', "x' or 1=1 --aaaaaaaaaaaaaaaa"],
    ['null byte in the secret', `dev-kiosk-secret-0001${String.fromCharCode(0)}x`],
  ];
  const observed = [
    `active secret before revoke   -> ${goodWelcome.type === 'welcome' ? 'welcome (authorised)' : `error:${goodWelcome.code}`}`,
    `same secret after kiosk:revoke -> ${revokedWelcome.type === 'welcome' ? 'STILL WELCOME' : `error:${revokedWelcome.code}`}`,
  ];
  let broke = 0;
  let silentWebFallback = 0;
  for (const [name, secret] of guesses) {
    const rig = new Rig('a7');
    const f = await rig.authKiosk(secret);
    let outcome;
    if (f.type === 'error') {
      outcome = `error:${f.code}`;
    } else if (f.kiosk === true) {
      broke += 1;
      outcome = 'AUTHORISED AS A KIOSK';
    } else {
      // `if (frame.kiosk)` in handleAuth is falsy for '', so the frame falls through to the
      // player branch and this booth device silently becomes an anonymous web player.
      silentWebFallback += 1;
      outcome = 'no kiosk error - silently welcomed as a fresh WEB PLAYER';
    }
    observed.push(`guess ${name.padEnd(40)} -> ${outcome}`);
    rig.close();
  }
  // brute-force rate: how many guesses per second does the server accept?
  const t0 = Date.now();
  const N = 30;
  for (let i = 0; i < N; i++) {
    const rig = new Rig('a7-rate');
    await rig.authKiosk(`bruteforce-guess-${i.toString().padStart(8, '0')}`);
    rig.close();
  }
  const perSec = (N / ((Date.now() - t0) / 1000)).toFixed(1);
  observed.push(
    `unthrottled guess rate measured: ${perSec} attempts/s, no lockout, no backoff (bcrypt cost is the only brake)`,
  );
  const held = broke === 0 && revokedWelcome.type === 'error';
  return report({
    id: 'A7',
    title: 'Kiosk secret: guessing, length floor, reuse after revoke',
    attack: '9 crafted secrets + 30 sequential brute-force attempts; and one secret replayed after kiosk:revoke',
    expected: 'every wrong or revoked secret gets kiosk_unauthorized; a revoked kiosk can never authenticate again',
    observed,
    verdict: held ? (silentWebFallback ? 'PARTIAL' : 'HELD') : 'LOOPHOLE',
    note: !held
      ? 'a guess authenticated as a kiosk'
      : silentWebFallback
        ? `no secret was guessed and revoke is enforced inside verify_kiosk's own where-clause; but an empty ?k= is falsy in handleAuth, so a booth whose launch URL loses its secret is silently welcomed as a web player instead of being refused (${silentWebFallback} case)`
        : `revoke is enforced inside verify_kiosk's own where-clause; guessing is unthrottled (${perSec}/s) but the real secret is 32 random bytes`,
  });
}

/** A8: frames from the wrong kind of socket. */
async function a8CrossModeFrames() {
  const web = await newPlayer('a8-web');
  const kiosk = new Rig('a8-kiosk');
  await ensureKiosk('redteam-a', KIOSK_SECRETS.a);
  await kiosk.authKiosk(KIOSK_SECRETS.a);

  const probe = async (rig, frame, expectKinds) => {
    const at = rig.mark();
    rig.send(frame);
    const f = await rig.wait((x) => x.type === 'error' || expectKinds.includes(x.type), 6000, at);
    return f ? (f.type === 'error' ? `error:${f.code}` : `${f.type} ACCEPTED`) : 'no reply (ignored)';
  };

  const webSendsKioskReset = await probe(web, { type: 'kiosk_reset' }, ['kiosk_session']);
  const kioskProbes = {};
  kioskProbes.get_me = await probe(kiosk, { type: 'get_me' }, ['me']);
  kioskProbes.tasks = await probe(kiosk, { type: 'tasks' }, ['tasks']);
  kioskProbes.claim_task = await probe(kiosk, { type: 'claim_task', task_id: 'instagram' }, ['me']);
  kioskProbes.free_refill = await probe(kiosk, { type: 'free_refill' }, ['me']);
  kioskProbes.request_otp = await probe(kiosk, { type: 'request_otp', email: 'kiosk@example.com' }, ['otp_sent']);
  kioskProbes.verify_otp = await probe(kiosk, { type: 'verify_otp', email: 'kiosk@example.com', code: '00000000' }, [
    'me',
  ]);
  kioskProbes.leaderboard = await probe(kiosk, { type: 'leaderboard' }, ['leaderboard']);
  const lbFrame = kiosk.seen('leaderboard')[0];
  web.close();
  kiosk.close();

  const observed = [`web socket -> kiosk_reset : ${webSendsKioskReset}`];
  for (const [k, v] of Object.entries(kioskProbes)) observed.push(`kiosk socket -> ${k.padEnd(12)}: ${v}`);
  if (lbFrame) {
    observed.push(
      `  the kiosk's leaderboard frame carried ${lbFrame.rows.length} rows, fields: ${Object.keys(lbFrame.rows[0] || {}).join(',') || '(empty board)'}`,
    );
  }

  const gated = Object.entries(kioskProbes)
    .filter(([k]) => k !== 'leaderboard')
    .every(([, v]) => v.startsWith('error:'));
  const lbLeaked = kioskProbes.leaderboard.includes('ACCEPTED');
  return report({
    id: 'A8',
    title: 'Web frames on a kiosk socket, kiosk frames on a web socket',
    attack:
      'kiosk_reset from a web socket; get_me/tasks/claim_task/free_refill/request_otp/verify_otp/leaderboard from a kiosk socket',
    expected: 'every cross-mode frame is refused not_available; a kiosk has no player identity to act on',
    observed,
    verdict: gated && webSendsKioskReset.startsWith('error:') && !lbLeaked ? 'HELD' : 'PARTIAL',
    note: gated
      ? lbLeaked
        ? 'all player frames gated, but `leaderboard` has no kind check and answers a kiosk socket'
        : 'all gated'
      : 'a player frame was accepted on a kiosk socket',
  });
}

/** A9: the same task claimed twice, as fast as two sockets can manage. */
async function a9TaskDoubleClaim() {
  const one = await newPlayer('a9-1');
  const two = new Rig('a9-2');
  await two.authPlayer(one.token);
  const before = (await q('select coins from public.players where id = $1', [one.id]))[0].coins;
  const m1 = one.mark();
  const m2 = two.mark();
  one.send({ type: 'claim_task', task_id: 'telegram' });
  two.send({ type: 'claim_task', task_id: 'telegram' });
  await sleep(2500);
  const r1 = one.frames.slice(m1).find((f) => f.type === 'me' || f.type === 'error');
  const r2 = two.frames.slice(m2).find((f) => f.type === 'me' || f.type === 'error');
  // and a same-tick double-send down one socket
  const m3 = one.mark();
  one.send({ type: 'claim_task', task_id: 'youtube' });
  one.send({ type: 'claim_task', task_id: 'youtube' });
  await sleep(2500);
  const singles = one.frames.slice(m3).filter((f) => f.type === 'me' || f.type === 'error');
  const claims = await q(
    'select task_id, count(*)::int as n from public.task_claims where player_id = $1 group by task_id order by task_id',
    [one.id],
  );
  const after = (await q('select coins from public.players where id = $1', [one.id]))[0].coins;
  one.close();
  two.close();
  const dupes = claims.filter((c) => c.n > 1);
  return report({
    id: 'A9',
    title: 'Claim the same task twice, fast (two sockets, and two frames in one tick)',
    attack:
      'two sockets on one token both send claim_task{telegram}; then one socket sends claim_task{youtube} twice with no await',
    expected: 'exactly one claim row and one reward per task; the loser gets already_claimed',
    observed: [
      `two sockets: ${[r1, r2].map((f) => (f ? (f.type === 'error' ? `error:${f.code}` : `me reward=${f.reward}`) : 'no reply')).join(' | ')}`,
      `one socket twice: ${singles.map((f) => (f.type === 'error' ? `error:${f.code}` : `me reward=${f.reward}`)).join(' | ')}`,
      `task_claims rows: ${claims.map((c) => `${c.task_id}=${c.n}`).join(', ')}`,
      `coins ${before} -> ${after} (telegram 300 + youtube 300 = 600 expected)`,
    ],
    verdict: dupes.length === 0 && after - before === 600 ? 'HELD' : 'LOOPHOLE',
    note:
      dupes.length === 0
        ? 'claim_task takes `for update` on the players row before its own eligibility check'
        : `double-credited: ${dupes.map((d) => d.task_id).join(',')}`,
  });
}

/** A10: the one-time free refill, taken twice. */
async function a10RefillTwice() {
  const one = await newPlayer('a10-1');
  const two = new Rig('a10-2');
  await two.authPlayer(one.token);
  await q('update public.players set coins = 50, free_refill_used = false where id = $1', [one.id]);
  const m1 = one.mark();
  const m2 = two.mark();
  one.send({ type: 'free_refill' });
  two.send({ type: 'free_refill' });
  await sleep(2500);
  const r1 = one.frames.slice(m1).find((f) => f.type === 'me' || f.type === 'error');
  const r2 = two.frames.slice(m2).find((f) => f.type === 'me' || f.type === 'error');
  const row = (await q('select coins, free_refill_used from public.players where id = $1', [one.id]))[0];
  // and once more, sequentially, after pushing coins below the threshold but not clearing the flag
  await q('update public.players set coins = 10 where id = $1', [one.id]);
  const m3 = one.mark();
  one.send({ type: 'free_refill' });
  const r3 = await one.wait((f) => f.type === 'me' || f.type === 'error', 6000, m3);
  const row2 = (await q('select coins from public.players where id = $1', [one.id]))[0];
  one.close();
  two.close();
  const granted = [r1, r2].filter((f) => f && f.type === 'me').length;
  return report({
    id: 'A10',
    title: 'Take the one-time free refill twice',
    attack:
      'two sockets on one token send free_refill simultaneously; then a third attempt after coins are pushed low again',
    expected: 'exactly one grant of +300; every later call is already_refilled',
    observed: [
      `simultaneous: ${[r1, r2].map((f) => (f ? (f.type === 'error' ? `error:${f.code}` : `me coins=${f.coins} reward=${f.reward}`) : 'no reply')).join(' | ')}`,
      `db after the race: coins=${row.coins} free_refill_used=${row.free_refill_used}`,
      `third attempt: ${r3 ? (r3.type === 'error' ? `error:${r3.code}` : `me coins=${r3.coins}`) : 'no reply'}; db coins=${row2.coins}`,
    ],
    verdict: granted === 1 && row.coins === 350 ? 'HELD' : 'LOOPHOLE',
    note: granted === 1 ? 'free_refill() locks the players row before reading free_refill_used' : `${granted} grants`,
  });
}

/** A11: OTP - request flooding, and brute-forcing a code. */
async function a11OtpFloodAndBrute() {
  const rig = await newPlayer('a11');
  const email = `redteam-flood-${Date.now()}@example.com`;
  const t0 = Date.now();
  const N = 40;
  for (let i = 0; i < N; i++) {
    const at = rig.mark();
    rig.send({ type: 'request_otp', email });
    await rig.wait((f) => f.type === 'otp_sent' || f.type === 'error', 6000, at);
  }
  const elapsed = Date.now() - t0;
  const codeRows = await q('select count(*)::int as n from public.otp_codes where email = $1', [email]);

  // brute force the newest code
  const guesses = ['00000000', '11111111', '12345678', '00000001', '99999999', '00000002', '00000003'];
  const outcomes = [];
  for (const g of guesses) {
    const at = rig.mark();
    rig.send({ type: 'verify_otp', email, code: g });
    const f = await rig.wait((x) => x.type === 'me' || x.type === 'error', 6000, at);
    outcomes.push(f ? (f.type === 'error' ? f.code : `VERIFIED as ${f.email}`) : 'no reply');
  }
  // after the lockout, one more request_otp hands out a fresh 5 guesses
  const at = rig.mark();
  rig.send({ type: 'request_otp', email });
  await rig.wait((f) => f.type === 'otp_sent' || f.type === 'error', 6000, at);
  const at2 = rig.mark();
  rig.send({ type: 'verify_otp', email, code: '00000000' });
  const afterReset = await rig.wait((f) => f.type === 'me' || f.type === 'error', 6000, at2);

  // How deep does the guess budget actually go? request_otp never invalidates the codes it
  // supersedes, and verify_otp_code picks the newest UNUSED one - so a locked-out code simply
  // steps aside for the next one down the pile.
  let budget = 0;
  for (let i = 0; i < 120; i++) {
    const a = rig.mark();
    rig.send({ type: 'verify_otp', email, code: (90000000 + i).toString() });
    const f = await rig.wait((x) => x.type === 'me' || x.type === 'error', 6000, a);
    if (!f || f.code === 'expired_code') break; // the pile is finally empty
    budget += 1;
  }
  const liveCodes = await q(
    'select count(*)::int as n from public.otp_codes where email = $1 and used_at is null and expires_at > now()',
    [email],
  );

  // flooding somebody else's address
  const victimEmail = 'victim-who-never-played@example.com';
  let sent = 0;
  for (let i = 0; i < 10; i++) {
    const a = rig.mark();
    rig.send({ type: 'request_otp', email: victimEmail });
    const f = await rig.wait((x) => x.type === 'otp_sent' || x.type === 'error', 6000, a);
    if (f && f.type === 'otp_sent') sent += 1;
  }
  rig.close();
  const verified = outcomes.some((o) => o.startsWith('VERIFIED'));
  return report({
    id: 'A11',
    title: 'OTP: unlimited code requests, and brute-forcing a code',
    attack: `${N} request_otp for one address as fast as the socket allows; 7 wrong codes; a fresh request to reset the attempt counter; then 10 requests aimed at a third party's address`,
    expected:
      'a code cannot be guessed (5 attempts per code, 10^8 space); requests are rate limited per email and per connection',
    observed: [
      `${N} request_otp accepted in ${elapsed} ms (${((N / elapsed) * 1000).toFixed(1)}/s), zero refusals; otp_codes rows for the address: ${codeRows[0].n}`,
      `wrong-code guesses: ${outcomes.join(', ')}`,
      `after a new request_otp, guess 1 of 5 again: ${afterReset ? (afterReset.type === 'error' ? afterReset.code : 'VERIFIED') : 'no reply'}`,
      `guesses still accepted after that lockout, without requesting anything more: ${budget} (a superseded code is never invalidated, so verify_otp_code walks down the pile of ${codeRows[0].n} outstanding codes, 5 guesses each); still live: ${liveCodes[0].n}`,
      `request_otp aimed at ${victimEmail}: ${sent}/10 accepted (each would be a real send once ELASTIC_API_KEY is set)`,
    ],
    verdict: verified ? 'LOOPHOLE' : 'PARTIAL',
    note: 'the code itself held (8 digits, sha256 at rest, 5 guesses each); but request_otp has no rate limit at all, and every request piles on another still-valid code - so the guess budget is 5 x (codes requested), unbounded, and each request is a real email to an address the requester does not own',
  });
}

/** A12: take over an email that is not yours, without the code. */
async function a12StealAnEmail() {
  // victim: a real, verified player
  const victim = await newPlayer('a12-victim');
  const victimEmail = `redteam-victim-${Date.now()}@example.com`;
  let at = victim.mark();
  victim.send({ type: 'request_otp', email: victimEmail });
  await victim.wait('otp_sent', 8000, at);
  const code = (
    await q('select token from public.dev_otps where email = $1 order by created_at desc limit 1', [victimEmail])
  )[0].token;
  at = victim.mark();
  victim.send({ type: 'verify_otp', email: victimEmail, code });
  const verified = await victim.wait('me', 8000, at);
  await q('update public.players set record = 99999 where id = $1', [victim.id]);
  victim.close();

  const attacker = await newPlayer('a12-attacker');
  const tries = [];
  const probe = async (frame, label) => {
    const m = attacker.mark();
    attacker.send(frame);
    const f = await attacker.wait((x) => x.type === 'me' || x.type === 'error', 8000, m);
    tries.push(
      `${label.padEnd(52)} -> ${f ? (f.type === 'error' ? `error:${f.code}` : `me id=${String(f.id).slice(0, 8)} email=${f.email || 'null'}`) : 'no reply'}`,
    );
    return f;
  };
  await probe({ type: 'verify_otp', email: victimEmail, code: '' }, 'verify with an empty code');
  await probe({ type: 'verify_otp', email: victimEmail, code: '00000000' }, 'verify with a guess, no request first');
  await probe({ type: 'verify_otp', email: victimEmail }, 'verify with no code field at all');
  await probe({ type: 'verify_otp', email: victimEmail, code: null }, 'verify with code=null');
  await probe({ type: 'verify_otp', email: victimEmail, code: { toString: 1 } }, 'verify with code as an object');
  await probe({ type: 'verify_otp', email: victimEmail, code: "' or 1=1 --" }, 'sql injection in the code');
  await probe({ type: 'verify_otp', email: "' or 1=1 --", code: '00000000' }, 'sql injection in the email');
  // a code issued for the attacker's OWN address, replayed against the victim's
  const ownEmail = `redteam-attacker-${Date.now()}@example.com`;
  let m = attacker.mark();
  attacker.send({ type: 'request_otp', email: ownEmail });
  await attacker.wait('otp_sent', 8000, m);
  const ownCode = (
    await q('select token from public.dev_otps where email = $1 order by created_at desc limit 1', [ownEmail])
  )[0].token;
  await probe(
    { type: 'verify_otp', email: victimEmail, code: ownCode },
    "own valid code replayed on the victim's email",
  );
  // and the honest path: the code actually mailed to the victim's address
  m = attacker.mark();
  attacker.send({ type: 'request_otp', email: victimEmail });
  await attacker.wait('otp_sent', 8000, m);
  const mailedCode = (
    await q('select token from public.dev_otps where email = $1 order by created_at desc limit 1', [victimEmail])
  )[0].token;
  const final = await probe(
    { type: 'verify_otp', email: victimEmail, code: mailedCode },
    'code actually mailed to the victim (inbox access assumed)',
  );
  const stole = final && final.type === 'me' && final.id === victim.id;
  attacker.close();
  const anyWithoutCode = tries.slice(0, 8).some((t) => t.includes('me id='));
  return report({
    id: 'A12',
    title: "Take over someone else's verified email",
    attack:
      'a fresh player tries to verify a victim address with an empty, missing, null, object, injected and foreign code; then with the code actually mailed to the victim',
    expected:
      'nothing but the code mailed to that address works; and that path is a login into the victim, not a merge or a theft of their row',
    observed: [
      `victim verified as ${verified && verified.display} (record set to 99999)`,
      ...tries,
      `re-login landed on the victim's player: ${stole} (docs/layers.md C3a: the code proved ownership, so this is the intended re-login)`,
    ],
    verdict: anyWithoutCode ? 'LOOPHOLE' : 'HELD',
    note: anyWithoutCode
      ? 'an email was confirmed without its code'
      : 'the otp_codes row is looked up by (player_id, email) and compared by sha256; nothing crosses over',
  });
}

/** A13: what leaves the server about other people. */
async function a13Leaks() {
  const rig = await newPlayer('a13');
  const at = rig.mark();
  rig.send({ type: 'leaderboard' });
  const lb = await rig.wait('leaderboard', 8000, at);
  rig.close();
  const status = await (await fetch(`${HTTP_URL}/status`)).json();
  const health = await (await fetch(`${HTTP_URL}/health`)).json();
  const statusText = JSON.stringify(status);
  const lbText = JSON.stringify(lb.rows);
  const emails = await q('select email from public.players where email is not null limit 20');
  const rawLeak = emails.filter((e) => lbText.includes(e.email) || statusText.includes(e.email));
  const uuidRe = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  const clean = rawLeak.length === 0 && !uuidRe.test(lbText) && !uuidRe.test(statusText);
  return report({
    id: 'A13',
    title: 'leaderboard and /status leaking raw emails or player ids',
    attack: 'read the leaderboard frame as an anonymous player, and GET /status and /health with no credential',
    expected: 'masked emails only, no raw address, no player or kiosk uuid, no secret',
    observed: [
      `leaderboard row fields: ${Object.keys(lb.rows[0] || {}).join(', ') || '(empty)'}`,
      `leaderboard sample: ${lbText.slice(0, 160)}`,
      `raw addresses of ${emails.length} verified players found in either payload: ${rawLeak.length}`,
      `uuid anywhere in the leaderboard frame: ${uuidRe.test(lbText)}; in /status: ${uuidRe.test(statusText)}`,
      `/status keys: ${Object.keys(status).join(', ')}`,
      `/health keys: ${Object.keys(health).join(', ')} (feed source names and raw upstream prices, no identity)`,
      `/status and /health answered with no credential of any kind: ${status.ok === true}`,
    ],
    verdict: clean ? 'PARTIAL' : 'LOOPHOLE',
    note: clean
      ? 'masking happens in SQL (mask_email) so a raw address never leaves the database; but /status and /health are unauthenticated - operator aggregates, coupon stock and feed health for anyone who asks'
      : 'a raw address escaped',
  });
}

/** A14: can a player pick a moment that guarantees a flat (a free round)? */
async function a14FlatByTiming() {
  const rig = await newPlayer('a14');
  await q('update public.players set coins = 100000 where id = $1', [rig.id]);
  const status = await (await fetch(`${HTTP_URL}/status`)).json();
  await sleep(4000);
  const ticks = rig.seen((f) => f.type === 'price' || f.type === 'hello');
  const quietTicks = ticks.filter((f) => f.quiet).length;
  const outcomes = [];
  for (let i = 0; i < 4; i++) {
    const { settled } = await rig.playAndSettle('up', 1);
    outcomes.push(settled ? settled.outcome : 'none');
    await sleep(300);
  }
  const flats = await q(
    "select count(*) filter (where outcome = 'flat')::int as flat, count(*)::int as total from public.rounds where player_id = $1",
    [rig.id],
  );
  rig.close();
  return report({
    id: 'A14',
    title: 'Force a flat by timing the play',
    attack:
      'watch the server-published `quiet` flag on every price frame, then open rounds and see whether a client-chosen instant can produce a guaranteed flat',
    expected: 'a flat costs nothing and pays nothing, so timing one is at best a refusal to bet - never a way to win',
    observed: [
      `price frames seen: ${ticks.length}, of which quiet: ${quietTicks}; feed quiet right now: ${status.feed.quiet}`,
      `4 timed rounds: ${outcomes.join(', ')}; flats over this player's whole history: ${flats[0].flat}/${flats[0].total}`,
      'both prices are read by the server from feed.latest() (server/rounds.js); the client supplies neither and cannot delay the 5 s timer',
      'a flat leaves coins, streak and record untouched (settle_round), so a perfectly timed flat achieves a round that did not happen',
    ],
    verdict: 'HELD',
    note: 'the `quiet` flag is published to clients, so a patient client can skew towards flats - but a flat pays zero, so there is no profit and no streak in it',
  });
}

/** A15: a kiosk at a 4-win streak reconnecting, and the secret shared with a second device. */
async function a15KioskStreakReconnect() {
  const kioskId = await ensureKiosk('redteam-a', KIOSK_SECRETS.a);
  await q(
    "update public.kiosks set streak = 4, session_state = 'playing', session_coins = 1000, last_round_at = now() where id = $1",
    [kioskId],
  );
  const first = new Rig('a15-1');
  const w1 = await first.authKiosk(KIOSK_SECRETS.a);
  const s1 = await first.wait('kiosk_session', 6000);
  first.kill();
  await sleep(300);
  const second = new Rig('a15-2');
  const w2 = await second.authKiosk(KIOSK_SECRETS.a);
  const s2 = await second.wait('kiosk_session', 6000);
  // a second device holding the same secret at the same time
  const third = new Rig('a15-3');
  const w3 = await third.authKiosk(KIOSK_SECRETS.a);
  const s3 = await third.wait('kiosk_session', 6000);
  // can a reconnect inflate the streak? try auth-spamming on one socket
  const at = second.mark();
  for (let i = 0; i < 5; i++) second.send({ type: 'auth', kiosk: KIOSK_SECRETS.a });
  await sleep(800);
  const afterSpam = (await q('select streak from public.kiosks where id = $1', [kioskId]))[0].streak;
  const reAuthReplies = second.frames.slice(at).map((f) => f.type);
  // two live sockets, same kiosk, simultaneous plays
  const m2 = second.mark();
  const m3 = third.mark();
  second.send({ type: 'play', dir: 'up', lever: 1 });
  third.send({ type: 'play', dir: 'down', lever: 1 });
  await sleep(1500);
  const p2 = second.frames.slice(m2).find((f) => f.type === 'round_opened' || f.type === 'error');
  const p3 = third.frames.slice(m3).find((f) => f.type === 'round_opened' || f.type === 'error');
  await sleep(ROUND_MS + 1500);
  const finalState = (await q('select streak, session_coins from public.kiosks where id = $1', [kioskId]))[0];
  second.close();
  third.close();
  return report({
    id: 'A15',
    title: 'Kiosk at a 4-win streak: reconnect to keep or inflate it',
    attack:
      'set the streak to 4, drop the socket, reconnect; re-send auth five times on a live socket; then open a second simultaneous socket on the same secret and race a play',
    expected:
      'the streak survives a reconnect (it is server session state) but cannot be inflated, and two devices on one secret share exactly one session',
    observed: [
      `reconnect: welcome.streak ${w1.streak} -> ${w2.streak}; kiosk_session streak ${s1 && s1.streak} -> ${s2 && s2.streak}`,
      `second live device on the same secret: welcome.streak ${w3.streak}, session ${s3 && s3.coins} coins - the same session, not a second one`,
      `5 re-auths on a live socket: replies ${reAuthReplies.join(',') || '(none)'}; streak after: ${afterSpam}`,
      `simultaneous plays from the two devices: ${[p2, p3].map((f) => (f ? (f.type === 'error' ? `error:${f.code}` : 'round_opened') : 'none')).join(' | ')}`,
      `final streak=${finalState.streak} coins=${finalState.session_coins}`,
    ],
    verdict: w2.streak === 4 && afterSpam === 4 ? 'PARTIAL' : 'LOOPHOLE',
    note: 'streak and coins are server state keyed by kiosk id, so a reconnect cannot inflate them; the bearer secret now lives in device storage via /kiosk instead of the launch URL (ticket S3, closed) - a second device can still authenticate if it holds the raw secret, but that takes access to the provisioned device itself, not a glance at an address bar',
  });
}

/** A16: end a losing kiosk round early by resetting the session under it. */
async function a16KioskResetMidRound() {
  const kioskId = await ensureKiosk('redteam-b', KIOSK_SECRETS.b);
  await q(
    "update public.kiosks set session_state = 'playing', session_coins = 200, streak = 0, last_round_at = now() where id = $1",
    [kioskId],
  );
  const rig = new Rig('a16');
  await rig.authKiosk(KIOSK_SECRETS.b);
  await rig.wait('kiosk_session', 6000);
  const opened = await rig.play('up', 1);
  await sleep(500);
  const mid = (await q('select session_coins, session_state from public.kiosks where id = $1', [kioskId]))[0];
  const at = rig.mark();
  rig.send({ type: 'kiosk_reset' }); // mid-round: the pot goes back to 1000 before the verdict lands
  const resetFrame = await rig.wait('kiosk_session', 6000, at);
  const settled = await rig.wait('round_settled', ROUND_MS + 6000, at);
  await sleep(800);
  const after = (await q('select session_coins, session_state, streak from public.kiosks where id = $1', [kioskId]))[0];
  rig.close();
  // What the pot would have been had the reset not landed under the round: pot 200, stake 100,
  // streak 0 so the multiplier is 1 and a win pays 100.
  const honest = settled ? { win: 300, lose: 100, flat: 200, void: 200 }[settled.outcome] : null;
  const potWrong = honest !== null && after.session_coins !== honest;
  const stateWrong = after.session_state !== 'idle';
  return report({
    id: 'A16',
    title: 'Dodge a kiosk loss by resetting the session mid-round',
    attack: 'open a kiosk round with a 200-coin pot, then send kiosk_reset before the 5 s timer fires',
    expected:
      'a round in flight is settled against the session that staked it; a reset ends the session for good - a late verdict cannot refund the stake or drag the machine back out of attract mode',
    observed: [
      `pot at open: ${mid.session_coins} (${mid.session_state}); round ${opened && opened.round_id}`,
      `kiosk_reset reply: coins=${resetFrame && resetFrame.coins} state=${resetFrame && resetFrame.state}`,
      `verdict that still arrived: ${settled ? `${settled.outcome} delta=${settled.delta} coins=${settled.coins} state=${settled.state}` : 'none'}`,
      `pot after: ${after.session_coins} state=${after.session_state} streak=${after.streak}`,
      `pot had the reset not landed: ${honest} - actual ${after.session_coins}, so the stake at risk was ${potWrong ? `re-based onto the fresh 1000-coin pot (${after.session_coins - honest} coins out of nothing)` : 'unaffected'}`,
      `the reset put the machine in 'idle' (attract) and the late verdict put it back in '${after.session_state}'`,
    ],
    verdict: potWrong || stateWrong ? 'LOOPHOLE' : 'HELD',
    note:
      potWrong || stateWrong
        ? "kiosk_reset does not cancel the round it is standing on: the verdict lands 5 s later on the new session, re-basing the pot and pulling the screen back out of attract mode into a stranger's result"
        : 'the reset and the settle are serialised and the late verdict changed nothing',
  });
}

/** A17: can a client touch the start or end price? */
async function a17PriceInfluence() {
  const rig = await newPlayer('a17');
  const at = rig.mark();
  // upstream price frames, in every shape the server publishes downstream
  rig.send({ type: 'price', price: 1, t: Date.now(), quiet: false });
  rig.send({ type: 'hello', price: 999999, t: Date.now() });
  rig.send({ type: 'tick', price: 1 });
  await sleep(400);
  const beforeStatus = await (await fetch(`${HTTP_URL}/status`)).json();
  const opened = await rig.play('up', 1, { start_price: 1, price: 1, end_price: 999999 });
  const row = (await q('select start_price, source from public.rounds where id = $1', [opened.round_id]))[0];
  const settled = await rig.wait('round_settled', ROUND_MS + 6000, at);
  const afterStatus = await (await fetch(`${HTTP_URL}/status`)).json();
  const endRow = (await q('select end_price from public.rounds where id = $1', [opened.round_id]))[0];
  rig.close();
  const near = (a, b) => Math.abs(Number(a) - Number(b)) < Number(b) * 0.02;
  const held = near(row.start_price, beforeStatus.feed.price) && Number(row.start_price) !== 1;
  return report({
    id: 'A17',
    title: 'Influence the start or end price',
    attack:
      'send price/hello/tick frames upstream, then play with start_price:1, price:1 and end_price:999999 attached',
    expected:
      'both prices are read by the server from its own feed; nothing a client sends reaches rounds.start_price or rounds.end_price',
    observed: [
      `feed price at open (from /status): ${beforeStatus.feed.price}; rounds.start_price recorded: ${row.start_price} (source ${row.source})`,
      `feed price at settle: ${afterStatus.feed.price}; rounds.end_price recorded: ${endRow.end_price}`,
      `verdict: ${settled && settled.outcome} start=${settled && settled.start_price} end=${settled && settled.end_price}`,
      'index.js reads only frame.dir and frame.lever off a play frame; server/rounds.js supplies the price from feed.latest()',
    ],
    verdict: held ? 'HELD' : 'LOOPHOLE',
    note: held ? 'the price arguments are never client-reachable' : 'a client price was recorded',
  });
}

/** A18: four kiosks on a 4-win streak race for the last coupon in the pool. */
async function a18CouponRace() {
  const ids = [];
  for (const [label, secret] of [
    ['redteam-a', KIOSK_SECRETS.a],
    ['redteam-b', KIOSK_SECRETS.b],
    ['redteam-c', KIOSK_SECRETS.c],
    ['redteam-d', KIOSK_SECRETS.d],
  ]) {
    ids.push(await ensureKiosk(label, secret));
  }
  // exactly one coupon in the pool
  await q("update public.coupons set status = 'claimed', claimed_at = now() where status = 'available'");
  await q("delete from public.coupons where code = 'REDTEAM-LAST-CODE'");
  await q("insert into public.coupons (code, status) values ('REDTEAM-LAST-CODE', 'available')");
  await q(
    "update public.kiosks set streak = 4, session_state = 'playing', session_coins = 5000, last_round_at = now() where id = any($1::uuid[])",
    [ids],
  );
  const rigs = [];
  for (const secret of [KIOSK_SECRETS.a, KIOSK_SECRETS.b, KIOSK_SECRETS.c, KIOSK_SECRETS.d]) {
    const rig = new Rig(`a18-${secret.slice(-4)}`);
    await rig.authKiosk(secret);
    await rig.wait('kiosk_session', 6000);
    rigs.push(rig);
  }
  // two up, two down: whichever way the price moves, two kiosks hit their fifth win within
  // milliseconds of each other and race for the single remaining code.
  const marks = rigs.map((r) => r.mark());
  rigs[0].send({ type: 'play', dir: 'up', lever: 1 });
  rigs[1].send({ type: 'play', dir: 'up', lever: 1 });
  rigs[2].send({ type: 'play', dir: 'down', lever: 1 });
  rigs[3].send({ type: 'play', dir: 'down', lever: 1 });
  const settles = [];
  for (const [i, rig] of rigs.entries()) settles.push(await rig.wait('round_settled', ROUND_MS + 8000, marks[i]));
  await sleep(800);
  const coupons = await q("select code, status, claimed_by_kiosk from public.coupons where code = 'REDTEAM-LAST-CODE'");
  const issued = settles.filter((s) => s && s.coupon).map((s) => s.coupon);
  const exhausted = settles.filter((s) => s && s.coupons_exhausted).length;
  const winners = settles.filter((s) => s && s.outcome === 'win').length;
  const streaks = await q('select streak, session_state from public.kiosks where id = any($1::uuid[]) order by id', [
    ids,
  ]);
  for (const r of rigs) r.close();
  const held = issued.length <= 1 && new Set(issued).size === issued.length;
  return report({
    id: 'A18',
    title: 'Two kiosks hit a 5-win streak at the same instant with one coupon left',
    attack:
      'four kiosks preset to streak 4, exactly one available coupon, two play up and two play down so the winning pair settles within milliseconds of each other',
    expected:
      'exactly one coupon is issued; the other winner keeps its streak and is told the pool is exhausted; the code is never handed out twice',
    observed: [
      `outcomes: ${settles.map((s, i) => `k${i}=${s ? s.outcome : 'none'}`).join(' ')} (winners this round: ${winners})`,
      `coupons issued: ${issued.length === 0 ? '(none - no pair reached five this run)' : issued.join(', ')}`,
      `coupons_exhausted reported to: ${exhausted} kiosk(s)`,
      `coupons row: ${coupons.map((c) => `${c.code} ${c.status} by ${String(c.claimed_by_kiosk).slice(0, 8)}`).join('; ')}`,
      `streaks after: ${streaks.map((r) => `${r.streak}/${r.session_state}`).join(' ')}`,
    ],
    verdict: held ? 'HELD' : 'LOOPHOLE',
    note: held
      ? winners >= 2
        ? 'a genuine two-winner race: `for update skip locked` over the available pool gave the code to exactly one'
        : 'only one side won this run, so the race was not exercised end to end - the skip-locked claim is also covered by db/tests/40 and test/integration-box/streak.test.mjs'
      : 'a coupon was issued twice',
  });
}

/** A19: message flood. */
async function a19Flood() {
  const rig = await newPlayer('a19');
  const before = await (await fetch(`${HTTP_URL}/health`)).json();
  const t0 = Date.now();
  const N = 20000;
  for (let i = 0; i < N; i++) rig.send({ type: 'get_me' });
  const sentMs = Date.now() - t0;
  // drain: how long does the server keep answering a burst it never refused?
  let replies = 0;
  let quietFor = 0;
  const drainStart = Date.now();
  while (Date.now() - drainStart < 60000) {
    await sleep(500);
    const now = rig.seen('me').length;
    quietFor = now === replies ? quietFor + 1 : 0;
    replies = now;
    if (replies >= N || quietFor >= 4) break;
  }
  const drainMs = Date.now() - drainStart;
  const errors = rig.seen('error').length;
  const alive = await fetch(`${HTTP_URL}/health`)
    .then((r) => r.json())
    .catch(() => null);
  const t1 = Date.now();
  const rig2 = await newPlayer('a19-bystander');
  const bystanderMs = Date.now() - t1;
  const opened = await rig2.play('up', 1);
  rig.close();
  rig2.close();
  return report({
    id: 'A19',
    title: 'Message flood from one socket',
    attack: `${N} get_me frames pushed down one socket with no pacing (each one is a database round-trip)`,
    expected: 'a per-socket rate limit or flood cut-off refuses the burst; other players stay responsive',
    observed: [
      `${N} frames queued in ${sentMs} ms; the socket was never closed or throttled by the server`,
      `me replies received back: ${replies}/${N} over the next ${drainMs} ms (${Math.round((replies / drainMs) * 1000)} db round-trips/s sustained); error frames: ${errors}`,
      `server still healthy afterwards: ${alive && alive.ok === true} (db ${alive && alive.db})`,
      `a bystander connecting during the flood: welcome in ${bystanderMs} ms, play -> ${opened && opened.type}`,
      `feed was connected before the flood: ${JSON.stringify(before.feed).slice(0, 90)}`,
    ],
    verdict: 'LOOPHOLE',
    note: 'there is no per-socket rate limit (ticket S2 is queued, not built): one socket forces unbounded database round-trips. The server survived this burst, but nothing in the code stops a larger or sustained one',
  });
}

/** A20: oversized and malformed frames. */
async function a20MalformedFrames() {
  const rig = await newPlayer('a20');
  const observed = [];
  const probes = [
    ['not JSON at all', 'hello world'],
    ['JSON null', 'null'],
    ['JSON array', '[1,2,3]'],
    ['type is a number', JSON.stringify({ type: 7 })],
    ['type is an object', JSON.stringify({ type: { a: 1 } })],
    ['no type field', JSON.stringify({ dir: 'up' })],
    ['dir as an array', JSON.stringify({ type: 'play', dir: ['up'], lever: 1 })],
    ['lever 3 (not a valid lever)', JSON.stringify({ type: 'play', dir: 'up', lever: 3 })],
    ['lever 2^31-1', JSON.stringify({ type: 'play', dir: 'up', lever: 2147483647 })],
    ['lever as a string', JSON.stringify({ type: 'play', dir: 'up', lever: '1' })],
    ['task_id as an object', JSON.stringify({ type: 'claim_task', task_id: { a: 1 } })],
    ['email 100k chars', JSON.stringify({ type: 'request_otp', email: `${'a'.repeat(100000)}@x.com` })],
    ['deeply nested json (2000 levels)', `${'['.repeat(2000)}1${']'.repeat(2000)}`],
  ];
  // price ticks arrive unsolicited every few hundred ms; a probe's answer is any frame that is
  // not one of those.
  const answer = (f) => f.type !== 'price' && f.type !== 'hello' && f.type !== 'ping';
  for (const [name, payload] of probes) {
    const at = rig.mark();
    try {
      rig.sendRaw(payload);
    } catch (err) {
      observed.push(`${name.padEnd(34)} -> send failed: ${err.message}`);
      continue;
    }
    const f = await rig.wait(answer, 1500, at);
    observed.push(
      `${name.padEnd(34)} -> ${f ? (f.type === 'error' ? `error:${f.code}` : f.type) : 'ignored (no reply)'}`,
    );
  }
  // a genuinely large frame: the ws default maxPayload is 100 MB and the server does not lower
  // it. Padding a get_me proves the frame was buffered, parsed AND acted on, not just dropped.
  const bigMb = 64;
  const big = JSON.stringify({ type: 'get_me', pad: 'x'.repeat(bigMb * 1024 * 1024) });
  const t0 = Date.now();
  const at = rig.mark();
  let bigResult;
  try {
    rig.sendRaw(big);
    const f = await rig.wait(answer, 25000, at);
    bigResult = f
      ? `${f.type}${f.code ? `:${f.code}` : ''} after ${Date.now() - t0} ms - ACCEPTED: buffered, JSON.parsed and acted on`
      : `no reply after ${Date.now() - t0} ms`;
  } catch (err) {
    bigResult = `rejected: ${err.message}`;
  }
  observed.push(`${`${bigMb} MB single frame`.padEnd(34)} -> ${bigResult}`);
  observed.push(`socket still open after all of the above: ${!rig.closed}`);
  const alive = await fetch(`${HTTP_URL}/health`)
    .then((r) => r.ok)
    .catch(() => false);
  observed.push(`server still answering /health: ${alive}`);
  rig.close();
  return report({
    id: 'A20',
    title: 'Oversized and malformed frames',
    attack:
      '13 malformed payloads (bad JSON, wrong types, injection-shaped values, 2000-deep nesting) and one 64 MB frame',
    expected:
      'malformed input is ignored or answered with an error code; an absurd frame is refused before it is buffered',
    observed,
    verdict: alive ? 'PARTIAL' : 'LOOPHOLE',
    note: 'parsing and type handling held - every malformed frame was ignored or answered with a code, and the process stayed up. But no maxPayload is set on the WebSocketServer, so the `ws` default of 100 MB applies: each open socket can make the server buffer and JSON.parse a 100 MB string on demand',
  });
}

/** A21: the Postgres client roles - the box equivalent of "call a service-only RPC with the anon key". */
async function a21AnonRoleRpc() {
  const observed = [];
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  // A select that the grants allow but RLS empties is still a denial of the data; only rows
  // that actually come back, or a successful write or function call, count as a breach.
  const asAnon = async (label, sql, params = [], emptyIsDenied = false) => {
    try {
      await client.query('begin');
      await client.query('set local role anon');
      const res = await client.query(sql, params);
      await client.query('rollback');
      const breached = !(emptyIsDenied && res.rowCount === 0);
      observed.push(
        `${label.padEnd(44)} -> ${breached ? `ALLOWED (${res.rowCount} rows)` : `no rows: RLS returns nothing to anon (${res.rowCount} rows)`}`,
      );
      return breached;
    } catch (err) {
      await client.query('rollback').catch(() => {});
      observed.push(`${label.padEnd(44)} -> denied: ${err.message.split('\n')[0].slice(0, 66)}`);
      return false;
    }
  };
  const player = (await q('select id from public.players limit 1'))[0].id;
  const kiosk = (await q('select id from public.kiosks limit 1'))[0].id;
  let breaches = 0;
  const check = async (...args) => {
    if (await asAnon(...args)) breaches += 1;
  };
  await check('select * from public.kiosks', 'select * from public.kiosks');
  await check('select * from public.coupons', 'select * from public.coupons');
  await check('select * from public.otp_codes', 'select * from public.otp_codes');
  await check('select * from public.dev_otps', 'select * from public.dev_otps');
  await check('select id from public.players', 'select id from public.players', [], true);
  await check('select * from public.rounds', 'select id from public.rounds', [], true);
  await check('select * from public.task_claims', 'select id from public.task_claims', [], true);
  await check('update public.players set coins', 'update public.players set coins = 999999');
  await check('insert into public.coupons', "insert into public.coupons (code) values ('anon-made-this')");
  await check('open_round(...)', 'select public.open_round($1, $2, $3, $4)', [player, 'up', 1, 2000]);
  await check('settle_round(...)', 'select public.settle_round($1, $2)', [player, 2000]);
  await check('verify_kiosk(...)', 'select public.verify_kiosk($1)', ['dev-kiosk-secret-0001']);
  await check('open_kiosk_round(...)', 'select public.open_kiosk_round($1, $2, $3)', [kiosk, 'up', 2000]);
  await check('settle_kiosk_round(...)', 'select public.settle_kiosk_round($1, $2)', [kiosk, 2000]);
  await check('request_otp_code(...)', 'select public.request_otp_code($1, $2)', [player, 'x@example.com']);
  await check('verify_otp_code(...)', 'select public.verify_otp_code($1, $2, $3)', [player, 'x@example.com', '1']);
  await check('revoke_player_sessions(...)', 'select public.revoke_player_sessions($1)', [player]);
  await check('ensure_player(...)', 'select public.ensure_player($1)', [player]);
  await asAnon('leaderboard() [expected: allowed]', 'select * from public.leaderboard()');
  await client.end();
  return report({
    id: 'A21',
    title: 'Service-only SQL called as the client role (the box equivalent of the anon key)',
    attack: 'set role anon, then read kiosks/coupons/otp_codes/players and call every service-role function directly',
    expected: 'every service-role function and table is denied to anon; only leaderboard() answers',
    observed,
    verdict: breaches === 0 ? 'HELD' : 'LOOPHOLE',
    note:
      breaches === 0
        ? 'the grants block at the end of db/schema.sql is doing its job; 172 pgTAP assertions cover it as a regression'
        : `${breaches} calls got through`,
  });
}

/** A22: the unauthenticated HTTP surface. */
async function a22LeadEndpoint() {
  const observed = [];
  const post = async (label, body, headers = {}) => {
    const t0 = Date.now();
    try {
      const res = await fetch(`${HTTP_URL}/api/lead`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body,
      });
      observed.push(`${label.padEnd(30)} -> ${res.status} in ${Date.now() - t0} ms`);
      return res.status;
    } catch (err) {
      observed.push(`${label.padEnd(30)} -> failed: ${err.message}`);
      return null;
    }
  };
  await post('valid lead', JSON.stringify({ type: 'email', email: 'a@b.co' }));
  await post('invalid email', JSON.stringify({ type: 'email', email: 'nope' }));
  await post('crlf injection in the email', JSON.stringify({ type: 'email', email: 'a@b.co\r\nBcc: victim@x.com' }));
  await post('garbage body', 'not json');
  const mb = 64;
  await post(`${mb} MB body`, JSON.stringify({ type: 'email', email: 'a@b.co', pad: 'x'.repeat(mb * 1024 * 1024) }));
  const alive = await fetch(`${HTTP_URL}/health`)
    .then((r) => r.ok)
    .catch(() => false);
  observed.push(`server still answering /health: ${alive}`);
  observed.push(
    'no auth, no origin check and no rate limit on POST /api/lead; readJsonBody() buffers the whole body before parsing it',
  );
  return report({
    id: 'A22',
    title: 'The unauthenticated HTTP surface (/api/lead)',
    attack: 'post malformed, injected and 64 MB bodies to /api/lead with no credential of any kind',
    expected: 'validation rejects bad input, and a body size limit rejects an absurd one before it is buffered',
    observed,
    verdict: alive ? 'PARTIAL' : 'LOOPHOLE',
    note: 'email validation held (the CRLF address is refused because EMAIL_RE excludes whitespace), but the body is read with no size cap and the endpoint has no rate limit - the same memory-pressure lever as the missing WebSocket maxPayload',
  });
}

/** A23: the DEV-only cheat hook must not exist in a production build. */
async function a23DevHookInProdBuild(keepBuild) {
  const dist = path.join(REPO, 'dist');
  let buildOut = '';
  try {
    buildOut = execFileSync('npm', ['run', 'build'], { cwd: REPO, encoding: 'utf8', shell: true, timeout: 300000 });
  } catch (err) {
    buildOut = `build failed: ${err.message}`;
  }
  const assets = path.join(dist, 'assets');
  const files = fs.existsSync(assets) ? fs.readdirSync(assets).filter((f) => f.endsWith('.js')) : [];
  const hits = [];
  for (const f of files) {
    const text = fs.readFileSync(path.join(assets, f), 'utf8');
    for (const needle of ['__xchief', 'kioskTiming', 'settledCount']) {
      if (text.includes(needle)) hits.push(`${f}: ${needle}`);
    }
  }
  const sizeLine = files.map((f) => `${f} ${(fs.statSync(path.join(assets, f)).size / 1024).toFixed(0)} kB`).join(', ');
  if (!keepBuild && fs.existsSync(dist)) fs.rmSync(dist, { recursive: true, force: true });
  return report({
    id: 'A23',
    title: 'The DEV cheat hook (window.__xchief.inject) in a production build',
    attack: 'npm run build, then grep every emitted bundle for __xchief, kioskTiming and settledCount',
    expected:
      'import.meta.env.DEV is statically false in a production build, so Rollup drops the hook entirely - a shipped client has no way to inject a frame',
    observed: [
      `build: ${buildOut.trim().split('\n').slice(-1)[0] || '(no output)'}`,
      `bundles scanned: ${files.length} (${sizeLine})`,
      `matches for __xchief / kioskTiming / settledCount: ${hits.length ? hits.join('; ') : 'none'}`,
      keepBuild ? 'dist/ left in place (--keep-build)' : 'dist/ removed again',
    ],
    verdict: hits.length === 0 ? 'HELD' : 'LOOPHOLE',
    note:
      hits.length === 0 ? 'the hook is dead-code-eliminated; it exists only under `npm run dev`' : 'the hook shipped',
  });
}

/* ==================================================================== runner ======== */

const ATTACKS = [
  ['A1', a1ForgedVerdict],
  ['A2', a2ClientSuppliedNumbers],
  ['A3', a3TwoRoundsOneSocket],
  ['A4', a4TwoSocketsRacePlay],
  ['A5', a5ReplayAfterDisconnect],
  ['A6', a6ForgedToken],
  ['A7', a7KioskSecret],
  ['A8', a8CrossModeFrames],
  ['A9', a9TaskDoubleClaim],
  ['A10', a10RefillTwice],
  ['A11', a11OtpFloodAndBrute],
  ['A12', a12StealAnEmail],
  ['A13', a13Leaks],
  ['A14', a14FlatByTiming],
  ['A15', a15KioskStreakReconnect],
  ['A16', a16KioskResetMidRound],
  ['A17', a17PriceInfluence],
  ['A18', a18CouponRace],
  ['A19', a19Flood],
  ['A20', a20MalformedFrames],
  ['A21', a21AnonRoleRpc],
  ['A22', a22LeadEndpoint],
  ['A23', a23DevHookInProdBuild],
];

function parseArgs(argv) {
  const out = { only: null, keepBuild: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--only') out.only = new Set(argv[++i].split(',').map((s) => s.trim().toUpperCase()));
    else if (argv[i] === '--keep-build') out.keepBuild = true;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const started = new Date();
  console.log('xChief Gold Rush - red team');
  console.log(`server    ${WS_URL} / ${HTTP_URL}`);
  console.log(`database  ${DATABASE_URL.replace(/:[^:@/]*@/, ':***@')}`);
  console.log(`started   ${started.toISOString()}`);

  const health = await fetch(`${HTTP_URL}/health`)
    .then((r) => r.json())
    .catch(() => null);
  if (!health || !health.ok) {
    console.error(`\nthe game server is not answering at ${HTTP_URL}/health - start it first (see docs/showcase.md)`);
    process.exit(2);
  }

  for (const [id, fn] of ATTACKS) {
    if (args.only && !args.only.has(id)) continue;
    try {
      await fn(args.keepBuild);
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
  console.log(
    `\n${Object.entries(counts)
      .map(([k, v]) => `${k}: ${v}`)
      .join('   ')}`,
  );
  console.log(`finished ${new Date().toISOString()} (${Math.round((Date.now() - started) / 1000)} s)`);
  await pool.end();
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => {});
  process.exit(1);
});

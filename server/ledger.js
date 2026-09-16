/**
 * Postgres access for the box game server (docs/box-plan.md 1.4, docs/box-spec.md 1.4).
 *
 * The box has no Supabase Auth and no client role: the server is the only thing that ever
 * talks to Postgres, over a plain `postgres` connection. Identity still never comes from a
 * client-supplied function argument (0000_compat.sql):
 *
 *   - Functions that take the identity as an argument (open_round, settle_round, void_round,
 *     verify_kiosk, open_kiosk_round, settle_kiosk_round, ensure_player) are called directly
 *     with `call()` - no session state needed, the caller already proved who it is.
 *   - Functions written for Supabase that read `auth.uid()` (get_me, claim_task, free_refill)
 *     are called inside `withPlayer()`, which sets `app.player_id` for one transaction via
 *     `set_config(..., true)` (SET LOCAL - cleared at commit/rollback) after the server has
 *     already verified the caller's token.
 *
 * Every Postgres exception raised by the game functions surfaces here as plain text
 * (`raise exception 'code'` -> `error.message === 'code'`). mapError() turns the ones the game
 * contract names into `Error` instances with a `.code`; anything else is passed through
 * unchanged so it fails loudly instead of being silently reclassified.
 */

import pg from 'pg';

const { Pool } = pg;

const KNOWN_ERROR_CODES = [
  'insufficient_coins',
  'rate_limited',
  'round_in_flight',
  'bad_dir',
  'bad_lever',
  'bad_price',
  'round_not_open',
  'kiosk_unauthorized',
  'session_over',
  'already_claimed',
  'email_required',
  'refill_unavailable',
  'unknown_task',
  'unauthenticated',
  'invalid_code',
  'too_many_attempts',
  'expired_code',
];

function mapError(err) {
  const msg = (err && err.message) || '';
  for (const code of KNOWN_ERROR_CODES) {
    if (msg.includes(code)) {
      const mapped = new Error(code);
      mapped.code = code;
      return mapped;
    }
  }
  return err;
}

let pool = null;

/** Lazy singleton so importing this module never opens a connection by itself. */
function getPool() {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL is required');
    pool = new Pool({ connectionString });
  }
  return pool;
}

/** Close the pool. Tests and graceful shutdown only. */
export async function close() {
  if (pool) {
    const p = pool;
    pool = null;
    await p.end();
  }
}

/** `select 1` for the health endpoint. Never throws: returns false on any failure. */
export async function ping() {
  try {
    await getPool().query('select 1');
    return true;
  } catch {
    return false;
  }
}

/**
 * Call a service-role function that takes the identity as its own argument. One statement,
 * no transaction needed: every game function is already atomic inside itself.
 */
export async function call(fnName, ...args) {
  const placeholders = args.map((_, i) => `$${i + 1}`).join(', ');
  try {
    const { rows } = await getPool().query(`select ${fnName}(${placeholders}) as result`, args);
    return rows[0] ? rows[0].result : null;
  } catch (err) {
    throw mapError(err);
  }
}

/**
 * Run fn(client) inside a transaction with `app.player_id` set for the duration, so
 * auth.uid() resolves inside functions written for Supabase (get_me, claim_task, free_refill).
 */
export async function withPlayer(playerId, fn) {
  const client = await getPool().connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.player_id', $1, true)", [playerId]);
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw mapError(err);
  } finally {
    client.release();
  }
}

/**
 * Settle a player round and add best_streak to the result. settle_round's own json omits it
 * (db/migrations/0003_functions.sql), but the round_settled frame contract (docs/box-plan.md
 * 1.2, docs/box-spec.md 1.2) names it, and players carries it - so read it back in the same
 * call rather than changing a migration another ticket already shipped and pgTAP-covered.
 */
export async function settlePlayerRound(playerId, roundId, endPrice) {
  const result = await call('settle_round', roundId, endPrice);
  const { rows } = await getPool().query('select best_streak from public.players where id = $1', [playerId]);
  return { ...result, best_streak: rows[0] ? rows[0].best_streak : null };
}

/** New anonymous player: a bare auth.users row, then the players row via ensure_player. */
export async function createPlayer() {
  const { rows } = await getPool().query('insert into auth.users default values returning id');
  const id = rows[0].id;
  await call('ensure_player', id);
  return id;
}

/** The caller's players row, created if absent (get_me() inside a set app.player_id transaction). */
export async function getMe(playerId) {
  return withPlayer(playerId, async (client) => {
    const { rows } = await client.query('select * from public.get_me()');
    return rows[0];
  });
}

export async function claimTask(playerId, taskId) {
  return withPlayer(playerId, async (client) => {
    const { rows } = await client.query('select public.claim_task($1) as result', [taskId]);
    return rows[0].result;
  });
}

export async function freeRefill(playerId) {
  return withPlayer(playerId, async (client) => {
    const { rows } = await client.query('select public.free_refill() as result');
    return rows[0].result;
  });
}

/** Top 10, no identity involved. */
export async function leaderboard() {
  const { rows } = await getPool().query('select * from public.leaderboard()');
  return rows;
}

/**
 * The kiosk's visitor session as the `kiosk_session` frame shape (ticket C1,
 * docs/layers.md): {coins, streak, state}. Sent right after a kiosk `welcome` and mirrored
 * into every kiosk `round_settled`.
 */
export async function kioskSession(kioskId) {
  const { rows } = await getPool().query(
    'select session_coins as coins, streak, session_state as state from public.kiosks where id = $1',
    [kioskId],
  );
  return rows[0] || { coins: 1000, streak: 0, state: 'idle' };
}

/** Starts a fresh visitor session (coins 1000, streak 0, playing). */
export async function startKioskSession(kioskId) {
  return call('start_kiosk_session', kioskId);
}

/** Back to attract mode: `kiosk_reset` (Claim/Done) and the idle sweep both call this. */
export async function resetKioskSession(kioskId) {
  return call('reset_kiosk_session', kioskId);
}

/**
 * open_kiosk_round returns {error: 'insufficient_coins'} instead of raising for that one case
 * (see the function's comment in db/schema.sql: marking the session broke and reporting the
 * error both have to survive, and a raise would undo the mark in the same statement). Turn
 * that into the same thrown-Error-with-.code shape every other case already gets from call()'s
 * mapError, so rounds.js does not need to special-case it.
 */
export async function openKioskRound(kioskId, dir, price, source, lever) {
  const result = await call('open_kiosk_round', kioskId, dir, price, source, lever);
  if (result && result.error) {
    const err = new Error(result.error);
    err.code = result.error;
    throw err;
  }
  return result;
}

/** Kiosks the idle sweep (server/kiosk.js) should reset: a session in progress whose last round is older than idleMs. */
export async function staleKiosks(idleMs) {
  const { rows } = await getPool().query(
    `select id from public.kiosks
       where status = 'active'
         and session_state <> 'idle'
         and last_round_at is not null
         and last_round_at < now() - ($1 || ' milliseconds')::interval`,
    [idleMs],
  );
  return rows.map((r) => r.id);
}

/**
 * Login codes (ticket 4, db/migrations/0011_otp_codes.sql). Both are service-only functions
 * that take the identity as their own argument, called directly with call() - no transaction
 * needed, exactly like open_round/verify_kiosk.
 */
export async function requestOtpCode(playerId, email) {
  return call('request_otp_code', playerId, email);
}

/**
 * verify_otp_code returns text, not a thrown error, for a wrong guess (see the migration's
 * comment: an UPDATE that must survive - the attempts count - cannot share a call with a raise
 * that would roll it back). The same text return also carries the re-login case (docs/layers.md
 * C3a): 'logged_in:<uuid>' when the email already belongs to a different, verified player, so
 * index.js can switch the socket's identity there. Every other non-'ok' outcome becomes the
 * same thrown-Error-with-.code shape every other ledger call already produces.
 */
export async function verifyOtpCode(playerId, email, code) {
  const outcome = await call('verify_otp_code', playerId, email, code);
  if (outcome === 'ok') return { loggedIn: null };
  if (outcome.startsWith('logged_in:')) return { loggedIn: outcome.slice('logged_in:'.length) };
  const err = new Error(outcome);
  err.code = outcome;
  throw err;
}

/** players.token_version for a player, or null if that id has no row - a token naming an
 * unknown player is exactly as invalid as a bad signature (server/index.js verifyToken). */
export async function getTokenVersion(playerId) {
  const { rows } = await getPool().query('select token_version from public.players where id = $1', [playerId]);
  return rows[0] ? rows[0].token_version : null;
}

/**
 * Dev-only capture (server/otp.js) when ELASTIC_API_KEY is unset: the same public.dev_otps
 * table the old Supabase Auth hook wrote to (db/migrations/0006_dev_otps.sql), now inserted
 * directly since there is no edge function on the box.
 */
export async function insertDevOtp(email, token) {
  await getPool().query('insert into public.dev_otps (email, token) values ($1, $2)', [email, token]);
}

/**
 * One aggregate round-trip for the operator /status endpoint (docs/layers.md D1). Every
 * number is a count, no player-identifying data leaves this function; index.js caches the
 * result for 5 s so polling /status never costs more than one query per five seconds.
 */
export async function statusAggregates() {
  const { rows } = await getPool().query(`
    select
      (select count(*)::int from public.rounds where status = 'open') as rounds_in_flight,
      (select count(*)::int from public.rounds
         where status = 'settled' and end_at > now() - interval '60 seconds') as rounds_settled_60s,
      (select count(*)::int from public.rounds
         where status = 'settled' and end_at > now() - interval '24 hours') as rounds_settled_24h,
      (select count(*)::int from public.rounds
         where outcome = 'flat' and end_at > now() - interval '24 hours') as flats_24h,
      (select count(*)::int from public.coupons where status = 'available') as coupons_available,
      (select count(*)::int from public.coupons where status = 'claimed') as coupons_claimed,
      (select count(*)::int from public.kiosks where status = 'active') as kiosks_active
  `);
  return rows[0];
}

/** Process start: nobody is left to honestly settle a round still marked open. */
export async function voidOpenRounds() {
  await getPool().query(
    "update public.rounds set status = 'settled', outcome = 'void', end_at = now() where status = 'open'",
  );
}

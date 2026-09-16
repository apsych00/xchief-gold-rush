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
  'already_claimed',
  'email_required',
  'refill_unavailable',
  'unknown_task',
  'unauthenticated',
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

/** Current streak for a kiosk (welcome frame after verify_kiosk). */
export async function kioskStreak(kioskId) {
  const { rows } = await getPool().query('select streak from public.kiosks where id = $1', [kioskId]);
  return rows[0] ? rows[0].streak : 0;
}

/** Process start: nobody is left to honestly settle a round still marked open. */
export async function voidOpenRounds() {
  await getPool().query(
    "update public.rounds set status = 'settled', outcome = 'void', end_at = now() where status = 'open'",
  );
}

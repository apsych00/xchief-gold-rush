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

// Every error code a client may legitimately see, per docs/box-spec.md ("error codes are the
// ones in docs/test-contract.md") plus feed_stale (docs/box-spec.md 1.1, thrown directly by
// server/rounds.js, not raised in Postgres). handleFrame and handleAuth (server/index.js) only
// ever forward a code from this list; anything else - a raw Postgres SQLSTATE included - becomes
// `internal` (D9, docs/reports/redteam.md).
export const KNOWN_ERROR_CODES = [
  'insufficient_coins',
  'rate_limited',
  'round_in_flight',
  'bad_dir',
  'bad_lever',
  'bad_price',
  'round_not_open',
  'kiosk_unauthorized',
  'session_over',
  'coupons_exhausted',
  'already_claimed',
  'email_required',
  'refill_unavailable',
  'already_refilled',
  'unknown_task',
  'unauthenticated',
  'invalid_code',
  'too_many_attempts',
  'expired_code',
  'feed_stale',
  // Ticket S18: sent directly by server/index.js's safe-mode gate, never raised in Postgres -
  // listed here for the same reason feed_stale is, as documentation of every code a client may
  // legitimately see.
  'safe_mode',
  // ticket C9: claim_prize()'s own failure codes (docs/tickets/c9-qr-claim.md decision 4),
  // deliberately not the bare 'invalid'/'expired' the wire contract shows the client - see
  // claim_prize's own comment in db/schema.sql for why. 'already_claimed' is shared with
  // claim_task above - the two contexts never collide since handleFrame and the /api/claim/*
  // handler each only ever forward the code they can produce.
  'claim_invalid',
  'claim_link_expired',
  'not_claimable',
  'kiosk_cap',
  'bad_progress',
  'progress_too_fast',
  'not_yet',
];

function mapError(err) {
  // returnTaskVisit throws its own Error with .code/.retryMs already set (not a Postgres
  // exception message to pattern-match) - withPlayer's catch runs every thrown error through
  // this function, so remapping it here by message would silently drop .retryMs. An error that
  // already carries a known .code is passed through untouched.
  if (err && KNOWN_ERROR_CODES.includes(err.code)) return err;
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
 * Like call(), but with `app.client_ip` set for the duration (ticket B13) so a function that
 * reads it - release_task_reward, to stamp task_claims.claimed_ip - sees the caller's IP. Needs
 * its own transaction: SET LOCAL only holds for the transaction it runs in, and call()'s bare
 * query has none.
 */
export async function callWithIp(fnName, ip, ...args) {
  const client = await getPool().connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.client_ip', $1, true)", [ip || null]);
    const placeholders = args.map((_, i) => `$${i + 1}`).join(', ');
    const { rows } = await client.query(`select ${fnName}(${placeholders}) as result`, args);
    await client.query('commit');
    return rows[0] ? rows[0].result : null;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw mapError(err);
  } finally {
    client.release();
  }
}

/**
 * Run fn(client) inside a transaction with `app.player_id` set for the duration, so
 * auth.uid() resolves inside functions written for Supabase (get_me, claim_task, free_refill).
 * `ip` (ticket B13), when given, is also set as `app.client_ip` so claim_task and any
 * release_task_reward call nested under it stamp task_claims.claimed_ip.
 */
export async function withPlayer(playerId, fn, ip) {
  const client = await getPool().connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.player_id', $1, true)", [playerId]);
    if (ip) await client.query("select set_config('app.client_ip', $1, true)", [ip]);
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

/**
 * Settle a kiosk round and turn settle_kiosk_round's own claim_token (ticket C9 decision 2)
 * into the absolute claim_url the round_settled frame actually carries - the code itself never
 * rides on this frame, only the one-time link.
 */
export async function settleKioskRound(roundId, endPrice) {
  const { claim_token: claimToken, ...result } = await call('settle_kiosk_round', roundId, endPrice);
  return { ...result, claim_url: claimUrlFor(claimToken) };
}

/**
 * New anonymous player: a bare auth.users row, then the players row via ensure_player.
 * deviceId (ticket B5), if given, is passed straight through to ensure_player's p_device -
 * applied only on the insert, so this new player's device_id is whichever device the socket's
 * auth frame resolved to.
 */
export async function createPlayer(deviceId = null) {
  const { rows } = await getPool().query('insert into auth.users default values returning id');
  const id = rows[0].id;
  await call('ensure_player', id, deviceId);
  return id;
}

/**
 * Device identity (ticket B5, docs/tickets/b5-device-identity.md decision 2-3): resolves the
 * device row for one `auth` frame. A verified deviceId gets last_seen_at and first_ip touched
 * (decision 3: both update on every auth, unlike the "first" in the name); ua is set only if
 * still null (first sight only). No deviceId, or one whose row is gone, creates a fresh device
 * instead - "absent or invalid" both land here as a new row, which is what the caller then
 * signs into the `device` token on `welcome`.
 */
export async function touchDevice(deviceId, ip, ua) {
  if (deviceId) {
    const { rows } = await getPool().query(
      `update public.devices set last_seen_at = now(), first_ip = $2, ua = coalesce(ua, $3)
         where id = $1
       returning id`,
      [deviceId, ip, ua],
    );
    if (rows[0]) return rows[0].id;
  }
  const { rows } = await getPool().query('insert into public.devices (first_ip, ua) values ($1, $2) returning id', [
    ip,
    ua,
  ]);
  return rows[0].id;
}

/** The caller's players row, created if absent (get_me() inside a set app.player_id transaction). */
export async function getMe(playerId) {
  return withPlayer(playerId, async (client) => {
    const { rows } = await client.query('select * from public.get_me()');
    return rows[0];
  });
}

export async function claimTask(playerId, taskId, ip) {
  return withPlayer(
    playerId,
    async (client) => {
      const { rows } = await client.query('select public.claim_task($1) as result', [taskId]);
      return rows[0].result;
    },
    ip,
  );
}

export async function freeRefill(playerId) {
  return withPlayer(playerId, async (client) => {
    const { rows } = await client.query('select public.free_refill() as result');
    return rows[0].result;
  });
}

/** Task definitions plus this player's own claimed state (docs/layers.md C5), computed by
 * get_tasks() - never assembled here from anything the client sent. */
export async function getTasks(playerId) {
  return withPlayer(playerId, async (client) => {
    const { rows } = await client.query('select * from public.get_tasks()');
    return rows;
  });
}

/**
 * Server-released reward (ticket B6+B7+B9): grants task `taskId` to `playerId` once per device
 * or verified email, called directly with the identity as an argument like ensure_player - never
 * through withPlayer/auth.uid(), since the caller (report_video_progress internally, or
 * server/index.js after a video/redirect/verify_otp event) already knows who it is granting to.
 * Resolves to null, not an error, when the reward was already claimed - see the SQL function's
 * own comment.
 */
export async function releaseTaskReward(playerId, taskId, ip) {
  return callWithIp('release_task_reward', ip, playerId, taskId);
}

/** Video watch progress (ticket B6 decision 2): upserts, and releases the reward itself once
 * 90% is crossed - never through claim_task, which refuses this task's kind. */
export async function reportVideoProgress(playerId, taskId, seconds, duration, ip) {
  return withPlayer(
    playerId,
    async (client) => {
      const { rows } = await client.query('select public.report_video_progress($1, $2, $3) as result', [
        taskId,
        seconds,
        duration,
      ]);
      return rows[0].result;
    },
    ip,
  );
}

/** Redirect-and-return, opening the 5 s window (ticket B7 decision 3). */
export async function startTaskVisit(playerId, taskId) {
  return withPlayer(playerId, async (client) => {
    const { rows } = await client.query('select public.start_task_visit($1) as result', [taskId]);
    return rows[0].result;
  });
}

/**
 * return_task_visit returns json, not a thrown error, for `not_yet` and `already_claimed` (see
 * the SQL function's own comment: the UPDATE that stamps returned_at must survive alongside
 * either outcome). Turn that into the same thrown-Error-with-.code shape every other case
 * already gets from call()'s mapError - `not_yet` also carries `retryMs` so the caller can tell
 * the client when to try again, the same way it carries `retry_ms` over the wire.
 */
export async function returnTaskVisit(playerId, taskId, ip) {
  return withPlayer(
    playerId,
    async (client) => {
      const { rows } = await client.query('select public.return_task_visit($1) as result', [taskId]);
      const result = rows[0].result;
      if (result && result.error) {
        const err = new Error(result.error);
        err.code = result.error;
        if (result.retry_ms != null) err.retryMs = result.retry_ms;
        throw err;
      }
      return result;
    },
    ip,
  );
}

/** One 20-row page of one tournament's board (ticket B2), no identity involved. `tournamentId`
 * null means whichever tournament public.current_tournament() reports; an explicit id reads
 * back a past or upcoming tournament's own board. `page` is 1-based. No tournament resolved, or
 * a page past the end, means empty rows, never an error - see public.leaderboard()'s own
 * comment in db/schema.sql. Each row carries its own badge `tier` (ticket B3). */
export async function leaderboard(tournamentId = null, page = 1) {
  const { rows } = await getPool().query('select * from public.leaderboard($1, $2)', [tournamentId, page]);
  return rows;
}

/** The total ranked-player count behind leaderboard() (ticket B2), for the client's page count. */
export async function leaderboardTotal(tournamentId = null) {
  const { rows } = await getPool().query('select public.leaderboard_total($1) as total', [tournamentId]);
  return Number(rows[0].total);
}

/** This player's own row on one tournament's board (ticket B2 decision 1, closes gap G3):
 * matched server-side by player id via public.my_rank(), never by comparing masked-email
 * strings. `null` when the caller has no verified email or no score in that tournament - not
 * an error, just nothing to highlight. */
export async function myRank(playerId, tournamentId = null) {
  return withPlayer(playerId, async (client) => {
    const { rows } = await client.query('select * from public.my_rank($1)', [tournamentId]);
    return rows[0] || null;
  });
}

/** The badge tier legend (ticket B3), ordered for display. No identity involved. */
export async function badgeLegend() {
  const { rows } = await getPool().query('select * from public.badge_legend()');
  return rows;
}

/** The tournament whose window contains this instant, or null when none is running.
 * public.current_tournament() is declared to return a single public.tournaments row (not
 * setof), so calling it in a FROM clause always yields exactly one row even when it found
 * nothing - a row of all-null columns, not zero rows (standard Postgres behaviour for a
 * NULL composite used as a table function). `id` is never null on a real tournament, so that
 * column is what tells the two cases apart. */
export async function currentTournament() {
  const { rows } = await getPool().query('select * from public.current_tournament()');
  return rows[0] && rows[0].id !== null ? rows[0] : null;
}

/** One tournament by id, for the `tournament` request frame's header - null if that id names
 * no tournament. */
export async function getTournament(id) {
  const { rows } = await getPool().query('select * from public.tournaments where id = $1', [id]);
  return rows[0] || null;
}

/** Every tournament, oldest first, for the client's past/upcoming switcher. Just the columns
 * the switcher needs to compute each one's status ('past' | 'live' | 'upcoming') against the
 * current time. */
export async function listTournaments() {
  const { rows } = await getPool().query(
    'select id, title, starts_at, ends_at from public.tournaments order by starts_at',
  );
  return rows;
}

/** Absolute claim URL from a claim_prize/settle_kiosk_round token (ticket C9 decision 2):
 * `${PUBLIC_URL}/claim/<token>`. Required only when a token is actually present - a box that
 * never has a kiosk reach the streak target inside a given run never needs it set. */
function publicUrl() {
  const base = process.env.PUBLIC_URL;
  if (!base) throw new Error('PUBLIC_URL is required to build a claim link');
  return base;
}

function claimUrlFor(token) {
  return token ? `${publicUrl()}/claim/${token}` : null;
}

/**
 * The kiosk's visitor session as the `kiosk_session` frame shape (ticket C1, docs/layers.md;
 * ticket C9 adds streak_target, claim_url and claim_expires_at): {coins, streak, state,
 * codes_left, streak_target, claim_url, claim_expires_at}. Sent right after a kiosk `welcome`
 * and mirrored into every kiosk `round_settled`. codes_left (ticket C8) is the live available
 * coupon count, computed here rather than cached, so it is always the number the kiosk would
 * see if it tried to play right now. claim_url/claim_expires_at mirror this kiosk's own most
 * recent still-open reservation (unclaimed, unexpired) so the WON screen survives a reconnect
 * without losing its QR - null once that reservation is claimed or the sweep releases it.
 */
export async function kioskSession(kioskId) {
  const { rows } = await getPool().query(
    `select k.session_coins as coins, k.streak, k.session_state as state,
       (select count(*)::int from public.coupons where status = 'available') as codes_left,
       public.get_setting_int('kiosk_streak_target', 5) as streak_target,
       cl.token as claim_token, cl.expires_at as claim_expires_at
     from public.kiosks k
     left join public.claim_links cl on cl.kiosk_id = k.id and cl.claimed_at is null and cl.expired_at is null
     where k.id = $1
     order by cl.created_at desc
     limit 1`,
    [kioskId],
  );
  const row = rows[0];
  if (!row) return { coins: 1000, streak: 0, state: 'idle', codes_left: 0, streak_target: 5 };
  const { claim_token: claimToken, ...rest } = row;
  return { ...rest, claim_url: claimUrlFor(claimToken) };
}

/** Live available-coupon count (ticket C8): the idle sweep polls this every tick to notice
 * the pool crossing zero either way, independent of any one kiosk's session. */
export async function availableCoupons() {
  const { rows } = await getPool().query("select count(*)::int as n from public.coupons where status = 'available'");
  return rows[0].n;
}

/** Starts a fresh visitor session (coins 1000, streak 0, playing). */
export async function startKioskSession(kioskId) {
  return call('start_kiosk_session', kioskId);
}

/** Open kiosk route (ticket K1): provision a new auto-kiosk. p_max caps active open kiosks. */
export async function createOpenKiosk(max = 50) {
  return call('create_open_kiosk', max);
}

/** Active kiosk counts split into seeded (non-open labels) and open (auto-provisioned). */
export async function kioskCounts() {
  const { rows } = await getPool().query(`
    select
      count(*) filter (where label not like 'open-%')::int as seeded,
      count(*) filter (where label like 'open-%')::int as open
    from public.kiosks
    where status = 'active'
  `);
  return rows[0];
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

/**
 * Claims a $100 bonus code once (ticket C9, docs/tickets/c9-qr-claim.md decision 4). ip may be
 * null (Caddy/Cloudflare terminate the connection in production, so it is usually present; a
 * direct dev connection may have none). email is validated by the caller (server/index.js,
 * the same EMAIL_RE every other email entry point uses) before this ever runs.
 */
export async function claimPrize(token, email, ip) {
  return call('claim_prize', token, email, ip);
}

/**
 * The /claim/<token> page's own read (GET /api/claim/<token>, ticket C9 decision 4): a plain
 * read, not a SECURITY DEFINER function, since the box's server already connects with full
 * access and this decides nothing - it only describes what claim_prize would do if called.
 * `email_masked` reuses the same public.mask_email() the leaderboard already shows the world -
 * never a raw address, even to someone reopening their own claimed link.
 */
export async function getClaimStatus(token) {
  const { rows } = await getPool().query(
    `select cl.expires_at, cl.claimed_at, cl.expired_at, public.mask_email(cl.email) as email_masked
     from public.claim_links cl where cl.token = $1`,
    [token],
  );
  const row = rows[0];
  if (!row) return { state: 'invalid' };
  if (row.claimed_at) return { state: 'claimed', email_masked: row.email_masked };
  if (row.expired_at || row.expires_at <= new Date()) return { state: 'expired' };
  return { state: 'ready', expires_at: row.expires_at };
}

/** The 60 s kiosk sweep's own claim-link housekeeping (ticket C9): releases every claim link
 * whose 24 h window ran out unclaimed, coupon back to 'available'. Returns the count released. */
export async function releaseExpiredClaims() {
  return call('release_expired_claims');
}

/** Mirrors an env-driven tunable into public.settings at boot (ticket C9 decision 1): a running
 * box can then change it with one SQL update, and a restart with no env var set never clobbers
 * that manual change - see server/index.js's start(). */
export async function upsertSetting(key, value) {
  await getPool().query(
    'insert into public.settings (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value',
    [key, value],
  );
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
      (select count(*)::int from public.coupons where status = 'reserved') as coupons_reserved,
      (select count(*)::int from public.kiosks where status = 'active') as kiosks_active,
      (select count(*)::int from public.devices
         where last_seen_at > now() - interval '24 hours') as devices_24h
  `);
  return rows[0];
}

/**
 * public.settings(key, value) - server-wide operator state mirrored across restarts (ticket
 * S18, safe mode). Not a client table: no policy grants it to anon/authenticated, same
 * treatment as dev_otps and otp_codes.
 */
export async function getSetting(key) {
  const { rows } = await getPool().query('select value from public.settings where key = $1', [key]);
  return rows[0] ? rows[0].value : null;
}

export async function setSetting(key, value) {
  await getPool().query(
    `insert into public.settings (key, value, updated_at) values ($1, $2, now())
       on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at`,
    [key, value],
  );
}

/** A device's created_at (ticket S18 decision 2: "a valid device token older than 10 minutes"
 * exempts a new anonymous player from a guarded refusal). Null when the token names no device. */
export async function getDeviceCreatedAt(deviceId) {
  const { rows } = await getPool().query('select created_at from public.devices where id = $1', [deviceId]);
  return rows[0] ? rows[0].created_at : null;
}

/** Instagram account storage (ticket B8). Called by the OAuth callback after the adapter has
 * verified the account. Throws on duplicate ig_user_id (the caller maps unique_violation to
 * already_claimed). */
export async function storeInstagramAccount(playerId, igUserId, username, deviceId = null) {
  await getPool().query(
    'insert into public.instagram_accounts (ig_user_id, username, player_id, device_id) values ($1, $2, $3, $4)',
    [igUserId, username, playerId, deviceId],
  );
}

/** Look up an Instagram account by its user id. */
export async function findInstagramAccount(igUserId) {
  const { rows } = await getPool().query('select * from public.instagram_accounts where ig_user_id = $1', [igUserId]);
  return rows[0] || null;
}

/** The device_id currently stored on the player's row, or null. */
export async function getPlayerDeviceId(playerId) {
  const { rows } = await getPool().query('select device_id from public.players where id = $1', [playerId]);
  return rows[0] ? rows[0].device_id : null;
}

/** Process start: nobody is left to honestly settle a round still marked open. */
export async function voidOpenRounds() {
  await getPool().query(
    "update public.rounds set status = 'settled', outcome = 'void', end_at = now() where status = 'open'",
  );
}

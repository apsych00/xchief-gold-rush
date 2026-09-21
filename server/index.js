/**
 * The box game server (docs/box-plan.md 1.2, docs/box-spec.md 1.2): one HTTP server for
 * /health, /status and /api/lead, one WebSocket at /ws for everything the game does.
 *
 * The client never reports its own result: every frame that changes coins, streak or a
 * coupon is decided here, from prices this process read itself off `feed.js`, through the
 * Postgres functions in `ledger.js`. See AGENTS.md.
 */

import { createServer } from 'node:http';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';

import { createFeed } from './feed.js';
import { createRoundManager } from './rounds.js';
import { createAlerts } from './alerts.js';
import { createKioskIdleSweep } from './kiosk.js';
import { createLimits, LIMITS } from './limits.js';
import { createSafeMode } from './safemode.js';
import * as ledger from './ledger.js';
import * as otp from './otp.js';
import * as instagram from './instagram.js';

const PING_INTERVAL_MS = 25000;
const MAX_MISSED_PONGS = 2;
const BACKPRESSURE_BYTES = 256 * 1024;
const STATUS_CACHE_MS = 5000; // /status does one DB round-trip; cache it so polling stays cheap
// Rows per leaderboard page - must match db/schema.sql's public.leaderboard()'s own
// `limit 25 offset ...` (that function has no way to take this as a parameter, so the two
// sides are kept in sync by hand; this constant is the single place the server-side number
// lives).
const LEADERBOARD_PAGE_SIZE = 25;

// Socket close codes for rate-limit refusals (ticket S2 decisions 1 and 7c): 4429 (mirroring
// HTTP 429) for anything that floods a socket after it authenticated, 4401 for a kiosk auth
// attempt that used a wrong secret - a distinct code so an operator reading Caddy/Dozzle logs
// can tell "abusive" from "guessing" apart.
const CLOSE_RATE_LIMITED = 4429;
const CLOSE_KIOSK_UNAUTHORIZED = 4401;
// Ticket S18 decision 2: "locked ... every new web socket is closed with 4503 after the
// welcome-less refusal frame" - 4503 for the same reason 4429/4401 pick their own numbers,
// mirroring HTTP 503 Service Unavailable so an operator reading logs can tell this refusal
// apart from an ordinary rate limit or a bad kiosk secret.
const CLOSE_SAFE_MODE = 4503;

const SAFE_MODE_RETRY_MS = 30000; // ticket S18 decision 2
// "a valid device token older than 10 minutes" (ticket S18 decision 2, guarded only).
const SAFE_MODE_DEVICE_TRUSTED_AGE_MS = 10 * 60 * 1000;
const SAFE_MODE_OTP_FACTOR = 0.5; // decision 2: "OTP requests allowed but halved limits"
const SAFE_MODE_LEADERBOARD_DEBOUNCE_MS = 5000; // decision 2: "throttled to once per 5 s"

const TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days (docs/layers.md C3a)
const TOKEN_RENEW_AFTER_SECONDS = 7 * 24 * 60 * 60; // sliding renewal: reissue once a token is older than this

const LEADERBOARD_DEBOUNCE_MS = 1000; // docs/layers.md C4: "debounced to at most once per second"

// Owner policy (ticket K3, second try): on the second or later genuine check the server no
// longer calls BoxAPI at all - it waits this long (so "Checking..." does not look instant/fake)
// and grants. Read at call time, like the other Instagram env knobs, so tests can zero it out.
function instagramGrantDelayMs() {
  const raw = process.env.INSTAGRAM_GRANT_DELAY_MS;
  const n = raw != null && raw !== '' ? Number(raw) : 3000;
  return Number.isFinite(n) && n >= 0 ? n : 3000;
}
const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
// /api/claim/<token>: the token is the base64url string settle_kiosk_round mints (ticket C9),
// never re-validated for shape here - an unknown or malformed token both just read as 'invalid'.
const CLAIM_PATH_RE = /^\/api\/claim\/([^/]+)$/;

const str = (v, max) =>
  String(v ?? '')
    .trim()
    .slice(0, max);

function tokenSecret() {
  const secret = process.env.PLAYER_TOKEN_SECRET;
  if (!secret) throw new Error('PLAYER_TOKEN_SECRET is required');
  return secret;
}

function tokenPayload(playerId, version, expiresAtSeconds) {
  return `${playerId}.${version}.${expiresAtSeconds}`;
}

/**
 * `<playerId>.<version>.<expiresAtSeconds>.<hmacHex>`, the hmac over the first three fields
 * (docs/layers.md C3a). `version` must equal players.token_version at verify time -
 * revoke_player_sessions bumps that column to invalidate every outstanding token for a player.
 * `nowSeconds` is a parameter rather than reading `Date.now()` here so tests can mint a token
 * as if it had been issued at an arbitrary time, instead of mocking the system clock.
 */
export function signToken(playerId, version = 1, nowSeconds = Math.floor(Date.now() / 1000)) {
  const expiresAt = nowSeconds + TOKEN_TTL_SECONDS;
  const payload = tokenPayload(playerId, version, expiresAt);
  const sig = crypto.createHmac('sha256', tokenSecret()).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

/**
 * An invalid token - bad shape, the old two-field format, a tampered signature, an expired
 * token, or a version that no longer matches players.token_version - is treated exactly like
 * no token: the caller starts fresh as a new anonymous player, never an error frame.
 *
 * `getVersion` defaults to a live lookup (ledger.getTokenVersion) and `nowSeconds` to the real
 * clock; both are overridable so unit tests can exercise the signature/expiry/version logic
 * without a database or a mocked Date.now().
 */
export async function verifyToken(
  token,
  { getVersion = ledger.getTokenVersion, nowSeconds = Math.floor(Date.now() / 1000) } = {},
) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 4) return null; // the old id.sig format has no version or expiry: simply invalid
  const [id, versionStr, expiresAtStr, sigHex] = parts;
  if (!UUID_RE.test(id)) return null;
  if (!/^[0-9]+$/.test(versionStr) || !/^[0-9]+$/.test(expiresAtStr)) return null;
  const version = Number(versionStr);
  const expiresAt = Number(expiresAtStr);

  const expectedHex = crypto
    .createHmac('sha256', tokenSecret())
    .update(tokenPayload(id, version, expiresAt))
    .digest('hex');
  let given;
  let expected;
  try {
    given = Buffer.from(sigHex, 'hex');
    expected = Buffer.from(expectedHex, 'hex');
  } catch {
    return null;
  }
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  if (expiresAt <= nowSeconds) return null;

  const dbVersion = await getVersion(id);
  return dbVersion === version ? id : null;
}

/**
 * Sliding renewal (docs/layers.md C3a): a token issued (expiresAt - 30d) more than 7 days ago
 * is replaced on its next `welcome`; a younger one is sent back unchanged so active players
 * never see their token churn on every connect.
 */
export function needsRenewal(token, nowSeconds = Math.floor(Date.now() / 1000)) {
  const expiresAt = Number(token.split('.')[2]);
  const issuedAt = expiresAt - TOKEN_TTL_SECONDS;
  return nowSeconds - issuedAt > TOKEN_RENEW_AFTER_SECONDS;
}

/**
 * `<deviceId>.<hmacHex>` (ticket B5, docs/tickets/b5-device-identity.md decision 2): signed
 * with the same PLAYER_TOKEN_SECRET as the player token, but no version and no expiry - a
 * device is never revoked and never renewed, it is just an opaque id the client happens to
 * hold onto in localStorage under its own key, forever (or until storage is cleared for it).
 */
export function signDeviceToken(deviceId) {
  const sig = crypto.createHmac('sha256', tokenSecret()).update(deviceId).digest('hex');
  return `${deviceId}.${sig}`;
}

/**
 * Invalid - bad shape, tampered - is treated exactly like absent (decision 2: "if absent or
 * invalid the server creates a device row"), never an error: the caller (handleAuth) passes
 * whatever this returns straight to ledger.touchDevice, which creates a fresh device for null.
 */
export function verifyDeviceToken(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [id, sigHex] = parts;
  if (!UUID_RE.test(id)) return null;
  const expectedHex = crypto.createHmac('sha256', tokenSecret()).update(id).digest('hex');
  let given;
  let expected;
  try {
    given = Buffer.from(sigHex, 'hex');
    expected = Buffer.from(expectedHex, 'hex');
  } catch {
    return null;
  }
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  return id;
}

// Instagram handle (ticket K3): trimmed, lowercased, a leading @ stripped, then 1-30 chars of
// [a-z0-9._] - Instagram's own username charset. Validated identically on the client (src/Tasks.jsx).
// Returns the normalized handle or null when it does not fit.
const IG_HANDLE_RE = /^[a-z0-9._]{1,30}$/;
export function normalizeHandle(raw) {
  const handle = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/^@+/, '');
  return IG_HANDLE_RE.test(handle) ? handle : null;
}

/**
 * Buffers an HTTP body up to LIMITS.MAX_HTTP_BODY_BYTES, counting bytes as chunks arrive (not
 * after the fact off Content-Length, which a client can lie about or omit) - ticket S2 decision
 * 7b / red team D4. A request over the cap stops being read past the limit: listeners are
 * detached rather than reading through `for await`, whose implicit cleanup on an early
 * break/throw destroys the socket before the caller gets a chance to answer 413 on it.
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    function onData(chunk) {
      total += chunk.length;
      if (total > LIMITS.MAX_HTTP_BODY_BYTES) {
        req.off('data', onData);
        req.off('end', onEnd);
        const err = new Error('body_too_large');
        err.code = 'body_too_large';
        reject(err);
        return;
      }
      chunks.push(chunk);
    }
    function onEnd() {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({});
      }
    }
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/**
 * Port of api/lead.js for the box's own HTTP server (docs/box-plan.md, "Lead capture": "the
 * box's server owns /api/lead - same JSON, same optional webhook"). Success answers 204 (no
 * Vercel function response body to shape here); validation errors keep the original JSON
 * error contract so the client's error handling does not need to know which host answered.
 *
 * Email only (ticket B4, docs/tasks-marketing-lead.md ground rules: "Only the email identifies
 * a web player"): name and phone are never accepted or stored, for either lead type. `type`
 * still distinguishes the in-game email capture from the xChief signup intent for whoever reads
 * the webhook, even though both now carry the same fields.
 */
async function handleLead(req, res) {
  if (req.method !== 'POST') {
    res.writeHead(405, { Allow: 'POST', 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' }));
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    if (err.code === 'body_too_large') {
      sendJson(res, 413, { ok: false, error: 'body_too_large' });
      return;
    }
    throw err;
  }
  const type = body.type === 'signup' ? 'signup' : 'email';
  const email = str(body.email, 254).toLowerCase();
  if (!EMAIL_RE.test(email)) {
    sendJson(res, 400, { ok: false, error: 'invalid_email' });
    return;
  }

  const lead = {
    type,
    email,
    source: str(body.source || 'unknown', 40),
    lang: str(body.lang, 5),
    balance: Number.isFinite(Number(body.balance)) ? Number(body.balance) : null,
    page: str(body.page, 200),
    ua: str(req.headers['user-agent'], 200),
    at: new Date().toISOString(),
  };

  console.log('[lead]', JSON.stringify(lead));

  const webhook = process.env.LEAD_WEBHOOK_URL;
  if (webhook) {
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (process.env.LEAD_WEBHOOK_SECRET) headers['X-Lead-Secret'] = process.env.LEAD_WEBHOOK_SECRET;
      await fetch(webhook, { method: 'POST', headers, body: JSON.stringify(lead) });
    } catch (err) {
      console.error('[lead] webhook failed', err?.message || err);
    }
  }

  res.writeHead(204);
  res.end();
}

/**
 * Build the server without starting it. `finnhubToken` defaults from the environment; tests
 * pass `null` (or nothing, with FINNHUB_TOKEN unset) to get a PAXG-only feed they drive
 * themselves through the returned `feed._injectTick`. `finnhubTokens` is FINNHUB_TOKENS, a
 * comma-separated list the feed rotates through on a 429/handshake rejection (server/feed.js);
 * it wins over finnhubToken when set, which stays as single-key sugar for anyone who hasn't
 * filled in the list.
 */
export function createApp({
  finnhubToken = process.env.FINNHUB_TOKEN || null,
  finnhubTokens = (process.env.FINNHUB_TOKENS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  // Kiosk idle-sweep timing (server/kiosk.js). Left undefined in production so kiosk.js's own
  // 60 s / 10 s defaults apply; tests shrink both so they do not wait on a real minute.
  kioskIdleMs = undefined,
  kioskSweepIntervalMs = undefined,
  // Live leaderboard push (docs/layers.md C4). Left at the default in production; tests shrink
  // it so a settle's broadcast does not sit in an in-progress test for a full second.
  leaderboardDebounceMs = LEADERBOARD_DEBOUNCE_MS,
  // Ticket S18 decision 2: the guarded/locked leaderboard throttle. Left at the product default
  // in production; tests shrink it for the same reason as leaderboardDebounceMs above.
  safeModeLeaderboardDebounceMs = SAFE_MODE_LEADERBOARD_DEBOUNCE_MS,
  // Test hook: override the fetch used by the alerts module so a test can prove no raw email
  // leaves through a webhook/Telegram transport (ticket K5).
  alertsFetch = undefined,
} = {}) {
  const playerSockets = new Map(); // playerId -> ws
  const kioskSockets = new Map(); // kioskId -> ws
  let statusCache = null; // { at, aggregates } - see STATUS_CACHE_MS
  // Assigned once, after `limits` and `alerts` exist below - declared here so
  // effectiveLeaderboardDebounceMs and handleAuth (defined ahead of that point) close over the
  // real value instead of a stale undefined one.
  let safeMode = null;

  function getSocket(kind, id) {
    return kind === 'player' ? playerSockets.get(id) : kioskSockets.get(id);
  }

  function send(ws, frame) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
  }

  function broadcastPrice(tick) {
    const frame = JSON.stringify({ type: 'price', price: tick.price, t: tick.t, quiet: tick.quiet });
    for (const ws of wss.clients) {
      if (!ws.authed || ws.readyState !== ws.OPEN) continue;
      if (ws.bufferedAmount > BACKPRESSURE_BYTES) continue; // round frames are sent directly, never through here
      ws.send(frame);
    }
  }

  // Live, masked leaderboard (docs/layers.md C4, ticket B2): recomputed after every player
  // round settle and pushed to every WEB socket - never a kiosk, which has no email and is
  // never ranked. `runAt` throttles this to at most one shared-payload query and one broadcast
  // round per `leaderboardDebounceMs`: the first settle after a quiet spell runs it immediately,
  // a burst of settles inside that window collapses into one more run right after it closes.
  // Each push always carries page 1 of the current tournament (ticket B2 decision 2); `me` is
  // computed per receiving socket (one extra SQL call per socket, acceptable at 100 concurrent)
  // since it is this player's own row, never shared - unlike the old top-10 payload, there is
  // no single "did anything change" json to dedupe against any more, so every scheduled run
  // broadcasts rather than skipping a quiet one.
  let leaderboardLastRunAt = 0;
  let leaderboardTimer = null;
  let leaderboardRunPending = false;

  /**
   * The part of the `leaderboard`-shaped payload every receiving socket shares (ticket B2):
   * `rows` (this page of that tournament's board, each carrying its own badge `tier`, ticket
   * B3), `tournament` (its own header - title, dates, prize - or null when none resolved),
   * `tournaments` (every tournament with a `status` computed against the current time, for the
   * client's past/upcoming switcher), and `page`/`pages`/`total` for the pager. `tournamentId`
   * null means whichever tournament is currently running; an explicit id reads back a past or
   * upcoming tournament's own board. `page` is 1-based.
   */
  async function buildLeaderboardShared(tournamentId, page) {
    const [rows, total, tournamentRow, tournamentRows] = await Promise.all([
      ledger.leaderboard(tournamentId, page),
      ledger.leaderboardTotal(tournamentId),
      tournamentId ? ledger.getTournament(tournamentId) : ledger.currentTournament(),
      ledger.listTournaments(),
    ]);
    const now = Date.now();
    const tournaments = tournamentRows.map((t) => ({
      id: t.id,
      title: t.title,
      starts_at: t.starts_at,
      ends_at: t.ends_at,
      status:
        now < new Date(t.starts_at).getTime() ? 'upcoming' : now >= new Date(t.ends_at).getTime() ? 'past' : 'live',
    }));
    const tournament = tournamentRow
      ? {
          id: tournamentRow.id,
          title: tournamentRow.title,
          starts_at: tournamentRow.starts_at,
          ends_at: tournamentRow.ends_at,
          prize_title: tournamentRow.prize_title,
          prize_image: tournamentRow.prize_image,
          broker_bonus: tournamentRow.broker_bonus,
        }
      : null;
    return {
      rows,
      tournament,
      tournaments,
      page,
      pages: Math.max(1, Math.ceil(total / LEADERBOARD_PAGE_SIZE)),
      total,
    };
  }

  /**
   * The full `leaderboard`-shaped reply to one socket's own request (ticket B2): the shared
   * page plus this player's own `me` row (public.my_rank(), matched by player id - closes gap
   * G3) and, only for a direct request and never for the unsolicited live push, the badge
   * `legend` (ticket B3 decision 3: "carries legend once, on request, not on push").
   */
  async function buildLeaderboardPayload(tournamentId, page, playerId, includeLegend) {
    const [shared, me, legend] = await Promise.all([
      buildLeaderboardShared(tournamentId, page),
      playerId ? ledger.myRank(playerId, tournamentId) : Promise.resolve(null),
      includeLegend ? ledger.badgeLegend() : Promise.resolve(undefined),
    ]);
    return { ...shared, me, ...(includeLegend ? { legend } : {}) };
  }

  async function runLeaderboardRefresh() {
    leaderboardLastRunAt = Date.now();
    let shared;
    try {
      shared = await buildLeaderboardShared(null, 1);
    } catch (err) {
      console.error('[leaderboard] refresh failed', err);
      return;
    }
    await Promise.all(
      Array.from(playerSockets.entries()).map(async ([playerId, ws]) => {
        if (ws.readyState !== ws.OPEN) return;
        try {
          const me = await ledger.myRank(playerId, null);
          send(ws, { type: 'leaderboard', ...shared, me });
        } catch (err) {
          console.error('[leaderboard] myRank failed', err);
        }
      }),
    );
  }

  /** Ticket S18 decision 2: guarded and locked throttle the leaderboard push to once per 5 s
   * instead of the product default. `safeMode` is assigned below, after this function is
   * defined but before it can ever run (nothing calls scheduleLeaderboardRefresh before start());
   * declared with `let` up front so this closure sees the real value once it exists. */
  function effectiveLeaderboardDebounceMs() {
    return safeMode && safeMode.level() !== 'normal' ? safeModeLeaderboardDebounceMs : leaderboardDebounceMs;
  }

  function scheduleLeaderboardRefresh() {
    const debounceMs = effectiveLeaderboardDebounceMs();
    const elapsed = Date.now() - leaderboardLastRunAt;
    if (elapsed >= debounceMs && !leaderboardTimer) {
      runLeaderboardRefresh().catch((err) => console.error('[leaderboard] refresh failed', err));
      return;
    }
    leaderboardRunPending = true;
    if (leaderboardTimer) return;
    leaderboardTimer = setTimeout(
      () => {
        leaderboardTimer = null;
        if (!leaderboardRunPending) return;
        leaderboardRunPending = false;
        runLeaderboardRefresh().catch((err) => console.error('[leaderboard] refresh failed', err));
      },
      Math.max(0, debounceMs - elapsed),
    );
  }

  const feed = createFeed({ finnhubToken, finnhubTokens, onTick: broadcastPrice });
  const rounds = createRoundManager({
    feed,
    ledger,
    getSocket,
    onPlayerSettled: scheduleLeaderboardRefresh,
    log: (line) => console.log(`[round] ${line}`),
  });
  const limits = createLimits({ log: (line) => console.log(line) });
  const alerts = createAlerts({
    latest: feed.latest,
    blockedCount: limits.blockedIpsCount,
    log: (line) => console.log(line),
    ...(alertsFetch !== undefined ? { fetch: alertsFetch } : {}),
  });
  safeMode = createSafeMode({
    ledger,
    getSignals: limits.safetySignals,
    alerts,
    log: (line) => console.log(line),
  });

  /**
   * The one DB round-trip /status needs (ledger.statusAggregates), cached for
   * STATUS_CACHE_MS so an operator page polling every 5 s never costs more than one query
   * every 5 s no matter how many people have it open.
   */
  async function getStatusAggregates() {
    const now = Date.now();
    if (statusCache && now - statusCache.at < STATUS_CACHE_MS) return statusCache.aggregates;
    const aggregates = await ledger.statusAggregates();
    statusCache = { at: now, aggregates };
    return aggregates;
  }

  /**
   * Operator-only aggregate view (docs/layers.md D1). No secrets, no player-identifying
   * data: counts, feed health, and open socket totals only.
   */
  async function handleStatus(res) {
    const [aggregates, db, kiosks] = await Promise.all([getStatusAggregates(), ledger.ping(), ledger.kioskCounts()]);
    const now = Date.now();
    const sources = {};
    for (const [id, s] of Object.entries(feed.status())) {
      sources[id] = {
        connected: s.connected,
        lastTickAt: s.lastTickAt,
        ageMs: s.lastTickAt === null ? null : now - s.lastTickAt,
        // Finnhub key rotation state (server/feed.js status()): which key index is live and how
        // many are configured, never the keys themselves. Absent for sources with no key list.
        ...(s.keyIndex !== undefined ? { keyIndex: s.keyIndex, keyCount: s.keyCount } : {}),
      };
    }
    const p = feed.latest();
    sendJson(res, 200, {
      ok: true,
      uptimeSeconds: Math.round(process.uptime()),
      // `source` is which tier is publishing right now (mt5, finnhub, okx, binance) - the one
      // line an operator needs to tell MT5 from the fallbacks at a glance (gap G10).
      feed: { sources, source: p ? p.source || null : null, price: p ? p.price : null, quiet: p ? p.quiet : true },
      sockets: { web: playerSockets.size, kiosk: kioskSockets.size },
      rounds: {
        inFlight: aggregates.rounds_in_flight,
        settled60s: aggregates.rounds_settled_60s,
        settled24h: aggregates.rounds_settled_24h,
      },
      flats24h: aggregates.flats_24h,
      coupons: {
        available: aggregates.coupons_available,
        claimed: aggregates.coupons_claimed,
        reserved: aggregates.coupons_reserved,
      },
      kiosksActive: aggregates.kiosks_active,
      kiosks: { seeded: kiosks.seeded, open: kiosks.open },
      devices24h: aggregates.devices_24h,
      limits: limits.stats(),
      safe_mode: safeMode.status(),
      instagram: instagram.status(),
      db,
    });
  }
  /**
   * POST /api/kiosk/provision (ticket K1): public, no auth. Creates an open kiosk when the
   * exhibition switch is on, guarded by the anonymous-auth per-IP window and a hard cap on
   * active open kiosks. Returns {id, secret, label}; the raw secret is shown once and never
   * stored again.
   */
  async function handleProvision(req, res, ip) {
    if (process.env.KIOSK_OPEN_PROVISION !== '1') {
      sendJson(res, 404, { ok: false, error: 'not_configured' });
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST', 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' }));
      return;
    }
    const budget = limits.checkAnonAuth(ip);
    if (!budget.allowed) {
      sendJson(res, 429, { ok: false, error: 'rate_limited', retry_ms: budget.retryMs });
      return;
    }
    const max = Number(process.env.KIOSK_OPEN_MAX) || 50;
    try {
      const kiosk = await ledger.createOpenKiosk(max);
      sendJson(res, 200, kiosk);
    } catch (err) {
      const code = ledger.KNOWN_ERROR_CODES.includes(err.code) ? err.code : 'internal';
      if (code === 'internal') console.error('[provision] unhandled error', err);
      sendJson(res, code === 'kiosk_cap' ? 429 : 500, { ok: false, error: code });
    }
  }

  /** GET /api/claim/<token> (ticket C9 decision 4): the claim page's own read - never a
   * decision, just what claim_prize would do if called right now. */
  async function handleClaimGet(res, token) {
    sendJson(res, 200, await ledger.getClaimStatus(token));
  }

  /**
   * POST /api/claim/<token> {email} (ticket C9 decision 4): one atomic claim_prize() call, then
   * the bonus code is emailed through server/otp.js's Elastic sender - a mail failure is logged
   * and never undoes the claim that already committed in Postgres. claim_prize's own
   * `claim_invalid`/`claim_link_expired` become the wire contract's `invalid`/`expired` here;
   * `already_claimed` is already the public name.
   */
  async function handleClaimPost(req, res, token, ip) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      if (err.code === 'body_too_large') {
        sendJson(res, 413, { ok: false, error: 'body_too_large' });
        return;
      }
      throw err;
    }
    const email = str(body.email, 254).toLowerCase();
    if (!EMAIL_RE.test(email)) {
      sendJson(res, 400, { ok: false, error: 'invalid_email' });
      return;
    }
    try {
      const result = await ledger.claimPrize(token, email, ip && ip !== 'unknown' ? ip : null);
      // The email no longer carries this claim link: its only link is the client area's promo
      // page, where the code is redeemed. By the time the visitor reads it, this page has already
      // done its job - it is where they typed the email that got them the code.
      otp.sendClaimCode(email, result.code).catch((err) => {
        console.error('[claim] sendClaimCode failed', err?.message || err);
      });
      sendJson(res, 200, { ok: true, code: result.code, email });
    } catch (err) {
      const code = ledger.KNOWN_ERROR_CODES.includes(err.code) ? err.code : 'internal';
      if (code === 'internal') console.error('[claim] unhandled error', err);
      const publicCode = code === 'claim_invalid' ? 'invalid' : code === 'claim_link_expired' ? 'expired' : code;
      sendJson(res, publicCode === 'internal' ? 500 : 409, { ok: false, error: publicCode });
    }
  }

  const kioskIdleSweep = createKioskIdleSweep({
    ledger,
    getSocket,
    listKioskSockets: () => kioskSockets.entries(),
    alerts,
    ...(kioskIdleMs !== undefined ? { idleMs: kioskIdleMs } : {}),
    ...(kioskSweepIntervalMs !== undefined ? { intervalMs: kioskSweepIntervalMs } : {}),
    log: (line) => console.log(`[kiosk] ${line}`),
  });

  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      ledger.ping().then((db) => sendJson(res, 200, { ok: true, feed: feed.status(), db }));
      return;
    }
    if (req.method === 'GET' && req.url === '/status') {
      handleStatus(res).catch((err) => {
        console.error('[status] unhandled error', err);
        sendJson(res, 500, { ok: false, error: 'internal' });
      });
      return;
    }
    if (req.url && req.url.startsWith('/api/')) {
      // Same per-IP connection window as a ws upgrade (ticket S2 decision 7b).
      const ip = limits.clientIp(req);
      if (limits.checkApiRequest(ip)) {
        sendJson(res, 429, { ok: false, error: 'rate_limited' });
        return;
      }
      const claimMatch = req.url.match(CLAIM_PATH_RE);
      if (claimMatch) {
        const token = decodeURIComponent(claimMatch[1]);
        // CORS (ticket C9): production serves the SPA and /api/* from one Caddy origin, where
        // this header is a no-op, but the dev recipe (docs/tickets/c9-qr-claim.md) runs Vite and
        // this server on two different ports - a claim page fetch is then cross-origin, and a
        // JSON POST triggers a preflight OPTIONS the server must answer. Safe wide open: nothing
        // this route does is cookie/session-authorized, the token in the URL is the only proof
        // of anything, exactly like a bearer secret.
        res.setHeader('Access-Control-Allow-Origin', '*');
        if (req.method === 'OPTIONS') {
          res.writeHead(204, {
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
          });
          res.end();
          return;
        }
        if (req.method === 'GET') {
          handleClaimGet(res, token).catch((err) => {
            console.error('[claim] unhandled error', err);
            sendJson(res, 500, { ok: false, error: 'internal' });
          });
          return;
        }
        if (req.method === 'POST') {
          // ticket C9 decision 4: 5 per 10 minutes per IP, its own budget - a claim attempt has
          // no socket or player identity to key S2's other windows on.
          const budget = limits.checkClaimIp(ip);
          if (!budget.allowed) {
            sendJson(res, 429, { ok: false, error: 'rate_limited', retry_ms: budget.retryMs });
            return;
          }
          handleClaimPost(req, res, token, ip).catch((err) => {
            console.error('[claim] unhandled error', err);
            sendJson(res, 500, { ok: false, error: 'internal' });
          });
          return;
        }
        res.writeHead(405, { Allow: 'GET, POST', 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' }));
        return;
      }
      if (req.url === '/api/kiosk/provision') {
        // CORS (ticket K1): same dev-recipe split as the claim route above - Vite and this server on
        // two different ports, so the open kiosk route's POST is cross-origin and needs a preflight
        // answered. Safe wide open: this route mints a fresh, unprivileged kiosk identity, nothing
        // it does is cookie/session-authorized.
        res.setHeader('Access-Control-Allow-Origin', '*');
        if (req.method === 'OPTIONS') {
          res.writeHead(204, {
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
          });
          res.end();
          return;
        }
        handleProvision(req, res, ip).catch((err) => {
          console.error('[provision] unhandled error', err);
          sendJson(res, 500, { ok: false, error: 'internal' });
        });
        return;
      }
    }
    if (req.url === '/api/lead') {
      handleLead(req, res).catch((err) => {
        console.error('[lead] unhandled error', err);
        sendJson(res, 500, { ok: false, error: 'internal' });
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  // maxPayload rejects an oversize frame before it is ever buffered whole (red team D4);
  // MAX_FRAME_BYTES (4 KB, ticket S2 decision 2) already covers what a legitimate frame needs.
  const wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.MAX_FRAME_BYTES });

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname !== '/ws') {
      socket.destroy();
      return;
    }
    const ip = limits.clientIp(req);
    if (limits.checkNewConnection(ip)) {
      socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.clientIp = ip;
      limits.trackSocketOpen(ip);
      wss.emit('connection', ws, req);
    });
  });

  async function sendHelloAndPending(ws, kind, id) {
    const missed = rounds.takePending(kind, id);
    if (missed) {
      send(ws, missed);
      if (kind === 'player') {
        const me = await ledger.getMe(id);
        send(ws, { type: 'me', ...me });
      }
    }
    const p = feed.latest();
    send(ws, p ? { type: 'hello', price: p.price, t: p.t, quiet: p.quiet } : { type: 'hello', price: null });
  }

  async function handleAuth(ws, frame) {
    // D7 (docs/reports/redteam.md): the kiosk parameter's presence is the signal, not its
    // truthiness - `''` (a launch URL that lost its query string) must fail closed as a kiosk,
    // never fall through and be welcomed as a fresh web player.
    const isKioskAttempt = frame.kiosk !== undefined;
    if (isKioskAttempt) {
      try {
        // A kiosk auth attempt mints or guesses an identity exactly like an anonymous player
        // does, so it shares that budget (ticket S2 decision 7c) - checked before verify_kiosk
        // runs its bcrypt compare, so a throttled guesser cannot also burn CPU on it.
        const budget = limits.checkAnonAuth(ws.clientIp);
        if (!budget.allowed) {
          send(ws, { type: 'error', code: 'rate_limited', retry_ms: budget.retryMs });
          return;
        }
        const kioskId = await ledger.call('verify_kiosk', frame.kiosk);
        ws.authed = true;
        ws.kind = 'kiosk';
        ws.identity = kioskId;
        kioskSockets.set(kioskId, ws);
        const session = await ledger.kioskSession(kioskId);
        send(ws, { type: 'welcome', kiosk: true, streak: session.streak });
        send(ws, { type: 'kiosk_session', ...session });
        await sendHelloAndPending(ws, 'kiosk', kioskId);
      } catch (err) {
        const code = ledger.KNOWN_ERROR_CODES.includes(err.code) ? err.code : 'internal';
        if (code === 'internal') console.error('[auth] kiosk auth error', err);
        send(ws, { type: 'error', code });
        // Ticket S2 decision 7c: a failed kiosk auth (wrong or guessed secret) closes the socket
        // instead of leaving it open to keep guessing.
        ws.close(CLOSE_KIOSK_UNAUTHORIZED, code);
      }
      return;
    }

    try {
      let playerId = null;
      let currentToken = null;
      let version = 1;
      let tokenIssuedAtMs = null;
      if (frame.token) {
        const id = await verifyToken(frame.token);
        if (id) {
          playerId = id;
          currentToken = frame.token;
          version = Number(frame.token.split('.')[1]);
          tokenIssuedAtMs = (Number(frame.token.split('.')[2]) - TOKEN_TTL_SECONDS) * 1000;
        }
      }

      // Safe mode (ticket S18 decision 2). Only a brand-new anonymous player (no valid player
      // token above) is ever gated - a returning player with a token resumes normally in
      // guarded, and everything below this block runs exactly as it did before S18 whenever
      // safeMode.level() is 'normal'.
      if (!playerId) {
        limits.trackAnonAttempt(); // before any gate below, so a refusal never hides the attempt
        const safeLevel = safeMode.level();
        if (safeLevel !== 'normal') {
          // guarded's own exemption: a device this socket already holds, old enough that it
          // predates whatever just started the flood, rather than one minted on the spot by it.
          // locked drops this exemption entirely (decision 2: "additionally ... except kiosks
          // and sockets with a token issued before the lock" - a device alone is no longer
          // enough), which is why this check is skipped outright once level is 'locked'.
          let deviceTrusted = false;
          if (safeLevel === 'guarded') {
            const deviceId0 = verifyDeviceToken(frame.device);
            if (deviceId0) {
              const createdAt = await ledger.getDeviceCreatedAt(deviceId0);
              if (createdAt && Date.now() - new Date(createdAt).getTime() > SAFE_MODE_DEVICE_TRUSTED_AGE_MS) {
                deviceTrusted = true;
              }
            }
          }
          if (!deviceTrusted) {
            send(ws, { type: 'error', code: 'safe_mode', retry_ms: SAFE_MODE_RETRY_MS });
            if (safeLevel === 'locked') ws.close(CLOSE_SAFE_MODE, 'safe_mode');
            return;
          }
        }
      } else if (safeMode.level() === 'locked') {
        // locked's own tightening on top of guarded's (decision 2): a returning player's token
        // only resumes here if it predates the lock - one issued during it (impossible under
        // normal play, since no new tokens are minted while locked, but checked all the same)
        // is treated exactly like a fresh anonymous connection: refused and closed.
        const lockedAtMs = safeMode.lockedAtMs();
        if (lockedAtMs === null || tokenIssuedAtMs >= lockedAtMs) {
          send(ws, { type: 'error', code: 'safe_mode', retry_ms: SAFE_MODE_RETRY_MS });
          ws.close(CLOSE_SAFE_MODE, 'safe_mode');
          return;
        }
      }

      // Device identity (ticket B5): resolved before createPlayer, since a brand-new anonymous
      // player's device_id is set once, at creation, from whichever device this auth frame
      // carries (decision 2). touchDevice creates a fresh row for an absent or invalid token.
      // The per-IP anonymous-player budget (S2) is checked first so a throttled IP never
      // creates device rows either.
      if (!playerId) {
        const budget = limits.checkAnonAuth(ws.clientIp);
        if (!budget.allowed) {
          send(ws, { type: 'error', code: 'rate_limited', retry_ms: budget.retryMs });
          return;
        }
      }
      const presentedDeviceId = verifyDeviceToken(frame.device);
      const deviceId = presentedDeviceId || !playerId
        ? await ledger.touchDevice(presentedDeviceId, ws.clientIp, ws.userAgent)
        : null;

      if (!playerId) playerId = await ledger.createPlayer(deviceId);

      const me = await ledger.getMe(playerId);
      ws.authed = true;
      ws.kind = 'player';
      ws.identity = playerId;
      ws.deviceId = me.device_id || null;
      // Ticket B13: the no-device reward budget keys on whether this socket ends up with a
      // device id at all - minted just now for a brand-new player, presented on a return visit,
      // or already on the player's own row - not on whether the client happened to present a
      // token on this specific connection. A fresh browser's first-ever claim has one (the
      // server mints it during this same auth and returns it on `welcome`); only a player whose
      // own row has never carried a device_id (a client from before device identity existed, or
      // one that has never stored the token welcome gave it) is actually "no device".
      ws.hasDevice = ws.deviceId != null;
      playerSockets.set(playerId, ws);
      const token = currentToken && !needsRenewal(currentToken) ? currentToken : signToken(playerId, version);
      const welcome = { type: 'welcome', token, me };
      if (deviceId) welcome.device = signDeviceToken(deviceId);
      // Ticket K3: hand the client the account it must follow so every user-facing mention of the
      // handle comes from the configured INSTAGRAM_HANDLE, never a value baked into the client.
      const ourInstagramHandle = instagram.ourHandle();
      if (ourInstagramHandle) welcome.our_handle = ourInstagramHandle;
      send(ws, welcome);
      await sendHelloAndPending(ws, 'player', playerId);
    } catch (err) {
      // D9: only codes the contract names reach the client; anything else is logged here.
      const code = ledger.KNOWN_ERROR_CODES.includes(err.code) ? err.code : 'internal';
      if (code === 'internal') console.error('[auth] error', err);
      send(ws, { type: 'error', code });
    }
  }

  /**
   * Ticket B13: one line per refused reward claim, with the contract code and the player's
   * device id (null for old clients). Called both for direct refusals and from handleFrame's
   * catch for errors raised by the ledger.
   */
  function logRewardRefusal(ws, frameType, code) {
    console.log(
      `[rewards] refused claim: code=${code} device_id=${ws.deviceId || 'none'} player=${ws.identity || 'none'} ip=${ws.clientIp} frame=${frameType}`,
    );
  }

  async function handleFrame(ws, frame) {
    const { kind, identity: id } = ws;
    try {
      switch (frame.type) {
        case 'play': {
          const budget = limits.checkPlayRate(ws.socketId);
          if (!budget.allowed) {
            send(ws, { type: 'error', code: 'rate_limited', retry_ms: budget.retryMs });
            break;
          }
          const dir = frame.dir;
          const lever = kind === 'kiosk' ? (frame.lever ?? 1) : frame.lever;
          const opened = await rounds.play(kind, id, { dir, lever }, ws);
          send(ws, { type: 'round_opened', ...opened });
          break;
        }
        case 'kiosk_reset': {
          if (kind !== 'kiosk') {
            send(ws, { type: 'error', code: 'not_available' });
            break;
          }
          const session = await ledger.resetKioskSession(id);
          send(ws, { type: 'kiosk_session', ...session });
          break;
        }
        case 'get_me': {
          if (kind !== 'player') {
            send(ws, { type: 'error', code: 'unauthenticated' });
            break;
          }
          const budget = limits.checkQueryRate(ws.socketId, 'get_me');
          if (!budget.allowed) {
            send(ws, { type: 'error', code: 'rate_limited', retry_ms: budget.retryMs });
            break;
          }
          send(ws, { type: 'me', ...(await ledger.getMe(id)) });
          break;
        }
        case 'sign_out': {
          // Signing out has to mean the token is dead, not merely forgotten by the browser that
          // held it. revoke_player_sessions bumps players.token_version, and verifyToken above
          // requires an exact match, so every outstanding token for this player stops validating
          // at once - including any copy taken off the device. Without this the browser drops its
          // token while the token itself stays good for the rest of its 30 days.
          //
          // Kiosks never sign out: a booth device holds a bearer secret, not a player token, and
          // has no identity to detach from (docs/layers.md C5).
          if (kind !== 'player') {
            send(ws, { type: 'error', code: 'not_available' });
            break;
          }
          await ledger.revokePlayerSessions(id);
          // Answered before the socket is closed so the client knows the revoke committed and
          // can clear its own token; a client that clears first and never hears back would leave
          // the account signed in everywhere else.
          send(ws, { type: 'signed_out' });
          break;
        }
        case 'claim_task': {
          // Kiosks have no email, no tasks and no gifts (docs/layers.md C5): denied the same
          // way request_otp/verify_otp already are, not the bare 'unauthenticated' a player
          // would get for a stale/bad session.
          if (kind !== 'player') {
            logRewardRefusal(ws, 'claim_task', 'not_available');
            send(ws, { type: 'error', code: 'not_available' });
            break;
          }
          const rewardBudget = limits.checkRewardClaimIp(ws.clientIp, ws.hasDevice);
          if (!rewardBudget.allowed) {
            logRewardRefusal(ws, 'claim_task', 'rate_limited');
            send(ws, { type: 'error', code: 'rate_limited', retry_ms: rewardBudget.retryMs });
            break;
          }
          const claimed = await ledger.claimTask(id, frame.task_id, ws.clientIp);
          limits.recordRewardClaim(ws.clientIp, ws.hasDevice);
          const me = await ledger.getMe(id);
          send(ws, { type: 'me', ...me, reward: claimed.reward, task: frame.task_id });
          break;
        }
        case 'free_refill': {
          if (kind !== 'player') {
            logRewardRefusal(ws, 'free_refill', 'not_available');
            send(ws, { type: 'error', code: 'not_available' });
            break;
          }
          const rewardBudget = limits.checkRewardClaimIp(ws.clientIp, ws.hasDevice);
          if (!rewardBudget.allowed) {
            logRewardRefusal(ws, 'free_refill', 'rate_limited');
            send(ws, { type: 'error', code: 'rate_limited', retry_ms: rewardBudget.retryMs });
            break;
          }
          const refilled = await ledger.freeRefill(id);
          limits.recordRewardClaim(ws.clientIp, ws.hasDevice);
          const me = await ledger.getMe(id);
          send(ws, { type: 'me', ...me, reward: refilled.reward });
          break;
        }
        case 'task_progress': {
          // Video watch progress (ticket B6+B7+B9 decision 2): reported at most every 5 s while
          // the video plays and once on ended. report_video_progress releases the reward itself
          // once 90% is crossed - this reply is the usual `me`, with `reward`/`task` only when
          // that happened on this call.
          if (kind !== 'player') {
            logRewardRefusal(ws, 'task_progress', 'not_available');
            send(ws, { type: 'error', code: 'not_available' });
            break;
          }
          const taskFrameBudget = limits.checkQueryRate(ws.socketId, 'task_progress');
          if (!taskFrameBudget.allowed) {
            send(ws, { type: 'error', code: 'rate_limited', retry_ms: taskFrameBudget.retryMs });
            break;
          }
          const taskId = str(frame.task, 40);
          const rewardBudget = limits.checkRewardClaimIp(ws.clientIp, ws.hasDevice);
          if (!rewardBudget.allowed) {
            logRewardRefusal(ws, 'task_progress', 'rate_limited');
            send(ws, { type: 'error', code: 'rate_limited', retry_ms: rewardBudget.retryMs });
            break;
          }
          const progress = await ledger.reportVideoProgress(id, taskId, Number(frame.seconds), Number(frame.duration), ws.clientIp);
          if (progress.reward != null) limits.recordRewardClaim(ws.clientIp, ws.hasDevice);
          const me = await ledger.getMe(id);
          send(ws, {
            type: 'me',
            ...me,
            ...(progress.reward != null ? { reward: progress.reward, task: taskId } : {}),
          });
          break;
        }
        case 'task_start': {
          // Redirect and return (ticket B6+B7+B9 decision 3): sent before the client opens the
          // destination URL. The server records the visit and answers the window it granted.
          if (kind !== 'player') {
            send(ws, { type: 'error', code: 'not_available' });
            break;
          }
          const taskFrameBudget = limits.checkQueryRate(ws.socketId, 'task_start');
          if (!taskFrameBudget.allowed) {
            send(ws, { type: 'error', code: 'rate_limited', retry_ms: taskFrameBudget.retryMs });
            break;
          }
          const taskId = str(frame.task, 40);
          const started = await ledger.startTaskVisit(id, taskId);
          send(ws, { type: 'task_started', ...started });
          break;
        }
        case 'task_return': {
          // Sent when the tab regains focus. Released only once the 5 s window has actually
          // passed; `not_yet`/`already_claimed` arrive as the usual error frame (with `retry_ms`
          // on `not_yet`, from the catch block below).
          if (kind !== 'player') {
            logRewardRefusal(ws, 'task_return', 'not_available');
            send(ws, { type: 'error', code: 'not_available' });
            break;
          }
          const taskFrameBudget = limits.checkQueryRate(ws.socketId, 'task_return');
          if (!taskFrameBudget.allowed) {
            send(ws, { type: 'error', code: 'rate_limited', retry_ms: taskFrameBudget.retryMs });
            break;
          }
          const rewardBudget = limits.checkRewardClaimIp(ws.clientIp, ws.hasDevice);
          if (!rewardBudget.allowed) {
            logRewardRefusal(ws, 'task_return', 'rate_limited');
            send(ws, { type: 'error', code: 'rate_limited', retry_ms: rewardBudget.retryMs });
            break;
          }
          const taskId = str(frame.task, 40);
          const released = await ledger.returnTaskVisit(id, taskId, ws.clientIp);
          if (released.reward != null) limits.recordRewardClaim(ws.clientIp, ws.hasDevice);
          const me = await ledger.getMe(id);
          send(ws, { type: 'me', ...me, reward: released.reward, task: taskId });
          break;
        }
        case 'tasks': {
          if (kind !== 'player') {
            send(ws, { type: 'error', code: 'not_available' });
            break;
          }
          const budget = limits.checkQueryRate(ws.socketId, 'tasks');
          if (!budget.allowed) {
            send(ws, { type: 'error', code: 'rate_limited', retry_ms: budget.retryMs });
            break;
          }
          send(ws, { type: 'tasks', rows: await ledger.getTasks(id) });
          break;
        }
        case 'instagram_start': {
          // Ticket K3 step 1: the player enters their handle before being sent to Instagram to
          // follow. The server stores the handle (unverified) and answers with the URLs to open;
          // it never trusts the client's word on the follow - that is proven in instagram_check.
          if (kind !== 'player') {
            send(ws, { type: 'error', code: 'not_available' });
            break;
          }
          const budget = limits.checkQueryRate(ws.socketId, 'instagram_start');
          if (!budget.allowed) {
            send(ws, { type: 'error', code: 'rate_limited', retry_ms: budget.retryMs });
            break;
          }
          // No token yet: behave exactly like B8's not_configured (the row shows "coming soon"),
          // never crash. Checked before handle validation so the coming-soon path needs no input.
          if (instagram.status() === 'not_configured') {
            send(ws, { type: 'instagram_started', status: 'not_configured' });
            break;
          }
          const handle = normalizeHandle(frame.handle);
          if (!handle) {
            send(ws, { type: 'error', code: 'invalid_handle' });
            break;
          }
          await ledger.startInstagram(id, handle); // may raise instagram_handle_taken / _already_verified
          const ourHandle = instagram.ourHandle();
          const profileUrl =
            process.env.INSTAGRAM_PROFILE_URL || (ourHandle ? `https://www.instagram.com/${ourHandle}/` : null);
          const appUrl = ourHandle ? `instagram://user?username=${ourHandle}` : null;
          send(ws, {
            type: 'instagram_started',
            handle,
            our_handle: ourHandle || null,
            profile_url: profileUrl,
            app_url: appUrl,
          });
          break;
        }
        case 'instagram_check': {
          // Ticket K3 step 2: the player says "I followed, check". The server reads our own id and
          // the player's following list off BoxAPI (server/instagram.js) and decides - the client
          // never asserts the follow. On a proven follow, or the owner's second-try grant below,
          // the reward releases through the same release_task_reward path every other task uses
          // (once per player/device/email, B13).
          if (kind !== 'player') {
            send(ws, { type: 'error', code: 'not_available' });
            break;
          }
          // instagram_check counts against S2's per-socket query budget (ticket K3 decision 3),
          // whether or not this particular check reaches BoxAPI.
          const queryBudget = limits.checkQueryRate(ws.socketId, 'instagram_check');
          if (!queryBudget.allowed) {
            send(ws, { type: 'error', code: 'rate_limited', retry_ms: queryBudget.retryMs });
            break;
          }
          // Owner policy: every instagram_check - whether fired by the player's tap or by the
          // client's background focus listener - is treated the same way by the server. There is
          // no client-asserted "this one was automatic"; the
          // server has no such concept any more. At most one BoxAPI read ever happens per
          // player, on the check_attempts 0 -> 1 transition; any later check just waits out the
          // grant delay and releases. This also removes the old per-player 20 s BoxAPI window:
          // with at most one read per player ever, there is nothing left for it to protect.
          const account = await ledger.getInstagramAccount(id);
          if (!account) {
            // No handle stored: the player never ran instagram_start. Not an error - the row just
            // asks for the handle again.
            send(ws, { type: 'instagram_result', ok: false, reason: 'no_handle' });
            break;
          }
          if (account.verified_at) {
            // Already proven on an earlier check - nothing more to read from BoxAPI.
            send(ws, { type: 'instagram_result', ok: true });
            break;
          }

          let verdict = null; // set on a genuine BoxAPI read; stays null on the no-API grant below
          let grant = false;

          if ((account.check_attempts || 0) === 0) {
            // First genuine check. not_configured never calls out; every other outcome is a real
            // BoxAPI read.
            if (instagram.status() === 'not_configured') {
              verdict = { ok: false, reason: 'not_configured' };
            } else {
              verdict = await instagram.verifyFollow({ handle: account.handle });
              // Log the handle and the outcome, never the token (ticket K3 decision 2).
              console.log(
                `[instagram] check handle=${account.handle} player=${id} outcome=${verdict.ok ? 'ok' : verdict.reason}`,
              );
            }
            if (verdict.ok) {
              grant = true;
            } else {
              // Owner policy (ticket K3 - an intentional UX-over-strictness decision): any non-ok
              // first outcome - not_following, private, not_found, a transport or config error -
              // counts as one genuine attempt and unlocks the second-try grant below, no matter
              // what triggered this check.
              await ledger.bumpInstagramAttempt(id);
            }
          } else {
            // Second or later genuine attempt already on the row (owner policy): "no more API
            // calling to verify" - wait a beat so Checking... does not look instant/fake, then
            // grant. The server still decides and releases through the normal path below.
            console.log(`[instagram] second-try grant handle=${account.handle} player=${id} attempts=${account.check_attempts}`);
            await sleep(instagramGrantDelayMs());
            grant = true;
          }

          if (!grant) {
            send(ws, { type: 'instagram_result', ok: false, reason: verdict ? verdict.reason : 'not_following' });
            break;
          }
          const rewardBudget = limits.checkRewardClaimIp(ws.clientIp, ws.hasDevice);
          if (!rewardBudget.allowed) {
            logRewardRefusal(ws, 'instagram_check', 'rate_limited');
            send(ws, { type: 'error', code: 'rate_limited', retry_ms: rewardBudget.retryMs });
            break;
          }
          const released = await ledger.verifyInstagram(id, account.handle, ws.clientIp);
          if (released.reward != null) limits.recordRewardClaim(ws.clientIp, ws.hasDevice);
          const me = await ledger.getMe(id);
          send(ws, {
            type: 'instagram_result',
            ok: true,
            ...(released.reward != null ? { reward: released.reward } : {}),
            me,
          });
          break;
        }
        case 'leaderboard': {
          // D8 (docs/reports/redteam.md): a kiosk has no email and is never ranked; guarded the
          // same way every other player-only frame already is. Ticket B2 decision 2: the
          // request carries optional `tournament` and `page`; `tournament` absent or empty
          // means whichever tournament is currently running, `page` defaults to 1.
          if (kind !== 'player') {
            send(ws, { type: 'error', code: 'not_available' });
            break;
          }
          const tournamentId = str(frame.tournament, 50) || null;
          const page = Math.max(1, Number.parseInt(frame.page, 10) || 1);
          // Only the plain "open the leaderboard screen" request (page 1 of whichever
          // tournament is current) sits under the 1/s query budget, same as every other query
          // frame. A resolved page past 1, or an explicit tournament, is a pager or switcher
          // click - a person can flip through several of either in under a second, same
          // reasoning the `tournament` frame below has always carried; the per-socket
          // frame-rate limit (S2) still bounds it.
          if (page <= 1 && !tournamentId) {
            const budget = limits.checkQueryRate(ws.socketId, 'leaderboard');
            if (!budget.allowed) {
              send(ws, { type: 'error', code: 'rate_limited', retry_ms: budget.retryMs });
              break;
            }
          }
          send(ws, { type: 'leaderboard', ...(await buildLeaderboardPayload(tournamentId, page, id, true)) });
          break;
        }
        case 'tournament': {
          // Reads back a specific tournament's own board page 1 - past or upcoming - as the
          // same `leaderboard`-shaped frame (ticket B1; kept alongside the unified `leaderboard`
          // request above, ticket B2, for the existing callers that still address a tournament
          // by `id` on this frame type). An id naming no tournament resolves to a null header
          // and empty rows, not an error.
          // Not under the 1/s query budget: a switcher click reads two boards back to back;
          // the per-socket frame-rate limit (S2) still bounds it.
          if (kind !== 'player') {
            send(ws, { type: 'error', code: 'not_available' });
            break;
          }
          const tournamentId = str(frame.id, 50) || null;
          send(ws, { type: 'leaderboard', ...(await buildLeaderboardPayload(tournamentId, 1, id, true)) });
          break;
        }
        case 'request_otp': {
          if (kind !== 'player') {
            send(ws, { type: 'error', code: 'not_available' });
            break;
          }
          const email = str(frame.email, 254).toLowerCase();
          if (!EMAIL_RE.test(email)) {
            send(ws, { type: 'error', code: 'invalid_email' });
            break;
          }
          // Ticket S18 decision 2: "OTP requests allowed but halved limits" in guarded and
          // locked - existing sockets keep playing but everyone's OTP budget narrows while
          // safe mode is not 'normal'.
          const otpFactor = safeMode.level() === 'normal' ? 1 : SAFE_MODE_OTP_FACTOR;
          const ipBudget = limits.checkOtpIp(ws.clientIp, otpFactor);
          if (!ipBudget.allowed) {
            send(ws, { type: 'error', code: 'rate_limited', retry_ms: ipBudget.retryMs });
            break;
          }
          const emailBudget = limits.checkOtpEmail(email, otpFactor);
          if (!emailBudget.allowed) {
            send(ws, { type: 'error', code: 'rate_limited', retry_ms: emailBudget.retryMs });
            break;
          }
          const code = await ledger.requestOtpCode(id, email);
          await otp.send(email, code);
          send(ws, { type: 'otp_sent' });
          break;
        }
        case 'verify_otp': {
          if (kind !== 'player') {
            send(ws, { type: 'error', code: 'not_available' });
            break;
          }
          const email = str(frame.email, 254).toLowerCase();
          const code = str(frame.code, 8);
          const { loggedIn } = await ledger.verifyOtpCode(id, email, code);
          if (loggedIn) {
            // Re-login (docs/layers.md C3a): the code proved ownership of an email that
            // already belongs to a different, verified player. Switch this socket's identity
            // there; the anonymous player it started as is left untouched - no merge, no delete.
            if (playerSockets.get(id) === ws) playerSockets.delete(id);
            ws.identity = loggedIn;
            playerSockets.set(loggedIn, ws);
            const [me, loggedInVersion] = await Promise.all([ledger.getMe(loggedIn), ledger.getTokenVersion(loggedIn)]);
            // get_me() already reports email_verified true here - that player's email was set
            // (and confirmed) before this code could have proved ownership of it.
            send(ws, { type: 'me', ...me, token: signToken(loggedIn, loggedInVersion ?? 1) });
          } else {
            // Email verified (ticket B6+B7+B9 decision 4): release the `email` task itself, and
            // the `signup` task if this is the first time this device has verified - both go
            // through release_task_reward, which is a no-op (not an error) once already granted
            // on this device or verified email, so calling it unconditionally here is safe.
            // Ticket B13: no-device players share a tight per-IP reward budget; skip the reward
            // release when that budget is exhausted, but still complete the verification.
            const rewardBudget = limits.checkRewardClaimIp(ws.clientIp, ws.hasDevice);
            let emailReward = null;
            let signupReward = null;
            if (rewardBudget.allowed) {
              emailReward = await ledger.releaseTaskReward(id, 'email', ws.clientIp).catch((err) => {
                console.error('[otp] email task release failed', err);
                return null;
              });
              if (emailReward?.reward != null) limits.recordRewardClaim(ws.clientIp, ws.hasDevice);
              signupReward = await ledger.releaseTaskReward(id, 'signup', ws.clientIp).catch((err) => {
                console.error('[otp] signup task release failed', err);
                return null;
              });
              if (signupReward?.reward != null) limits.recordRewardClaim(ws.clientIp, ws.hasDevice);
            } else {
              logRewardRefusal(ws, 'verify_otp', 'rate_limited');
            }
            const reward = (emailReward?.reward || 0) + (signupReward?.reward || 0);
            const me = await ledger.getMe(id);
            send(ws, { type: 'me', ...me, ...(reward ? { reward } : {}) });
          }
          break;
        }
        default:
          break; // unknown frame type: ignored, not an error
      }
    } catch (err) {
      // D9 (docs/reports/redteam.md): only a code the game contract owns ever reaches the
      // client - a raw Postgres SQLSTATE (or any other unmapped error) becomes `internal`, and
      // the original is logged here, tagged with the frame type that triggered it.
      const code = ledger.KNOWN_ERROR_CODES.includes(err.code) ? err.code : 'internal';
      if (code === 'internal') console.error(`[frame:${frame.type}] error`, err);
      // Ticket B13: log refused reward claims with the contract code and device id.
      if (['claim_task', 'free_refill', 'task_progress', 'task_return'].includes(frame.type)) {
        logRewardRefusal(ws, frame.type, code);
      }
      send(ws, { type: 'error', code, ...(err.retryMs != null ? { retry_ms: err.retryMs } : {}) });
      if (kind === 'kiosk' && err.code === 'insufficient_coins') {
        // open_kiosk_round marked the session broke when it refused the stake; the kiosk's
        // screen is driven by kiosk_session frames, so tell it (docs/layers.md C2).
        const session = await ledger.kioskSession(id).catch(() => null);
        if (session) send(ws, { type: 'kiosk_session', ...session });
      }
    }
  }

  let socketIdCounter = 0;

  wss.on('connection', (ws, req) => {
    ws.authed = false;
    ws.kind = null;
    ws.identity = null;
    ws.missedPongs = 0;
    ws.userAgent = str(req.headers['user-agent'], 200) || null;
    ws.socketId = ++socketIdCounter; // frame-rate/play/query budgets key on this, never on identity

    ws.on('pong', () => {
      ws.missedPongs = 0;
    });

    // An oversize frame trips maxPayload internally and emits 'error' before 'close' - with no
    // listener that is an unhandled EventEmitter error, which crashes the process. A frame this
    // socket sent is already being rejected by maxPayload/frame-rate/blocklist checks
    // elsewhere; there is nothing more to do here than stop it becoming a crash.
    ws.on('error', (err) => console.error(`[ws] socket error: ${err.message}`));

    ws.on('message', (data) => {
      // Every message counts against the per-socket flood budget, authed or not - D2/A19's
      // flood ran over an authed-but-idle socket, but an unauthed one can flood identically.
      if (!limits.checkFrameRate(ws.socketId)) {
        ws.close(CLOSE_RATE_LIMITED, 'rate_limited');
        return;
      }

      let frame;
      try {
        frame = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!frame || typeof frame.type !== 'string') return;

      if (!ws.authed) {
        if (frame.type !== 'auth') {
          send(ws, { type: 'error', code: 'unauthenticated' });
          return;
        }
        handleAuth(ws, frame).catch((err) => console.error('[ws] auth error', err));
        return;
      }
      handleFrame(ws, frame).catch((err) => console.error('[ws] frame error', err));
    });

    ws.on('close', () => {
      if (ws.kind === 'player' && playerSockets.get(ws.identity) === ws) {
        playerSockets.delete(ws.identity);
      }
      if (ws.kind === 'kiosk' && kioskSockets.get(ws.identity) === ws) kioskSockets.delete(ws.identity);
      limits.trackSocketClose(ws.clientIp);
      limits.forgetSocket(ws.socketId);
    });
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      ws.missedPongs = (ws.missedPongs || 0) + 1;
      if (ws.missedPongs > MAX_MISSED_PONGS) {
        ws.terminate();
        continue;
      }
      send(ws, { type: 'ping' });
      try {
        ws.ping();
      } catch {
        /* socket already closing */
      }
    }
  }, PING_INTERVAL_MS);
  heartbeat.unref();

  return {
    server,
    wss,
    feed,
    kioskIdleSweep,
    limits,
    alerts,
    safeMode,

    /**
     * Void leftover open rounds and listen. Resolves with the bound port.
     *
     * startFeed defaults to true (the real upstream OKX/Binance/Finnhub sockets come up with
     * the server, as production needs). Tests pass startFeed: false to get a feed that is
     * fully driven by feed._injectTick with no real network connection - createFeed() alone
     * never opens a socket, only feed.start() does.
     */
    async start(port = Number(process.env.PORT) || 8787, { startFeed = true } = {}) {
      await ledger.voidOpenRounds();
      // ticket C9 decision 1: KIOSK_STREAK_TARGET mirrors into public.settings only when the
      // env var is actually set, so a restart with nothing set never clobbers a value the
      // owner changed by hand with a running box's own SQL update.
      if (process.env.KIOSK_STREAK_TARGET) {
        await ledger.upsertSetting('kiosk_streak_target', String(Number(process.env.KIOSK_STREAK_TARGET) || 3));
      }
      if (startFeed) feed.start();
      limits.start();
      alerts.start();
      safeMode.start();
      kioskIdleSweep.start();
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, () => {
          server.off('error', reject);
          resolve();
        });
      });
      return server.address().port;
    },

    async close() {
      kioskIdleSweep.stop();
      clearTimeout(leaderboardTimer);
      clearInterval(heartbeat);
      safeMode.stop();
      alerts.stop();
      limits.stop();
      try {
        feed.stop();
      } catch (err) {
        // feed.js's stop() removeAllListeners()s an upstream socket (including its own
        // 'error' handler) before closing it; closing a socket still mid-handshake then
        // raises an unhandled 'error' with nobody listening. Not this ticket's file to fix
        // (server/feed.js is ticket 2's); swallow the symptom here so shutdown stays clean.
        console.warn('[server] feed.stop() raised during shutdown:', err.message);
      }
      for (const ws of wss.clients) ws.terminate();
      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    },
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const app = createApp();
  app.start().then(
    (port) => console.log(`[server] listening on ${port}`),
    (err) => {
      console.error('[server] failed to start', err);
      process.exit(1);
    },
  );
}

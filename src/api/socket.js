/**
 * The one WebSocket to the box game server (docs/box-plan.md 1.2, docs/box-spec.md 1.2).
 * Every module under src/api/ that talks to the server in box mode goes through this file;
 * game.js, kiosk.js and session.js are thin delegates over the functions exported here.
 *
 * The client never reports its own result: play() only ever resolves with the server's
 * round_opened ack. The verdict (round_settled) arrives later, pushed down this same socket
 * once the server's own 5-second timer fires and it has read the price itself - see
 * server/rounds.js. onSettled() is how useGame.js hears about it, for both web and kiosk.
 */

import { apiUrl } from './client.js';

const TOKEN_KEY = 'xchief.player_token';
// Device identity (ticket B5, docs/tickets/b5-device-identity.md decision 2): its own key,
// separate from the player token, and never cleared by signOut - a device outlives every
// player that has ever played from it.
const DEVICE_TOKEN_KEY = 'xchief.device_token';
// Open kiosk route (ticket K1): a self-provisioned booth identity, persisted on the device so
// reloads, crashes and reboots resume the same server-side session.
const KIOSK_STORAGE_KEY = 'xchief.kiosk';
const MIN_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 10000;
const QUIET_AFTER_MS = 3000; // no price/hello frame this long -> the feed is quiet
const QUIET_POLL_MS = 250;
const REQUEST_TIMEOUT_MS = 8000;
const HEALTH_PROBE_TIMEOUT_MS = 3000;

// 'auto' (also the default when the variable is unset) means same origin: behind Caddy the
// socket lives at /ws next to the page, so a production build never bakes in a host. An
// explicit ws:// or wss:// URL is for local dev only (.env; .env.production pins 'auto').
function resolveWsUrl() {
  const raw = (import.meta.env && import.meta.env.VITE_GAME_WS) || 'auto';
  if (raw !== 'auto') return raw;
  if (typeof window === 'undefined') return '';
  return `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws`;
}
const WS_URL = resolveWsUrl();

/** Maps the socket's own URL to that same origin's /health (ws:// -> http://, wss:// -> https://,
 * whatever path the socket uses -> /health, per server/index.js and the Caddyfile). Used by the
 * failed-open probe below so it asks the exact origin the socket is failing to reach, not the
 * page's own origin. Returns null rather than throwing on a malformed WS_URL (dev misconfig or
 * the unresolved '' from a window-less environment). Exported for the unit test only. */
export function deriveHealthUrl(wsUrl) {
  if (!wsUrl) return null;
  try {
    const u = new URL(wsUrl);
    u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
    u.pathname = '/health';
    u.search = '';
    u.hash = '';
    return u.href;
  } catch {
    return null;
  }
}

/** True when this tab is the self-provisioning open kiosk route (ticket K1). */
export function isKioskPath() {
  return typeof window !== 'undefined' && window.location.pathname === '/kiosk';
}

function readStoredKiosk() {
  try {
    const raw = localStorage.getItem(KIOSK_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function storeKiosk(kiosk) {
  try {
    localStorage.setItem(KIOSK_STORAGE_KEY, JSON.stringify(kiosk));
  } catch {
    /* storage unavailable: the secret is lost on reload, which is the same as a fresh device */
  }
}

let cachedKioskSecret = null;

/** Drops the stored open-kiosk secret (both the cache and localStorage). Used only when the
 * server has just told us that secret names a kiosk it no longer recognizes - the fix for the
 * booth-bricking bug: reconnecting with the same dead secret would fail the same way forever. */
function clearStoredKiosk() {
  cachedKioskSecret = null;
  try {
    localStorage.removeItem(KIOSK_STORAGE_KEY);
  } catch {
    /* storage unavailable: nothing was persisted to begin with */
  }
}

/** The kiosk's bearer secret: ?k= on a seeded launch URL, or the stored open-kiosk secret on
 * /kiosk. The open-kiosk secret is cached after provisioning so authFrame sees it on reconnect. */
export function getKioskSecret() {
  if (cachedKioskSecret) return cachedKioskSecret;
  if (isKioskPath()) {
    const stored = readStoredKiosk();
    if (stored?.secret) {
      cachedKioskSecret = stored.secret;
      return stored.secret;
    }
    return null;
  }
  return new URLSearchParams(window.location.search).get('k');
}

/** Open kiosk route (ticket K1): call the server's public provision endpoint, store the result,
 * and cache the secret so the pending socket auth can use it. */
export async function provisionKiosk() {
  const res = await fetch(apiUrl('/api/kiosk/provision'), { method: 'POST' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.error || 'provision_failed');
    err.code = body.error || 'provision_failed';
    err.status = res.status;
    throw err;
  }
  const kiosk = await res.json();
  const stored = {
    id: kiosk.id,
    secret: kiosk.secret,
    label: kiosk.label,
    provisioned_at: new Date().toISOString(),
  };
  storeKiosk(stored);
  cachedKioskSecret = kiosk.secret;
  return stored;
}

function readToken() {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function storeToken(token) {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* storage unavailable: the socket still works, just re-issues a fresh player next visit */
  }
}

function readDeviceToken() {
  try {
    return localStorage.getItem(DEVICE_TOKEN_KEY);
  } catch {
    return null;
  }
}

function storeDeviceToken(deviceToken) {
  try {
    localStorage.setItem(DEVICE_TOKEN_KEY, deviceToken);
  } catch {
    /* storage unavailable: the server just issues a fresh device next visit, same as the token */
  }
}

/** Sign out (docs/layers.md C3): drop the stored token so the next `auth` frame starts a fresh
 * anonymous player. Does not touch the live socket - the caller reloads the page right after,
 * which is what actually re-runs `auth` with nothing to send. */
export function clearToken() {
  token = null;
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable: nothing was persisted to begin with */
  }
}

function makeEmitter() {
  const subs = new Set();
  return {
    on(cb) {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    emit(...args) {
      for (const cb of subs) cb(...args);
    },
  };
}

const priceEmitter = makeEmitter();
const statusEmitter = makeEmitter();
const settledEmitter = makeEmitter();
const identityEmitter = makeEmitter();
const kioskSessionEmitter = makeEmitter();
const leaderboardEmitter = makeEmitter();

let ws = null;
let started = false;
let backoffMs = MIN_BACKOFF_MS;
let reconnectTimer = null;

let connected = false; // true once `welcome` lands, false again on close
// Ticket K3: the Instagram account the player must follow, taken from the server's `welcome`
// (INSTAGRAM_HANDLE). The client shows whatever the server provides here rather than a handle
// baked into the bundle; null until a welcome that carries one lands.
let instagramHandle = null;
let quiet = false;
let lastFrameQuiet = false; // the server's movement-based quiet flag from the last price frame
let lastTickAt = null;
let isKiosk = false;
let token = null;
// D7 (docs/reports/redteam.md): a kiosk whose secret the server rejected (revoked, empty,
// too short) - reconnect will keep retrying the same bad secret forever, so this stays true
// across every retry until a `welcome` actually lands. Only ever set from a `k=` launch URL;
// a web player never sees this. The open `/kiosk` route never sets this flag - see
// needsReprovision below, which self-heals instead of getting stuck here.
let kioskUnauthorized = false;
// Booth bug fix: the open `/kiosk` route's stored secret can outlive the kiosk row it names (a
// DB reset, a redeploy that resets the db, or a manual revoke). When the server rejects it with
// kiosk_unauthorized, the handler below clears the stored secret and sets this flag; the next
// scheduled reconnect (still governed by the normal backoff, so this never hammers the server)
// re-provisions a fresh kiosk before it tries to open a socket again, instead of looping forever
// on the same dead secret. Never set for the ?k= launch-URL route - that one is not
// self-provisioning and keeps surfacing kioskUnauthorized as before.
let needsReprovision = false;
// Ticket OD1: the WS upgrade path's own 429 (S2's per-IP connection window) refuses the TCP
// handshake before any WebSocket frame exists (server/index.js's `upgrade` handler writes the
// raw HTTP response itself), which is exactly the one failure mode the WebSocket spec hides
// from JS - onclose fires with no readable status, same as any other failed handshake. But a
// string of closes that never reached onopen is not on its own evidence of that: an
// unreachable origin (dead port, wss:// against a plain-HTTP box) fails every attempt the same
// way, including the first two. So failure alone only counts as "the failed-open signature";
// deciding it actually means a refused upgrade takes a positive check - see
// probeConnectionRefused below, which asks the same origin's /health over plain HTTP once the
// signature shows up. Reachable and OK -> something is there and specifically declining the
// upgrade, so this is a genuine refusal. Unreachable, TLS failure, timeout or non-OK -> nothing
// is there at all, and this stays false so the modal reads "Connection lost" instead of naming
// a rate limit that was never hit.
let consecutiveFailedOpens = 0;
let connectionRefused = false;

/** Runs once per transition into the failed-open signature (see the comment above
 * connectionRefused) - not on every retry after that, so it never adds load to the backoff
 * loop or a black-holed origin's retry cadence. AbortController bounds it to
 * HEALTH_PROBE_TIMEOUT_MS so a box that swallows the request silently still resolves to
 * "Connection lost" promptly rather than leaving the modal title stale. Never throws into the
 * caller - onclose has already scheduled the next reconnect by the time this settles. */
async function probeConnectionRefused() {
  const healthUrl = deriveHealthUrl(WS_URL);
  if (!healthUrl) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_PROBE_TIMEOUT_MS);
  let reachable = false;
  try {
    const res = await fetch(healthUrl, { signal: controller.signal });
    reachable = res.ok;
  } catch {
    reachable = false;
  } finally {
    clearTimeout(timer);
  }
  connectionRefused = reachable;
  notifyStatus();
}

const pending = []; // { kinds: Set<string>, frame, resolve, reject, timer }

function notifyStatus() {
  statusEmitter.emit(state());
}

export function state() {
  return { connected, quiet, lastTickAt, kioskUnauthorized, connectionRefused };
}

function evaluateQuiet() {
  const arrivalStale = connected && lastTickAt !== null && Date.now() - lastTickAt > QUIET_AFTER_MS;
  const next = arrivalStale || lastFrameQuiet;
  if (next !== quiet) {
    quiet = next;
    notifyStatus();
  }
}

/** Dev-only hook for tests (ticket 5): window.__xchief exposes the last frame and the token. */
function devSnapshot(frame) {
  if (!import.meta.env.DEV) return;
  const g = (window.__xchief = window.__xchief || {});
  g.mode = 'server';
  g.lastFrame = frame;
  // Price ticks overwrite lastFrame within milliseconds of a verdict; a test that waits for
  // the verdict polls this counter instead, which only round_settled ever moves.
  if (frame.type === 'round_settled') g.settledCount = (g.settledCount || 0) + 1;
  g.token = token;
  // Ticket C2: lets a test drive a scenario that is rare to hit for real (a kiosk streak-target
  // win) by feeding a synthetic frame through the exact same path a real server frame takes -
  // it is not a shortcut that skips any client logic, just a way to supply the input.
  g.inject = g.inject || handleMessage;
}

function send(frame) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
}

/** Queue a request whose response is one of `kinds`, or an `error` frame. `frame` (the request
 * actually sent) is kept on the entry so settlePending can tell a targeted reply apart from an
 * unsolicited push that happens to share the same frame type - see its own comment. */
function request(kinds, frame) {
  return new Promise((resolve, reject) => {
    const entry = { kinds: new Set(kinds), frame, resolve, reject };
    entry.timer = setTimeout(() => {
      const i = pending.indexOf(entry);
      if (i !== -1) pending.splice(i, 1);
      reject(Object.assign(new Error('timeout'), { code: 'timeout' }));
    }, REQUEST_TIMEOUT_MS);
    pending.push(entry);
    send(frame);
  });
}

/** Strips the `type` tag, matching the shape the old RPC-style callers returned. */
function payloadOf(frame) {
  const { type: _type, ...rest } = frame;
  return rest;
}

/**
 * Resolve the first pending request that accepts this frame's type (or any pending request,
 * for an `error` frame - it has no type of its own to match against). Frames are not
 * necessarily answered in send order (server work is concurrent per-connection), so this
 * matches by kind rather than assuming the head of the queue is always next; see socket.js's
 * module doc.
 *
 * `leaderboard` gets an extra check: its unsolicited live push (docs/layers.md C4) shares the
 * exact same frame type as the reply to this socket's own getLeaderboard() request, always
 * carrying page 1 of the currently running tournament. Without this, a push landing while a
 * page-2+ (infinite scroll) or a different-tournament request is still in flight would resolve
 * that request with the push's page-1 rows instead of its actual reply - the caller then
 * appends the wrong page, duplicating rows, and the real reply either resolves nothing (already
 * spliced out of `pending`) or - worse - lands on a later, unrelated request. Matching the
 * reply's `page`/`tournament` back against what was actually sent closes that race; a push
 * whose page happens to be the same one currently requested is genuinely interchangeable with
 * that request's own reply, so this only ever narrows, never breaks, the ordinary case.
 */
function settlePending(frame) {
  const isError = frame.type === 'error';
  const idx = pending.findIndex((entry) => {
    if (isError) return true;
    if (!entry.kinds.has(frame.type)) return false;
    if (frame.type !== 'leaderboard') return true;
    // A request that named no tournament asked for "whichever is running", so any tournament in
    // the reply answers it - only compare when the request actually pinned one down. Comparing a
    // null request against the server's resolved id would never match, and the reply (the only
    // frame carrying `legend` and `me`) would time out instead of settling.
    const sentTournament = entry.frame.tournament ?? null;
    const replyTournament = frame.tournament?.id ?? null;
    const tournamentMatches = sentTournament === null || replyTournament === sentTournament;
    return frame.page === entry.frame.page && tournamentMatches;
  });
  if (idx === -1) return false;
  const [entry] = pending.splice(idx, 1);
  clearTimeout(entry.timer);
  if (isError)
    entry.reject(
      Object.assign(new Error(frame.code || 'error'), {
        code: frame.code || 'error',
        ...(frame.retry_ms != null ? { retryMs: frame.retry_ms } : {}),
      }),
    );
  else entry.resolve(frame);
  return true;
}

function handleWelcome(frame) {
  connected = true;
  kioskUnauthorized = false;
  isKiosk = Boolean(frame.kiosk);
  if (!isKiosk && frame.token) {
    token = frame.token;
    storeToken(token);
  }
  // Device identity (ticket B5): the server never sends this on a kiosk welcome - kiosks are
  // out of scope for device identity entirely - so isKiosk alone decides whether to store it.
  if (!isKiosk && frame.device) {
    storeDeviceToken(frame.device);
  }
  // Ticket K3: remember the account to follow so the tasks UI can render it (see getInstagramHandle).
  if (frame.our_handle) instagramHandle = frame.our_handle;
  notifyStatus();
}

/** Ticket K3: the Instagram handle the server told this client to follow, or null before a
 * welcome carrying one has landed. */
export function getInstagramHandle() {
  return instagramHandle;
}

/**
 * A `me` frame only ever carries a token for the re-login case (docs/layers.md C3a,
 * server/index.js's verify_otp handler): the code proved ownership of an email that already
 * belongs to a different, verified player, so the server switched this socket's identity and
 * sent a token for that player instead of the one welcome issued. Every other `me` reply
 * (get_me, claim_task, free_refill, an ordinary first-time verify_otp) has no token field and
 * changes nothing here - the socket is still the same player it always was.
 */
function handleMe(frame) {
  if (!frame.token) return;
  token = frame.token;
  storeToken(token);
  identityEmitter.emit(payloadOf(frame));
}

function handleTick(frame) {
  lastTickAt = Date.now();
  // The server decides "quiet" by price movement (server/feed.js): when the real quote is stale it
  // synthesizes gentle movement and flags the tick quiet:true. Honor that flag; the arrival-based
  // heuristic below only still covers a feed that goes fully silent (no frames at all).
  if (typeof frame.quiet === 'boolean') lastFrameQuiet = frame.quiet;
  evaluateQuiet();
  priceEmitter.emit(frame.price, { t: frame.t });
}

function handleMessage(frame) {
  devSnapshot(frame);
  switch (frame.type) {
    case 'welcome':
      handleWelcome(frame);
      break;
    case 'hello':
    case 'price':
      if (typeof frame.price === 'number') handleTick(frame);
      break;
    case 'round_settled':
      settledEmitter.emit(payloadOf(frame));
      break;
    case 'me':
      handleMe(frame);
      settlePending(frame);
      break;
    case 'kiosk_session':
      // Pushed after auth, after every settled kiosk round, after kiosk_reset, and by the
      // server's own 60 s idle sweep (server/kiosk.js) - the one source of truth for which
      // screen a kiosk should be showing (docs/layers.md C2).
      kioskSessionEmitter.emit(payloadOf(frame));
      break;
    case 'tasks':
      // A reply to this socket's own `tasks` request only - nothing pushes this unsolicited
      // (docs/layers.md C5), unlike `leaderboard` below.
      settlePending(frame);
      break;
    case 'leaderboard':
      // Both a reply to this socket's own `leaderboard` request (getLeaderboard()) and an
      // unsolicited push after a settle (docs/layers.md C4, ticket B2) arrive as this same
      // frame shape: `rows` (this page of that tournament's board), `tournament` (its header,
      // ticket B1), `tournaments` (the full switcher list), `page`/`pages`/`total` (the pager)
      // and `me` (this player's own row, ticket B2 decision 1). settlePending() is a no-op when
      // nothing is waiting on it.
      leaderboardEmitter.emit(payloadOf(frame));
      settlePending(frame);
      break;
    case 'ping':
      // ws-level pongs answer the server's heartbeat automatically; nothing to send back.
      break;
    case 'error':
      // D7: the server fails a rejected kiosk secret closed with kiosk_unauthorized, then closes
      // the socket (4401) - onclose schedules a reconnect that will just fail the same way, so
      // this flag (not the ordinary `reconnecting` status, which never lands without a prior
      // `welcome`) is what tells the kiosk shell to show its own error state.
      if (frame.code === 'kiosk_unauthorized' && getKioskSecret() !== null) {
        if (isKioskPath()) {
          clearStoredKiosk();
          needsReprovision = true;
        } else {
          kioskUnauthorized = true;
          notifyStatus();
        }
      }
      settlePending(frame);
      break;
    default:
      settlePending(frame);
      break;
  }
}

function authFrame() {
  // D7 (docs/reports/redteam.md): presence, not truthiness - an empty `?k=` still authenticates
  // as a kiosk (and fails closed there) rather than silently falling through to a web player.
  const kioskSecret = getKioskSecret();
  if (kioskSecret !== null) return { type: 'auth', kiosk: kioskSecret };
  const frame = { type: 'auth' };
  const storedToken = readToken();
  if (storedToken) frame.token = storedToken;
  const storedDevice = readDeviceToken();
  if (storedDevice) frame.device = storedDevice;
  return frame;
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(attemptReconnect, backoffMs);
  backoffMs = Math.min(MAX_BACKOFF_MS, backoffMs * 2);
}

/** The reconnect the retry timer actually runs. Ordinary case: just open() again, same as
 * always. When the previous attempt was rejected as kiosk_unauthorized on the open `/kiosk`
 * route, needsReprovision is set - re-provision a fresh kiosk first, so the socket that opens
 * next authenticates with a secret the server has actually heard of. If provisioning itself
 * fails (offline, switched off, capped), stay flagged and let the next scheduled attempt (still
 * on the same backoff, so this never turns into a tight loop) try again. */
async function attemptReconnect() {
  if (needsReprovision) {
    try {
      await provisionKiosk();
      needsReprovision = false;
    } catch {
      scheduleReconnect();
      return;
    }
  }
  open();
}

function rejectAllPending(code) {
  while (pending.length) {
    const entry = pending.shift();
    clearTimeout(entry.timer);
    entry.reject(Object.assign(new Error(code), { code }));
  }
}

function open() {
  if (!WS_URL) return;
  let openedThisAttempt = false;
  ws = new WebSocket(WS_URL);
  ws.onopen = () => {
    openedThisAttempt = true;
    backoffMs = MIN_BACKOFF_MS;
    consecutiveFailedOpens = 0;
    connectionRefused = false;
    send(authFrame());
  };
  ws.onmessage = (ev) => {
    let frame;
    try {
      frame = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (!frame || typeof frame.type !== 'string') return;
    handleMessage(frame);
  };
  ws.onclose = () => {
    connected = false;
    quiet = false;
    if (!openedThisAttempt) {
      consecutiveFailedOpens += 1;
      if (consecutiveFailedOpens === 2) probeConnectionRefused();
    }
    notifyStatus();
    rejectAllPending('disconnected');
    scheduleReconnect();
  };
  ws.onerror = () => {
    /* onclose always follows; nothing else to do here */
  };
}

/** Opens the socket if it is not already open/connecting. Safe to call more than once. */
export async function connect() {
  if (started) return;
  started = true;
  if (isKioskPath() && !getKioskSecret()) {
    try {
      await provisionKiosk();
    } catch {
      // Switch off (404) or cap/rate-limit: show the existing not-configured state rather than
      // retrying forever with no secret. A reload is the only recovery.
      kioskUnauthorized = true;
      notifyStatus();
      return;
    }
  }
  setInterval(evaluateQuiet, QUIET_POLL_MS).unref?.();
  open();
}

export function onPrice(cb) {
  return priceEmitter.on(cb);
}

export function onStatus(cb) {
  return statusEmitter.on(cb);
}

export function onSettled(cb) {
  return settledEmitter.on(cb);
}

/** Fires with the fresh `me` row when verify_otp switches this socket to a different, existing
 * player (docs/layers.md C3a) - never on an ordinary get_me/claim_task/free_refill reply. */
export function onIdentityChange(cb) {
  return identityEmitter.on(cb);
}

export function onKioskSession(cb) {
  return kioskSessionEmitter.on(cb);
}

/** Ends the current visitor's session (Claim/Done, or the client's own abandon flush). The
 * server clears coins/streak and the reply is a kiosk_session frame with state 'idle', caught
 * by onKioskSession like any other - this never asserts the new state itself. */
export function kioskReset() {
  send({ type: 'kiosk_reset' });
}

/** Fires with `{rows, tournament, tournaments, page, pages, total, me, legend?}` every time the
 * server pushes a `leaderboard` frame - on request (getLeaderboard's own reply also lands here)
 * and, unsolicited, after a settle (docs/layers.md C4, ticket B2). `legend` is only ever present
 * on a request reply, never on the unsolicited push (ticket B3 decision 3). Never fires for a
 * kiosk socket: the server never sends it one. */
export function onLeaderboard(cb) {
  return leaderboardEmitter.on(cb);
}

/** Resolves with round_opened; rejects with an Error whose .code is the server's error code. */
export function play(dir, lever) {
  return request(['round_opened'], { type: 'play', dir, lever }).then(payloadOf);
}

export function getMe() {
  return request(['me'], { type: 'get_me' }).then(payloadOf);
}

export function claimTask(id) {
  return request(['me'], { type: 'claim_task', task_id: id }).then(payloadOf);
}

export function freeRefill() {
  return request(['me'], { type: 'free_refill' }).then(payloadOf);
}

/** Task definitions plus this player's own claimed state (docs/layers.md C5), computed
 * server-side by public.get_tasks() - the tasks screen renders from this, never from a local
 * reward table. */
export function getTasks() {
  return request(['tasks'], { type: 'tasks' }).then((frame) => frame.rows);
}

/** One page of one tournament's board (ticket B2): `tournament` null/omitted means whichever
 * tournament is currently running, `page` defaults to 1. Same call reads back a past or
 * upcoming tournament's own board by passing its id. */
export function getLeaderboard({ tournament = null, page = 1 } = {}) {
  return request(['leaderboard'], { type: 'leaderboard', tournament, page }).then(payloadOf);
}

/** Video watch progress (ticket B6+B7+B9): resolves with the usual `me`, carrying `reward` only
 * on the call that crosses 90% - the server released it itself, never this claim. */
export function reportTaskProgress(task, seconds, duration) {
  return request(['me'], { type: 'task_progress', task, seconds, duration }).then(payloadOf);
}

/** Redirect and return, opening step: resolves with `{task, window_ms}`. */
export function startTaskVisit(task) {
  return request(['task_started'], { type: 'task_start', task }).then(payloadOf);
}

/** Redirect and return, return step: resolves with the usual `me` plus `reward`; rejects with
 * `not_yet` (carrying `.retry_ms`) or `already_claimed`. */
export function returnTaskVisit(task) {
  return request(['me'], { type: 'task_return', task }).then(payloadOf);
}

export function requestOtp(email) {
  return request(['otp_sent'], { type: 'request_otp', email }).then(payloadOf);
}

export function verifyOtp(email, code) {
  return request(['me'], { type: 'verify_otp', email, code }).then(payloadOf);
}

/** Instagram follow reward, step 1 (ticket K3): stores the handle server-side and resolves with
 * {handle, profile_url, app_url}, or {status:'not_configured'} while the token is missing. The
 * client opens those URLs; it never claims the follow itself. */
export function instagramStart(handle) {
  return request(['instagram_started'], { type: 'instagram_start', handle }).then(payloadOf);
}

/** Instagram follow reward, step 2 (ticket K3): asks the server to read BoxAPI and decide.
 * The server treats every check the same way regardless of what triggered it on the client -
 * there is no client-asserted "this one was automatic". Resolves with {ok, reason?, reward?, me?}
 * - the server released the reward, never this call. */
export function instagramCheck() {
  return request(['instagram_result'], { type: 'instagram_check' }).then(payloadOf);
}

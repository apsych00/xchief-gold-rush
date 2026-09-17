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

const TOKEN_KEY = 'xchief.player_token';
// Device identity (ticket B5, docs/tickets/b5-device-identity.md decision 2): its own key,
// separate from the player token, and never cleared by signOut - a device outlives every
// player that has ever played from it.
const DEVICE_TOKEN_KEY = 'xchief.device_token';
const MIN_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 10000;
const QUIET_AFTER_MS = 3000; // no price/hello frame this long -> the feed is quiet
const QUIET_POLL_MS = 250;
const REQUEST_TIMEOUT_MS = 8000;

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

/** The kiosk's launch URL bakes its bearer secret into ?k=; read fresh, the URL never changes mid-session. */
export function getKioskSecret() {
  return new URLSearchParams(window.location.search).get('k');
}

function readToken() {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function getStoredToken() {
  return readToken();
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
let quiet = false;
let lastTickAt = null;
let isKiosk = false;
let token = null;
// D7 (docs/reports/redteam.md): a kiosk whose secret the server rejected (revoked, empty,
// too short) - reconnect will keep retrying the same bad secret forever, so this stays true
// across every retry until a `welcome` actually lands. Only ever set from a `k=` launch URL;
// a web player never sees this.
let kioskUnauthorized = false;

const pending = []; // { kinds: Set<string>, resolve, reject, timer }

function notifyStatus() {
  statusEmitter.emit(state());
}

export function state() {
  return { connected, quiet, lastTickAt, kioskUnauthorized };
}

function evaluateQuiet() {
  const next = connected && lastTickAt !== null && Date.now() - lastTickAt > QUIET_AFTER_MS;
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
  // Ticket C2: lets a test drive a scenario that is rare to hit for real (a kiosk five-win
  // streak) by feeding a synthetic frame through the exact same path a real server frame takes -
  // it is not a shortcut that skips any client logic, just a way to supply the input.
  g.inject = g.inject || handleMessage;
}

function send(frame) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
}

/** Queue a request whose response is one of `kinds`, or an `error` frame. */
function request(kinds, frame) {
  return new Promise((resolve, reject) => {
    const entry = { kinds: new Set(kinds), resolve, reject };
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
 */
function settlePending(frame) {
  const isError = frame.type === 'error';
  const idx = pending.findIndex((entry) => isError || entry.kinds.has(frame.type));
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
  notifyStatus();
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
        kioskUnauthorized = true;
        notifyStatus();
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
  reconnectTimer = setTimeout(open, backoffMs);
  backoffMs = Math.min(MAX_BACKOFF_MS, backoffMs * 2);
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
  ws = new WebSocket(WS_URL);
  ws.onopen = () => {
    backoffMs = MIN_BACKOFF_MS;
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
    notifyStatus();
    rejectAllPending('disconnected');
    scheduleReconnect();
  };
  ws.onerror = () => {
    /* onclose always follows; nothing else to do here */
  };
}

/** Opens the socket if it is not already open/connecting. Safe to call more than once. */
export function connect() {
  if (started) return;
  started = true;
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

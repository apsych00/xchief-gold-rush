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
const MIN_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 10000;
const QUIET_AFTER_MS = 3000; // no price/hello frame this long -> the feed is quiet
const QUIET_POLL_MS = 250;
const REQUEST_TIMEOUT_MS = 8000;

// 'auto' means same origin: behind Caddy the socket lives at /ws next to the page, so a
// production build never bakes in a host. An explicit ws:// or wss:// URL is for local dev.
function resolveWsUrl() {
  const raw = (import.meta.env && import.meta.env.VITE_GAME_WS) || '';
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

function storeToken(token) {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* storage unavailable: the socket still works, just re-issues a fresh player next visit */
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

let ws = null;
let started = false;
let backoffMs = MIN_BACKOFF_MS;
let reconnectTimer = null;

let connected = false; // true once `welcome` lands, false again on close
let quiet = false;
let lastTickAt = null;
let isKiosk = false;
let token = null;

const pending = []; // { kinds: Set<string>, resolve, reject, timer }

function notifyStatus() {
  statusEmitter.emit(state());
}

export function state() {
  return { connected, quiet, lastTickAt };
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
  if (isError) entry.reject(Object.assign(new Error(frame.code || 'error'), { code: frame.code || 'error' }));
  else entry.resolve(frame);
  return true;
}

function handleWelcome(frame) {
  connected = true;
  isKiosk = Boolean(frame.kiosk);
  if (!isKiosk && frame.token) {
    token = frame.token;
    storeToken(token);
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
    case 'ping':
      // ws-level pongs answer the server's heartbeat automatically; nothing to send back.
      break;
    default:
      settlePending(frame);
      break;
  }
}

function authFrame() {
  const kioskSecret = getKioskSecret();
  if (kioskSecret) return { type: 'auth', kiosk: kioskSecret };
  const stored = readToken();
  return stored ? { type: 'auth', token: stored } : { type: 'auth' };
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

export function getLeaderboard() {
  return request(['leaderboard'], { type: 'leaderboard' }).then((frame) => frame.rows);
}

export function requestOtp(email) {
  return request(['otp_sent'], { type: 'request_otp', email }).then(payloadOf);
}

export function verifyOtp(email, code) {
  return request(['me'], { type: 'verify_otp', email, code }).then(payloadOf);
}

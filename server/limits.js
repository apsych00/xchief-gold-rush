/**
 * Per-socket and per-IP rate limits for the box game server (ticket S2, docs/box-architecture.md
 * 5b, docs/reports/redteam.md D3/D4/D10). Everything here lives in memory - sliding windows and
 * gauges keyed by IP or by a per-socket id - and is cleaned every SWEEP_INTERVAL_MS so a long
 * campaign never grows these maps without bound. Nothing here touches Postgres: the SQL 400
 * rounds/hour rule (db/schema.sql open_round) and the SQL 3-codes-per-email/10min rule
 * (request_otp_code) stay exactly where they are and are not duplicated here.
 *
 * Every constant is overridable by an env var of the same name, read once at import time -
 * production sets nothing and gets the defaults below; tests set what they need before
 * importing this module (or server/index.js, which imports it).
 */

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === '1' || raw.toLowerCase() === 'true';
}

const MINUTE = 60 * 1000;

export const LIMITS = {
  TRUST_PROXY: envBool('TRUST_PROXY', true),

  MAX_SOCKETS_PER_IP: envInt('MAX_SOCKETS_PER_IP', 20),
  MAX_CONNECTIONS_PER_IP_PER_MIN: envInt('MAX_CONNECTIONS_PER_IP_PER_MIN', 30),
  MAX_ANON_PLAYERS_PER_IP_PER_10MIN: envInt('MAX_ANON_PLAYERS_PER_IP_PER_10MIN', 10),
  // Ticket OD1: raised from 5 to a venue-safe 30. The owner's local-stack repro traced the
  // literal 429 the browser console showed to this exact window on the WS upgrade path (S2's
  // checkNewConnection), not to the OTP frames themselves - a shared venue IP (docs/TRACKER.md:
  // "production numbers under review with the owner (venue NAT)") burns through this budget
  // across every visitor behind it, and a fresh code request is exactly the kind of retry a
  // frustrated single visitor also does. 30 per 10 minutes per IP is generous enough for a booth
  // sharing one public address without opening the door to a real flood (MAX_CONNECTIONS_PER_IP_
  // PER_MIN above still caps how fast any one IP can even reach this window).
  MAX_OTP_REQUESTS_PER_IP_PER_10MIN: envInt('MAX_OTP_REQUESTS_PER_IP_PER_10MIN', 30),
  // The ticket names this "already exists in SQL: keep it" - db/schema.sql's
  // request_otp_code has no such check (grepped; nothing per-email anywhere in the schema).
  // Implemented here instead, in memory, alongside the IP one; see the ticket report. Raised
  // from 3 to 5 (ticket OD1) alongside the IP window above - a legitimate resend after a typo
  // plus one more attempt at the same email should never itself become the reason a visitor
  // is refused.
  MAX_OTP_REQUESTS_PER_EMAIL_PER_10MIN: envInt('MAX_OTP_REQUESTS_PER_EMAIL_PER_10MIN', 5),
  // POST /api/claim/* (ticket C9 decision 4): 5 per 10 minutes per IP, the same shape as the
  // OTP-per-IP window above - a claim page has no session of its own to rate-limit by socket.
  MAX_CLAIM_REQUESTS_PER_IP_PER_10MIN: envInt('MAX_CLAIM_REQUESTS_PER_IP_PER_10MIN', 5),
  // Ticket B13: a player whose own row has never carried a device_id - a client from before
  // device identity existed, or one that has lost its stored device token - can only release
  // rewards a few times per IP per hour. A fresh browser's own first claim does not count: the
  // server mints and binds a device to that socket during the very same auth (server/index.js's
  // ws.hasDevice). This is a soft front-line rate limit; the per-player unique index on
  // task_claims and the per-device partial index are the hard backstop.
  MAX_REWARD_CLAIMS_PER_IP_PER_HOUR_NO_DEVICE: envInt('MAX_REWARD_CLAIMS_PER_IP_PER_HOUR_NO_DEVICE', 3),

  MAX_FRAMES_PER_SOCKET_PER_MIN: envInt('MAX_FRAMES_PER_SOCKET_PER_MIN', 200),
  MAX_FRAME_BYTES: envInt('MAX_FRAME_BYTES', 4 * 1024),
  MAX_HTTP_BODY_BYTES: envInt('MAX_HTTP_BODY_BYTES', 4 * 1024),

  PLAY_MIN_INTERVAL_MS: envInt('PLAY_MIN_INTERVAL_MS', 4000),
  QUERY_MIN_INTERVAL_MS: envInt('QUERY_MIN_INTERVAL_MS', 1000), // leaderboard / tasks / get_me / task_progress / task_start / task_return

  BLOCK_TRIP_COUNT: envInt('BLOCK_TRIP_COUNT', 5),
  BLOCK_TRIP_WINDOW_MS: envInt('BLOCK_TRIP_WINDOW_MS', 10 * MINUTE),
  BLOCK_DURATION_MS: envInt('BLOCK_DURATION_MS', 15 * MINUTE),

  SWEEP_INTERVAL_MS: envInt('SWEEP_INTERVAL_MS', MINUTE),
  REFUSAL_LOG_INTERVAL_MS: envInt('REFUSAL_LOG_INTERVAL_MS', MINUTE),
};

/** A key -> timestamps[] sliding window. `now` is passed in on every call so tests can drive
 * an injected clock instead of the real one. */
class SlidingWindow {
  constructor(windowMs) {
    this.windowMs = windowMs;
    this.hits = new Map();
  }

  /** Drop expired timestamps for `key`, add `now`, return the resulting count in the window. */
  record(key, now) {
    let arr = this.hits.get(key);
    if (!arr) {
      arr = [];
      this.hits.set(key, arr);
    }
    const cutoff = now - this.windowMs;
    while (arr.length && arr[0] < cutoff) arr.shift();
    arr.push(now);
    return arr.length;
  }

  /** Count in the window without recording a new hit. */
  count(key, now) {
    const arr = this.hits.get(key);
    if (!arr) return 0;
    const cutoff = now - this.windowMs;
    while (arr.length && arr[0] < cutoff) arr.shift();
    return arr.length;
  }

  /** ms until the oldest hit in the window falls out of it - the natural retry_ms for a refusal. */
  retryMs(key, now) {
    const arr = this.hits.get(key);
    if (!arr || !arr.length) return 0;
    return Math.max(0, arr[0] + this.windowMs - now);
  }

  /** Drop expired entries everywhere and forget keys left with nothing in the window. */
  sweep(now) {
    const cutoff = now - this.windowMs;
    for (const [key, arr] of this.hits) {
      while (arr.length && arr[0] < cutoff) arr.shift();
      if (arr.length === 0) this.hits.delete(key);
    }
  }

  get size() {
    return this.hits.size;
  }
}

/** A key -> last-hit-timestamp tracker for a plain "at most one every intervalMs" rule (play
 * cadence, leaderboard/tasks/get_me query cadence). Unlike SlidingWindow this only ever needs
 * the single most recent hit, not a whole array. */
class MinInterval {
  constructor(intervalMs) {
    this.intervalMs = intervalMs;
    this.lastAt = new Map();
  }

  /** Record a hit for `key` at `now`. Returns null when allowed, or the ms to wait when too
   * soon - and does NOT update lastAt on a refusal, so a burst of refused attempts cannot push
   * the real retry time out further than the one genuine hit already set. */
  check(key, now) {
    const last = this.lastAt.get(key);
    if (last !== undefined && now - last < this.intervalMs) {
      return this.intervalMs - (now - last);
    }
    this.lastAt.set(key, now);
    return null;
  }

  forget(key) {
    this.lastAt.delete(key);
  }

  sweep(now) {
    for (const [key, at] of this.lastAt) {
      if (now - at > this.intervalMs) this.lastAt.delete(key);
    }
  }
}

/** `CF-Connecting-IP`, else the first hop of `X-Forwarded-For`, else the raw socket address -
 * the proxy headers are trusted only when TRUST_PROXY is on (Caddy/Cloudflare terminate the
 * connection in production; in a test or a direct connection there is no proxy to trust). */
export function clientIp(req, trustProxy = LIMITS.TRUST_PROXY) {
  if (trustProxy) {
    const cf = req.headers['cf-connecting-ip'];
    if (cf) return String(cf).trim();
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

/**
 * @param {object} [deps]
 * @param {() => number} [deps.now]
 * @param {(line: string) => void} [deps.log]
 */
export function createLimits({ now = Date.now, log = console.log } = {}) {
  const openSocketsByIp = new Map(); // ip -> count of currently open sockets
  const connectWindow = new SlidingWindow(MINUTE); // shared by ws upgrades and /api/* requests
  // Ticket S18 (safe mode): the same two signals as above, but system-wide instead of per-IP -
  // a rotating-IP flood never trips any one IP's own window, so the automatic escalation state
  // machine (server/safemode.js) needs the aggregate instead. globalConnectWindow is fed by
  // every accepted socket (trackSocketOpen), globalAnonAttemptWindow by every web auth attempt
  // that would create a new anonymous player (server/index.js calls trackAnonAttempt directly,
  // before any safe-mode gate, so a refusal never hides the attempt from this signal).
  const globalConnectWindow = new SlidingWindow(MINUTE);
  const globalAnonAttemptWindow = new SlidingWindow(10 * MINUTE);
  const anonPlayerWindow = new SlidingWindow(10 * MINUTE);
  const otpIpWindow = new SlidingWindow(10 * MINUTE);
  const otpEmailWindow = new SlidingWindow(10 * MINUTE);
  const claimIpWindow = new SlidingWindow(10 * MINUTE);
  // Ticket B13: reward claims (task, refill, video, redirect, email/signup) from players
  // that have no device token - old clients, or players created before device identity
  // existed. One sliding window per IP; players with a device_id are exempt.
  const rewardClaimIpWindow = new SlidingWindow(60 * MINUTE);
  const frameWindow = new SlidingWindow(MINUTE); // keyed by a per-socket id, not by IP
  const playInterval = new MinInterval(LIMITS.PLAY_MIN_INTERVAL_MS); // keyed by socket id
  const queryInterval = new MinInterval(LIMITS.QUERY_MIN_INTERVAL_MS); // keyed by `${socketId}:${type}`
  const tripWindow = new SlidingWindow(LIMITS.BLOCK_TRIP_WINDOW_MS); // keyed by ip
  const blocklist = new Map(); // ip -> unblockAt
  const refusalWindow = new SlidingWindow(MINUTE); // keyed by 'all', for /status.refusals_1m
  const lastRefusalLogAt = new Map(); // ip -> timestamp, so a hammering ip logs at most once/min

  function isBlocked(ip) {
    const until = blocklist.get(ip);
    if (until === undefined) return false;
    if (until <= now()) {
      blocklist.delete(ip);
      return false;
    }
    return true;
  }

  function recordRefusal(ip, reason) {
    refusalWindow.record('all', now());
    const t = now();
    const last = lastRefusalLogAt.get(ip);
    if (last === undefined || t - last >= LIMITS.REFUSAL_LOG_INTERVAL_MS) {
      lastRefusalLogAt.set(ip, t);
      log(`[limits] refused ${ip}: ${reason}`);
    }
  }

  /** An IP that keeps tripping the connection-rate limit gets shut out entirely for a while
   * (ticket S2 decision 5): five trips inside BLOCK_TRIP_WINDOW_MS blocks new connections from
   * that IP for BLOCK_DURATION_MS. */
  function recordTrip(ip) {
    const t = now();
    const count = tripWindow.record(ip, t);
    if (count >= LIMITS.BLOCK_TRIP_COUNT && !isBlocked(ip)) {
      blocklist.set(ip, t + LIMITS.BLOCK_DURATION_MS);
      log(`[limits] blocking ${ip} for ${Math.round(LIMITS.BLOCK_DURATION_MS / 1000)}s: tripped the connection limit ${count} times`);
    }
  }

  /**
   * Called before a ws upgrade completes, and before an /api/* request is handled. Returns
   * null when the connection is allowed, or a reason string when it must be refused.
   */
  function checkNewConnection(ip) {
    const t = now();
    if (isBlocked(ip)) {
      recordRefusal(ip, 'blocked');
      return 'blocked';
    }
    const openSockets = openSocketsByIp.get(ip) || 0;
    if (openSockets >= LIMITS.MAX_SOCKETS_PER_IP) {
      recordRefusal(ip, 'too many open sockets');
      recordTrip(ip);
      return 'too_many_sockets';
    }
    const perMinute = connectWindow.record(ip, t);
    if (perMinute > LIMITS.MAX_CONNECTIONS_PER_IP_PER_MIN) {
      recordRefusal(ip, 'too many connections per minute');
      recordTrip(ip);
      return 'too_many_connections';
    }
    return null;
  }

  /** Called before an /api/* HTTP request is handled (ticket S2 decision 7b: "the same per-IP
   * connection window as sockets"). Shares connectWindow and the block list with
   * checkNewConnection, but never touches openSocketsByIp - an HTTP request has no persistent
   * socket to count. */
  function checkApiRequest(ip) {
    const t = now();
    if (isBlocked(ip)) {
      recordRefusal(ip, 'blocked');
      return 'blocked';
    }
    const perMinute = connectWindow.record(ip, t);
    if (perMinute > LIMITS.MAX_CONNECTIONS_PER_IP_PER_MIN) {
      recordRefusal(ip, 'too many connections per minute');
      recordTrip(ip);
      return 'too_many_connections';
    }
    return null;
  }

  function trackSocketOpen(ip) {
    openSocketsByIp.set(ip, (openSocketsByIp.get(ip) || 0) + 1);
    globalConnectWindow.record('all', now());
  }

  /** Ticket S18: called once per web auth attempt that would create a new anonymous player -
   * before any per-IP budget or safe-mode gate, so a refusal never hides the attempt from the
   * escalation signal. Kiosk auth attempts never call this: they are not "anonymous players"
   * for the purpose of this signal (a fixed, small number of booths, unaffected by safe mode). */
  function trackAnonAttempt() {
    globalAnonAttemptWindow.record('all', now());
  }

  function trackSocketClose(ip) {
    const n = (openSocketsByIp.get(ip) || 0) - 1;
    if (n <= 0) openSocketsByIp.delete(ip);
    else openSocketsByIp.set(ip, n);
  }

  /** Anonymous players (`auth` without a valid token) and kiosk auth attempts share this
   * window (ticket S2 decisions 2 and 7c): both are ways to mint or guess an identity, and
   * both need throttling per IP. */
  function checkAnonAuth(ip) {
    const t = now();
    const count = anonPlayerWindow.record(ip, t);
    if (count > LIMITS.MAX_ANON_PLAYERS_PER_IP_PER_10MIN) {
      recordRefusal(ip, 'too many anonymous auths');
      return { allowed: false, retryMs: anonPlayerWindow.retryMs(ip, t) };
    }
    return { allowed: true };
  }

  /** `factor` (ticket S18 decision 2: guarded/locked "OTP requests allowed but halved limits")
   * scales the configured max down; server/index.js passes 0.5 whenever safe mode is not
   * 'normal', 1 otherwise. Floored, and never below 1 - safe mode narrows the budget, it never
   * closes it entirely. */
  function checkOtpIp(ip, factor = 1) {
    const t = now();
    const count = otpIpWindow.record(ip, t);
    const max = Math.max(1, Math.floor(LIMITS.MAX_OTP_REQUESTS_PER_IP_PER_10MIN * factor));
    if (count > max) {
      recordRefusal(ip, 'too many otp requests');
      return { allowed: false, retryMs: otpIpWindow.retryMs(ip, t) };
    }
    return { allowed: true };
  }

  /** Per-email OTP request budget (ticket S2 decision 2). Not backed by SQL - see the
   * MAX_OTP_REQUESTS_PER_EMAIL_PER_10MIN comment in LIMITS above. `factor`: see checkOtpIp. */
  function checkOtpEmail(email, factor = 1) {
    const t = now();
    const count = otpEmailWindow.record(email, t);
    const max = Math.max(1, Math.floor(LIMITS.MAX_OTP_REQUESTS_PER_EMAIL_PER_10MIN * factor));
    if (count > max) {
      return { allowed: false, retryMs: otpEmailWindow.retryMs(email, t) };
    }
    return { allowed: true };
  }

  /** POST /api/claim/* budget (ticket C9 decision 4): 5 per 10 minutes per IP. */
  function checkClaimIp(ip) {
    const t = now();
    const count = claimIpWindow.record(ip, t);
    if (count > LIMITS.MAX_CLAIM_REQUESTS_PER_IP_PER_10MIN) {
      recordRefusal(ip, 'too many claim attempts');
      return { allowed: false, retryMs: claimIpWindow.retryMs(ip, t) };
    }
    return { allowed: true };
  }

  /**
   * Ticket B13: players without a device token (old clients) share a tight per-IP hourly
   * budget for reward releases. Does not record a hit - callers record only when a reward
   * is actually granted, so an `already_claimed` attempt does not consume the budget.
   */
  function checkRewardClaimIp(ip, hasDevice) {
    if (hasDevice) return { allowed: true };
    const t = now();
    const count = rewardClaimIpWindow.count(ip, t);
    if (count >= LIMITS.MAX_REWARD_CLAIMS_PER_IP_PER_HOUR_NO_DEVICE) {
      recordRefusal(ip, 'too many reward claims from no-device players');
      return { allowed: false, retryMs: rewardClaimIpWindow.retryMs(ip, t) };
    }
    return { allowed: true };
  }

  /** Record one successful reward grant against the no-device IP budget (ticket B13). */
  function recordRewardClaim(ip, hasDevice) {
    if (hasDevice) return;
    rewardClaimIpWindow.record(ip, now());
  }

  /** `play` at most once every PLAY_MIN_INTERVAL_MS per socket (ticket S2 decision 3). The SQL
   * 400-rounds-per-hour rule (open_round) stays as the backstop; this is the per-round-cadence
   * front line. */
  function checkPlayRate(socketId) {
    const wait = playInterval.check(socketId, now());
    return wait === null ? { allowed: true } : { allowed: false, retryMs: wait };
  }

  /** `leaderboard` / `tasks` / `get_me` and, since ticket B13, `task_progress` / `task_start` /
   * `task_return` at most once a second each, per socket (ticket S2 decision 3) - `type` keeps
   * each budget independent of the others. */
  function checkQueryRate(socketId, type) {
    const wait = queryInterval.check(`${socketId}:${type}`, now());
    return wait === null ? { allowed: true } : { allowed: false, retryMs: wait };
  }

  /** Frame flood: at most MAX_FRAMES_PER_SOCKET_PER_MIN per socket. `socketId` is a value the
   * caller mints once per connection (index.js uses a counter), not the identity - a fresh
   * socket always gets a fresh budget. */
  function checkFrameRate(socketId) {
    const t = now();
    const count = frameWindow.record(socketId, t);
    return count <= LIMITS.MAX_FRAMES_PER_SOCKET_PER_MIN;
  }

  function forgetSocket(socketId) {
    frameWindow.hits.delete(socketId);
    playInterval.forget(socketId);
    for (const type of ['leaderboard', 'tasks', 'get_me', 'task_progress', 'task_start', 'task_return', 'share_link']) {
      queryInterval.forget(`${socketId}:${type}`);
    }
  }

  function blockedIpsCount() {
    const t = now();
    let n = 0;
    for (const until of blocklist.values()) if (until > t) n++;
    return n;
  }

  function sweep() {
    const t = now();
    connectWindow.sweep(t);
    globalConnectWindow.sweep(t);
    globalAnonAttemptWindow.sweep(t);
    anonPlayerWindow.sweep(t);
    otpIpWindow.sweep(t);
    otpEmailWindow.sweep(t);
    claimIpWindow.sweep(t);
    rewardClaimIpWindow.sweep(t);
    frameWindow.sweep(t);
    playInterval.sweep(t);
    queryInterval.sweep(t);
    tripWindow.sweep(t);
    refusalWindow.sweep(t);
    for (const [ip, until] of blocklist) {
      if (until <= t) blocklist.delete(ip);
    }
    for (const [ip, at] of lastRefusalLogAt) {
      if (t - at > LIMITS.REFUSAL_LOG_INTERVAL_MS) lastRefusalLogAt.delete(ip);
    }
  }

  let timer = null;

  return {
    clientIp: (req) => clientIp(req),
    checkNewConnection,
    checkApiRequest,
    trackSocketOpen,
    trackSocketClose,
    trackAnonAttempt,
    checkAnonAuth,
    checkOtpIp,
    checkOtpEmail,
    checkClaimIp,
    checkRewardClaimIp,
    recordRewardClaim,
    checkFrameRate,
    checkPlayRate,
    checkQueryRate,
    forgetSocket,
    isBlocked,

    /** /status.limits (ticket S2 decision 4). */
    stats() {
      return {
        ips_active: openSocketsByIp.size,
        refusals_1m: refusalWindow.count('all', now()),
        blocked_ips: blocklist.size,
      };
    },

    blockedIpsCount,

    /** Ticket S18: the three numbers the automatic escalation state machine
     * (server/safemode.js) compares against its thresholds every poll. */
    safetySignals() {
      const t = now();
      return {
        connectionsPerMin: globalConnectWindow.count('all', t),
        newAnonPlayersPer10Min: globalAnonAttemptWindow.count('all', t),
        blockedIps: blockedIpsCount(),
      };
    },

    start() {
      if (timer) return;
      timer = setInterval(sweep, LIMITS.SWEEP_INTERVAL_MS);
      timer.unref();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },

    // Test-only escape hatches: exercise the sliding window and block list directly with an
    // injected clock, without a socket or an HTTP request in sight.
    _sweep: sweep,
    _tripWindow: tripWindow,
    _blocklist: blocklist,

    // Ticket B13: integration tests run against one shared server process; reward claim
    // windows are per-IP and would otherwise leak across test files. Test files call this
    // in before() to start each file with a clean no-device reward budget.
    _resetRewardClaimWindow() {
      rewardClaimIpWindow.hits.clear();
    },
  };
}

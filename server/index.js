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
import * as ledger from './ledger.js';
import * as otp from './otp.js';

const PING_INTERVAL_MS = 25000;
const MAX_MISSED_PONGS = 2;
const BACKPRESSURE_BYTES = 256 * 1024;
const STATUS_CACHE_MS = 5000; // /status does one DB round-trip; cache it so polling stays cheap

const TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days (docs/layers.md C3a)
const TOKEN_RENEW_AFTER_SECONDS = 7 * 24 * 60 * 60; // sliding renewal: reissue once a token is older than this

const LEADERBOARD_DEBOUNCE_MS = 1000; // docs/layers.md C4: "debounced to at most once per second"

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

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

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
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

  const body = await readJsonBody(req);
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
 * themselves through the returned `feed._injectTick`.
 */
export function createApp({
  finnhubToken = process.env.FINNHUB_TOKEN || null,
  // Kiosk idle-sweep timing (server/kiosk.js). Left undefined in production so kiosk.js's own
  // 60 s / 10 s defaults apply; tests shrink both so they do not wait on a real minute.
  kioskIdleMs = undefined,
  kioskSweepIntervalMs = undefined,
  // Live leaderboard push (docs/layers.md C4). Left at the default in production; tests shrink
  // it so a settle's broadcast does not sit in an in-progress test for a full second.
  leaderboardDebounceMs = LEADERBOARD_DEBOUNCE_MS,
} = {}) {
  const playerSockets = new Map(); // playerId -> ws
  const kioskSockets = new Map(); // kioskId -> ws
  let statusCache = null; // { at, aggregates } - see STATUS_CACHE_MS

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

  // Live, masked leaderboard (docs/layers.md C4): recomputed after every player round settle
  // and pushed to every WEB socket - never a kiosk, which has no email and is never ranked -
  // whenever the top 10 actually changed. `runAt` throttles this to at most one query and one
  // broadcast per `leaderboardDebounceMs`: the first settle after a quiet spell runs the query
  // immediately, a burst of settles inside that window collapses into one more run right after
  // it closes.
  let leaderboardLastRunAt = 0;
  let leaderboardTimer = null;
  let leaderboardRunPending = false;
  let leaderboardLastJson = null;

  /**
   * The `leaderboard`-shaped payload for one tournament (ticket B1): `rows` (that tournament's
   * top 10), `tournament` (its own header - title, dates, prize - or null when none resolved),
   * and `tournaments` (every tournament with a `status` computed against the current time, for
   * the client's past/upcoming switcher). `tournamentId` null means whichever tournament is
   * currently running; an explicit id is the `tournament` request frame reading back a past or
   * upcoming tournament's own board.
   */
  async function buildLeaderboardPayload(tournamentId) {
    const [rows, tournamentRow, tournamentRows] = await Promise.all([
      ledger.leaderboard(tournamentId),
      tournamentId ? ledger.getTournament(tournamentId) : ledger.currentTournament(),
      ledger.listTournaments(),
    ]);
    const now = Date.now();
    const tournaments = tournamentRows.map((t) => ({
      id: t.id,
      title: t.title,
      starts_at: t.starts_at,
      ends_at: t.ends_at,
      status: now < new Date(t.starts_at).getTime() ? 'upcoming' : now >= new Date(t.ends_at).getTime() ? 'past' : 'live',
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
    return { rows, tournament, tournaments };
  }

  async function runLeaderboardRefresh() {
    leaderboardLastRunAt = Date.now();
    let payload;
    try {
      payload = await buildLeaderboardPayload(null);
    } catch (err) {
      console.error('[leaderboard] refresh failed', err);
      return;
    }
    const json = JSON.stringify(payload);
    if (json === leaderboardLastJson) return;
    leaderboardLastJson = json;
    const frame = JSON.stringify({ type: 'leaderboard', ...payload });
    for (const ws of playerSockets.values()) {
      if (ws.readyState === ws.OPEN) ws.send(frame);
    }
  }

  function scheduleLeaderboardRefresh() {
    const elapsed = Date.now() - leaderboardLastRunAt;
    if (elapsed >= leaderboardDebounceMs && !leaderboardTimer) {
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
      Math.max(0, leaderboardDebounceMs - elapsed),
    );
  }

  const feed = createFeed({ finnhubToken, onTick: broadcastPrice });
  const rounds = createRoundManager({
    feed,
    ledger,
    getSocket,
    onPlayerSettled: scheduleLeaderboardRefresh,
    log: (line) => console.log(`[round] ${line}`),
  });
  const alerts = createAlerts({ latest: feed.latest, log: (line) => console.log(line) });

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
    const [aggregates, db] = await Promise.all([getStatusAggregates(), ledger.ping()]);
    const now = Date.now();
    const sources = {};
    for (const [id, s] of Object.entries(feed.status())) {
      sources[id] = {
        connected: s.connected,
        lastTickAt: s.lastTickAt,
        ageMs: s.lastTickAt === null ? null : now - s.lastTickAt,
      };
    }
    const p = feed.latest();
    sendJson(res, 200, {
      ok: true,
      uptimeSeconds: Math.round(process.uptime()),
      feed: { sources, price: p ? p.price : null, quiet: p ? p.quiet : true },
      sockets: { web: playerSockets.size, kiosk: kioskSockets.size },
      rounds: {
        inFlight: aggregates.rounds_in_flight,
        settled60s: aggregates.rounds_settled_60s,
        settled24h: aggregates.rounds_settled_24h,
      },
      flats24h: aggregates.flats_24h,
      coupons: { available: aggregates.coupons_available, claimed: aggregates.coupons_claimed },
      kiosksActive: aggregates.kiosks_active,
      db,
    });
  }
  const kioskIdleSweep = createKioskIdleSweep({
    ledger,
    getSocket,
    listKioskSockets: () => kioskSockets.entries(),
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

  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname !== '/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
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
    try {
      if (frame.kiosk) {
        const kioskId = await ledger.call('verify_kiosk', frame.kiosk);
        ws.authed = true;
        ws.kind = 'kiosk';
        ws.identity = kioskId;
        kioskSockets.set(kioskId, ws);
        const session = await ledger.kioskSession(kioskId);
        send(ws, { type: 'welcome', kiosk: true, streak: session.streak });
        send(ws, { type: 'kiosk_session', ...session });
        await sendHelloAndPending(ws, 'kiosk', kioskId);
        return;
      }

      let playerId = null;
      let currentToken = null;
      let version = 1;
      if (frame.token) {
        const id = await verifyToken(frame.token);
        if (id) {
          playerId = id;
          currentToken = frame.token;
          version = Number(frame.token.split('.')[1]);
        }
      }
      if (!playerId) playerId = await ledger.createPlayer();

      const me = await ledger.getMe(playerId);
      ws.authed = true;
      ws.kind = 'player';
      ws.identity = playerId;
      playerSockets.set(playerId, ws);
      const token = currentToken && !needsRenewal(currentToken) ? currentToken : signToken(playerId, version);
      send(ws, { type: 'welcome', token, me });
      await sendHelloAndPending(ws, 'player', playerId);
    } catch (err) {
      send(ws, { type: 'error', code: err.code || 'unauthenticated' });
    }
  }

  async function handleFrame(ws, frame) {
    const { kind, identity: id } = ws;
    try {
      switch (frame.type) {
        case 'play': {
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
          send(ws, { type: 'me', ...(await ledger.getMe(id)) });
          break;
        }
        case 'claim_task': {
          // Kiosks have no email, no tasks and no gifts (docs/layers.md C5): denied the same
          // way request_otp/verify_otp already are, not the bare 'unauthenticated' a player
          // would get for a stale/bad session.
          if (kind !== 'player') {
            send(ws, { type: 'error', code: 'not_available' });
            break;
          }
          const claimed = await ledger.claimTask(id, frame.task_id);
          const me = await ledger.getMe(id);
          send(ws, { type: 'me', ...me, reward: claimed.reward, task: frame.task_id });
          break;
        }
        case 'free_refill': {
          if (kind !== 'player') {
            send(ws, { type: 'error', code: 'not_available' });
            break;
          }
          const refilled = await ledger.freeRefill(id);
          const me = await ledger.getMe(id);
          send(ws, { type: 'me', ...me, reward: refilled.reward });
          break;
        }
        case 'tasks': {
          if (kind !== 'player') {
            send(ws, { type: 'error', code: 'not_available' });
            break;
          }
          send(ws, { type: 'tasks', rows: await ledger.getTasks(id) });
          break;
        }
        case 'leaderboard': {
          send(ws, { type: 'leaderboard', ...(await buildLeaderboardPayload(null)) });
          break;
        }
        case 'tournament': {
          // Reads back a specific tournament's own board - past or upcoming - as the same
          // `leaderboard`-shaped frame (ticket B1). An id naming no tournament resolves to a
          // null header and empty rows, not an error.
          const tournamentId = str(frame.id, 50) || null;
          send(ws, { type: 'leaderboard', ...(await buildLeaderboardPayload(tournamentId)) });
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
            const [me, loggedInVersion] = await Promise.all([
              ledger.getMe(loggedIn),
              ledger.getTokenVersion(loggedIn),
            ]);
            // get_me() already reports email_verified true here - that player's email was set
            // (and confirmed) before this code could have proved ownership of it.
            send(ws, { type: 'me', ...me, token: signToken(loggedIn, loggedInVersion ?? 1) });
          } else {
            send(ws, { type: 'me', ...(await ledger.getMe(id)) });
          }
          break;
        }
        default:
          break; // unknown frame type: ignored, not an error
      }
    } catch (err) {
      send(ws, { type: 'error', code: err.code || 'internal' });
      if (kind === 'kiosk' && err.code === 'insufficient_coins') {
        // open_kiosk_round marked the session broke when it refused the stake; the kiosk's
        // screen is driven by kiosk_session frames, so tell it (docs/layers.md C2).
        const session = await ledger.kioskSession(id).catch(() => null);
        if (session) send(ws, { type: 'kiosk_session', ...session });
      }
    }
  }

  wss.on('connection', (ws) => {
    ws.authed = false;
    ws.kind = null;
    ws.identity = null;
    ws.missedPongs = 0;

    ws.on('pong', () => {
      ws.missedPongs = 0;
    });

    ws.on('message', (data) => {
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
      if (ws.kind === 'player' && playerSockets.get(ws.identity) === ws) playerSockets.delete(ws.identity);
      if (ws.kind === 'kiosk' && kioskSockets.get(ws.identity) === ws) kioskSockets.delete(ws.identity);
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
      if (startFeed) feed.start();
      alerts.start();
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
      alerts.stop();
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

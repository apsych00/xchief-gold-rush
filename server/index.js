/**
 * The box game server (docs/box-plan.md 1.2, docs/box-spec.md 1.2): one HTTP server for
 * /health and /api/lead, one WebSocket at /ws for everything the game does.
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
import * as ledger from './ledger.js';
import * as otp from './otp.js';

const PING_INTERVAL_MS = 25000;
const MAX_MISSED_PONGS = 2;
const BACKPRESSURE_BYTES = 256 * 1024;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^\+?[0-9 ()-]{7,20}$/;

const str = (v, max) =>
  String(v ?? '')
    .trim()
    .slice(0, max);

function tokenSecret() {
  const secret = process.env.PLAYER_TOKEN_SECRET;
  if (!secret) throw new Error('PLAYER_TOKEN_SECRET is required');
  return secret;
}

function signToken(playerId) {
  const sig = crypto.createHmac('sha256', tokenSecret()).update(playerId).digest('hex');
  return `${playerId}.${sig}`;
}

/** An invalid token (bad shape, wrong signature) is treated as no token: caller starts fresh. */
function verifyToken(token) {
  if (typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot === -1) return null;
  const id = token.slice(0, dot);
  const sigHex = token.slice(dot + 1);
  if (!UUID_RE.test(id)) return null;
  const expectedHex = crypto.createHmac('sha256', tokenSecret()).update(id).digest('hex');
  const given = Buffer.from(sigHex, 'hex');
  const expected = Buffer.from(expectedHex, 'hex');
  if (given.length !== expected.length) return null;
  return crypto.timingSafeEqual(given, expected) ? id : null;
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

  if (type === 'signup') {
    const name = str(body.name, 80);
    const phone = str(body.phone, 24);
    if (name.length < 2) {
      sendJson(res, 400, { ok: false, error: 'invalid_name' });
      return;
    }
    if (!PHONE_RE.test(phone)) {
      sendJson(res, 400, { ok: false, error: 'invalid_phone' });
      return;
    }
    lead.name = name;
    lead.phone = phone;
  }

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
export function createApp({ finnhubToken = process.env.FINNHUB_TOKEN || null } = {}) {
  const playerSockets = new Map(); // playerId -> ws
  const kioskSockets = new Map(); // kioskId -> ws

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

  const feed = createFeed({ finnhubToken, onTick: broadcastPrice });
  const rounds = createRoundManager({
    feed,
    ledger,
    getSocket,
    log: (line) => console.log(`[round] ${line}`),
  });

  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      ledger.ping().then((db) => sendJson(res, 200, { ok: true, feed: feed.status(), db }));
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
        const streak = await ledger.kioskStreak(kioskId);
        send(ws, { type: 'welcome', kiosk: true, streak });
        await sendHelloAndPending(ws, 'kiosk', kioskId);
        return;
      }

      let playerId = frame.token ? verifyToken(frame.token) : null;
      if (!playerId) playerId = await ledger.createPlayer();

      const me = await ledger.getMe(playerId);
      ws.authed = true;
      ws.kind = 'player';
      ws.identity = playerId;
      playerSockets.set(playerId, ws);
      send(ws, { type: 'welcome', token: signToken(playerId), me });
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
          const lever = kind === 'kiosk' ? 1 : frame.lever;
          const opened = await rounds.play(kind, id, { dir, lever });
          send(ws, { type: 'round_opened', ...opened });
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
          if (kind !== 'player') {
            send(ws, { type: 'error', code: 'unauthenticated' });
            break;
          }
          await ledger.claimTask(id, frame.task_id);
          send(ws, { type: 'me', ...(await ledger.getMe(id)) });
          break;
        }
        case 'free_refill': {
          if (kind !== 'player') {
            send(ws, { type: 'error', code: 'unauthenticated' });
            break;
          }
          await ledger.freeRefill(id);
          send(ws, { type: 'me', ...(await ledger.getMe(id)) });
          break;
        }
        case 'leaderboard': {
          send(ws, { type: 'leaderboard', rows: await ledger.leaderboard() });
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
          await ledger.verifyOtpCode(id, email, code);
          send(ws, { type: 'me', ...(await ledger.getMe(id)), email_verified: true });
          break;
        }
        default:
          break; // unknown frame type: ignored, not an error
      }
    } catch (err) {
      send(ws, { type: 'error', code: err.code || 'internal' });
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
      clearInterval(heartbeat);
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

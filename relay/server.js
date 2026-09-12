/**
 * xChief Gold Rush price relay.
 *
 * Opens ONE upstream connection per source and broadcasts every price to all
 * connected browsers. This is what lets many players share a single Finnhub
 * key (Finnhub allows one socket per key) and guarantees everyone at the
 * booth sees the same quote.
 *
 * Sources, best first:
 *   1. Finnhub: XAU/USD from OANDA / IC Markets  (needs FINNHUB_TOKEN)
 *   2. OKX: PAXG/USDT mid price                  (no key)
 *   3. Binance: PAXG/USDT book ticker mid        (no key)
 *
 * The relay always publishes the best source that is currently ticking. If a
 * better source goes silent for STALE_MS it is demoted until it ticks again.
 *
 * Client protocol (JSON text frames):
 *   -> {"type":"hello","symbol":"XAU/USD","source":"OANDA","price":4355.6,"t":1700000000000}
 *   -> {"type":"price","symbol":"XAU/USD","source":"OANDA","price":4355.7,"t":...}
 *   -> {"type":"status","symbol":...,"source":...,"clients":12}
 *   -> {"type":"ping"}                    (every 25 s; clients may ignore)
 *
 * HTTP:
 *   GET /health -> 200 {"ok":true,...}
 *   GET /price  -> last price JSON
 */

import http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT || 8787);
const FINNHUB_TOKEN = process.env.FINNHUB_TOKEN || '';
const STALE_MS = Number(process.env.STALE_MS || 20000);
const PING_MS = 25000;
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30000;

const FINNHUB_SYMBOLS = {
  'OANDA:XAU_USD': 'OANDA',
  'IC MARKETS:41': 'IC Markets',
};

const isValid = (p) => typeof p === 'number' && Number.isFinite(p) && p > 100 && p < 100000;

// ---------------------------------------------------------------- sources --

const sources = [];

if (FINNHUB_TOKEN) {
  sources.push({
    id: 'finnhub',
    priority: 1,
    symbol: 'XAU/USD',
    label: 'OANDA',
    url: `wss://ws.finnhub.io?token=${encodeURIComponent(FINNHUB_TOKEN)}`,
    subscribe: Object.keys(FINNHUB_SYMBOLS).map((s) => JSON.stringify({ type: 'subscribe', symbol: s })),
    parse(m) {
      if (!m || m.type !== 'trade' || !Array.isArray(m.data)) return null;
      let best = null;
      for (const d of m.data) {
        if (!(d.s in FINNHUB_SYMBOLS) || typeof d.p !== 'number') continue;
        if (!best || d.s === 'OANDA:XAU_USD') best = d;
      }
      return best ? { price: best.p, label: FINNHUB_SYMBOLS[best.s] } : null;
    },
  });
} else {
  console.warn('[relay] FINNHUB_TOKEN not set: XAU/USD broker feed disabled, using PAXG only');
}

sources.push(
  {
    id: 'okx',
    priority: 2,
    symbol: 'PAXG/USD',
    label: 'OKX',
    url: 'wss://ws.okx.com:8443/ws/v5/public',
    subscribe: [JSON.stringify({ op: 'subscribe', args: [{ channel: 'tickers', instId: 'PAXG-USDT' }] })],
    parse(m) {
      const d = m && m.data && m.data[0];
      if (!d || !d.bidPx || !d.askPx) return null;
      return { price: (Number(d.bidPx) + Number(d.askPx)) / 2 };
    },
  },
  {
    id: 'binance',
    priority: 3,
    symbol: 'PAXG/USD',
    label: 'Binance',
    url: 'wss://data-stream.binance.vision/ws/paxgusdt@bookTicker',
    subscribe: [],
    parse(m) {
      if (!m || !m.b || !m.a) return null;
      return { price: (Number(m.b) + Number(m.a)) / 2 };
    },
  },
);

// ------------------------------------------------------------------ state --

const state = {
  price: null,
  symbol: null,
  source: null,
  t: 0,
  sourceId: null,
};
const lastTick = new Map(); // source id -> { price, label, t }

function bestSource() {
  const now = Date.now();
  let best = null;
  for (const s of sources) {
    const tick = lastTick.get(s.id);
    if (!tick || now - tick.t > STALE_MS) continue;
    if (!best || s.priority < best.priority) best = s;
  }
  return best;
}

function onTick(src, parsed) {
  if (!parsed || !isValid(parsed.price)) return;
  const label = parsed.label || src.label;
  lastTick.set(src.id, { price: parsed.price, label, t: Date.now() });
  const best = bestSource();
  if (!best || best.id !== src.id) return; // a better source is live; ignore this one
  const changedSource = state.sourceId !== src.id || state.source !== label;
  state.price = parsed.price;
  state.symbol = src.symbol;
  state.source = label;
  state.sourceId = src.id;
  state.t = Date.now();
  if (changedSource) {
    console.log(`[relay] now publishing ${src.symbol} from ${label}`);
    broadcast(statusMessage());
  }
  broadcast(JSON.stringify({ type: 'price', symbol: state.symbol, source: state.source, price: state.price, t: state.t }));
}

// --------------------------------------------------------------- upstream --

function connectUpstream(src, attempt = 0) {
  let ws;
  try {
    ws = new WebSocket(src.url);
  } catch (err) {
    scheduleReconnect(src, attempt, err);
    return;
  }
  let opened = false;
  ws.on('open', () => {
    opened = true;
    console.log(`[relay] upstream ${src.id} connected`);
    for (const m of src.subscribe) ws.send(m);
  });
  ws.on('message', (buf) => {
    let m;
    try {
      m = JSON.parse(buf.toString());
    } catch {
      return;
    }
    if (m && m.type === 'error') console.warn(`[relay] upstream ${src.id} error:`, m.msg || m);
    try {
      onTick(src, src.parse(m));
    } catch (err) {
      console.warn(`[relay] parse failed for ${src.id}:`, err.message);
    }
  });
  ws.on('close', (code) => {
    console.warn(`[relay] upstream ${src.id} closed (${code})`);
    scheduleReconnect(src, opened ? 0 : attempt + 1);
  });
  ws.on('error', (err) => {
    console.warn(`[relay] upstream ${src.id} socket error:`, err.message);
  });
}

function scheduleReconnect(src, attempt, err) {
  const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** Math.min(attempt, 5));
  if (err) console.warn(`[relay] upstream ${src.id} failed:`, err.message);
  setTimeout(() => connectUpstream(src, attempt), delay);
}

for (const src of sources) connectUpstream(src);

// ----------------------------------------------------------------- server --

const server = http.createServer((req, res) => {
  const url = req.url || '/';
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (url.startsWith('/health')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, clients: wss.clients.size, ...state, sources: [...lastTick.keys()] }));
    return;
  }
  if (url.startsWith('/price')) {
    res.writeHead(state.price ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(state));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('xchief gold relay\n');
});

const wss = new WebSocketServer({ server, path: '/ws' });

function statusMessage() {
  return JSON.stringify({ type: 'status', symbol: state.symbol, source: state.source, clients: wss.clients.size });
}

function broadcast(text) {
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(text);
  }
}

wss.on('connection', (client) => {
  client.isAlive = true;
  client.on('pong', () => {
    client.isAlive = true;
  });
  client.on('error', () => {});
  client.send(JSON.stringify({ type: 'hello', symbol: state.symbol, source: state.source, price: state.price, t: state.t }));
});

setInterval(() => {
  for (const client of wss.clients) {
    if (client.isAlive === false) {
      client.terminate();
      continue;
    }
    client.isAlive = false;
    try {
      client.ping();
      if (client.readyState === WebSocket.OPEN) client.send('{"type":"ping"}');
    } catch {
      /* ignore */
    }
  }
}, PING_MS);

server.listen(PORT, () => {
  console.log(`[relay] listening on :${PORT}  (ws path /ws, sources: ${sources.map((s) => s.id).join(', ')})`);
});

process.on('SIGTERM', () => {
  console.log('[relay] shutting down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000);
});

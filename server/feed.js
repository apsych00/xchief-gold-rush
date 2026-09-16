/**
 * Price feed for the box game server (docs/box-spec.md 1.1, docs/box-plan.md
 * "Price feed"). Starting point: relay/server.js.
 *
 * One upstream connection per source, all kept hot at once:
 *   1. Finnhub  OANDA:XAU_USD trade stream   (only when a token is given)
 *   2. OKX      PAXG-USDT tickers mid
 *   3. Binance  PAXG/USDT bookTicker mid
 * Reconnect with exponential backoff 1 s..30 s.
 *
 * ONE published series: the active source is the highest-priority source that
 * ticked within STALE_MS; a source is demoted only after 10 s of silence.
 * Each source carries an offset and published = raw + offset[active]. On a
 * switch from A to B, offset[B] is anchored to the last published value so
 * the level never jumps mid-round. While the game is idle (setIdle(true): no
 * round open anywhere for 2 s) and Finnhub is active, offset[finnhub] decays
 * toward 0 by at most REANCHOR_STEP per tick, sliding the level back to true
 * XAU/USD. Offsets are never adjusted while not idle.
 *
 * Client rule: the onTick payload ({price, t, quiet}) is all any client ever
 * sees; it carries no source name. status() is for the operator's health
 * endpoint and latest().source for the round manager's audit column only.
 */

import { WebSocket } from 'ws';

const STALE_MS = 10000; // demote the active source only after 10 s of silence
const QUIET_MS = 3000; // no published tick for 3 s -> the series is quiet
const PRICE_MIN = 100;
const PRICE_MAX = 100000;
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const REANCHOR_STEP = 0.05; // max offset decay per tick while idle

const isValidPrice = (p) => typeof p === 'number' && Number.isFinite(p) && p > PRICE_MIN && p < PRICE_MAX;
const round2 = (p) => Math.round(p * 100) / 100;

/** Source definitions in priority order; Finnhub only exists when a token is given. */
function sourceDefs(finnhubToken) {
  const defs = [];
  if (finnhubToken) {
    defs.push({
      id: 'finnhub',
      priority: 1,
      url: `wss://ws.finnhub.io?token=${encodeURIComponent(finnhubToken)}`,
      subscribe: [JSON.stringify({ type: 'subscribe', symbol: 'OANDA:XAU_USD' })],
      parse(m) {
        if (!m || m.type !== 'trade' || !Array.isArray(m.data)) return null;
        for (const d of m.data) {
          if (d && d.s === 'OANDA:XAU_USD' && typeof d.p === 'number') return d.p;
        }
        return null;
      },
    });
  }
  defs.push(
    {
      id: 'okx',
      priority: 2,
      url: 'wss://ws.okx.com:8443/ws/v5/public',
      subscribe: [JSON.stringify({ op: 'subscribe', args: [{ channel: 'tickers', instId: 'PAXG-USDT' }] })],
      parse(m) {
        const d = m && m.data && m.data[0];
        if (!d || !d.bidPx || !d.askPx) return null;
        return (Number(d.bidPx) + Number(d.askPx)) / 2;
      },
    },
    {
      id: 'binance',
      priority: 3,
      url: 'wss://data-stream.binance.vision/ws/paxgusdt@bookTicker',
      subscribe: [],
      parse(m) {
        if (!m || !m.b || !m.a) return null;
        return (Number(m.b) + Number(m.a)) / 2;
      },
    },
  );
  return defs.sort((a, b) => a.priority - b.priority);
}

/**
 * Create the feed. Call start() to open the upstream sockets; stop() closes
 * everything and cancels reconnects. onTick receives every accepted tick of
 * the active source as { price, t, quiet:false } - no source name.
 */
export function createFeed({ finnhubToken, onTick, now = Date.now } = {}) {
  const sources = new Map(); // id -> state, iteration order = priority order
  for (const def of sourceDefs(finnhubToken)) {
    sources.set(def.id, { def, connected: false, lastTickAt: null, raw: null, offset: 0 });
  }

  let activeId = null; // source id currently publishing the series
  let published = null; // last published tick: { price, t }
  let idle = false; // set by the round manager via setIdle
  let running = false; // start()/stop() gate for the sockets and timers
  const sockets = new Map();
  const retryTimers = new Map();
  const attempts = new Map();

  /** Highest-priority source that ticked within STALE_MS of t, or null. */
  function pickActive(t) {
    for (const s of sources.values()) {
      if (s.lastTickAt !== null && t - s.lastTickAt <= STALE_MS) return s;
    }
    return null;
  }

  /**
   * Accept one parsed raw price at time t. Shared by the websocket message
   * handlers and the _injectTick test hook so both go through one pipeline.
   */
  function ingest(sourceId, raw, t) {
    const src = sources.get(sourceId);
    if (!src || !isValidPrice(raw)) return; // unknown source or invalid price: dropped

    src.raw = raw;
    src.lastTickAt = t;

    const next = pickActive(t);
    if (!next) return;
    const switched = next.def.id !== activeId;
    if (switched) {
      // Anchor the incoming source to the current level; the very first tick
      // of the feed keeps offset 0.
      if (activeId !== null && published) next.offset = round2(published.price - next.raw);
      activeId = next.def.id;
    }
    if (src.def.id !== activeId) return; // non-active source: raw updated only, never published

    if (idle && !switched && activeId === 'finnhub') {
      // Re-anchor: slide back toward true XAU/USD by at most REANCHOR_STEP per tick.
      const off = next.offset;
      next.offset = off > 0 ? Math.max(0, round2(off - REANCHOR_STEP)) : Math.min(0, round2(off + REANCHOR_STEP));
    }

    published = { price: round2(next.raw + next.offset), t };
    if (onTick) onTick({ price: published.price, t, quiet: false });
  }

  // --------------------------------------------------------------- upstream --

  function connect(src) {
    const id = src.def.id;
    let ws;
    try {
      ws = new WebSocket(src.def.url);
    } catch (err) {
      retry(id, (attempts.get(id) || 0) + 1, err);
      return;
    }
    sockets.set(id, ws);
    let opened = false;
    ws.on('open', () => {
      opened = true;
      attempts.set(id, 0);
      src.connected = true;
      for (const m of src.def.subscribe) ws.send(m);
    });
    ws.on('message', (buf) => {
      let m;
      try {
        m = JSON.parse(buf.toString());
      } catch {
        return;
      }
      if (m && m.type === 'error') {
        console.warn(`[feed] upstream ${id} error:`, m.msg || m);
        return;
      }
      let raw;
      try {
        raw = src.def.parse(m);
      } catch (err) {
        console.warn(`[feed] parse failed for ${id}:`, err.message);
        return;
      }
      if (raw !== null && raw !== undefined) ingest(id, raw, now());
    });
    ws.on('close', () => {
      src.connected = false;
      if (running) retry(id, opened ? 0 : (attempts.get(id) || 0) + 1);
    });
    ws.on('error', (err) => {
      console.warn(`[feed] upstream ${id} socket error:`, err.message);
    });
  }

  /** Exponential backoff, 1 s..30 s. */
  function retry(sourceId, attempt, err) {
    if (!running) return;
    attempts.set(sourceId, attempt);
    if (err) console.warn(`[feed] upstream ${sourceId} failed:`, err.message);
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** Math.min(attempt, 5));
    const timer = setTimeout(() => {
      retryTimers.delete(sourceId);
      const src = sources.get(sourceId);
      if (running && src) connect(src);
    }, delay);
    retryTimers.set(sourceId, timer);
  }

  function start() {
    if (running) return;
    running = true;
    for (const src of sources.values()) connect(src);
  }

  function stop() {
    running = false;
    for (const timer of retryTimers.values()) clearTimeout(timer);
    retryTimers.clear();
    for (const [id, ws] of sockets) {
      ws.removeAllListeners();
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      const src = sources.get(id);
      if (src) src.connected = false;
    }
    sockets.clear();
  }

  // ------------------------------------------------------------------- reads --

  /**
   * Last published tick with the quiet flag evaluated at call time:
   * quiet = no published tick in the last 3 s. Returns null before the first
   * accepted tick. `source` is internal (rounds.source audit), never client.
   */
  function latest() {
    if (!published || activeId === null) return null;
    return { price: published.price, t: published.t, source: activeId, quiet: now() - published.t > QUIET_MS };
  }

  /** Per-source operator detail for the health endpoint. */
  function status() {
    const out = {};
    for (const [id, s] of sources) out[id] = { connected: s.connected, lastTickAt: s.lastTickAt, raw: s.raw };
    return out;
  }

  /** Called by the round manager: true when no round has been open anywhere for 2 s. */
  function setIdle(isIdle) {
    idle = Boolean(isIdle);
  }

  return {
    start,
    stop,
    latest,
    status,
    setIdle,
    // Test-only hooks: drive the feed through the real pipeline without sockets.
    _injectTick(sourceId, rawPrice, t) {
      ingest(sourceId, rawPrice, t);
    },
    _setConnected(sourceId, ok) {
      const src = sources.get(sourceId);
      if (src) src.connected = Boolean(ok);
    },
  };
}

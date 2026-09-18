/**
 * Price feed for the box game server (docs/box-spec.md 1.1, docs/box-plan.md
 * "Price feed"). Starting point: relay/server.js.
 *
 * One upstream connection per source, all kept hot at once:
 *   0. MT5      broker XAUUSD tick stream    (METAAPI_TOKEN+METAAPI_ACCOUNT_ID, or else MT5_BRIDGE_WS)
 *   1. Finnhub  OANDA:XAU_USD trade stream   (only when a token is given)
 *   2. OKX      PAXG-USDT tickers mid
 *   3. Binance  PAXG/USDT bookTicker mid
 * Reconnect with exponential backoff 1 s..30 s.
 *
 * MT5 is a "custom" source (server/feed-mt5.js for MetaApi,
 * server/feed-mt5-bridge.js for our own terminal+bridge, docs/mt5-feed.md):
 * it does not speak the raw WebSocket protocol the others share, so it
 * connects through its own adapter (connect()/disconnect(), onTick/onState
 * callbacks) instead of a `url`/`subscribe`/`parse` def. It still goes
 * through the same ingest() pipeline as every other source once a tick
 * arrives, so priority, demotion, the continuity offset, and validation are
 * identical.
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
import { createMt5Source } from './feed-mt5.js';
import { createMt5BridgeSource } from './feed-mt5-bridge.js';

const STALE_MS = 10000; // demote the active source only after 10 s of silence
// Quiet is keyed on price MOVEMENT, not tick arrival: off-hours the upstream keeps sending
// frequent ticks at the SAME price, so "no tick for 3 s" never fires and the chart flatlines.
// The market is quiet once the published real price has not CHANGED for QUIET_MS.
const QUIET_MS = 3000; // no change in the published real price for 3 s -> the market is quiet
const PRICE_MIN = 100;
const PRICE_MAX = 100000;
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const REANCHOR_STEP = 0.05; // max offset decay per tick while idle
// Quiet-market simulation (ported from the old client src/priceFeed.js): while the real price
// is still, publish a gentle, mean-reverting random walk anchored to the last real price so a
// 5 s round is still playable. Amplitude is fractions of a dollar - a believable XAU/USD lull.
const QUIET_AMPLITUDE = 0.35; // max synthetic drift from the last real price, in dollars
const QUIET_STEP = 0.12; // random-walk increment scale per synthetic tick
const QUIET_REVERT = 0.05; // mean-reversion pull back toward the real price each tick

const isValidPrice = (p) => typeof p === 'number' && Number.isFinite(p) && p > PRICE_MIN && p < PRICE_MAX;
// Gold is quoted to 3 decimals (Finnhub OANDA: 4308.425). Publishing 2 collapsed real moves
// into "no change" and made the chart feel stepped; keep the third decimal.
const round3 = (p) => Math.round(p * 1000) / 1000;

/**
 * Source definitions in priority order. Finnhub only exists when a token is
 * given; mt5 only exists when either MetaApi (METAAPI_TOKEN +
 * METAAPI_ACCOUNT_ID) or our own bridge (MT5_BRIDGE_WS, docs/mt5-feed.md
 * "Bridge route") is configured. MetaApi wins if both are set - it is the
 * hosted route and the one already vetted against the success bar.
 */
function sourceDefs({ finnhubToken, metaapiToken, metaapiAccountId, metaapiSymbol, mt5BridgeWs, feedRelayWs }) {
  const defs = [];
  if (metaapiToken && metaapiAccountId) {
    defs.push({
      id: 'mt5',
      priority: 0,
      custom: true,
      createSource: (onTick, onState) =>
        createMt5Source({ token: metaapiToken, accountId: metaapiAccountId, symbol: metaapiSymbol, onTick, onState }),
    });
  } else if (mt5BridgeWs) {
    defs.push({
      id: 'mt5',
      priority: 0,
      custom: true,
      createSource: (onTick, onState) => createMt5BridgeSource({ url: mt5BridgeWs, onTick, onState }),
    });
  }
  if (feedRelayWs) {
    // The gold price relay (relay/server.js) holds the one Finnhub socket a key allows and
    // fans it out; a game server pointed at it (FEED_RELAY_WS) takes the relay's published
    // price as its Finnhub tier instead of opening its own socket, so any number of servers
    // share one key. The relay's frames are {type:'hello'|'price', price, t}.
    defs.push({
      id: 'finnhub',
      priority: 1,
      url: feedRelayWs,
      subscribe: [],
      parse(m) {
        if (!m || (m.type !== 'price' && m.type !== 'hello')) return null;
        return typeof m.price === 'number' ? m.price : null;
      },
    });
  } else if (finnhubToken) {
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
export function createFeed({
  finnhubToken,
  metaapiToken = process.env.METAAPI_TOKEN || null,
  metaapiAccountId = process.env.METAAPI_ACCOUNT_ID || null,
  metaapiSymbol = process.env.METAAPI_SYMBOL || 'XAUUSD',
  mt5BridgeWs = process.env.MT5_BRIDGE_WS || null,
  feedRelayWs = process.env.FEED_RELAY_WS || null,
  onTick,
  now = Date.now,
  random = Math.random, // injectable for deterministic tests of the quiet-market walk
} = {}) {
  const sources = new Map(); // id -> state, iteration order = priority order
  for (const def of sourceDefs({ finnhubToken, metaapiToken, metaapiAccountId, metaapiSymbol, mt5BridgeWs, feedRelayWs })) {
    sources.set(def.id, { def, connected: false, lastTickAt: null, raw: null, offset: 0 });
  }

  let activeId = null; // source id currently publishing the series
  let published = null; // last published tick: { price, t }
  let lastRealPrice = null; // last published value driven by a real upstream change: the walk anchor
  let lastChangeAt = null; // when that real value last changed; quiet is keyed on this, not tick arrival
  let quiet = false; // currently synthesizing a quiet-market walk
  let quietDrift = 0; // bounded random-walk offset from lastRealPrice while quiet
  let reentryResidual = 0; // synthetic drift carried past a quiet -> real resume, decayed to 0 for a smooth landing
  let idle = false; // set by the round manager via setIdle
  let running = false; // start()/stop() gate for the sockets and timers
  const sockets = new Map();
  const customSources = new Map(); // id -> { connect, disconnect } handle for non-WebSocket sources (mt5)
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
      if (activeId !== null && published) next.offset = round3(published.price - next.raw);
      activeId = next.def.id;
    }
    if (src.def.id !== activeId) return; // non-active source: raw updated only, never published

    if (idle && !switched && activeId === 'finnhub') {
      // Re-anchor: slide back toward true XAU/USD by at most REANCHOR_STEP per tick.
      const off = next.offset;
      next.offset = off > 0 ? Math.max(0, round3(off - REANCHOR_STEP)) : Math.min(0, round3(off + REANCHOR_STEP));
    }

    // The value the real series would publish this tick (raw + the source offset). A source
    // switch is always a change point even when the level is continuous: it means a fresh active
    // source just took over after the old one fell silent, which is a demotion, not a quiet
    // market, so the quiet clock restarts from here rather than counting the old source's silence.
    const realPrice = round3(next.raw + next.offset);
    const realChanged = switched || lastRealPrice === null || realPrice !== lastRealPrice;

    if (realChanged) {
      // A genuine upstream move (or the very first tick): the real series is live. If we were
      // synthesizing, resume the real series smoothly. On a same-source resume the last shown
      // value was lastRealPrice + drift, so carry that drift across as a residual that decays to
      // 0 over the next ticks - the real move shows through without the drift snapping away. A
      // source switch already anchored next.offset to the last published value (continuity), so
      // that path lands on the real series on its own and needs no residual.
      if (quiet) {
        reentryResidual = switched ? 0 : quietDrift;
        quiet = false;
        quietDrift = 0;
      }
      lastRealPrice = realPrice;
      lastChangeAt = t;
    } else if (!quiet && !idle && lastChangeAt !== null && t - lastChangeAt > QUIET_MS) {
      // The published real price has not changed for QUIET_MS while a round is (or was just) in
      // play: the market is quiet. Start synthesizing so the chart keeps moving. Gated on !idle
      // so the idle re-anchor (offset decay back to true XAU) is never fought while no one plays.
      quiet = true;
      quietDrift = 0;
    }

    let price;
    if (quiet) {
      // Bounded, mean-reverting random walk around the last real price. Small amplitude so it
      // reads as a real XAU/USD lull, anchored to lastRealPrice so it never drifts far.
      quietDrift += (random() - 0.5) * QUIET_STEP - quietDrift * QUIET_REVERT;
      if (quietDrift > QUIET_AMPLITUDE) quietDrift = QUIET_AMPLITUDE;
      else if (quietDrift < -QUIET_AMPLITUDE) quietDrift = -QUIET_AMPLITUDE;
      price = round3(lastRealPrice + quietDrift);
    } else if (reentryResidual !== 0) {
      // Glide the carried-over synthetic drift out by at most REANCHOR_STEP per tick.
      price = round3(realPrice + reentryResidual);
      reentryResidual =
        reentryResidual > 0
          ? Math.max(0, round3(reentryResidual - REANCHOR_STEP))
          : Math.min(0, round3(reentryResidual + REANCHOR_STEP));
    } else {
      price = realPrice;
    }

    published = { price, t };
    // The quiet flag is movement-based: true whenever the real price has been still for QUIET_MS,
    // whether or not this exact tick is synthetic. The synthetic ticks carry quiet:true so the
    // client can show its "quiet market" label.
    const quietFlag = lastChangeAt !== null && t - lastChangeAt > QUIET_MS;
    if (onTick) onTick({ price, t, quiet: quietFlag });
  }

  // --------------------------------------------------------------- upstream --

  function connect(src) {
    if (src.def.custom) {
      connectCustom(src);
      return;
    }
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

  /**
   * Connect a custom (non-WebSocket) source, e.g. mt5 (server/feed-mt5.js).
   * Mirrors the ws open/close handling above: `opened` tracks whether this
   * connection ever came up, so a drop after a good connection retries from
   * attempt 0 while a drop before ever connecting backs off.
   */
  function connectCustom(src) {
    const id = src.def.id;
    let opened = false;
    // Arrival time, never the broker's own clock: lastTickAt/staleness compare against now(),
    // and a broker timestamp in the broker's timezone would demote a healthy source.
    const handle = src.def.createSource(
      (raw) => ingest(id, raw, now()),
      (state) => {
        const wasConnected = src.connected;
        src.connected = Boolean(state && state.connected);
        if (src.connected) {
          opened = true;
          attempts.set(id, 0);
        } else if (wasConnected && running) {
          retry(id, opened ? 0 : (attempts.get(id) || 0) + 1);
        }
      },
    );
    customSources.set(id, handle);
    Promise.resolve()
      .then(() => handle.connect())
      .catch((err) => {
        src.connected = false;
        if (running) retry(id, (attempts.get(id) || 0) + 1, err);
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
      ws.on('error', () => {}); // close() on a CONNECTING socket emits error; never let it crash the process
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      const src = sources.get(id);
      if (src) src.connected = false;
    }
    sockets.clear();
    for (const [id, handle] of customSources) {
      const src = sources.get(id);
      if (src) src.connected = false;
      Promise.resolve()
        .then(() => handle.disconnect())
        .catch(() => {
          /* ignore: best-effort teardown, mirrors ws.close() above */
        });
    }
    customSources.clear();
  }

  // ------------------------------------------------------------------- reads --

  /**
   * Last published tick with the quiet flag evaluated at call time:
   * quiet = the real price has not changed in the last 3 s (a quiet market,
   * whether the last tick was real or synthetic). Returns null before the first
   * accepted tick. `source` is internal (rounds.source audit), never client.
   */
  function latest() {
    if (!published || activeId === null) return null;
    const q = lastChangeAt !== null && now() - lastChangeAt > QUIET_MS;
    return { price: published.price, t: published.t, source: activeId, quiet: q };
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

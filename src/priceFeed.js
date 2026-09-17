/**
 * Live gold price feed.
 *
 * Gold is quoted through PAXG (Paxos Gold, one token = one troy ounce of
 * gold) on public exchange WebSockets. These are free, need no API key, and
 * push best bid/ask in real time, so the game can settle a 5-second round on
 * a genuine market move. The mid price ((bid + ask) / 2) is used because it
 * changes far more often than the last trade.
 *
 * All WebSocket sources are opened at once; the first one to deliver a price
 * wins and the rest are closed. If the winner drops, the race restarts. If no
 * socket delivers within a few seconds, a REST poller takes over, and if even
 * that fails the game runs on a simulated walk flagged as "demo".
 *
 * To plug in a broker feed (for example an MT5 bridge), add another entry to
 * WS_SOURCES with its url, subscribe message and parse function.
 *
 * Server mode (docs/box-plan.md, "Client price feed in server mode"): when the app is wired
 * to the box game server (VITE_GAME_WS set), startPriceFeed() below dispatches to
 * startServerPriceFeed() at the bottom of this file instead - the only source is then the
 * socket's own price frames. Local mode (everything above) is unchanged either way.
 */
import { enabled as serverMode } from './api/client.js';
import { connect as connectSocket, onPrice as onSocketPrice, onStatus as onSocketStatus } from './api/socket.js';

const FINNHUB_TOKEN = (import.meta.env && import.meta.env.VITE_FINNHUB_TOKEN) || '';
const FINNHUB_SYMBOLS = {
  'OANDA:XAU_USD': 'OANDA',
  'IC MARKETS:41': 'IC Markets',
};

const RELAY_URL = (import.meta.env && import.meta.env.VITE_RELAY_URL) || '';

// Lower priority number = better source. When a better source starts
// delivering while a worse one is active, the feed switches to it.
const WS_SOURCES = [
  // Our own relay (relay/server.js): one upstream connection shared by every
  // player, so any number of devices get the broker XAU/USD feed and all see
  // the same quote. Priority 0 = always preferred when reachable.
  ...(RELAY_URL
    ? [
        {
          id: 'relay',
          label: 'Relay',
          symbol: 'XAU/USD',
          priority: 0,
          url: RELAY_URL,
          parse(m) {
            if (!m || (m.type !== 'price' && m.type !== 'hello')) return null;
            if (typeof m.price !== 'number') return null;
            return { price: m.price, label: m.source || 'Relay', symbol: m.symbol || 'XAU/USD' };
          },
        },
      ]
    : []),
  // Real XAU/USD spot from forex brokers via Finnhub (needs VITE_FINNHUB_TOKEN).
  // One Finnhub key allows a single open connection; extra devices fall back
  // to the exchange sources below automatically. Skipped when a relay is
  // configured, because the relay already holds that one connection.
  ...(FINNHUB_TOKEN && !RELAY_URL
    ? [
        {
          id: 'finnhub',
          label: 'OANDA',
          symbol: 'XAU/USD',
          priority: 1,
          url: `wss://ws.finnhub.io?token=${encodeURIComponent(FINNHUB_TOKEN)}`,
          subscribeMany: Object.keys(FINNHUB_SYMBOLS).map((s) => ({ type: 'subscribe', symbol: s })),
          parse(m) {
            if (!m || m.type !== 'trade' || !Array.isArray(m.data)) return null;
            let best = null;
            for (const d of m.data) {
              if (!(d.s in FINNHUB_SYMBOLS) || typeof d.p !== 'number') continue;
              // Prefer OANDA when both brokers tick in the same message.
              if (!best || d.s === 'OANDA:XAU_USD') best = d;
            }
            return best ? { price: best.p, label: FINNHUB_SYMBOLS[best.s] } : null;
          },
        },
      ]
    : []),
  {
    id: 'okx',
    label: 'OKX',
    symbol: 'PAXG/USD',
    priority: 2,
    url: 'wss://ws.okx.com:8443/ws/v5/public',
    subscribe: { op: 'subscribe', args: [{ channel: 'tickers', instId: 'PAXG-USDT' }] },
    parse(m) {
      const d = m && m.data && m.data[0];
      if (!d || !d.bidPx || !d.askPx) return null;
      return (Number(d.bidPx) + Number(d.askPx)) / 2;
    },
  },
  {
    id: 'binance',
    label: 'Binance',
    symbol: 'PAXG/USD',
    priority: 2,
    url: 'wss://data-stream.binance.vision/ws/paxgusdt@bookTicker',
    parse(m) {
      if (!m || !m.b || !m.a) return null;
      return (Number(m.b) + Number(m.a)) / 2;
    },
  },
  {
    id: 'binance2',
    label: 'Binance',
    symbol: 'PAXG/USD',
    priority: 2,
    url: 'wss://stream.binance.com:9443/ws/paxgusdt@bookTicker',
    parse(m) {
      if (!m || !m.b || !m.a) return null;
      return (Number(m.b) + Number(m.a)) / 2;
    },
  },
  {
    id: 'kraken',
    label: 'Kraken',
    symbol: 'PAXG/USD',
    priority: 3,
    url: 'wss://ws.kraken.com/v2',
    subscribe: { method: 'subscribe', params: { channel: 'ticker', symbol: ['PAXG/USD'], event_trigger: 'bbo' } },
    parse(m) {
      if (!m || m.channel !== 'ticker' || !m.data || !m.data[0]) return null;
      const d = m.data[0];
      if (typeof d.bid !== 'number' || typeof d.ask !== 'number') return null;
      return (d.bid + d.ask) / 2;
    },
  },
];

const REST_SOURCES = [
  {
    id: 'binance-rest',
    label: 'Binance',
    url: 'https://api.binance.com/api/v3/ticker/bookTicker?symbol=PAXGUSDT',
    parse: (j) => (j && j.bidPrice && j.askPrice ? (Number(j.bidPrice) + Number(j.askPrice)) / 2 : null),
  },
  {
    id: 'gold-api',
    label: 'Gold spot',
    url: 'https://api.gold-api.com/price/XAU',
    parse: (j) => (j && typeof j.price === 'number' ? j.price : null),
  },
];

const WS_RACE_TIMEOUT_MS = 5000; // no socket price within this → start REST polling
const DEMO_TIMEOUT_MS = 9000; // nothing at all within this → simulated prices
const REST_INTERVAL_MS = 1000;
const DEMO_INTERVAL_MS = 120;
const STALE_MS = 15000; // a live source silent this long is considered dead
const RECONNECT_MS = 2000;
const UPGRADE_GRACE_MS = 12000; // keep better-priority sockets open this long after a worse one wins
const DEFAULT_DEMO_PRICE = 4350;

// Quiet-market layer: when the real price has not changed for this long
// (weekends, holidays, dead minutes), micro-moves are simulated around the
// last real price so a 5-second round can still settle. The first real change
// snaps the price back to the market and ends the simulation.
const QUIET_AFTER_MS = 3000;
const QUIET_INTERVAL_MS = 120;
const QUIET_AMPLITUDE = 0.35; // max drift from the real price, in dollars

const isValid = (p) => typeof p === 'number' && Number.isFinite(p) && p > 100 && p < 100000;

/**
 * @param {{ onPrice: (price:number, meta:{source:string, mode:'live'|'poll'|'demo'|'quiet'}) => void,
 *           onStatus: (s:{mode:'connecting'|'live'|'poll'|'demo', source:string|null, quiet:boolean}) => void }} opts
 * @returns {() => void} stop
 */
function startLocalPriceFeed({ onPrice, onStatus }) {
  let stopped = false;
  let sockets = [];
  let active = null; // { id, label, ws }
  let restTimer = null;
  let demoTimer = null;
  let raceTimer = null;
  let demoFallbackTimer = null;
  let staleTimer = null;
  let reconnectTimer = null;
  let lastPrice = null;
  let mode = 'connecting';
  let source = null;

  // quiet-market layer state
  let lastRealPrice = null;
  let lastChangeAt = 0;
  let quiet = false;
  let quietOffset = 0;
  let quietWatch = null;
  let quietTimer = null;

  let symbol = null;
  let upgradeTimer = null;

  const setStatus = (next, src, sym) => {
    mode = next;
    source = src || null;
    if (sym !== undefined) symbol = sym;
    onStatus({ mode: next, source, symbol, quiet });
  };

  const clearTimers = () => {
    clearTimeout(raceTimer);
    clearTimeout(demoFallbackTimer);
    clearTimeout(staleTimer);
    clearTimeout(reconnectTimer);
    clearInterval(restTimer);
    clearInterval(demoTimer);
    clearInterval(quietWatch);
    clearInterval(quietTimer);
    clearTimeout(upgradeTimer);
    restTimer = demoTimer = quietWatch = quietTimer = null;
  };

  const stopQuiet = () => {
    if (!quiet) return;
    quiet = false;
    quietOffset = 0;
    clearInterval(quietTimer);
    quietTimer = null;
    onStatus({ mode, source, symbol, quiet });
  };

  const startQuiet = () => {
    if (quiet || stopped || lastRealPrice === null) return;
    quiet = true;
    quietOffset = 0;
    onStatus({ mode, source, symbol, quiet });
    quietTimer = setInterval(() => {
      if (stopped) return;
      // Bounded random walk with mean reversion so the simulated price never
      // drifts far from the real market.
      quietOffset += (Math.random() - 0.5) * 0.12 - quietOffset * 0.05;
      quietOffset = Math.max(-QUIET_AMPLITUDE, Math.min(QUIET_AMPLITUDE, quietOffset));
      const p = Math.round((lastRealPrice + quietOffset) * 100) / 100;
      lastPrice = p;
      onPrice(p, { source: 'quiet', mode: 'quiet' });
    }, QUIET_INTERVAL_MS);
  };

  // Watches for a market that has gone still while a real source is connected.
  quietWatch = setInterval(() => {
    if (stopped || lastRealPrice === null) return;
    if (mode !== 'live' && mode !== 'poll') return;
    if (!quiet && Date.now() - lastChangeAt > QUIET_AFTER_MS) startQuiet();
  }, 250);

  const closeAll = () => {
    for (const s of sockets) {
      try {
        s.ws.onopen = s.ws.onmessage = s.ws.onerror = s.ws.onclose = null;
        s.ws.close();
      } catch {
        /* ignore */
      }
    }
    sockets = [];
    active = null;
  };

  const armStale = () => {
    clearTimeout(staleTimer);
    staleTimer = setTimeout(() => {
      if (stopped) return;
      // Live socket went quiet; restart the race without dropping to demo.
      clearTimeout(upgradeTimer);
      closeAll();
      startRace();
    }, STALE_MS);
  };

  const stopFallbacks = () => {
    clearInterval(restTimer);
    clearInterval(demoTimer);
    restTimer = demoTimer = null;
    clearTimeout(raceTimer);
    clearTimeout(demoFallbackTimer);
  };

  const deliver = (price, src, m) => {
    if (stopped || !isValid(price)) return;
    if (m === 'live' || m === 'poll') {
      const changed = price !== lastRealPrice;
      lastRealPrice = price;
      if (changed) {
        lastChangeAt = Date.now();
        if (quiet) stopQuiet(); // real move: snap back to the market
      } else if (quiet) {
        return; // unchanged real quote while simulating: keep the simulation
      }
    }
    lastPrice = price;
    onPrice(price, { source: src, mode: m });
  };

  const startDemo = () => {
    if (demoTimer || stopped) return;
    let p = lastPrice || DEFAULT_DEMO_PRICE;
    stopQuiet();
    setStatus('demo', null, null);
    demoTimer = setInterval(() => {
      p += (Math.random() - 0.5) * 0.4 + (Math.random() - 0.5) * 0.1;
      deliver(p, 'demo', 'demo');
    }, DEMO_INTERVAL_MS);
  };

  const startRest = () => {
    if (restTimer || stopped) return;
    let idx = 0;
    const poll = async () => {
      if (stopped || mode === 'live') return;
      const src = REST_SOURCES[idx % REST_SOURCES.length];
      try {
        const r = await fetch(src.url, { cache: 'no-store' });
        const p = src.parse(await r.json());
        if (isValid(p)) {
          if (demoTimer) {
            clearInterval(demoTimer);
            demoTimer = null;
          }
          if (mode !== 'poll') setStatus('poll', src.label, src.symbol || 'PAXG/USD');
          deliver(p, src.id, 'poll');
          return;
        }
      } catch {
        /* try the next source on the following tick */
      }
      idx += 1;
    };
    poll();
    restTimer = setInterval(poll, REST_INTERVAL_MS);
  };

  const startRace = () => {
    if (stopped) return;
    if (typeof WebSocket === 'undefined') {
      startRest();
      demoFallbackTimer = setTimeout(() => {
        if (mode === 'connecting') startDemo();
      }, DEMO_TIMEOUT_MS);
      return;
    }
    if (mode !== 'live') setStatus('connecting', null, null);

    const closeEntry = (e) => {
      try {
        e.ws.onopen = e.ws.onmessage = e.ws.onerror = e.ws.onclose = null;
        e.ws.close();
      } catch {
        /* ignore */
      }
    };

    // Make `entry` the active source. Sockets that are not better than it are
    // closed; better ones stay open for a grace period in case they start
    // ticking (for example the broker feed connecting a moment later).
    const promote = (entry) => {
      active = entry;
      sockets = sockets.filter((s) => {
        if (s === entry) return true;
        if (s.priority < entry.priority) return true;
        closeEntry(s);
        return false;
      });
      clearTimeout(upgradeTimer);
      if (sockets.length > 1) {
        upgradeTimer = setTimeout(() => {
          sockets = sockets.filter((s) => {
            if (s === active) return true;
            closeEntry(s);
            return false;
          });
        }, UPGRADE_GRACE_MS);
      }
      stopFallbacks();
      setStatus('live', entry.label, entry.symbol);
    };

    sockets = WS_SOURCES.map((src) => {
      let ws;
      try {
        ws = new WebSocket(src.url);
      } catch {
        return null;
      }
      const entry = { id: src.id, label: src.label, symbol: src.symbol || 'PAXG/USD', priority: src.priority ?? 9, ws };
      ws.onopen = () => {
        const msgs = src.subscribeMany || (src.subscribe ? [src.subscribe] : []);
        for (const m of msgs) {
          try {
            ws.send(JSON.stringify(m));
          } catch {
            /* ignore */
          }
        }
      };
      ws.onmessage = (ev) => {
        if (stopped) return;
        let parsed = null;
        try {
          parsed = src.parse(JSON.parse(ev.data));
        } catch {
          return;
        }
        const price = parsed && typeof parsed === 'object' ? parsed.price : parsed;
        if (!isValid(price)) return;
        if (parsed && typeof parsed === 'object') {
          const nextLabel = parsed.label || entry.label;
          const nextSymbol = parsed.symbol || entry.symbol;
          if (nextLabel !== entry.label || nextSymbol !== entry.symbol) {
            entry.label = nextLabel;
            entry.symbol = nextSymbol;
            if (active === entry) setStatus('live', entry.label, entry.symbol);
          }
        }
        if (!active || entry.priority < active.priority) promote(entry);
        if (active !== entry) return;
        armStale();
        deliver(price, src.id, 'live');
      };
      const onDrop = () => {
        if (stopped) return;
        if (active === entry) {
          active = null;
          clearTimeout(staleTimer);
          clearTimeout(upgradeTimer);
          for (const s of sockets) if (s !== entry) closeEntry(s);
          sockets = [];
          reconnectTimer = setTimeout(startRace, RECONNECT_MS);
        } else {
          sockets = sockets.filter((s) => s !== entry);
        }
      };
      ws.onerror = onDrop;
      ws.onclose = onDrop;
      return entry;
    }).filter(Boolean);

    raceTimer = setTimeout(() => {
      if (!active && mode !== 'live') startRest();
    }, WS_RACE_TIMEOUT_MS);
    demoFallbackTimer = setTimeout(() => {
      if (!active && lastPrice === null) startDemo();
    }, DEMO_TIMEOUT_MS);
  };

  console.info('[feed] sources:', WS_SOURCES.map((s) => `${s.id}(p${s.priority})`).join(', '));
  startRace();

  return () => {
    stopped = true;
    quiet = false;
    clearTimers();
    closeAll();
  };
}

/**
 * Server mode: the ONLY source is the game socket's price frames - no exchange sockets, no
 * REST polling, no quiet-market simulation. What the player sees is exactly what the server
 * will settle the round on. mode is 'connecting' (socket not open/authed yet), 'live' (a tick
 * within the last 3 s) or 'quiet' (none for 3 s) - see src/api/socket.js's onStatus.
 */
function startServerPriceFeed({ onPrice, onStatus }) {
  let stopped = false;
  let mode = 'connecting';
  // Ticket OD1: whether socket.js's own connectionRefused signature (see its comment) is
  // currently up - reported alongside mode, but on its own change, not mode's: it can flip
  // while mode stays 'connecting' the whole time, which report()'s mode-equality guard would
  // otherwise swallow.
  let connectionRefused = false;

  const emit = () => onStatus({ mode, source: null, symbol: 'XAU/USD', quiet: mode === 'quiet', connectionRefused });

  const report = (next) => {
    if (stopped || mode === next) return;
    mode = next;
    emit();
  };

  const offPrice = onSocketPrice((price) => {
    if (stopped) return;
    report('live');
    onPrice(price, { source: 'server', mode: 'live' });
  });

  const offStatus = onSocketStatus((s) => {
    if (stopped) return;
    const nextMode = !s.connected ? 'connecting' : s.quiet ? 'quiet' : 'live';
    const refused = Boolean(s.connectionRefused);
    const changed = nextMode !== mode || refused !== connectionRefused;
    mode = nextMode;
    connectionRefused = refused;
    if (changed) emit();
  });

  onStatus({ mode, source: null, symbol: 'XAU/USD', quiet: false, connectionRefused: false });
  connectSocket();

  return () => {
    stopped = true;
    offPrice();
    offStatus();
  };
}

/**
 * @param {{ onPrice: (price:number, meta:{source:string, mode:'live'|'poll'|'demo'|'quiet'}) => void,
 *           onStatus: (s:{mode:'connecting'|'live'|'poll'|'demo', source:string|null, quiet:boolean, connectionRefused?:boolean}) => void }} opts
 * @returns {() => void} stop
 */
export function startPriceFeed(opts) {
  return serverMode ? startServerPriceFeed(opts) : startLocalPriceFeed(opts);
}

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
 */

const WS_SOURCES = [
  {
    id: 'okx',
    label: 'OKX',
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
    url: 'wss://data-stream.binance.vision/ws/paxgusdt@bookTicker',
    parse(m) {
      if (!m || !m.b || !m.a) return null;
      return (Number(m.b) + Number(m.a)) / 2;
    },
  },
  {
    id: 'binance2',
    label: 'Binance',
    url: 'wss://stream.binance.com:9443/ws/paxgusdt@bookTicker',
    parse(m) {
      if (!m || !m.b || !m.a) return null;
      return (Number(m.b) + Number(m.a)) / 2;
    },
  },
  {
    id: 'kraken',
    label: 'Kraken',
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
const DEFAULT_DEMO_PRICE = 4350;

const isValid = (p) => typeof p === 'number' && Number.isFinite(p) && p > 100 && p < 100000;

/**
 * @param {{ onPrice: (price:number, meta:{source:string, mode:'live'|'poll'|'demo'}) => void,
 *           onStatus: (s:{mode:'connecting'|'live'|'poll'|'demo', source:string|null}) => void }} opts
 * @returns {() => void} stop
 */
export function startPriceFeed({ onPrice, onStatus }) {
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

  const setStatus = (next, source) => {
    mode = next;
    onStatus({ mode: next, source: source || null });
  };

  const clearTimers = () => {
    clearTimeout(raceTimer);
    clearTimeout(demoFallbackTimer);
    clearTimeout(staleTimer);
    clearTimeout(reconnectTimer);
    clearInterval(restTimer);
    clearInterval(demoTimer);
    restTimer = demoTimer = null;
  };

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
    lastPrice = price;
    onPrice(price, { source: src, mode: m });
  };

  const startDemo = () => {
    if (demoTimer || stopped) return;
    let p = lastPrice || DEFAULT_DEMO_PRICE;
    setStatus('demo', null);
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
          if (mode !== 'poll') setStatus('poll', src.label);
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
    if (mode !== 'live') setStatus('connecting', null);

    sockets = WS_SOURCES.map((src) => {
      let ws;
      try {
        ws = new WebSocket(src.url);
      } catch {
        return null;
      }
      const entry = { id: src.id, label: src.label, ws };
      ws.onopen = () => {
        if (src.subscribe) {
          try {
            ws.send(JSON.stringify(src.subscribe));
          } catch {
            /* ignore */
          }
        }
      };
      ws.onmessage = (ev) => {
        if (stopped) return;
        let price = null;
        try {
          price = src.parse(JSON.parse(ev.data));
        } catch {
          return;
        }
        if (!isValid(price)) return;
        if (!active) {
          // First socket with a real price wins; close the others.
          active = entry;
          for (const other of sockets) {
            if (other !== entry) {
              try {
                other.ws.onopen = other.ws.onmessage = other.ws.onerror = other.ws.onclose = null;
                other.ws.close();
              } catch {
                /* ignore */
              }
            }
          }
          sockets = [entry];
          stopFallbacks();
          setStatus('live', src.label);
        }
        if (active !== entry) return;
        armStale();
        deliver(price, src.id, 'live');
      };
      const onDrop = () => {
        if (stopped) return;
        if (active === entry) {
          active = null;
          sockets = [];
          clearTimeout(staleTimer);
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

  startRace();

  return () => {
    stopped = true;
    clearTimers();
    closeAll();
  };
}

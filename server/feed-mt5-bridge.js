/**
 * WebSocket adapter for our own MT5-under-Wine terminal + bridge (mt5/bridge.py,
 * docs/mt5-feed.md "Bridge route"). Same connect()/disconnect(),
 * onTick(rawPrice, t) / onState({connected}) contract as server/feed-mt5.js
 * (the MetaApi adapter) - server/feed.js treats either the same way and
 * never knows which one is behind the `mt5` source id.
 *
 * The bridge speaks a plain WebSocket protocol: one JSON object per tick
 * ({price, bid, ask, t}) or per login-state change
 * ({type:'status', connected}). Every message is validated before onTick
 * fires (finite price 100..100000, finite t); anything else is dropped.
 *
 * Reconnect/backoff is not this file's job: server/feed.js already retries
 * any custom source (calls connect() again, 1 s..30 s backoff) whenever
 * onState reports a drop after a good connection - the same mechanism the
 * plain-WebSocket sources in sourceDefs get. This adapter only needs to
 * resolve connect() once the socket is open and reject it if the socket
 * never comes up, so that outer retry loop has something to back off on.
 */

import { WebSocket } from 'ws';

const PRICE_MIN = 100;
const PRICE_MAX = 100000;
const isValidPrice = (p) => typeof p === 'number' && Number.isFinite(p) && p > PRICE_MIN && p < PRICE_MAX;
const isValidTime = (t) => typeof t === 'number' && Number.isFinite(t);

/**
 * @param {object} opts
 * @param {string} opts.url - MT5_BRIDGE_WS, e.g. ws://mt5:8765.
 * @param {(rawPrice: number, t: number) => void} opts.onTick
 * @param {(state: {connected: boolean}) => void} [opts.onState]
 * @param {typeof WebSocket} [opts._WebSocket] - test hook: replaces the `ws` client.
 */
export function createMt5BridgeSource({ url, onTick, onState, _WebSocket } = {}) {
  const WS = _WebSocket || WebSocket;
  let ws = null;
  let closed = false;

  function connect() {
    return new Promise((resolve, reject) => {
      closed = false;
      let settled = false;
      let sock;
      try {
        sock = new WS(url);
      } catch (err) {
        reject(err);
        return;
      }
      ws = sock;

      sock.on('open', () => {
        settled = true;
        if (!closed) onState?.({ connected: true });
        resolve();
      });

      sock.on('message', (buf) => {
        if (closed) return;
        let m;
        try {
          m = JSON.parse(buf.toString());
        } catch {
          return;
        }
        if (!m || typeof m !== 'object') return;
        if (m.type === 'status') {
          onState?.({ connected: Boolean(m.connected) });
          return;
        }
        if (isValidPrice(m.price) && isValidTime(m.t)) onTick(m.price, m.t);
      });

      sock.on('close', () => {
        if (closed) return;
        if (!settled) {
          settled = true;
          reject(new Error('mt5 bridge socket closed before opening'));
          return;
        }
        onState?.({ connected: false });
      });

      sock.on('error', (err) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
        // Once open, an error is followed by a close event; that branch above
        // is what reports the drop, so there is nothing else to do here.
      });
    });
  }

  function disconnect() {
    closed = true;
    const sock = ws;
    ws = null;
    if (!sock) return Promise.resolve();
    sock.removeAllListeners();
    sock.on('error', () => {}); // close() on a CONNECTING socket emits error; never let it crash the process
    try {
      sock.close();
    } catch {
      /* ignore */
    }
    return Promise.resolve();
  }

  return { connect, disconnect };
}

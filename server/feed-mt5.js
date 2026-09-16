/**
 * Adapter around the MetaApi Node SDK (docs/mt5-feed.md, "Buy: hosted
 * bridge"). Isolated from server/feed.js so the feed stays dependency-light:
 * `metaapi.cloud-sdk` pulls a large, old-pinned dependency tree (socket.io
 * v2, crypto-browserify, native bufferutil/utf-8-validate bindings), so it is
 * NOT a package.json dependency here. It is loaded with a dynamic import()
 * only when createMt5Source().connect() actually runs, and only the box that
 * hooks MT5 up needs it installed (docs/mt5-feed.md, "Hook-up procedure").
 *
 * This keeps the SDK swappable for a plain WebSocket bridge later (the
 * "Implement: own terminal + bridge" route in docs/mt5-feed.md) without
 * touching feed.js: createMt5Source's shape - connect()/disconnect(), and
 * onTick(rawPrice, t) / onState({connected}) callbacks - is the only contract
 * feed.js relies on.
 */

/**
 * @param {object} opts
 * @param {string} opts.token - MetaApi API token (METAAPI_TOKEN).
 * @param {string} opts.accountId - MetaApi account id (METAAPI_ACCOUNT_ID).
 * @param {string} [opts.symbol] - broker symbol to subscribe to (METAAPI_SYMBOL, default XAUUSD).
 * @param {(rawPrice: number, t: number) => void} opts.onTick - called with the mid price and broker time on every accepted price update.
 * @param {(state: {connected: boolean}) => void} [opts.onState] - called when the streaming connection comes up or drops.
 * @param {() => Promise<any>} [opts._loadSdk] - test hook: replaces the dynamic import of metaapi.cloud-sdk with a fake module loader.
 */
export function createMt5Source({ token, accountId, symbol = 'XAUUSD', onTick, onState, _loadSdk } = {}) {
  // The package's bare entry resolves to its browser bundle under Node's ESM `import`
  // condition (it references `window`); `esm-node` is the Node build.
  const loadSdk = _loadSdk || (() => import('metaapi.cloud-sdk/esm-node').then((m) => m.default || m));

  let connection = null;
  let listener = null;
  let closed = false;

  async function connect() {
    closed = false;
    const MetaApi = await loadSdk();
    const api = new MetaApi(token);
    const account = await api.metatraderAccountApi.getAccount(accountId);
    connection = account.getStreamingConnection();

    listener = {
      onConnected: async () => {
        if (!closed) onState?.({ connected: true });
      },
      onDisconnected: async () => {
        if (!closed) onState?.({ connected: false });
      },
      onSymbolPriceUpdated: async (instanceIndex, price) => {
        if (closed || !price) return;
        const bid = Number(price.bid);
        const ask = Number(price.ask);
        if (!Number.isFinite(bid) || !Number.isFinite(ask)) return;
        const mid = (bid + ask) / 2;
        const brokerTime = price.time instanceof Date ? price.time.getTime() : Date.parse(price.brokerTime || '');
        onTick(mid, Number.isFinite(brokerTime) ? brokerTime : Date.now());
      },
    };
    connection.addSynchronizationListener(listener);

    await connection.connect();
    await connection.waitSynchronized();
    await connection.subscribeToMarketData(symbol);
    if (!closed) onState?.({ connected: true });
  }

  async function disconnect() {
    closed = true;
    const conn = connection;
    const lis = listener;
    connection = null;
    listener = null;
    if (!conn) return;
    try {
      if (lis) conn.removeSynchronizationListener(lis);
      await conn.unsubscribeFromMarketData(symbol);
      await conn.close();
    } catch {
      /* best-effort teardown: the process is tearing this source down anyway */
    }
  }

  return { connect, disconnect };
}

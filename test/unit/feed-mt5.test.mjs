// Unit tests for server/feed-mt5.js, the MetaApi adapter. No network: the SDK
// is replaced with a fake module via the _loadSdk test hook, so these never
// touch metaapi.cloud-sdk (not installed here - see docs/mt5-feed.md).
// Run: node --test test/unit/feed-mt5.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createMt5Source } from '../../server/feed-mt5.js';

/** A fake MetaApi SDK narrow enough to drive the adapter's contract. */
function fakeSdk() {
  const calls = {
    constructedWith: null,
    getAccountWith: null,
    subscribeWith: null,
    unsubscribeWith: null,
    connectCalled: 0,
    waitSynchronizedCalled: 0,
    closeCalled: 0,
    addListenerCalled: 0,
    removeListenerCalled: 0,
  };
  let listener = null;

  const connection = {
    addSynchronizationListener(l) {
      calls.addListenerCalled++;
      listener = l;
    },
    removeSynchronizationListener(l) {
      calls.removeListenerCalled++;
      assert.equal(l, listener, 'removes the exact listener it added');
      // Deliberately NOT nulled here: a couple of tests fire the listener
      // directly after disconnect() to prove the adapter's own `closed`
      // guard (not just "there is no listener left to call") suppresses it.
    },
    async connect() {
      calls.connectCalled++;
    },
    async waitSynchronized() {
      calls.waitSynchronizedCalled++;
    },
    async subscribeToMarketData(symbol) {
      calls.subscribeWith = symbol;
    },
    async unsubscribeFromMarketData(symbol) {
      calls.unsubscribeWith = symbol;
    },
    async close() {
      calls.closeCalled++;
    },
  };

  const account = { getStreamingConnection: () => connection };

  function MetaApi(token) {
    calls.constructedWith = token;
    this.metatraderAccountApi = {
      async getAccount(accountId) {
        calls.getAccountWith = accountId;
        return account;
      },
    };
  }

  return {
    calls,
    connection,
    loadSdk: async () => MetaApi,
    fireConnected: () => listener?.onConnected(),
    fireDisconnected: () => listener?.onDisconnected(),
    firePrice: (price) => listener?.onSymbolPriceUpdated(0, price),
  };
}

test('connect() drives the SDK: constructs with the token, fetches the account, subscribes to the symbol', async () => {
  const sdk = fakeSdk();
  const source = createMt5Source({
    token: 'tok-123',
    accountId: 'acct-456',
    symbol: 'XAUUSD',
    onTick: () => {},
    _loadSdk: sdk.loadSdk,
  });
  await source.connect();
  assert.equal(sdk.calls.constructedWith, 'tok-123');
  assert.equal(sdk.calls.getAccountWith, 'acct-456');
  assert.equal(sdk.calls.connectCalled, 1);
  assert.equal(sdk.calls.waitSynchronizedCalled, 1);
  assert.equal(sdk.calls.subscribeWith, 'XAUUSD');
  assert.equal(sdk.calls.addListenerCalled, 1);
});

test('defaults the symbol to XAUUSD when none is given', async () => {
  const sdk = fakeSdk();
  const source = createMt5Source({ token: 't', accountId: 'a', onTick: () => {}, _loadSdk: sdk.loadSdk });
  await source.connect();
  assert.equal(sdk.calls.subscribeWith, 'XAUUSD');
});

test('onState(connected:true) fires once subscribeToMarketData resolves', async () => {
  const sdk = fakeSdk();
  const states = [];
  const source = createMt5Source({
    token: 't',
    accountId: 'a',
    onTick: () => {},
    onState: (s) => states.push(s),
    _loadSdk: sdk.loadSdk,
  });
  await source.connect();
  assert.deepEqual(states, [{ connected: true }]);
});

test('onConnected/onDisconnected synchronization callbacks map to onState', async () => {
  const sdk = fakeSdk();
  const states = [];
  const source = createMt5Source({
    token: 't',
    accountId: 'a',
    onTick: () => {},
    onState: (s) => states.push(s),
    _loadSdk: sdk.loadSdk,
  });
  await source.connect();
  states.length = 0; // clear the initial connected state from connect() itself
  await sdk.fireDisconnected();
  await sdk.fireConnected();
  assert.deepEqual(states, [{ connected: false }, { connected: true }]);
});

test('a price update maps bid/ask to mid and broker time to t', async () => {
  const sdk = fakeSdk();
  const ticks = [];
  const source = createMt5Source({
    token: 't',
    accountId: 'a',
    onTick: (price, t) => ticks.push({ price, t }),
    _loadSdk: sdk.loadSdk,
  });
  await source.connect();
  await sdk.firePrice({ bid: 4355.1, ask: 4355.3, time: new Date('2026-09-16T10:00:00.000Z') });
  assert.equal(ticks.length, 1);
  // The adapter publishes the raw mid; feed.js's own round3 does the rounding
  // (docs/mt5-feed.md: "same validation... same continuous-series offset").
  assert.ok(Math.abs(ticks[0].price - 4355.2) < 1e-9);
  assert.equal(ticks[0].t, Date.parse('2026-09-16T10:00:00.000Z'));
});

test('falls back to brokerTime string, then to Date.now() when neither is present', async () => {
  const sdk = fakeSdk();
  const ticks = [];
  const source = createMt5Source({
    token: 't',
    accountId: 'a',
    onTick: (price, t) => ticks.push({ price, t }),
    _loadSdk: sdk.loadSdk,
  });
  await source.connect();

  await sdk.firePrice({ bid: 4355.0, ask: 4355.2, brokerTime: '2026-09-16 10:00:05.000' });
  assert.equal(ticks[0].t, Date.parse('2026-09-16 10:00:05.000'));

  const before = Date.now();
  await sdk.firePrice({ bid: 4355.0, ask: 4355.2 });
  const after = Date.now();
  assert.ok(ticks[1].t >= before && ticks[1].t <= after, 'falls back to Date.now()');
});

test('a price update with a non-numeric bid or ask is ignored', async () => {
  const sdk = fakeSdk();
  const ticks = [];
  const source = createMt5Source({
    token: 't',
    accountId: 'a',
    onTick: (price, t) => ticks.push({ price, t }),
    _loadSdk: sdk.loadSdk,
  });
  await source.connect();
  await sdk.firePrice({ bid: 'x', ask: 4355.2 });
  await sdk.firePrice({ bid: 4355.0, ask: undefined });
  await sdk.firePrice(null);
  assert.equal(ticks.length, 0);
});

test('disconnect() unsubscribes, removes the listener and closes the connection', async () => {
  const sdk = fakeSdk();
  const source = createMt5Source({
    token: 't',
    accountId: 'a',
    symbol: 'XAUUSD',
    onTick: () => {},
    _loadSdk: sdk.loadSdk,
  });
  await source.connect();
  await source.disconnect();
  assert.equal(sdk.calls.unsubscribeWith, 'XAUUSD');
  assert.equal(sdk.calls.removeListenerCalled, 1);
  assert.equal(sdk.calls.closeCalled, 1);
});

test('disconnect() before connect() is a safe no-op', async () => {
  const sdk = fakeSdk();
  const source = createMt5Source({ token: 't', accountId: 'a', onTick: () => {}, _loadSdk: sdk.loadSdk });
  await assert.doesNotReject(() => source.disconnect());
  assert.equal(sdk.calls.closeCalled, 0);
});

test('price updates and disconnect callbacks after disconnect() are ignored (closed flag)', async () => {
  const sdk = fakeSdk();
  const ticks = [];
  const states = [];
  const source = createMt5Source({
    token: 't',
    accountId: 'a',
    onTick: (price, t) => ticks.push({ price, t }),
    onState: (s) => states.push(s),
    _loadSdk: sdk.loadSdk,
  });
  await source.connect();
  await source.disconnect();
  states.length = 0;
  await sdk.fireDisconnected();
  await sdk.firePrice({ bid: 4355.0, ask: 4355.2 });
  assert.deepEqual(states, [], 'no state callback once closed');
  assert.equal(ticks.length, 0, 'no tick once closed, even if the SDK still calls the old listener');
});

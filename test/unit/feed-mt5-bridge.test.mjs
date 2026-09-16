// Unit tests for server/feed-mt5-bridge.js, the WebSocket adapter for our
// own MT5-under-Wine terminal + bridge (mt5/bridge.py). No real bridge: a
// fake WebSocket server (ws's own WebSocketServer, bound to an ephemeral
// port) drives the adapter through its real client socket.
// Run: node --test test/unit/feed-mt5-bridge.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';

import { createMt5BridgeSource } from '../../server/feed-mt5-bridge.js';

/** A fake bridge server: send(payload) broadcasts to every connected client. */
function fakeServer() {
  const wss = new WebSocketServer({ port: 0 });
  const clients = new Set();
  wss.on('connection', (ws) => clients.add(ws));
  return {
    wss,
    url: () => `ws://127.0.0.1:${wss.address().port}`,
    send(payload) {
      const msg = JSON.stringify(payload);
      for (const ws of clients) ws.send(msg);
    },
    sendRaw(raw) {
      for (const ws of clients) ws.send(raw);
    },
    closeClients() {
      for (const ws of clients) ws.close();
    },
    async close() {
      for (const ws of clients) ws.terminate();
      await new Promise((resolve) => wss.close(resolve));
    },
  };
}

test('messages become ticks: price/bid/ask/t pass straight to onTick', async () => {
  const server = fakeServer();
  const ticks = [];
  const source = createMt5BridgeSource({ url: server.url(), onTick: (price, t) => ticks.push({ price, t }) });
  await source.connect();
  server.send({ price: 4355.2, bid: 4355.1, ask: 4355.3, t: 1700000000000 });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(ticks, [{ price: 4355.2, t: 1700000000000 }]);
  await source.disconnect();
  await server.close();
});

test('invalid messages are dropped: out-of-range price, missing t, malformed JSON', async () => {
  const server = fakeServer();
  const ticks = [];
  const source = createMt5BridgeSource({ url: server.url(), onTick: (price, t) => ticks.push({ price, t }) });
  await source.connect();
  server.send({ price: 99, bid: 99, ask: 99.1, t: 1 }); // below PRICE_MIN
  server.send({ price: 4355.2, bid: 4355.1, ask: 4355.3, t: 'not-a-number' });
  server.send({ price: 'nope', t: 1700000000000 });
  server.sendRaw('not json at all');
  server.send({ type: 'status', connected: true }); // a status message, never a tick
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(ticks.length, 0);
  await source.disconnect();
  await server.close();
});

test('status messages map to onState', async () => {
  const server = fakeServer();
  const states = [];
  const source = createMt5BridgeSource({
    url: server.url(),
    onTick: () => {},
    onState: (s) => states.push(s),
  });
  await source.connect();
  states.length = 0; // clear the connected:true fired by connect() itself
  server.send({ type: 'status', connected: false });
  server.send({ type: 'status', connected: true });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(states, [{ connected: false }, { connected: true }]);
  await source.disconnect();
  await server.close();
});

test('connect() resolves and reports connected:true once the socket opens', async () => {
  const server = fakeServer();
  const states = [];
  const source = createMt5BridgeSource({
    url: server.url(),
    onTick: () => {},
    onState: (s) => states.push(s),
  });
  await source.connect();
  assert.deepEqual(states, [{ connected: true }]);
  await source.disconnect();
  await server.close();
});

test('connect() rejects when the socket never comes up', async () => {
  // Nothing listening on this port.
  const source = createMt5BridgeSource({ url: 'ws://127.0.0.1:1', onTick: () => {} });
  await assert.rejects(() => source.connect());
});

test('reconnect after close: a server-side close reports connected:false', async () => {
  const server = fakeServer();
  const states = [];
  const source = createMt5BridgeSource({
    url: server.url(),
    onTick: () => {},
    onState: (s) => states.push(s),
  });
  await source.connect();
  states.length = 0;
  server.closeClients();
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(states, [{ connected: false }]);
  await server.close();
});

test('disconnect() closes the socket and suppresses any late callback', async () => {
  const server = fakeServer();
  const ticks = [];
  const states = [];
  const source = createMt5BridgeSource({
    url: server.url(),
    onTick: (price, t) => ticks.push({ price, t }),
    onState: (s) => states.push(s),
  });
  await source.connect();
  await source.disconnect();
  states.length = 0;
  server.send({ price: 4355.2, bid: 4355.1, ask: 4355.3, t: 1700000000000 });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(ticks.length, 0);
  await server.close();
});

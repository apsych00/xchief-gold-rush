// Unit tests for deriveHealthUrl in src/api/socket.js (fix/socket-down-ux): the failed-open
// probe needs the same origin the socket itself is trying to reach, mapped from ws(s):// to
// http(s):// with the path swapped for /health (server/index.js, Caddyfile). No socket, no
// fetch - just the URL derivation.
//
// Run: node --test test/unit/socket-health-url.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { deriveHealthUrl } = await import('../../src/api/socket.js');

test('ws:// becomes http://, path swapped for /health', () => {
  assert.equal(deriveHealthUrl('ws://localhost:9/ws'), 'http://localhost:9/health');
});

test('wss:// becomes https://, path swapped for /health', () => {
  assert.equal(deriveHealthUrl('wss://play.xchief.example/ws'), 'https://play.xchief.example/health');
});

test('the auto same-origin case (already resolved to a concrete ws(s):// URL) maps the same way', () => {
  // resolveWsUrl() never leaves 'auto' in WS_URL - by the time deriveHealthUrl sees it, 'auto'
  // has already been resolved to `${protocol}://${host}/ws` against window.location. This is
  // that resolved shape.
  assert.equal(deriveHealthUrl('wss://booth.example/ws'), 'https://booth.example/health');
});

test('query and hash on the socket URL are dropped, not carried onto the health probe', () => {
  assert.equal(deriveHealthUrl('ws://localhost:8080/ws?k=abc#frag'), 'http://localhost:8080/health');
});

test('a missing or malformed URL returns null instead of throwing', () => {
  assert.equal(deriveHealthUrl(''), null);
  assert.equal(deriveHealthUrl(null), null);
  assert.equal(deriveHealthUrl('not a url'), null);
});

// Unit tests for the Instagram adapter (ticket B8):
// - state HMAC round-trip and tamper detection
// - authorizeUrl / exchangeCode / readMe success path
// - each documented error shape returned by the adapter
//
// Run: node --test test/unit/instagram.test.mjs

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.PLAYER_TOKEN_SECRET ??= 'unit-test-secret';

const { signInstagramState, readInstagramState } = await import('../../server/index.js');
const instagram = await import('../../server/instagram.js');
const { startFakeInstagram } = await import('../fakes/instagram.mjs');

const PLAYER_ID = '11111111-1111-4111-8111-111111111111';

let fake;

before(async () => {
  fake = await startFakeInstagram(0);
  process.env.INSTAGRAM_APP_ID = 'fake-app-id';
  process.env.INSTAGRAM_APP_SECRET = 'fake-app-secret';
  process.env.INSTAGRAM_REDIRECT_URI = 'https://goldrush.example.com/api/instagram/callback';
  process.env.INSTAGRAM_API_BASE = fake.url;
});

after(async () => {
  await fake.stop();
  delete process.env.INSTAGRAM_APP_ID;
  delete process.env.INSTAGRAM_APP_SECRET;
  delete process.env.INSTAGRAM_REDIRECT_URI;
  delete process.env.INSTAGRAM_API_BASE;
});

test('signInstagramState produces a state that readInstagramState verifies and extracts', () => {
  const state = signInstagramState(PLAYER_ID);
  assert.equal(readInstagramState(state), PLAYER_ID);
});

test('readInstagramState rejects a tampered state', () => {
  const state = signInstagramState(PLAYER_ID);
  const tampered = state.replace(/^./, state[0] === 'a' ? 'b' : 'a');
  assert.equal(readInstagramState(tampered), null);
});

test('readInstagramState rejects garbage', () => {
  assert.equal(readInstagramState('not-a-state'), null);
  assert.equal(readInstagramState(''), null);
  assert.equal(readInstagramState(null), null);
});

test('authorizeUrl returns the configured authorize URL with state', () => {
  const state = signInstagramState(PLAYER_ID);
  const result = instagram.authorizeUrl({ state });
  assert.equal(result.ok, true);
  const url = new URL(result.url);
  assert.equal(url.origin + url.pathname, `${fake.url}/oauth/authorize`);
  assert.equal(url.searchParams.get('client_id'), 'fake-app-id');
  assert.equal(url.searchParams.get('redirect_uri'), process.env.INSTAGRAM_REDIRECT_URI);
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('scope'), 'user_profile');
  assert.equal(url.searchParams.get('state'), state);
});

test('adapter exchanges a code and reads the user profile', async () => {
  const auth = instagram.authorizeUrl({ state: 'test-state' });

  // Simulate the user visiting the authorize URL and Instagram redirecting back.
  const authRes = await fetch(auth.url, { redirect: 'manual' });
  const location = authRes.headers.get('location');
  assert.ok(location, 'fake authorize returned a redirect location');
  const code = new URL(location).searchParams.get('code');
  assert.ok(code, 'redirect location contains a code');

  const exchanged = await instagram.exchangeCode({ code });
  assert.equal(exchanged.ok, true);
  assert.ok(exchanged.access_token);

  const me = await instagram.readMe({ token: exchanged.access_token });
  assert.equal(me.ok, true);
  assert.ok(me.id);
  assert.ok(me.username);
});

test('exchangeCode returns an error for an invalid code', async () => {
  const result = await instagram.exchangeCode({ code: 'invalid_code' });
  assert.equal(result.ok, false);
  assert.ok(result.code);
});

test('readMe returns an error for an invalid token', async () => {
  const result = await instagram.readMe({ token: 'invalid_token' });
  assert.equal(result.ok, false);
  assert.ok(result.code);
});

test('the adapter reports not_configured when env is incomplete', async () => {
  const appId = process.env.INSTAGRAM_APP_ID;
  delete process.env.INSTAGRAM_APP_ID;
  try {
    assert.equal(instagram.status(), 'not_configured');
    const auth = instagram.authorizeUrl({ state: 'x' });
    assert.equal(auth.ok, false);
    assert.equal(auth.code, 'not_configured');
    const exchanged = await instagram.exchangeCode({ code: 'x' });
    assert.equal(exchanged.ok, false);
    assert.equal(exchanged.code, 'not_configured');
    const me = await instagram.readMe({ token: 'x' });
    assert.equal(me.ok, false);
    assert.equal(me.code, 'not_configured');
  } finally {
    process.env.INSTAGRAM_APP_ID = appId;
  }
});

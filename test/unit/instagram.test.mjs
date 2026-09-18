// Unit tests for the BoxAPI Instagram adapter (ticket K3, replacing B8's OAuth adapter):
// - handle validation (normalizeHandle)
// - getUserByUsername / getFollowing against the fake BoxAPI
// - verifyFollow for a follower, a non-follower, a private account and an unknown handle
// - not_configured when the token is missing
//
// Run: node --test test/unit/instagram.test.mjs

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.PLAYER_TOKEN_SECRET ??= 'unit-test-secret';

const { normalizeHandle } = await import('../../server/index.js');
const instagram = await import('../../server/instagram.js');
const { startFakeBoxApi } = await import('../fakes/boxapi.mjs');

let fake;

before(async () => {
  fake = await startFakeBoxApi(0);
  process.env.BOXAPI_TOKEN = 'fake-token';
  process.env.BOXAPI_BASE = `${fake.url}/`;
  process.env.INSTAGRAM_HANDLE = 'xchief';
  instagram.resetCache();
});

after(async () => {
  await fake.stop();
  delete process.env.BOXAPI_TOKEN;
  delete process.env.BOXAPI_BASE;
  delete process.env.INSTAGRAM_HANDLE;
  instagram.resetCache();
});

test('normalizeHandle trims, lowercases and strips a leading @', () => {
  assert.equal(normalizeHandle('  @FollowER '), 'follower');
  assert.equal(normalizeHandle('user.name_1'), 'user.name_1');
});

test('normalizeHandle rejects empty, too long and out-of-charset handles', () => {
  assert.equal(normalizeHandle(''), null);
  assert.equal(normalizeHandle('   '), null);
  assert.equal(normalizeHandle('a'.repeat(31)), null);
  assert.equal(normalizeHandle('has space'), null);
  assert.equal(normalizeHandle('bad!char'), null);
  assert.equal(normalizeHandle(null), null);
});

test('status reflects the BOXAPI_TOKEN env', () => {
  assert.equal(instagram.status(), 'configured');
  const saved = process.env.BOXAPI_TOKEN;
  delete process.env.BOXAPI_TOKEN;
  try {
    assert.equal(instagram.status(), 'not_configured');
  } finally {
    process.env.BOXAPI_TOKEN = saved;
  }
});

test('getUserByUsername resolves a public account to id, username and privacy', async () => {
  const res = await instagram.getUserByUsername({ username: 'follower' });
  assert.equal(res.ok, true);
  assert.equal(res.username, 'follower');
  assert.equal(res.is_private, false);
  assert.ok(res.id);
});

test('getUserByUsername reports is_private for a private account', async () => {
  const res = await instagram.getUserByUsername({ username: 'privateuser' });
  assert.equal(res.ok, true);
  assert.equal(res.is_private, true);
});

test('getUserByUsername returns not_found for an unknown handle', async () => {
  const res = await instagram.getUserByUsername({ username: 'nobodyhere' });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'not_found');
});

test('getFollowing returns the set of ids/usernames the account follows', async () => {
  const them = await instagram.getUserByUsername({ username: 'follower' });
  const following = await instagram.getFollowing({ id: them.id, count: 200 });
  assert.equal(following.ok, true);
  assert.ok(following.usernames.has('xchief'));
});

test('verifyFollow returns ok for an account that follows us', async () => {
  const res = await instagram.verifyFollow({ handle: 'follower' });
  assert.deepEqual(res, { ok: true });
});

test('verifyFollow returns not_following for a public non-follower', async () => {
  const res = await instagram.verifyFollow({ handle: 'nonfollower' });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'not_following');
});

test('verifyFollow returns private for a private account (never reads the hidden list)', async () => {
  const res = await instagram.verifyFollow({ handle: 'privateuser' });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'private');
});

test('verifyFollow returns not_found for an unknown handle', async () => {
  const res = await instagram.verifyFollow({ handle: 'nobodyhere' });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'not_found');
});

test('verifyFollow returns not_configured when the token is missing', async () => {
  const saved = process.env.BOXAPI_TOKEN;
  delete process.env.BOXAPI_TOKEN;
  instagram.resetCache();
  try {
    const res = await instagram.verifyFollow({ handle: 'follower' });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'not_configured');
  } finally {
    process.env.BOXAPI_TOKEN = saved;
    instagram.resetCache();
  }
});

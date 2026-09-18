// Unit tests for the BoxAPI Instagram adapter (ticket K3, replacing B8's OAuth adapter):
// - handle validation (normalizeHandle)
// - getUserByUsername / getFollowers / getFollowing against the fake BoxAPI
// - verifyFollow via the primary our-followers path (fresh follower, private follower, paging,
//   the scan cap), the secondary player-following path, and the freshness retry
// - not_configured when the token is missing
//
// The retry delay is pinned to 0 so the loop runs instantly (server/instagram.js reads
// INSTAGRAM_RETRY_DELAY_MS at call time).
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
  process.env.INSTAGRAM_HANDLE = 'xchief.global';
  process.env.INSTAGRAM_RETRY_DELAY_MS = '0';
  instagram.resetCache();
});

after(async () => {
  await fake.stop();
  delete process.env.BOXAPI_TOKEN;
  delete process.env.BOXAPI_BASE;
  delete process.env.INSTAGRAM_HANDLE;
  delete process.env.INSTAGRAM_RETRY_DELAY_MS;
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

test('normalizeHandle accepts our dotted handle', () => {
  assert.equal(normalizeHandle('xchief.global'), 'xchief.global');
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

test('getFollowers reads a newest-first page of our follower list with paging metadata', async () => {
  const us = await instagram.getUserByUsername({ username: 'xchief.global' });
  const page = await instagram.getFollowers({ id: us.id });
  assert.equal(page.ok, true);
  // Page 1 holds the newest followers; the fake seeds privatefollower/follower at the top.
  assert.ok(page.usernames.has('follower'), 'follower is on the first page');
  assert.equal(page.hasMore, true, 'more pages remain');
  assert.ok(page.cursor, 'a paging cursor is returned while more remain');
});

test('getFollowing returns the set of ids/usernames the account follows', async () => {
  const them = await instagram.getUserByUsername({ username: 'follower' });
  const following = await instagram.getFollowing({ id: them.id, count: 200 });
  assert.equal(following.ok, true);
  assert.ok(following.usernames.has('xchief.global'));
});

test('verifyFollow returns ok for a follower on the first page of our followers', async () => {
  const res = await instagram.verifyFollow({ handle: 'follower' });
  assert.deepEqual(res, { ok: true });
});

test('verifyFollow confirms a PRIVATE player who is in our followers (immune to their privacy)', async () => {
  const res = await instagram.verifyFollow({ handle: 'privatefollower' });
  assert.deepEqual(res, { ok: true }, 'we read OUR follower list, never the private player list');
});

test('verifyFollow confirms a follower deeper in the list by paging', async () => {
  const res = await instagram.verifyFollow({ handle: 'deeppager' });
  assert.deepEqual(res, { ok: true });
});

test('verifyFollow does not page past the scan cap', async () => {
  const res = await instagram.verifyFollow({ handle: 'beyondcap' });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'not_following', 'a follower past the cap is not confirmed');
});

test('verifyFollow confirms via the secondary player-following path', async () => {
  // secondaryonly is not in our followers, but its own following list includes us.
  const res = await instagram.verifyFollow({ handle: 'secondaryonly' });
  assert.deepEqual(res, { ok: true });
});

test('verifyFollow returns not_following for a public account in neither list', async () => {
  const res = await instagram.verifyFollow({ handle: 'nonfollower' });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'not_following');
});

test('verifyFollow returns private for a private account in neither list', async () => {
  const res = await instagram.verifyFollow({ handle: 'privateuser' });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'private');
});

test('verifyFollow returns not_found for an unknown handle', async () => {
  const res = await instagram.verifyFollow({ handle: 'nobodyhere' });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'not_found');
});

test('verifyFollow retries through BoxAPI freshness lag on our follower list', async () => {
  // Isolate a single follower that BoxAPI only surfaces after two reads: the first two reads miss
  // it, the third (the second retry) sees it. INSTAGRAM_FOLLOWERS_READS defaults to 3.
  fake.reset();
  fake.setFollowers('xchief.global', ['freshfollower']);
  fake.setPendingFollower('freshfollower', 2);
  const res = await instagram.verifyFollow({ handle: 'freshfollower' });
  assert.deepEqual(res, { ok: true });
  fake.reset();
});

test('verifyFollow gives up when the follower never surfaces within the read budget', async () => {
  // Surfaces only after more reads than the budget allows -> stays not_following.
  fake.reset();
  fake.setFollowers('xchief.global', ['freshfollower']);
  fake.setPendingFollower('freshfollower', 99);
  const res = await instagram.verifyFollow({ handle: 'freshfollower' });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'not_following');
  fake.reset();
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

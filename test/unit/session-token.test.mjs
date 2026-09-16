// Unit tests for the player token functions in server/index.js (docs/layers.md C3a):
// signToken/verifyToken/needsRenewal. No database, no socket: verifyToken's DB lookup
// (players.token_version) is stubbed with an injected getVersion, and every function takes
// `now` as seconds since the epoch rather than reading the system clock, so a token can be
// minted "as if issued 8 days ago" without mocking Date.now().
//
// Run: node --test test/unit/session-token.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.PLAYER_TOKEN_SECRET ??= 'unit-test-secret';

const { signToken, verifyToken, needsRenewal } = await import('../../server/index.js');

const DAY = 24 * 60 * 60;
const NOW = 1_800_000_000; // an arbitrary fixed "now", in seconds
const PLAYER_ID = '11111111-1111-4111-8111-111111111111';

/** verifyToken always needs a version source; most cases here want a fixed current version. */
const versionIs = (v) => async () => v;

test('a token signed and verified at the same instant round-trips to the same player id', async () => {
  const token = signToken(PLAYER_ID, 1, NOW);
  const id = await verifyToken(token, { getVersion: versionIs(1), nowSeconds: NOW });
  assert.equal(id, PLAYER_ID);
});

test('a token format is <playerId>.<version>.<expiresAtSeconds>.<hmacHex>', () => {
  const token = signToken(PLAYER_ID, 3, NOW);
  const parts = token.split('.');
  assert.equal(parts.length, 4);
  assert.equal(parts[0], PLAYER_ID);
  assert.equal(parts[1], '3');
  assert.equal(Number(parts[2]), NOW + 30 * DAY);
  assert.match(parts[3], /^[0-9a-f]{64}$/);
});

test('a token past its expiresAt fails verification, not just close to it', async () => {
  const issuedLongAgo = NOW - 31 * DAY;
  const token = signToken(PLAYER_ID, 1, issuedLongAgo); // expiresAt = issuedLongAgo + 30d, already before NOW
  const id = await verifyToken(token, { getVersion: versionIs(1), nowSeconds: NOW });
  assert.equal(id, null);
});

test('a token issued 29 days ago (1 day left) still verifies', async () => {
  const token = signToken(PLAYER_ID, 1, NOW - 29 * DAY);
  const id = await verifyToken(token, { getVersion: versionIs(1), nowSeconds: NOW });
  assert.equal(id, PLAYER_ID);
});

test('a version that no longer matches players.token_version fails verification', async () => {
  const token = signToken(PLAYER_ID, 1, NOW);
  const id = await verifyToken(token, { getVersion: versionIs(2), nowSeconds: NOW });
  assert.equal(id, null, 'revoke_player_sessions bumped the db version past what this token carries');
});

test('an unknown player (no token_version row) fails verification', async () => {
  const token = signToken(PLAYER_ID, 1, NOW);
  const id = await verifyToken(token, { getVersion: versionIs(null), nowSeconds: NOW });
  assert.equal(id, null);
});

test('a tampered signature fails verification even with an otherwise valid token', async () => {
  const token = signToken(PLAYER_ID, 1, NOW);
  const parts = token.split('.');
  const flipped = parts[3][0] === '0' ? '1' : '0';
  const tampered = [...parts.slice(0, 3), flipped + parts[3].slice(1)].join('.');
  const id = await verifyToken(tampered, { getVersion: versionIs(1), nowSeconds: NOW });
  assert.equal(id, null);
});

test('a tampered payload (version bumped by the client itself) fails verification', async () => {
  const token = signToken(PLAYER_ID, 1, NOW);
  const [id, , expiresAt, sig] = token.split('.');
  const forged = [id, '99', expiresAt, sig].join('.');
  const result = await verifyToken(forged, { getVersion: versionIs(99), nowSeconds: NOW });
  assert.equal(result, null, 'the signature was computed over version 1, not the forged 99');
});

test('the old two-field id.sig format is simply invalid, never a legacy fallback', async () => {
  const oldStyleSig = crypto.createHmac('sha256', process.env.PLAYER_TOKEN_SECRET).update(PLAYER_ID).digest('hex');
  const oldToken = `${PLAYER_ID}.${oldStyleSig}`;
  const id = await verifyToken(oldToken, { getVersion: versionIs(1), nowSeconds: NOW });
  assert.equal(id, null);
});

test('garbage input is invalid, not a thrown error', async () => {
  assert.equal(await verifyToken(null, { getVersion: versionIs(1), nowSeconds: NOW }), null);
  assert.equal(await verifyToken(undefined, { getVersion: versionIs(1), nowSeconds: NOW }), null);
  assert.equal(await verifyToken('not-a-real-token', { getVersion: versionIs(1), nowSeconds: NOW }), null);
  assert.equal(await verifyToken('a.b.c.d', { getVersion: versionIs(1), nowSeconds: NOW }), null);
});

test('needsRenewal is false for a token issued less than 7 days ago', () => {
  const token = signToken(PLAYER_ID, 1, NOW - 3 * DAY);
  assert.equal(needsRenewal(token, NOW), false);
});

test('needsRenewal is true for a token issued more than 7 days ago', () => {
  const token = signToken(PLAYER_ID, 1, NOW - 8 * DAY);
  assert.equal(needsRenewal(token, NOW), true);
});

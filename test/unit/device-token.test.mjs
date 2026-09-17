// Unit tests for the device token functions in server/index.js (ticket B5,
// docs/tickets/b5-device-identity.md decision 2): signDeviceToken/verifyDeviceToken. No
// database, no socket - the token is a pure signature over an id, with no version and no
// expiry to check, unlike the player token in session-token.test.mjs.
//
// Run: node --test test/unit/device-token.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.PLAYER_TOKEN_SECRET ??= 'unit-test-secret';

const { signDeviceToken, verifyDeviceToken } = await import('../../server/index.js');

const DEVICE_ID = '22222222-2222-4222-8222-222222222222';

test('a device token signed and verified round-trips to the same device id', () => {
  const token = signDeviceToken(DEVICE_ID);
  assert.equal(verifyDeviceToken(token), DEVICE_ID);
});

test('a device token format is <deviceId>.<hmacHex>, no version and no expiry field', () => {
  const token = signDeviceToken(DEVICE_ID);
  const parts = token.split('.');
  assert.equal(parts.length, 2);
  assert.equal(parts[0], DEVICE_ID);
  assert.match(parts[1], /^[0-9a-f]{64}$/);
});

test('a tampered signature fails verification', () => {
  const token = signDeviceToken(DEVICE_ID);
  const [id, sig] = token.split('.');
  const flipped = sig[0] === '0' ? '1' : '0';
  const tampered = `${id}.${flipped}${sig.slice(1)}`;
  assert.equal(verifyDeviceToken(tampered), null);
});

test('a tampered id (client forging a different device) fails verification', () => {
  const token = signDeviceToken(DEVICE_ID);
  const [, sig] = token.split('.');
  const otherId = '33333333-3333-4333-8333-333333333333';
  const forged = `${otherId}.${sig}`;
  assert.equal(verifyDeviceToken(forged), null, 'the signature was computed over the original id, not the forged one');
});

test('a missing or garbage token is invalid, not a thrown error', () => {
  assert.equal(verifyDeviceToken(null), null);
  assert.equal(verifyDeviceToken(undefined), null);
  assert.equal(verifyDeviceToken(''), null);
  assert.equal(verifyDeviceToken('not-a-real-token'), null);
  assert.equal(verifyDeviceToken('a.b.c'), null, 'three fields is the player-token shape, not the two-field device shape');
});

test('the old-format four-field player token is not a valid device token', () => {
  assert.equal(verifyDeviceToken(`${DEVICE_ID}.1.1234567890.deadbeef`), null);
});

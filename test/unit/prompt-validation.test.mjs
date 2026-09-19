// Unit coverage for the unified email/OTP prompt's client-side validation (unify-email-modal
// ticket, src/promptValidation.js). PromptModal.jsx imports these same two functions, so this is
// the one place the rule is tested, not a copy of it.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isValidCode, isValidEmail } from '../../src/promptValidation.js';

test('isValidEmail accepts ordinary addresses', () => {
  assert.equal(isValidEmail('player@example.com'), true);
  assert.equal(isValidEmail('a.b+tag@sub.example.co'), true);
});

test('isValidEmail trims surrounding whitespace before checking', () => {
  assert.equal(isValidEmail('  player@example.com  '), true);
});

test('isValidEmail rejects the shapes a human is likely to type by mistake', () => {
  assert.equal(isValidEmail(''), false);
  assert.equal(isValidEmail('not-an-email'), false);
  assert.equal(isValidEmail('missing-at.example.com'), false);
  assert.equal(isValidEmail('two@@example.com'), false);
  assert.equal(isValidEmail('trailing-dot@example.'), false);
  assert.equal(isValidEmail('spaced name@example.com'), false);
  assert.equal(isValidEmail(null), false);
  assert.equal(isValidEmail(undefined), false);
});

test('isValidCode accepts exactly the configured number of digits', () => {
  assert.equal(isValidCode('12345678', 8), true);
  assert.equal(isValidCode('123456', 6), true);
});

test('isValidCode rejects the wrong length in either direction', () => {
  assert.equal(isValidCode('1234567', 8), false);
  assert.equal(isValidCode('123456789', 8), false);
  assert.equal(isValidCode('', 8), false);
});

test('isValidCode rejects non-digit characters even at the right length', () => {
  assert.equal(isValidCode('1234abcd', 8), false);
  assert.equal(isValidCode('12 34 567', 8), false);
});

test('isValidCode defaults to a 4-digit code, matching every OTP the server issues', () => {
  assert.equal(isValidCode('1234'), true);
  assert.equal(isValidCode('12345678'), false);
});

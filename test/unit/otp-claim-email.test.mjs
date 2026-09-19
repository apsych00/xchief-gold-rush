// Unit tests for server/otp.js's sendClaimCode (docs/email-gift-card-template.md): the wiring
// between a claimed prize and the Elastic Mail send, not the mail provider itself. Nothing here
// hits Elastic - global.fetch is stubbed, same pattern as test/unit/ads-warmup.test.mjs and
// test/unit/alerts.test.mjs.
//
// Covered: with ELASTIC_CLAIM_TEMPLATE_ID set, the request carries the template id and the
// {code}/{expires_at}/{claim_url} merge fields; without one, it falls back to the original
// plain-text body; without ELASTIC_API_KEY at all, nothing is sent; and a send failure rejects
// the promise instead of throwing synchronously, which is what lets the caller's fire-and-forget
// .catch() (server/index.js's handleClaimPost) log it without ever touching the claim that
// already committed in Postgres.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { sendClaimCode } = await import('../../server/otp.js');

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_ENV = {
  ELASTIC_API_KEY: process.env.ELASTIC_API_KEY,
  ELASTIC_CLAIM_TEMPLATE_ID: process.env.ELASTIC_CLAIM_TEMPLATE_ID,
  OTP_SENDER: process.env.OTP_SENDER,
};

function resetEnv() {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  globalThis.fetch = ORIGINAL_FETCH;
}

function installFetchMock(response = { ok: true, json: async () => ({ success: true }) }) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return response;
  };
  return calls;
}

function formParams(call) {
  return new URLSearchParams(call.init.body);
}

test('with a template id set, sendClaimCode sends the template and its merge fields', async (t) => {
  t.after(resetEnv);
  process.env.ELASTIC_API_KEY = 'test-key';
  process.env.ELASTIC_CLAIM_TEMPLATE_ID = 'gift-card-template-123';
  const calls = installFetchMock();

  await sendClaimCode('winner@example.com', 'XCH-CODE-0001', {
    claimUrl: 'https://goldrush.xchief.academy/claim/sample-token',
  });

  assert.equal(calls.length, 1, 'exactly one send');
  assert.equal(calls[0].url, 'https://api.elasticemail.com/v2/email/send');
  const params = formParams(calls[0]);
  assert.equal(params.get('apikey'), 'test-key');
  assert.equal(params.get('to'), 'winner@example.com');
  assert.equal(params.get('template'), 'gift-card-template-123');
  assert.equal(params.get('merge_code'), 'XCH-CODE-0001');
  assert.equal(params.get('merge_claim_url'), 'https://goldrush.xchief.academy/claim/sample-token');
  assert.ok(params.get('merge_expires_at'), 'merge_expires_at is set');
  // Human-readable, not a raw ISO timestamp or epoch number.
  assert.match(params.get('merge_expires_at'), /^[A-Z][a-z]+ \d{1,2}, \d{4}$/);
  assert.equal(params.has('bodyText'), false, 'the plain-text body is not sent alongside a template');
});

test('sendClaimCode\'s expiry is about 30 days out, matching the email copy', async (t) => {
  t.after(resetEnv);
  process.env.ELASTIC_API_KEY = 'test-key';
  process.env.ELASTIC_CLAIM_TEMPLATE_ID = 'gift-card-template-123';
  const calls = installFetchMock();

  const before = Date.now();
  await sendClaimCode('winner@example.com', 'XCH-CODE-0001', { claimUrl: null });
  const after = Date.now();

  const expiresAtText = formParams(calls[0]).get('merge_expires_at');
  const expiresAt = Date.parse(expiresAtText);
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  // formatExpiry renders a calendar day (UTC midnight), not a timestamp, so it can read up to a
  // day earlier than the exact 30*24h mark depending on the time of day this test runs.
  assert.ok(expiresAt >= before + THIRTY_DAYS_MS - ONE_DAY_MS, 'expiry is not sooner than ~30 days out');
  assert.ok(expiresAt <= after + THIRTY_DAYS_MS + ONE_DAY_MS, 'expiry is not much later than 30 days out');
});

test('without a template id, sendClaimCode falls back to the plain-text body', async (t) => {
  t.after(resetEnv);
  process.env.ELASTIC_API_KEY = 'test-key';
  delete process.env.ELASTIC_CLAIM_TEMPLATE_ID;
  const calls = installFetchMock();

  await sendClaimCode('winner@example.com', 'XCH-CODE-0002', {
    claimUrl: 'https://goldrush.xchief.academy/claim/sample-token',
  });

  assert.equal(calls.length, 1);
  const params = formParams(calls[0]);
  assert.equal(params.has('template'), false, 'no template param without a configured id');
  assert.equal(params.has('merge_code'), false);
  assert.ok(params.get('bodyText').includes('XCH-CODE-0002'), 'the code is in the plain-text body');
  assert.equal(params.get('subject'), 'Your xChief $100 bonus code');
});

test('without an API key, sendClaimCode sends nothing at all (dev path)', async (t) => {
  t.after(resetEnv);
  delete process.env.ELASTIC_API_KEY;
  process.env.ELASTIC_CLAIM_TEMPLATE_ID = 'gift-card-template-123';
  const calls = installFetchMock();

  await sendClaimCode('winner@example.com', 'XCH-CODE-0003', { claimUrl: 'https://example.com/claim/x' });

  assert.equal(calls.length, 0, 'no network call is made without an API key');
});

test('a send failure rejects the promise (never throws synchronously) so a fire-and-forget .catch() can log it without touching the already-committed claim', async (t) => {
  t.after(resetEnv);
  process.env.ELASTIC_API_KEY = 'test-key';
  process.env.ELASTIC_CLAIM_TEMPLATE_ID = 'gift-card-template-123';
  installFetchMock({ ok: false, json: async () => ({ success: false, error: 'bounced' }) });

  const promise = sendClaimCode('winner@example.com', 'XCH-CODE-0004', { claimUrl: null });
  // The call site (server/index.js) never awaits this - it only chains .catch(). Proving the
  // failure surfaces as a rejection, not a thrown exception before any promise exists, is what
  // makes that fire-and-forget pattern safe.
  assert.ok(promise instanceof Promise);
  await assert.rejects(promise, /bounced/);
});

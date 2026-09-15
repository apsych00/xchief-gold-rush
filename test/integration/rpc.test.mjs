// Client-reachable RPC rules, against one fresh anonymous player.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rpc, newAnonymousSession, describeResponse, errorText, BASE_URL, ANON_KEY } from './harness.mjs';

const session = await newAnonymousSession();

test('get_me creates the player row with coins 1000 and record 1000', async () => {
  const { res, json } = await rpc('get_me', { token: session.token, body: {} });
  assert.equal(res.status, 200, describeResponse(res, json));
  assert.equal(Number(json.coins), 1000, `fresh coins must be 1000, got ${json.coins}`);
  assert.equal(Number(json.record), 1000, `fresh record must be 1000, got ${json.record}`);
  assert.equal(Number(json.streak), 0, `fresh streak must be 0, got ${json.streak}`);
});

test('free_refill on a fresh (full) player fails with refill_unavailable', async () => {
  const { res, json } = await rpc('free_refill', { token: session.token, body: {} });
  assert.notEqual(res.status, 200, describeResponse(res, json));
  assert.match(errorText(json), /refill_unavailable/, describeResponse(res, json));
});

test('claim_task "signup" on an anonymous user fails with email_required', async () => {
  const { res, json } = await rpc('claim_task', { token: session.token, body: { p_task: 'signup' } });
  assert.notEqual(res.status, 200, describeResponse(res, json));
  assert.match(errorText(json), /email_required/, describeResponse(res, json));
});

test('claim_task "instagram" pays once, then fails with already_claimed', async () => {
  const first = await rpc('claim_task', { token: session.token, body: { p_task: 'instagram' } });
  assert.equal(first.res.status, 200, describeResponse(first.res, first.json));
  assert.equal(
    Number(first.json.coins),
    1300,
    `after the instagram reward coins must be 1300, got ${first.json.coins}`,
  );

  const second = await rpc('claim_task', { token: session.token, body: { p_task: 'instagram' } });
  assert.notEqual(second.res.status, 200, describeResponse(second.res, second.json));
  assert.match(errorText(second.json), /already_claimed/, describeResponse(second.res, second.json));
});

test('leaderboard rows expose exactly display_name, record, rank', async () => {
  const { res, json } = await rpc('leaderboard', { body: {} });
  assert.equal(res.status, 200, describeResponse(res, json));
  assert.ok(Array.isArray(json), 'leaderboard must return an array of rows');
  for (const row of json) {
    assert.deepEqual(
      Object.keys(row).sort(),
      ['display_name', 'rank', 'record'],
      `unexpected leaderboard columns in ${JSON.stringify(row)}`,
    );
  }
});

test('anon cannot select the coupons table', async () => {
  const res = await fetch(`${BASE_URL}/rest/v1/coupons?select=code`, {
    headers: { apikey: ANON_KEY },
  });
  assert.notEqual(res.status, 200, `GET coupons returned HTTP ${res.status}`);
});

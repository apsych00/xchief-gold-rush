// HTTP contract: `play-round` auth, validation, timing, in-flight guard, settle shape.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fn, newAnonymousSession, describeResponse, errorText } from './harness.mjs';

const session = await newAnonymousSession();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('play-round without Authorization answers 401 unauthenticated', async () => {
  const { res, json } = await fn('play-round', { body: { dir: 'up', lever: 1 } });
  assert.equal(res.status, 401, describeResponse(res, json));
  assert.match(errorText(json), /unauthenticated/, describeResponse(res, json));
});

test('play-round with lever 3 answers 400 bad_lever', async () => {
  const { res, json } = await fn('play-round', {
    body: { dir: 'up', lever: 3 },
    token: session.token,
  });
  assert.equal(res.status, 400, describeResponse(res, json));
  assert.match(errorText(json), /bad_lever/, describeResponse(res, json));
});

test('play-round settles a fresh player per economy rules and takes >= 5 s', async () => {
  const start = Date.now();
  const { res, json } = await fn('play-round', {
    body: { dir: 'up', lever: 1 },
    token: session.token,
  });
  const elapsed = Date.now() - start;
  assert.equal(res.status, 200, describeResponse(res, json));
  assert.ok(elapsed >= 5000, `response arrived after only ${elapsed} ms`);

  for (const key of ['outcome', 'delta', 'mult', 'coins', 'streak', 'record', 'start_price', 'end_price']) {
    assert.ok(key in json, `settle json missing "${key}": ${describeResponse(res, json)}`);
  }
  assert.ok(['win', 'lose', 'flat'].includes(json.outcome), `outcome=${json.outcome}`);
  assert.ok(json.start_price > 0 && json.end_price > 0, 'prices must be positive');

  // Fresh player: coins 1000, record 1000, streak 0. Lever 1 -> stake 100, mult 1x.
  assert.equal(Number(json.mult), 1, `mult for a streak-0 round must be 1, got ${json.mult}`);
  const expected =
    json.outcome === 'win'
      ? { coins: 1100, streak: 1, record: 1100 }
      : json.outcome === 'lose'
        ? { coins: 900, streak: 0, record: 1000 }
        : { coins: 1000, streak: 0, record: 1000 };
  assert.equal(Number(json.coins), expected.coins, `coins after a ${json.outcome}`);
  assert.equal(Number(json.streak), expected.streak, `streak after a ${json.outcome}`);
  assert.equal(Number(json.record), expected.record, `record after a ${json.outcome}`);
  assert.equal(Number(json.delta), Number(json.coins) - 1000, 'delta must match the coins change');

  // The server decides the outcome from the prices it read, not from the client.
  const drift = Number(json.end_price) - Number(json.start_price);
  const expectedOutcome = drift > 0 ? 'win' : drift < 0 ? 'lose' : 'flat';
  assert.equal(json.outcome, expectedOutcome, 'outcome must match dir=up against the price move');
});

test('a second play-round while the first is in flight answers 409 round_in_flight', async () => {
  const first = fn('play-round', { body: { dir: 'down', lever: 1 }, token: session.token });
  await sleep(500);
  const { res, json } = await fn('play-round', {
    body: { dir: 'up', lever: 1 },
    token: session.token,
  });
  assert.equal(res.status, 409, describeResponse(res, json));
  assert.match(errorText(json), /round_in_flight/, describeResponse(res, json));

  // Let the in-flight round settle so we do not leave state dangling.
  const settled = await first;
  assert.equal(settled.res.status, 200, describeResponse(settled.res, settled.json));
});

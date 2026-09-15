// HTTP contract: `play-round-kiosk` (no auth header; bearer secret in the body).
import test from 'node:test';
import assert from 'node:assert/strict';
import { fn, describeResponse, errorText } from './harness.mjs';

test('play-round-kiosk with a wrong secret answers 401 kiosk_unauthorized', async () => {
  const { res, json } = await fn('play-round-kiosk', {
    body: { secret: 'wrong-secret-wrong-secret', dir: 'up' },
  });
  assert.equal(res.status, 401, describeResponse(res, json));
  assert.match(errorText(json), /kiosk_unauthorized/, describeResponse(res, json));
});

test('play-round-kiosk with the dev secret returns outcome and a numeric streak', async () => {
  const { res, json } = await fn('play-round-kiosk', {
    body: { secret: 'dev-kiosk-secret-0001', dir: 'up' },
  });
  assert.equal(res.status, 200, describeResponse(res, json));
  assert.ok(['win', 'lose', 'flat'].includes(json.outcome), `outcome=${json.outcome}`);
  assert.equal(typeof Number(json.streak), 'number');
  assert.ok(!Number.isNaN(Number(json.streak)), `streak must be a number, got ${json.streak}`);
});

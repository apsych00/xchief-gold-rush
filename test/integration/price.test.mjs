// HTTP contract: `price` -> 200 {symbol, price, t, source}, t in epoch ms.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fn, describeResponse } from './harness.mjs';

test('price returns the promised shape with a fresh timestamp', async () => {
  const before = Date.now();
  const { res, json } = await fn('price', { body: {} });
  const after = Date.now();
  assert.equal(res.status, 200, describeResponse(res, json));
  assert.equal(typeof json.symbol, 'string', describeResponse(res, json));
  assert.equal(typeof json.price, 'number', describeResponse(res, json));
  assert.ok(json.price > 0, `price must be positive, got ${json.price}`);
  assert.equal(typeof json.t, 'number', describeResponse(res, json));
  assert.ok(
    json.t >= before - 10_000 && json.t <= after + 10_000,
    `t=${json.t} is not within 10 s of now (${before}..${after})`,
  );
  assert.ok('source' in json, describeResponse(res, json));
});

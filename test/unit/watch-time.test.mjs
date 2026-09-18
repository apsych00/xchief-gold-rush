import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accumulateWatchTime } from '../../src/watchTime.js';

test('a 30s jump adds at most 1.5s', () => {
  const result = accumulateWatchTime({ current: 30, previous: 0, accumulated: 0 });
  assert.equal(result, 1.5);
});

test('normal 1s ticks accumulate in full', () => {
  let accumulated = 0;
  accumulated = accumulateWatchTime({ current: 1, previous: 0, accumulated });
  accumulated = accumulateWatchTime({ current: 2, previous: 1, accumulated });
  assert.equal(accumulated, 2);
});

test('rewinds do not subtract watched time', () => {
  const result = accumulateWatchTime({ current: 5, previous: 10, accumulated: 7 });
  assert.equal(result, 7);
});

test('a 0.5s tick accumulates exactly', () => {
  const result = accumulateWatchTime({ current: 3.5, previous: 3, accumulated: 10 });
  assert.equal(result, 10.5);
});

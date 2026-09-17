// Unit tests for the ad banner rotation picker (ticket B11, src/adsPicker.js).
// Run: node --test test/unit/ads-picker.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickRandomAd } from '../../src/adsPicker.js';

const A = { src: '/ads/a.png', alt: 'a', href: 'https://a.example' };
const B = { src: '/ads/b.png', alt: 'b', href: 'https://b.example' };
const C = { src: '/ads/c.png', alt: 'c', href: 'https://c.example' };

test('an empty list picks nothing', () => {
  assert.equal(pickRandomAd([], null), null);
  assert.equal(pickRandomAd(undefined, null), null);
  assert.equal(pickRandomAd(null, null), null);
});

test('a single-item list always returns that item, even as its own "exclude"', () => {
  assert.equal(pickRandomAd([A], null), A);
  assert.equal(pickRandomAd([A], A.src), A);
});

test('the pick always comes from the given list', () => {
  const items = [A, B, C];
  for (let i = 0; i < 50; i++) {
    const picked = pickRandomAd(items, null);
    assert.ok(items.includes(picked));
  }
});

test('every item in a multi-item list is reachable at random', () => {
  const items = [A, B, C];
  const seen = new Set();
  for (let i = 0; i < 200; i++) seen.add(pickRandomAd(items, null).src);
  assert.deepEqual(seen, new Set([A.src, B.src, C.src]));
});

test('the pick never repeats the excluded src when another item is available', () => {
  const items = [A, B, C];
  for (let i = 0; i < 200; i++) {
    assert.notEqual(pickRandomAd(items, A.src).src, A.src);
  }
});

test('with exactly two items, excluding one always yields the other', () => {
  const items = [A, B];
  for (let i = 0; i < 50; i++) {
    assert.equal(pickRandomAd(items, A.src), B);
    assert.equal(pickRandomAd(items, B.src), A);
  }
});

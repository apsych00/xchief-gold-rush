// Unit tests for the animated-banner rotation (ticket U3): the duration-based, list-order
// rotation that an iframe-bearing list uses, as opposed to the random pick B11 shipped for
// image-only lists (test/unit/ads-picker.test.mjs still covers that pick).
// Run: node --test test/unit/ads-rotation.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_IMAGE_DURATION_MS, adDurationMs, hasIframeAds, isIframeAd, nextAd } from '../../src/adsPicker.js';

// The two seeded banner entries, exactly as ads/banners.json carries them.
const board = { type: 'iframe', src: '/ads/banners/xchief-board-banner.html?embed=1', duration_ms: 20500 };
const concept = {
  type: 'iframe',
  src: '/ads/banners/xchief-banner-concepts.html?concept=3&embed=1',
  duration_ms: 11500,
};
const img1 = { type: 'image', src: '/ads/banner-1.png', href: 'https://www.xchief.com/' };
const img2 = { type: 'image', src: '/ads/banner-2.png', href: 'https://www.xchief.com/' };

test('only an entry with type "iframe" is an iframe banner', () => {
  assert.equal(isIframeAd(board), true);
  assert.equal(isIframeAd(concept), true);
  assert.equal(isIframeAd(img1), false);
  // A pre-U3 entry with no type at all still reads as an image, never as an iframe.
  assert.equal(isIframeAd({ src: '/ads/legacy.png' }), false);
});

test('an iframe banner shows for its own duration_ms (one full loop)', () => {
  assert.equal(adDurationMs(board), 20500);
  assert.equal(adDurationMs(concept), 11500);
});

test('an image, or an iframe without a sane duration, falls back to the 8 s default', () => {
  assert.equal(adDurationMs(img1), DEFAULT_IMAGE_DURATION_MS);
  assert.equal(adDurationMs({ type: 'iframe', src: '/x' }), DEFAULT_IMAGE_DURATION_MS);
  assert.equal(adDurationMs({ type: 'iframe', src: '/x', duration_ms: 0 }), DEFAULT_IMAGE_DURATION_MS);
  assert.equal(adDurationMs({ type: 'iframe', src: '/x', duration_ms: -1 }), DEFAULT_IMAGE_DURATION_MS);
});

test('a list is iframe-bearing iff it contains an iframe entry', () => {
  assert.equal(hasIframeAds([img1, img2]), false);
  assert.equal(hasIframeAds([board, img1]), true);
  assert.equal(hasIframeAds([]), false);
  assert.equal(hasIframeAds(undefined), false);
});

test('ordered rotation walks the list in order and wraps, never at random', () => {
  const list = [board, concept, img1, img2];
  const seen = [nextAd(list, null)];
  for (let i = 1; i < list.length * 2; i += 1) {
    seen.push(nextAd(list, seen[seen.length - 1]));
  }
  // The first full cycle is exactly the list order; the second repeats it.
  assert.deepEqual(seen.slice(0, list.length), list);
  assert.deepEqual(seen.slice(list.length, list.length * 2), list);
});

test('ordered rotation is deterministic at every position', () => {
  const list = [board, concept, img1, img2];
  for (const at of list) {
    assert.equal(nextAd(list, at), nextAd(list, at));
  }
  assert.equal(nextAd(list, board), concept);
  assert.equal(nextAd(list, concept), img1);
  assert.equal(nextAd(list, img1), img2);
  assert.equal(nextAd(list, img2), board);
});

test('a two-entry iframe list alternates in order', () => {
  const list = [board, concept];
  assert.equal(nextAd(list, null), board);
  assert.equal(nextAd(list, board), concept);
  assert.equal(nextAd(list, concept), board);
});

test('an empty list rotates to nothing', () => {
  assert.equal(nextAd([], board), null);
  assert.equal(nextAd(undefined, board), null);
  assert.equal(nextAd(null, board), null);
});

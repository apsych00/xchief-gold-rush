// Unit tests for the ad-zone latency fix (leaderboard ads: the first banner used to take 2-3 s to
// appear because its ~1 MB creative was only ever fetched once the iframe itself mounted, gated
// behind the leaderboard's own data load). src/adsWarmup.js holds the warmup plumbing as plain,
// side-effecting functions (split out of src/ads.jsx the same way src/adsPicker.js is, so this
// suite can import it with a bare `node --test`, no JSX parsing involved) - exercised here with a
// mocked fetch/Image, no DOM or browser needed.
//
// loadBanners() memoizes its fetch at module scope (every caller - the App-level warmup and
// AdZone itself - must share one in-flight request), so this file's tests run in a fixed order and
// each one accounts for that shared cache instead of resetting it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadBanners, prefetchBanner, warmBanners } from '../../src/adsWarmup.js';

const board = { type: 'iframe', src: '/ads/banners/xchief-board-banner.html?embed=1', duration_ms: 20500 };
const concept = {
  type: 'iframe',
  src: '/ads/banners/xchief-banner-concepts.html?concept=3&embed=1',
  duration_ms: 11500,
};
const img = { type: 'image', src: '/ads/banner-1.png', href: 'https://www.xchief.com/' };

function installFetchMock(list) {
  const calls = [];
  globalThis.fetch = (url, opts) => {
    calls.push({ url, opts });
    return Promise.resolve({ ok: true, json: () => Promise.resolve(list) });
  };
  return calls;
}

test('the seeded banner list carries exactly two banners, so the rotation is always those two', async () => {
  const fs = await import('node:fs/promises');
  const list = JSON.parse(await fs.readFile(new URL('../../ads/banners.json', import.meta.url), 'utf8'));
  assert.equal(list.length, 2, 'ads/banners.json must hold exactly two entries for a two-banner rotation');
});

test('loadBanners fetches the banner list from /ads/banners.json', async () => {
  const calls = installFetchMock([board, concept]);
  const list = await loadBanners();
  assert.deepEqual(list, [board, concept]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/ads/banners.json');
});

test('loadBanners memoizes: a second call does not re-fetch', async () => {
  const calls = installFetchMock([board, concept]);
  const first = await loadBanners();
  const second = await loadBanners();
  assert.equal(first, second);
  // installFetchMock above is never hit again - the module-level cache from the previous test
  // (and this one) answers every subsequent call.
  assert.equal(calls.length, 0);
});

test('prefetchBanner warms an iframe banner by fetching its own src', async () => {
  const calls = [];
  globalThis.fetch = (url) => {
    calls.push(url);
    return Promise.resolve({ ok: true });
  };
  prefetchBanner(board);
  assert.deepEqual(calls, [board.src]);
});

test('prefetchBanner warms an image banner by decoding it off-DOM, not over fetch', async () => {
  const fetchCalls = [];
  globalThis.fetch = (url) => {
    fetchCalls.push(url);
    return Promise.resolve({ ok: true });
  };
  let createdSrc = null;
  class FakeImage {
    set src(v) {
      createdSrc = v;
    }
  }
  globalThis.Image = FakeImage;
  prefetchBanner(img);
  assert.equal(createdSrc, img.src);
  assert.deepEqual(fetchCalls, []);
  delete globalThis.Image;
});

test('prefetchBanner is a no-op for a missing/empty ad', () => {
  assert.doesNotThrow(() => prefetchBanner(null));
  assert.doesNotThrow(() => prefetchBanner({}));
});

test('warmBanners loads the list and prefetches every entry', async () => {
  const fetchUrls = [];
  globalThis.fetch = (url) => {
    fetchUrls.push(url);
    // The first call this test makes is the banners.json fetch itself, already resolved and
    // cached by the earlier loadBanners tests in this file - so warmBanners here only needs to
    // prefetch each entry's own creative.
    return Promise.resolve({ ok: true });
  };
  const list = await warmBanners();
  assert.deepEqual(list, [board, concept]);
  // Both iframe entries from the cached list were prefetched via fetch(ad.src).
  assert.ok(fetchUrls.includes(board.src));
  assert.ok(fetchUrls.includes(concept.src));
});

// The ad rotation's network warmup, split out of src/ads.jsx for the same reason adsPicker.js is
// (see that file's header): plain JS, no JSX, so the unit test (test/unit/ads-warmup.test.mjs)
// can import it with a bare `node --test`.
//
// Each animated banner HTML doc (ads/banners/) is a self-contained, font-inlined file over 1 MB;
// that download, not the banners.json list itself, was the real 2-3 s delay before the first
// banner appeared on the leaderboard. Fetching and warming both eagerly, as early as the app can
// (App.jsx calls warmBanners() once on mount, well before a player ever taps into the
// leaderboard), means the browser's HTTP cache already holds them by the time the ad zone
// actually mounts, so its iframe's own onLoad fires close to instantly instead of waiting on a
// fresh multi-hundred-KB-to-MB fetch.

export const BANNERS_URL = '/ads/banners.json';

// Module-scoped so every caller (the App-level warmup and the ad zone itself) shares one
// in-flight/resolved request instead of each firing its own.
let bannersPromise = null;
export function loadBanners() {
  if (!bannersPromise) {
    bannersPromise = fetch(BANNERS_URL)
      .then((res) => (res.ok ? res.json() : []))
      .then((list) => (Array.isArray(list) ? list : []))
      .catch(() => []);
  }
  return bannersPromise;
}

/** Warms the browser's cache for one banner's creative, ahead of it ever being shown: an iframe
 * banner is just fetched (its src is what the later <iframe> will request, same URL, so a normal
 * HTTP cache hit covers it); an image banner is decoded through an off-DOM Image(). Errors are
 * swallowed - this is a head start, never a requirement, and the real <iframe>/<img> retries on
 * its own if the network was down for the prefetch. */
export function prefetchBanner(ad) {
  if (!ad || !ad.src) return;
  if (ad.type === 'iframe') {
    fetch(ad.src).catch(() => {
      /* best-effort warmup */
    });
  } else if (typeof Image !== 'undefined') {
    const img = new Image();
    img.src = ad.src;
  }
}

/** Called once from App.jsx on mount (web only, never the kiosk, which never shows ads at all):
 * loads the banner list and prefetches every entry's creative so the whole rotation is already
 * warm in cache by the time a player reaches the leaderboard. */
export function warmBanners() {
  return loadBanners().then((list) => {
    list.forEach(prefetchBanner);
    return list;
  });
}

// The ad rotation's pure picking logic (ticket B11), split out of src/ads.js so the unit test
// (test/unit/ads-picker.test.mjs) can import it with plain `node --test`, with no JSX to parse.
//
// Ticket U3 extends this with the animated banners: an entry with `type: "iframe"` is a
// self-contained HTML banner (ads/banners/) that must show for one full loop before the next
// entry, in list order. Mixed or iframe-bearing lists are therefore rotated deterministically
// (the order is the story); image-only lists keep the random pick the B11 unit test covers.

/** How long a still image banner shows when it has no own `duration_ms` (the B11 eight seconds). */
export const DEFAULT_IMAGE_DURATION_MS = 8000;

export function isIframeAd(ad) {
  return !!ad && ad.type === 'iframe';
}

export function hasIframeAds(items) {
  return Array.isArray(items) && items.some(isIframeAd);
}

/** An iframe banner shows for its own `duration_ms` (one full loop); anything else - an image,
 * or an iframe missing a sane duration - falls back to the image default. */
export function adDurationMs(ad) {
  const ms = ad && ad.duration_ms;
  if (isIframeAd(ad) && Number.isFinite(ms) && ms > 0) return ms;
  return DEFAULT_IMAGE_DURATION_MS;
}

/** The next banner in list order, wrapping at the end. `null` for an empty (or non-array) list.
 * Matches the current banner by identity first, then by src, so a caller that reconstructed an
 * equivalent entry still advances from the right place. */
export function nextAd(items, current) {
  if (!Array.isArray(items) || items.length === 0) return null;
  if (current == null) return items[0];
  let idx = items.indexOf(current);
  if (idx === -1) idx = items.findIndex((it) => it && current && it.src === current.src);
  return items[idx === -1 ? 0 : (idx + 1) % items.length];
}

/** Picks a random item from `items`, never repeating `excludeSrc` back-to-back unless it is the
 * only item available. `null` for an empty (or non-array) list. */
export function pickRandomAd(items, excludeSrc) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const pool = items.length > 1 && excludeSrc != null ? items.filter((it) => it.src !== excludeSrc) : items;
  const from = pool.length ? pool : items;
  return from[Math.floor(Math.random() * from.length)];
}

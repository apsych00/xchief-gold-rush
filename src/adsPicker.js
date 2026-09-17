// The ad rotation's pure picking logic (ticket B11), split out of src/ads.js so the unit test
// (test/unit/ads-picker.test.mjs) can import it with plain `node --test`, with no JSX to parse.

/** Picks a random item from `items`, never repeating `excludeSrc` back-to-back unless it is the
 * only item available. `null` for an empty (or non-array) list. */
export function pickRandomAd(items, excludeSrc) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const pool = items.length > 1 && excludeSrc != null ? items.filter((it) => it.src !== excludeSrc) : items;
  const from = pool.length ? pool : items;
  return from[Math.floor(Math.random() * from.length)];
}

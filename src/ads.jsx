/**
 * Ad banner zone (ticket B11, docs/tasks-marketing-lead.md A1; animated banners ticket U3). The
 * list itself is `ads/banners.json`, deliberately outside `dist/` so an operator can add or swap
 * banners without a rebuild (Caddyfile's `handle_path /ads*`, vite.config.js's dev-only mirror of
 * the same path). Fetched once per load; rotated on a client-side timer - nothing here is
 * server-decided, unlike every scoring/reward path in this app, because a banner has no effect on
 * the game.
 *
 * An entry with `type: "iframe"` is one of the two self-contained banners under ads/banners/,
 * embedded exactly as their README says and shown for its `duration_ms` (one full loop). A list
 * that carries an iframe rotates in list order, deterministically - the story is the point; an
 * image-only list keeps the random pick B11 shipped.
 *
 * This file is .jsx rather than the ticket's plain src/ads.js: `vite build` (rollup) refuses to
 * parse JSX in a .js file even though the dev server's esbuild/babel path accepts it. src/ads.js
 * is kept as a thin re-export so every import path the ticket and this ticket's tests use still
 * resolves.
 */
import { useEffect, useState } from 'react';
import { adDurationMs, hasIframeAds, nextAd, pickRandomAd } from './adsPicker.js';

export { adDurationMs, hasIframeAds, nextAd, pickRandomAd };

const BANNERS_URL = '/ads/banners.json';

/** The leaderboard screen's banner zone. Its height follows the banner aspect ratio (1072:310),
 * so the list above reclaims the rest through the flex column. Renders nothing - the list above
 * then takes the full height, per the CSS flex layout - when the fetch fails or the list is
 * empty. Never mounted for the kiosk (App.jsx never renders Leaderboard there at all). */
export function AdZone() {
  const [ads, setAds] = useState([]);
  const [current, setCurrent] = useState(null);

  useEffect(() => {
    let cancelled = false;
    fetch(BANNERS_URL)
      .then((res) => (res.ok ? res.json() : []))
      .then((list) => {
        if (cancelled || !Array.isArray(list) || list.length === 0) return;
        setAds(list);
        // Iframes lead the list in ads/banners.json, so an iframe-bearing list opens on entry 0.
        setCurrent(hasIframeAds(list) ? list[0] : pickRandomAd(list));
      })
      .catch(() => {
        /* fetch failed: ads/current stay empty, the zone renders nothing */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!current || ads.length < 2) return undefined;
    const id = setTimeout(() => {
      setCurrent((prev) => (hasIframeAds(ads) ? nextAd(ads, prev) : pickRandomAd(ads, prev?.src)));
    }, adDurationMs(current));
    return () => clearTimeout(id);
  }, [ads, current]);

  if (!current) return null;

  return (
    <div className="ad-zone">
      {current.type === 'iframe' ? (
        // Clicks belong to the banner itself, so there is no wrapping anchor here. tabIndex -1
        // keeps the frame out of the keyboard tab order; loading="lazy" defers the offscreen
        // load until the zone is near the viewport.
        <iframe
          key={current.src}
          className="ad-zone-frame"
          src={current.src}
          title="xChief"
          loading="lazy"
          tabIndex={-1}
        />
      ) : (
        <a key={current.src} className="ad-zone-link" href={current.href} target="_blank" rel="noopener noreferrer">
          <img className="ad-zone-img" src={current.src} alt={current.alt || ''} draggable={false} />
        </a>
      )}
    </div>
  );
}

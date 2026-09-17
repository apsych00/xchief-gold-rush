/**
 * Ad banner zone (ticket B11, docs/tasks-marketing-lead.md A1). The list itself is
 * `ads/banners.json`, deliberately outside `dist/` so an operator can add or swap banners
 * without a rebuild (Caddyfile's `handle_path /ads*`, vite.config.js's dev-only mirror of the
 * same path). Fetched once per load; picked at random and rotated on a client-side timer -
 * nothing here is server-decided, unlike every scoring/reward path in this app, because a
 * banner has no effect on the game.
 *
 * This file is .jsx rather than the ticket's plain src/ads.js: `vite build` (rollup) refuses to
 * parse JSX in a .js file even though the dev server's esbuild/babel path accepts it. src/ads.js
 * is kept as a thin re-export so every import path the ticket and this ticket's tests use still
 * resolves.
 */
import { useEffect, useState } from 'react';
import { pickRandomAd } from './adsPicker.js';

export { pickRandomAd };

const BANNERS_URL = '/ads/banners.json';
const ROTATE_MS = 8000;

/** Bottom 40% of the leaderboard screen (App.jsx's Leaderboard). Renders nothing - the list
 * above then takes the full height, per the CSS flex layout - when the fetch fails or the list
 * is empty. Never mounted for the kiosk (App.jsx never renders Leaderboard there at all). */
export function AdZone() {
  const [ads, setAds] = useState([]);
  const [current, setCurrent] = useState(null);

  useEffect(() => {
    let cancelled = false;
    fetch(BANNERS_URL)
      .then((res) => (res.ok ? res.json() : []))
      .then((list) => {
        if (cancelled || !Array.isArray(list)) return;
        setAds(list);
        setCurrent(pickRandomAd(list));
      })
      .catch(() => {
        /* fetch failed: ads/current stay empty, the zone renders nothing */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (ads.length < 2) return undefined;
    const id = setInterval(() => {
      setCurrent((prev) => pickRandomAd(ads, prev?.src));
    }, ROTATE_MS);
    return () => clearInterval(id);
  }, [ads]);

  if (!current) return null;

  return (
    <div className="ad-zone">
      <a key={current.src} className="ad-zone-link" href={current.href} target="_blank" rel="noopener noreferrer">
        <img className="ad-zone-img" src={current.src} alt={current.alt || ''} draggable={false} />
      </a>
    </div>
  );
}

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
import { useEffect, useRef, useState } from 'react';
import { adDurationMs, hasIframeAds, nextAd, pickRandomAd } from './adsPicker.js';

export { adDurationMs, hasIframeAds, nextAd, pickRandomAd };

const BANNERS_URL = '/ads/banners.json';
// Both banners (image and iframe) point here. Single constant so the destination changes in one
// place; the image-banner path can still override per-entry via banners.json's `href`.
const XCHIEF_AD_URL = 'https://www.xchief.com/?utm_source=goldrush&utm_campaign=goldrush';
// Native canvas of the two HTML banners (ads/banners/README.md); .ad-zone keeps the same ratio.
const BANNER_W = 1072;
const BANNER_H = 310;
// The banners carry a slim dark margin inside their canvas; overscan the scaled frame so the
// creative reaches the zone edges (owner 2026-09-18), cropped by .ad-zone's overflow:hidden.
const OVERSCAN = 1.12;

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

  // Scale for the iframe banners: zone width over the banners' native canvas width. Measured with a
  // ResizeObserver so a rotated phone or a resized desktop window keeps the whole creative visible.
  const zoneRef = useRef(null);
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const el = zoneRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const measure = () => setScale(el.clientWidth / BANNER_W);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [current]);

  if (!current) return null;

  return (
    <div className="ad-zone" ref={zoneRef}>
      {current.type === 'iframe' ? (
        // The two bundled banners lay themselves out for their native 1072x310 canvas and keep a
        // minimum content height below ~800 px wide, so a frame sized to the zone clips their
        // bottom. The frame is therefore always the native canvas size and is scaled down as one
        // block to the zone's width (transform-origin top left), like any fixed-size creative.
        // tabIndex -1 keeps the frame out of the keyboard tab order; loading="lazy" defers the
        // offscreen load until the zone is near the viewport.
        // The scale lives on a wrapper: .ad-zone-frame keeps the gr-rise entrance animation, whose
        // fill-mode would otherwise overwrite an inline transform on the frame itself.
        // The banner's own HTML has no click target of its own, so a transparent anchor is layered
        // on top of the whole zone (after the scale wrapper in source order, so it paints above the
        // iframe) and carries the click instead. It sits outside .ad-zone-scale so it isn't affected
        // by that wrapper's scale/overscan transform and always covers the full visible zone.
        <>
          <div
            key={current.src}
            className="ad-zone-scale"
            style={{ transform: `translate(-50%, -50%) scale(${scale * OVERSCAN})` }}
          >
            <iframe
              className="ad-zone-frame"
              src={current.src}
              title="xChief"
              loading="lazy"
              tabIndex={-1}
              width={BANNER_W}
              height={BANNER_H}
            />
          </div>
          <a
            className="ad-zone-click"
            href={current.href || XCHIEF_AD_URL}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="xChief"
          />
        </>
      ) : (
        <a
          key={current.src}
          className="ad-zone-link"
          href={current.href || XCHIEF_AD_URL}
          target="_blank"
          rel="noopener noreferrer"
        >
          <img className="ad-zone-img" src={current.src} alt={current.alt || ''} draggable={false} />
        </a>
      )}
    </div>
  );
}

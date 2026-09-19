// Ticket B10+B11 names this file src/ads.js; the actual component lives in src/ads.jsx because
// `vite build` (rollup) rejects JSX in a .js file. Plain re-export, no JSX here.
export { AdZone, loadBanners, pickRandomAd, prefetchBanner, warmBanners } from './ads.jsx';

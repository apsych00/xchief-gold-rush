// E2E for ticket U3 (the two animated xChief banners in the ad zone). Same harness shape as
// tests/e2e/b10-b11-tour-ads.spec.js: a running dev server (BASE_URL) plus the box game server
// (PORT/GAME_SERVER env), both already up when this suite runs - see this ticket's report for the
// exact recipe (db/run-tests-u3.sh --keep, PORT=8806, BASE_URL=http://localhost:5368). GAME_WS
// and DATABASE_URL must be set in the environment; this suite never reads .env.
//
// Screenshots land in docs/reports/u3/.
import { expect, test } from '@playwright/test';
import { WebSocket } from 'ws';

import { dismissFirstVisit } from './first-visit.js';

const KIOSK_SECRET = 'dev-kiosk-secret-0001';
const KIOSK_URL = `/?k=${KIOSK_SECRET}`;
const GAME_WS = process.env.VITE_GAME_WS;
const REPORT_DIR = 'docs/reports/u3';
// .ad-zone's own aspect-ratio (src/styles.css) - not the banners' native 1072:310 canvas. The
// zone overscans and crops the banners' own dark margin (commit 1a41ed7, "crop banner dark
// margin so it fills the zone") so the visible art reaches the edges with no letterbox; this
// constant was left at the pre-crop 1072:310 ratio, which this suite never actually matched
// afterward (unrelated pre-existing test bug, fixed while touching this file for the ad-latency
// ticket).
const BANNER_ASPECT = 1072 / 272;

/** Ends whatever session the dev kiosk currently has, over an independent socket - same helper
 * shape as tests/e2e/b10-b11-tour-ads.spec.js so kiosk state never leaks between the two suites. */
function resetKioskSession() {
  return new Promise((resolve, reject) => {
    expect(GAME_WS, 'VITE_GAME_WS must be set for this suite (never read from .env)').toBeTruthy();
    const ws = new WebSocket(GAME_WS);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('timed out resetting the kiosk session'));
    }, 8000);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', kiosk: KIOSK_SECRET })));
    ws.on('message', (data) => {
      let frame;
      try {
        frame = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (frame.type === 'welcome') {
        ws.send(JSON.stringify({ type: 'kiosk_reset' }));
      } else if (frame.type === 'kiosk_session') {
        clearTimeout(timer);
        ws.close();
        resolve(frame);
      } else if (frame.type === 'error') {
        clearTimeout(timer);
        ws.close();
        reject(Object.assign(new Error(frame.code), { code: frame.code }));
      }
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

test.describe('web: the ad zone shows an animated banner (U3)', () => {
  test.setTimeout(60000);

  test('the zone shows an iframe from /ads/banners/ and keeps the 1072:310 aspect ratio', async ({ page }) => {
    await page.goto('/');
    // A fresh context: the first-visit tour sits in front of the board (B10/C11). Dismiss it the
    // way a visitor does, then open the leaderboard.
    await dismissFirstVisit(page);
    await page.getByRole('button', { name: 'Board' }).click();
    await expect(page.locator('.lb')).toBeVisible();

    // ---- 1. the zone renders an iframe whose src is one of the animated banners ------------
    const frame = page.locator('.ad-zone-frame');
    await expect(frame).toBeVisible({ timeout: 10000 });
    await expect(frame).toHaveAttribute('src', /^\/ads\/banners\//);
    await expect(frame).toHaveAttribute('title', 'xChief');
    await expect(frame).toHaveAttribute('tabindex', '-1');

    // The dev server (vite.config.js's ads dev middleware) and Caddy both serve ads/banners/:
    // prove the src really answers with the banner HTML, not the SPA fallback.
    const src = await frame.getAttribute('src');
    const res = await page.request.get(src);
    expect(res.ok(), `GET ${src} must answer 200`).toBeTruthy();
    expect(res.headers()['content-type']).toContain('text/html');
    expect((await res.text()).trimStart().toLowerCase()).toMatch(/^<!doctype html/);
    await page.screenshot({ path: `${REPORT_DIR}/01-web-ad-zone-iframe.png` });

    // ---- 2. the zone height follows the banner aspect ratio, within 2 px -------------------
    const box = await page.locator('.ad-zone').boundingBox();
    expect(box, 'the ad zone must have a box').not.toBeNull();
    const expected = box.width / BANNER_ASPECT;
    expect(
      Math.abs(box.height - expected),
      `zone ${box.width.toFixed(1)}x${box.height.toFixed(1)} must match ${BANNER_ASPECT.toFixed(4)}:1 (expected height ${expected.toFixed(1)})`,
    ).toBeLessThanOrEqual(2);
    await page.screenshot({ path: `${REPORT_DIR}/02-web-ad-zone-aspect.png` });

    // ---- 2b. the scaled frame fills the zone exactly and the banner is not clipped -----------
    // The frame is the native 1072x310 canvas scaled down as one block (src/ads.jsx), so its
    // rendered box must equal the zone's box, and inside the frame the document must fit its own
    // 310 px viewport (the assets keep a minimum content height when laid out narrower).
    const frameBox = await frame.boundingBox();
    expect(Math.abs(frameBox.width - box.width)).toBeLessThanOrEqual(2);
    expect(Math.abs(frameBox.height - box.height)).toBeLessThanOrEqual(2);
    const inner = page.frameLocator('.ad-zone-frame');
    await expect
      .poll(() => inner.locator('html').evaluate((el) => [el.clientWidth, el.scrollHeight]), { timeout: 15000 })
      .toEqual([1072, 310]);
  });

  test('the rotation holds exactly two banners, back to back forever', async ({ page }) => {
    test.setTimeout(90000);
    const res = await page.request.get('/ads/banners.json');
    expect(res.ok()).toBeTruthy();
    const list = await res.json();
    expect(list, 'the leaderboard ad rotation must carry exactly two banners').toHaveLength(2);
    const knownSrcs = new Set(list.map((ad) => ad.src));

    await page.goto('/');
    await dismissFirstVisit(page);
    await goToLeaderboard(page);

    const frame = page.locator('.ad-zone-frame');
    await expect(frame).toBeVisible({ timeout: 10000 });
    const firstSrc = await frame.getAttribute('src');
    expect(knownSrcs.has(firstSrc), `${firstSrc} must be one of the two seeded banners`).toBeTruthy();

    // Walk one full cycle: after two rotations the src must be back to the first one, and at no
    // point does a third, different banner show up.
    const seen = [firstSrc];
    for (let i = 0; i < 2; i += 1) {
      await expect
        .poll(async () => frame.getAttribute('src'), { timeout: 30000, message: 'banner must rotate' })
        .not.toBe(seen[seen.length - 1]);
      const src = await frame.getAttribute('src');
      expect(knownSrcs.has(src), `${src} must be one of the two seeded banners`).toBeTruthy();
      seen.push(src);
    }
    expect(new Set(seen).size, `only two distinct banners must ever show: ${JSON.stringify(seen)}`).toBe(2);
    expect(seen[0]).toBe(seen[2]);
  });

  test('the first banner is warm before the leaderboard even opens, and the zone reserves its own space', async ({
    page,
  }) => {
    // App.jsx's warmBanners() fires on mount (Home screen), well before this test ever taps into
    // the leaderboard - so the banner list and both creatives are already in the HTTP cache by
    // the time the zone mounts. Regression guard for the 2-3 s delay bug: the fetch this test
    // makes here must reuse that warm cache, not hit the network cold.
    await page.goto('/');
    await dismissFirstVisit(page);

    const start = Date.now();
    await goToLeaderboard(page);
    const frame = page.locator('.ad-zone-frame');
    await expect(frame).toBeVisible({ timeout: 10000 });
    const zoneVisibleMs = Date.now() - start;
    const boxBeforeLoad = await page.locator('.ad-zone').boundingBox();

    await expect
      .poll(() => frame.evaluate((el) => el.classList.contains('is-loaded')), { timeout: 10000 })
      .toBe(true);
    const loadedMs = Date.now() - start;
    const boxAfterLoad = await page.locator('.ad-zone').boundingBox();

    // "Essentially immediate": the zone box itself (reserved by the aspect-ratio CSS, independent
    // of the iframe's own load) must be on screen almost as soon as the board opens.
    expect(zoneVisibleMs, `.ad-zone-frame took ${zoneVisibleMs}ms to appear`).toBeLessThan(2000);
    // The regression this ticket fixes: the banner's own ~1 MB document used to take 2-3 s to
    // paint because nothing prefetched it. Warm, it must finish well under that.
    expect(loadedMs, `banner took ${loadedMs}ms to finish loading`).toBeLessThan(2500);
    // No layout shift: the zone's box (reserved by aspect-ratio, sized before the banner ever
    // loads) is identical before and after the iframe finishes loading.
    expect(boxAfterLoad.width).toBeCloseTo(boxBeforeLoad.width, 0);
    expect(boxAfterLoad.height).toBeCloseTo(boxBeforeLoad.height, 0);
    expect(boxAfterLoad.y).toBeCloseTo(boxBeforeLoad.y, 0);

    await page.screenshot({ path: `${REPORT_DIR}/04-web-ad-zone-fast-load.png` });
  });
});

async function goToLeaderboard(page) {
  await page.getByRole('button', { name: 'Board' }).click();
  await expect(page.locator('.lb')).toBeVisible();
}

test.describe.serial('kiosk: the ad zone never renders there (U3)', () => {
  test.setTimeout(60000);

  test.beforeEach(async () => {
    await resetKioskSession();
  });

  test('the kiosk never renders the animated banner zone', async ({ page }) => {
    await page.goto(KIOSK_URL);
    await expect
      .poll(() => page.evaluate(() => window.__xchief && window.__xchief.mode), {
        message: 'window.__xchief.mode must be "server" - the client is not wired to the game socket',
        timeout: 10000,
      })
      .toBe('server');
    await expect(page.getByText('Tap to play')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.ad-zone, .ad-zone-frame, .ad-zone-img')).toHaveCount(0);
    await page.screenshot({ path: `${REPORT_DIR}/03-kiosk-no-ad-zone.png` });
  });
});

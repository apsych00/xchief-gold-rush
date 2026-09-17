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
// The banners' canvas (ads/banners/README.md), and the aspect-ratio src/styles.css sets on .ad-zone.
const BANNER_ASPECT = 1072 / 310;

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
});

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

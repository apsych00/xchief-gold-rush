// E2E for ticket B10+B11 (tour-seen flags, ad banner list). Same harness shape as
// tests/e2e/kiosk.spec.js and player-promises.spec.js: a running dev server (BASE_URL) plus the
// box game server (PORT/GAME_SERVER env below), both already up when this suite runs - see this
// ticket's delivery report for the exact recipe (db/run-tests-b10.sh --keep, PORT=8793,
// BASE_URL=http://localhost:5352). GAME_WS and DATABASE_URL must be set in the environment;
// this suite never reads .env.
//
// Screenshots land in docs/reports/b10-b11/.
import { expect, test } from '@playwright/test';

import { dismissFirstVisit } from './first-visit.js';

const REPORT_DIR = 'docs/reports/b10-b11';

// The hard guarantee a kiosk must keep (docs/layers.md C2, extended here to B11's ad zone):
// none of the web's chrome, or the ad zone, may ever exist in the kiosk DOM.
function forbiddenUi(page) {
  return page.locator('.lead, .signup, .lb, .tasks, .nav, .ad-zone, input[type="email"]');
}

test.describe('web: tour placeholder and the ad zone (B10, B11)', () => {
  test.setTimeout(60000);

  test('the first-visit tour shows once, and the leaderboard ad zone renders an image', async ({ page }) => {
    // Every Playwright test already runs in its own fresh browser context (docs/layers.md,
    // same as every other spec in this suite) - localStorage starts empty with no setup here.
    await page.goto('/');

    // ---- 1. the first-visit tour appears on a fresh device --------------------------------
    await expect(page.locator('.modal-backdrop .modal')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.modal-title')).toHaveText('Call the next 5 seconds');
    await page.screenshot({ path: `${REPORT_DIR}/01-web-tour-card1.png` });

    await dismissFirstVisit(page);
    await expect(page.locator('.modal-backdrop')).toHaveCount(0);

    // ---- 2. the leaderboard's ad zone renders a banner from ads/banners.json --------------
    await page.getByRole('button', { name: 'Board' }).click();
    await expect(page.locator('.lb')).toBeVisible();
    // Ticket U3: the list now leads with the two animated banners, so the first thing the zone
    // shows is an iframe served from /ads/banners/ (the still images rotate in behind it). The
    // iframe's own load and the aspect ratio are proven by tests/e2e/u3-animated-banners.spec.js.
    const adFrame = page.locator('.ad-zone-frame');
    await expect(adFrame).toBeVisible({ timeout: 10000 });
    await expect(adFrame).toHaveAttribute('src', /^\/ads\/banners\//);
    await page.screenshot({ path: `${REPORT_DIR}/02-web-ad-zone.png` });

    // ---- 3. reloading never shows the tour again - xchief.tour_seen persisted -------------
    await page.reload();
    await expect(page.locator('.modal-backdrop')).toHaveCount(0, { timeout: 5000 });
    await expect(page.locator('.hero-art')).toBeVisible();
    await page.screenshot({ path: `${REPORT_DIR}/03-web-no-tour-after-reload.png` });
  });
});

test.describe.serial('kiosk: no ad zone or web chrome, intro once per boot (B10, B11)', () => {
  test.setTimeout(60000);

  // Each test gets its own fresh browser context (empty localStorage), so /kiosk self-provisions
  // a brand-new, already-idle kiosk identity every time - no shared dev secret to reset anymore.
  test('the kiosk never renders the ad zone or web chrome, and the intro shows once this boot', async ({
    page,
  }) => {
    await page.goto('/kiosk');
    await expect
      .poll(() => page.evaluate(() => window.__xchief && window.__xchief.mode), {
        message: 'window.__xchief.mode must be "server" - the client is not wired to the game socket',
        timeout: 10000,
      })
      .toBe('server');
    await expect(page.getByText('Tap to play')).toBeVisible({ timeout: 10000 });
    await expect(forbiddenUi(page)).toHaveCount(0);

    // ---- 1. first tap this boot: the intro, not PLAYING directly --------------------------
    await page.locator('.btn-start').click();
    await expect(page.locator('.modal-backdrop .modal')).toBeVisible({ timeout: 5000 });
    await expect(
      page.getByText('Predict gold for 5 seconds. Win 3 in a row and take home the $100 bonus.'),
    ).toBeVisible();
    await expect(forbiddenUi(page)).toHaveCount(0);
    await page.screenshot({ path: `${REPORT_DIR}/04-kiosk-intro.png` });

    // Dismissing it counts as activity and starts PLAYING (docs/layers.md, B10 decision 2).
    await page.getByRole('button', { name: 'Start' }).click();
    await expect(page.locator('.modal-backdrop')).toHaveCount(0);
    await expect(page.locator('.btn-up')).toBeEnabled({ timeout: 20000 });
    await expect(forbiddenUi(page)).toHaveCount(0);
    await page.screenshot({ path: `${REPORT_DIR}/05-kiosk-playing-no-ad-zone.png` });

    // ---- 2. back to ATTRACT (a synthetic idle frame, the same technique
    // tests/e2e/kiosk.spec.js uses to drive screens deterministically) and tap again: the intro
    // must not show a second time this boot -----------------------------------------------
    await page.evaluate(() => {
      window.__xchief.inject({ type: 'kiosk_session', coins: 1000, streak: 0, state: 'idle' });
    });
    await expect(page.getByText('Tap to play')).toBeVisible({ timeout: 5000 });

    await page.locator('.btn-start').click();
    await expect(page.locator('.modal-backdrop')).toHaveCount(0, { timeout: 3000 });
    await expect(page.locator('.btn-up')).toBeEnabled({ timeout: 20000 });
    await expect(forbiddenUi(page)).toHaveCount(0);
  });
});

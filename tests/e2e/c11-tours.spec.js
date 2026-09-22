// E2E for ticket C11: the real first-visit tour (web) and the kiosk intro, both mounted on the
// B10 flags. Web: three cards, Next, Skip on card 1 ends the tour, and the tour never returns
// after a reload (xchief.tour_seen). Kiosk: the intro shows once per boot, both languages at
// once, and its "Start" button drops the visitor into PLAYING - and its streak number comes from
// the server's kiosk_session frame, never a hard-coded 3.
//
// Dev recipe used for this suite: a copy of db/run-tests.sh with PORT=55460 and container
// goldrush-c11-keep, the game server on PORT=8801 with VITE_GAME_WS=ws://localhost:8801/ws, and
// Vite on 5362. GAME_WS and DATABASE_URL must be set in the environment; this suite never reads
// .env. Screenshots land in docs/reports/c11/.
import { expect, test } from '@playwright/test';

const REPORT_DIR = 'docs/reports/c11';

// The hard guarantee a kiosk must keep (docs/layers.md C2): none of the web's chrome may ever
// exist in the kiosk DOM, intro screen included.
function forbiddenUi(page) {
  return page.locator('.lead, .signup, .lb, .tasks, .nav, .ad-zone, input[type="email"]');
}

test.describe('web: the three-card first-visit tour (C11)', () => {
  test.setTimeout(60000);

  test('walks all three cards with Next, Got it ends it, and it never returns after reload', async ({ page }) => {
    // A fresh browser context (Playwright gives every test one) starts with empty localStorage,
    // so this is exactly a first visit: no pre-seeding, no test-only bypass.
    await page.goto('/');
    await expect(page.locator('.modal-backdrop .modal')).toBeVisible({ timeout: 10000 });

    await expect(page.locator('.modal-title')).toHaveText('Call the next 5 seconds');
    await expect(page.locator('.modal-sub')).toHaveText('Gold goes up or down. Pick one before the round starts.');
    await page.screenshot({ path: `${REPORT_DIR}/01-web-card-1.png` });

    await page.getByRole('button', { name: 'Next' }).click();
    await expect(page.locator('.modal-title')).toHaveText('Win coins, climb the board');
    await expect(page.locator('.modal-sub')).toHaveText(
      'Every right call adds to your record; the top of the board wins the prize.',
    );
    await page.screenshot({ path: `${REPORT_DIR}/02-web-card-2.png` });

    await page.getByRole('button', { name: 'Next' }).click();
    await expect(page.locator('.modal-title')).toHaveText('Verify your email to be ranked');
    await expect(page.locator('.modal-sub')).toHaveText(
      'Anonymous play is fine; only verified emails appear on the leaderboard.',
    );
    await page.screenshot({ path: `${REPORT_DIR}/03-web-card-3.png` });

    // The last card advances nothing: it has no Next, only the terminal Got it.
    await expect(page.getByRole('button', { name: 'Next' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Got it' }).click();
    await expect(page.locator('.modal-backdrop')).toHaveCount(0);

    // xchief.tour_seen persisted: a reload never shows the tour again.
    await page.reload();
    await expect(page.locator('.modal-backdrop')).toHaveCount(0, { timeout: 5000 });
    await expect(page.locator('.hero-art')).toBeVisible();
    await page.screenshot({ path: `${REPORT_DIR}/04-web-no-tour-after-reload.png` });
  });

  test('Skip on card 1 ends the tour, and it never returns after reload', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.modal-backdrop .modal')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.modal-title')).toHaveText('Call the next 5 seconds');

    await page.getByRole('button', { name: 'Skip' }).click();
    await expect(page.locator('.modal-backdrop')).toHaveCount(0);

    await page.reload();
    await expect(page.locator('.modal-backdrop')).toHaveCount(0, { timeout: 5000 });
    await expect(page.locator('.hero-art')).toBeVisible();
  });
});

test.describe.serial('kiosk: the intro on the B10 mount point (C11)', () => {
  test.setTimeout(60000);

  // Each test gets its own fresh browser context (empty localStorage), so /kiosk self-provisions
  // a brand-new, already-idle kiosk identity every time - no shared dev secret to reset anymore.
  test('the intro shows once per boot, and Start goes to play', async ({ page }) => {
    await page.goto('/kiosk');
    await expect
      .poll(() => page.evaluate(() => window.__xchief && window.__xchief.mode), {
        message: 'window.__xchief.mode must be "server" - the client is not wired to the game socket',
        timeout: 10000,
      })
      .toBe('server');
    await expect(page.getByText('Tap to play')).toBeVisible({ timeout: 10000 });

    // ---- 1. first tap this boot: the intro, not PLAYING directly ----------------------------
    await page.locator('.btn-start').click();
    await expect(page.locator('.modal-backdrop .modal')).toBeVisible({ timeout: 5000 });
    await expect(
      page.getByText('Predict gold for 5 seconds. Win 3 in a row and take home the $100 bonus.'),
    ).toBeVisible();
    await expect(forbiddenUi(page)).toHaveCount(0);
    await page.screenshot({ path: `${REPORT_DIR}/05-kiosk-intro.png` });

    // Start counts as activity and begins PLAYING (docs/layers.md, B10 decision 2).
    await page.getByRole('button', { name: 'Start' }).click();
    await expect(page.locator('.modal-backdrop')).toHaveCount(0);
    await expect(page.locator('.btn-up')).toBeEnabled({ timeout: 20000 });
    await expect(forbiddenUi(page)).toHaveCount(0);
    await page.screenshot({ path: `${REPORT_DIR}/06-kiosk-playing.png` });

    // ---- 2. back to ATTRACT (a synthetic idle frame, the technique kiosk.spec.js uses) and
    // tap again: the intro must not show a second time this boot --------------------------
    await page.evaluate(() => {
      window.__xchief.inject({ type: 'kiosk_session', coins: 1000, streak: 0, state: 'idle' });
    });
    await expect(page.getByText('Tap to play')).toBeVisible({ timeout: 5000 });

    await page.locator('.btn-start').click();
    await expect(page.locator('.modal-backdrop')).toHaveCount(0, { timeout: 3000 });
    await expect(page.locator('.btn-up')).toBeEnabled({ timeout: 20000 });
  });

  test('the intro number is the streak_target from the session frame, not a hard-coded 3', async ({ page }) => {
    await page.goto('/kiosk');
    await expect
      .poll(() => page.evaluate(() => window.__xchief && window.__xchief.mode), {
        message: 'window.__xchief.mode must be "server" - the client is not wired to the game socket',
        timeout: 10000,
      })
      .toBe('server');
    await expect(page.getByText('Tap to play')).toBeVisible({ timeout: 10000 });

    // Open the intro first so the server's own post-auth kiosk_session (streak_target 3) has
    // definitely landed; then push the exact kiosk_session shape the server sends, with the
    // owner's target at 7. The intro must read it from the frame (useKioskFlow's streakTarget)
    // and re-render, rather than keep a hard-coded 3.
    await page.locator('.btn-start').click();
    await expect(page.locator('.modal-backdrop .modal')).toBeVisible({ timeout: 5000 });
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      window.__xchief.inject({
        type: 'kiosk_session',
        coins: 1000,
        streak: 0,
        state: 'idle',
        codes_left: 1,
        streak_target: 7,
      });
    });

    await expect(page.getByText('Win 7 in a row and take home the $100 bonus.')).toBeVisible();
    await page.screenshot({ path: `${REPORT_DIR}/07-kiosk-intro-streak-target.png` });
    await expect(forbiddenUi(page)).toHaveCount(0);
  });
});

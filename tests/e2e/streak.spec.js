// Blind E2E for the kiosk streak QR/claim screen (default kiosk_streak_target is 3). Synthetic
// frames enter through the DEV-only socket hook, while the assertions exercise the same client
// rendering path as server frames.
import { expect, test } from '@playwright/test';

import { dismissFirstVisit } from './first-visit.js';

const CLAIM_URL = 'http://localhost:5359/claim/b14-exact-claim-token-1234';

function settledFrame(streak, extra = {}) {
  return {
    type: 'round_settled',
    round_id: `b14-round-${streak}`,
    outcome: 'win',
    delta: 100,
    mult: streak >= 3 ? 3 : streak === 2 ? 2 : 1.5,
    coins: 1000 + streak * 100,
    streak,
    claim_url: null,
    claim_expires_at: null,
    coupons_exhausted: false,
    state: 'playing',
    start_price: 2000,
    end_price: 2001,
    ...extra,
  };
}

async function injectSettled(page, streak, extra = {}) {
  await page.evaluate(
    ({ frame, coins, state }) => {
      window.__xchief.inject(frame);
      window.__xchief.inject({ type: 'kiosk_session', coins, streak: frame.streak, state });
    },
    { frame: settledFrame(streak, extra), coins: 1000 + streak * 100, state: extra.state || 'playing' },
  );
}

/** The kiosk play screen does not print the streak as a number: the contract-visible effects
 * of a streak are the balance from the frame's coins and the lit combo indicator. */
async function expectDisplayedStreak(page, streak) {
  await expect(page.locator('.balance-text')).toHaveText((1000 + streak * 100).toLocaleString('en-US'));
  await expect(page.locator('.combo-on')).toHaveCount(1);
}

test.describe.serial('kiosk streak QR claim screen', () => {
  test.setTimeout(45000);

  // Each test gets its own fresh browser context (empty localStorage), so /kiosk self-provisions
  // a brand-new, already-idle kiosk identity every time - no shared dev secret to reset anymore.
  test('shows the QR claim screen with no code, and the button resets to ATTRACT', async ({ page }) => {
    await page.goto('/kiosk');
    await expect(page.getByText('Tap to play')).toBeVisible({ timeout: 10000 });
    await page.locator('.btn-start').click();
    await dismissFirstVisit(page);
    await expect(page.locator('.btn-up')).toBeEnabled({ timeout: 10000 });

    // Streaks below the default target of 3 (a real kiosk win would already show the QR screen
    // at streak 3, so only 1 and 2 are the plausible pre-win states here).
    for (const streak of [1, 2]) {
      await injectSettled(page, streak);
      await expectDisplayedStreak(page, streak);
    }

    await injectSettled(page, 0, {
      claim_url: CLAIM_URL,
      claim_expires_at: new Date(Date.now() + 86400000).toISOString(),
      state: 'won',
    });
    await expect(
      page.getByText('Congratulations! You won the xChief $100 bonus. Scan to claim your gift:'),
    ).toBeVisible({ timeout: 5000 });
    const qr = page.locator('.kiosk-qr');
    await expect(qr).toBeVisible();
    await expect
      .poll(() => qr.evaluate((element) => element.getClientRects().length))
      .toBe(1);
    await expect(page.getByRole('button', { name: "I've scanned it" })).toBeVisible();

    await page.getByRole('button', { name: "I've scanned it" }).click();
    await expect(page.getByText('Tap to play')).toBeVisible({ timeout: 10000 });
  });

  test('does not hide the QR screen before its own 20-second contract window', async ({ page }) => {
    await page.goto('/kiosk');
    await expect(page.getByText('Tap to play')).toBeVisible({ timeout: 10000 });
    await page.locator('.btn-start').click();
    await dismissFirstVisit(page);
    await expect(page.locator('.btn-up')).toBeEnabled({ timeout: 10000 });

    await injectSettled(page, 0, {
      claim_url: CLAIM_URL,
      claim_expires_at: new Date(Date.now() + 86400000).toISOString(),
      state: 'won',
    });
    await expect(page.locator('.kiosk-qr')).toBeVisible({ timeout: 5000 });
    await page.waitForTimeout(15000);
    await expect(page.locator('.kiosk-qr')).toBeVisible();
  });
});

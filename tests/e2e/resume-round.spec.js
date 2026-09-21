// E2E for ticket resume-round: leaving the play screen mid-round must not make the client forget
// that round is still live - the server keeps it running and paying out regardless of who is
// watching (AGENTS.md's "server owns the round"). Same harness as tests/e2e/nav-on-play.spec.js.
import { expect, test } from '@playwright/test';

import { dismissFirstVisit } from './first-visit.js';

async function startGame(page) {
  await page.goto('/');
  await dismissFirstVisit(page);
  await page.locator('.btn-start').click();
  await expect(page.locator('.btn-up')).toBeEnabled({ timeout: 20000 });
}

test.describe('Resuming a round after leaving the play screen', () => {
  test('leaving mid-round and returning shows that same round still running, locked, with no toasts', async ({
    page,
  }) => {
    await startGame(page);
    await page.click('.btn-up');
    await expect(page.locator('.countdown')).toBeVisible({ timeout: 3000 });

    // Nav order is fixed (home, game, tasks, lb) - see App.jsx's Nav component.
    await page.locator('.nav-btn').nth(2).click(); // Missions
    await page.getByRole('button', { name: 'Leave anyway' }).click();
    await expect(page.locator('.tasks')).toBeVisible();

    // Long enough to prove the round is not sitting frozen, short enough that it has not
    // settled yet - the round lasts 5s total.
    await page.waitForTimeout(2000);
    await expect(page.locator('.toast')).toHaveCount(0);

    await page.locator('.nav-btn').nth(1).click(); // back to Play
    await expect(page.locator('.console')).toBeVisible();

    // The same round, not a fresh idle screen: locked in on the prediction already made, the
    // up/down buttons unavailable exactly as they were before leaving.
    await expect(page.locator('.pane-idle')).toHaveCount(0);
    await expect(page.locator('.pane-running')).toBeVisible();
    await expect(page.locator('.locked-note')).toContainText('Up ▲');
    await expect(page.locator('.btn-up')).toBeDisabled();
    await expect(page.locator('.btn-down')).toBeDisabled();

    // No refusal, no rate limit, anywhere in this journey - and the round settles on its own.
    await expect(page.locator('.toast')).toHaveCount(0);
    await expect(page.locator('.pane-result')).toBeVisible({ timeout: 6000 });
    await expect(page.locator('.toast')).toHaveCount(0);
  });

  test('leaving, letting the round settle while away, and returning shows the settled result, not a dead countdown or a refusal', async ({
    page,
  }) => {
    await startGame(page);
    await page.click('.btn-up');
    await expect(page.locator('.countdown')).toBeVisible({ timeout: 3000 });

    await page.locator('.nav-btn').nth(0).click(); // Home
    await page.getByRole('button', { name: 'Leave anyway' }).click();
    await expect(page.locator('.home')).toBeVisible();

    // Wait for the round to actually settle while away - the same signal the client itself
    // bumps (src/api/socket.js's devSnapshot, on every round_settled frame), not a blind sleep.
    await page.waitForFunction(() => window.__xchief && window.__xchief.settledCount >= 1, null, {
      timeout: 10000,
    });
    await expect(page.locator('.toast')).toHaveCount(0);

    await page.locator('.nav-btn').nth(1).click(); // back to Play
    await expect(page.locator('.pane-result')).toBeVisible({ timeout: 2000 });
    await expect(page.locator('.pane-idle')).toHaveCount(0);
    await expect(page.locator('.countdown')).toHaveCount(0);
    await expect(page.locator('.toast')).toHaveCount(0);
  });

  test('a player who never leaves the play screen is unaffected', async ({ page }) => {
    await startGame(page);
    await page.click('.btn-up');
    await expect(page.locator('.countdown')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('.pane-result')).toBeVisible({ timeout: 20000 });
    await expect(page.locator('.toast')).toHaveCount(0);
  });
});

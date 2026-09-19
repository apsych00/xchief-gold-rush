// E2E for the "Share your record" mission (db/seed.sql's 'story' row, kind='manual'). The bug this
// replaces: tapping the mission's own row granted the reward on the tap itself. The fixed flow
// (src/Tasks.jsx -> src/Profile.jsx -> src/ShareModal.jsx's `mission` mode) instead navigates to
// Profile, opens the same share-my-record modal a player already knows, and only claims once a
// fake 3 s countdown after the Share/Download press finishes - never on the tap that got here.
import { expect, test } from '@playwright/test';

import { dismissFirstVisit } from './first-visit.js';

// Coins as rendered in the top balance chip, locale digits stripped to a number.
async function screenCoins(page) {
  const text = await page.locator('.balance-text').innerText();
  return Number(text.replace(/[^\d]/g, ''));
}

async function goToTasks(page) {
  await page.locator('.nav-btn').nth(2).click();
  await expect(page.locator('.tasks')).toBeVisible({ timeout: 5000 });
}

function shareMissionRow(page) {
  return page.locator('.task').filter({ hasText: 'Share your record' });
}

// Forces the file-share branch so the primary button reads "Share" and pressing it calls
// navigator.share directly, the same stub instagram.spec.js / share.spec.js use.
async function stubFileShare(page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'canShare', { value: () => true, configurable: true });
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: async () => {
        window.__shared = true;
      },
    });
  });
}

test.describe('share your record mission', () => {
  test.setTimeout(120000);

  test('tapping the mission row only navigates - nothing is granted until the countdown after Share finishes', async ({
    page,
  }) => {
    await stubFileShare(page);
    await page.goto('/');
    await dismissFirstVisit(page);
    await expect
      .poll(() => page.evaluate(() => window.__xchief && window.__xchief.mode), { timeout: 10000 })
      .toBe('server');

    const beforeCoins = await screenCoins(page);

    await goToTasks(page);
    const row = shareMissionRow(page);
    await expect(row).toBeVisible();
    await row.locator('.task-btn').click();

    // The tap itself only navigates: Profile is shown, its share modal is already open (no
    // separate press of the profile's own "Share my record" button), and nothing was credited.
    await expect(page.locator('.pf')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('.share-modal')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('.share-badge-img')).toBeVisible({ timeout: 10000 });
    expect(await screenCoins(page)).toBe(beforeCoins);

    // Pressing Share starts the fake countdown; the button label counts down and stays disabled
    // instead of granting immediately.
    await page.getByRole('button', { name: /^Share$/ }).click();
    await expect(page.locator('.share-primary')).toBeDisabled();
    await expect(page.locator('.share-primary')).toContainText(/\d/);
    expect(await screenCoins(page)).toBe(beforeCoins);

    // Only once the countdown reaches zero does the reward land and the modal close itself.
    await expect(page.locator('.share-modal')).toHaveCount(0, { timeout: 6000 });
    await expect.poll(() => screenCoins(page), { timeout: 10000 }).toBe(beforeCoins + 300);

    // Back on Tasks, the mission reads claimed and the balance carried over.
    await goToTasks(page);
    await expect(row.locator('.task-state')).toBeVisible({ timeout: 5000 });
    await expect(row.locator('.task-btn')).toHaveCount(0);
    expect(await screenCoins(page)).toBe(beforeCoins + 300);
  });

  test('closing the share modal before pressing Share grants nothing and leaves the mission claimable', async ({
    page,
  }) => {
    await stubFileShare(page);
    await page.goto('/');
    await dismissFirstVisit(page);
    await expect
      .poll(() => page.evaluate(() => window.__xchief && window.__xchief.mode), { timeout: 10000 })
      .toBe('server');

    const beforeCoins = await screenCoins(page);

    await goToTasks(page);
    const row = shareMissionRow(page);
    await row.locator('.task-btn').click();
    await expect(page.locator('.share-modal')).toBeVisible({ timeout: 5000 });

    await page.getByRole('button', { name: /close/i }).click();
    await expect(page.locator('.share-modal')).toHaveCount(0);
    expect(await screenCoins(page)).toBe(beforeCoins);

    await goToTasks(page);
    await expect(row.locator('.task-btn')).toBeVisible({ timeout: 5000 });
    await expect(row.locator('.task-state')).toHaveCount(0);
    expect(await screenCoins(page)).toBe(beforeCoins);
  });

  test('closing the modal mid-countdown grants nothing and leaves the mission claimable', async ({ page }) => {
    await stubFileShare(page);
    await page.goto('/');
    await dismissFirstVisit(page);
    await expect
      .poll(() => page.evaluate(() => window.__xchief && window.__xchief.mode), { timeout: 10000 })
      .toBe('server');

    const beforeCoins = await screenCoins(page);

    await goToTasks(page);
    const row = shareMissionRow(page);
    await row.locator('.task-btn').click();
    await expect(page.locator('.share-modal')).toBeVisible({ timeout: 5000 });

    // Every modal in this app is a full-screen backdrop (.modal-backdrop, z-index 30) that sits
    // above the bottom nav and top bar - the same as the PIN, video and Instagram modals - so
    // there is no way to tap away to Home or Tasks while this one is open. The only reachable
    // "abandon mid-countdown" path is the modal's own Close button, pressed before the 3 s
    // countdown that started on the Share press has finished.
    await page.getByRole('button', { name: /^Share$/ }).click();
    await expect(page.locator('.share-primary')).toBeDisabled();
    await page.getByRole('button', { name: /close/i }).click();
    await expect(page.locator('.share-modal')).toHaveCount(0);

    // Give the 3 s countdown time to have elapsed if it had (wrongly) survived the close.
    await page.waitForTimeout(4000);
    expect(await screenCoins(page)).toBe(beforeCoins);

    await goToTasks(page);
    await expect(row.locator('.task-btn')).toBeVisible({ timeout: 5000 });
    await expect(row.locator('.task-state')).toHaveCount(0);
    expect(await screenCoins(page)).toBe(beforeCoins);
  });

  test('the standalone profile share button (not via the mission) never grants the mission reward', async ({
    page,
  }) => {
    await stubFileShare(page);
    await page.goto('/');
    await dismissFirstVisit(page);
    await expect
      .poll(() => page.evaluate(() => window.__xchief && window.__xchief.mode), { timeout: 10000 })
      .toBe('server');

    const beforeCoins = await screenCoins(page);

    // Straight to Profile via the avatar, never through the Tasks row.
    await page.getByRole('button', { name: /your profile|profile/i }).click();
    await expect(page.locator('.pf')).toBeVisible();
    await expect(page.locator('.share-modal')).toHaveCount(0);
    await page.getByRole('button', { name: /share my record/i }).click();
    await expect(page.locator('.share-modal')).toBeVisible();
    await expect(page.locator('.share-badge-img')).toBeVisible({ timeout: 10000 });

    // No mission hint, no countdown: this is the plain share action, unchanged.
    await expect(page.locator('.share-modal .modal-sub')).toHaveCount(0);
    await page.getByRole('button', { name: /^Share$/ }).click();
    await expect(page.locator('.share-primary')).toBeEnabled();

    await page.waitForTimeout(4000);
    expect(await screenCoins(page)).toBe(beforeCoins);

    await page.getByRole('button', { name: /close/i }).click();
    await expect(page.locator('.share-modal')).toHaveCount(0);
    await goToTasks(page);
    await expect(shareMissionRow(page).locator('.task-btn')).toBeVisible({ timeout: 5000 });
  });
});

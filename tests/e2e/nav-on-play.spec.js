// E2E for ticket nav-on-play: the bottom nav now stays on the play screen, so an accidental tap
// mid-round must not cost the player their stake. Same harness as tests/e2e/smoke.spec.js: a
// running dev server (BASE_URL) against the box game server.
import { expect, test } from '@playwright/test';

import { dismissFirstVisit } from './first-visit.js';

function pathnameOf(page) {
  return new URL(page.url()).pathname;
}

async function startGame(page) {
  await page.goto('/');
  await dismissFirstVisit(page);
  await page.locator('.btn-start').click();
  // The direction buttons stay disabled until a live price is in.
  await expect(page.locator('.btn-up')).toBeEnabled({ timeout: 20000 });
}

test.describe('Bottom nav on the play screen', () => {
  test('the nav is visible on the play screen, and the old home button is gone', async ({ page }) => {
    await startGame(page);
    await expect(page.locator('.nav')).toBeVisible();
    await expect(page.locator('.nav-btn')).toHaveCount(4);
    await expect(page.locator('.btn-home')).toHaveCount(0);
  });

  test('tapping a nav destination during a live round asks first, and does not navigate', async ({ page }) => {
    await startGame(page);
    await page.click('.btn-up');
    await expect(page.locator('.countdown')).toBeVisible({ timeout: 3000 });

    // Nav order is fixed (home, game, tasks, lb) - see App.jsx's Nav component.
    await page.locator('.nav-btn').nth(2).click();
    await expect(page.locator('.modal-title')).toHaveText('Leave the play screen?');
    await expect(page.locator('.tasks')).toHaveCount(0);
    expect(pathnameOf(page)).toBe('/play');
  });

  test('cancelling leaves the player on the play screen with their round still running', async ({ page }) => {
    await startGame(page);
    await page.click('.btn-up');
    await expect(page.locator('.countdown')).toBeVisible({ timeout: 3000 });

    await page.locator('.nav-btn').nth(3).click(); // Board
    await page.getByRole('button', { name: 'Keep playing' }).click();

    await expect(page.locator('.modal-backdrop')).toHaveCount(0);
    await expect(page.locator('.console')).toBeVisible();
    await expect(page.locator('.countdown')).toBeVisible();
    await expect(page.locator('.pane-result')).toHaveCount(0);
    expect(pathnameOf(page)).toBe('/play');
  });

  test('confirming navigates to the tapped destination', async ({ page }) => {
    await startGame(page);
    await page.click('.btn-up');
    await expect(page.locator('.countdown')).toBeVisible({ timeout: 3000 });

    await page.locator('.nav-btn').nth(2).click(); // Missions
    await page.getByRole('button', { name: 'Leave anyway' }).click();

    await expect(page.locator('.modal-backdrop')).toHaveCount(0);
    await expect(page.locator('.tasks')).toBeVisible();
    expect(pathnameOf(page)).toBe('/missions');
  });

  test('tapping a nav destination on the result screen navigates immediately, with no dialog', async ({ page }) => {
    await startGame(page);
    await page.click('.btn-up');
    await expect(page.locator('.countdown')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('.pane-result')).toBeVisible({ timeout: 20000 });

    await page.locator('.nav-btn').nth(3).click(); // Board
    await expect(page.locator('.modal-backdrop')).toHaveCount(0);
    await expect(page.locator('.lb')).toBeVisible();
    expect(pathnameOf(page)).toBe('/board');
  });

  // Decision (ticket nav-on-play): the hardware/gesture back button can walk off the play screen
  // exactly as a nav tap can, so it is guarded the same way - useUrlRouting.js's popstate handler
  // puts the address bar back to /play before the confirmation shows, and only moves it on to the
  // new screen once the player actually confirms.
  test('browser back during a live round also asks first; cancelling restores the URL and the round', async ({
    page,
  }) => {
    await startGame(page);
    expect(pathnameOf(page)).toBe('/play');
    await page.click('.btn-up');
    await expect(page.locator('.countdown')).toBeVisible({ timeout: 3000 });

    await page.evaluate(() => window.history.back());
    await expect(page.locator('.modal-title')).toHaveText('Leave the play screen?');

    await page.getByRole('button', { name: 'Keep playing' }).click();
    await expect(page.locator('.modal-backdrop')).toHaveCount(0);
    expect(pathnameOf(page)).toBe('/play');
    await expect(page.locator('.countdown')).toBeVisible();

    await page.evaluate(() => window.history.back());
    await page.getByRole('button', { name: 'Leave anyway' }).click();
    await expect(page.locator('.home')).toBeVisible();
    expect(pathnameOf(page)).toBe('/');
  });
});

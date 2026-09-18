// E2E for the Instagram follow reward (ticket K3). Runs against the dev server, the box game
// server, and the fake BoxAPI server configured in playwright.config.js. The player enters a
// handle, is sent to Instagram to follow, and the server verifies the follow through BoxAPI.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

import { dismissFirstVisit } from './first-visit.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const REPORT_DIR = path.join(REPO_ROOT, 'docs', 'reports', 'k3');
fs.mkdirSync(REPORT_DIR, { recursive: true });

// Coins as rendered in the top balance chip, locale digits stripped to a number.
async function screenCoins(page) {
  const text = await page.locator('.balance-text').innerText();
  return Number(text.replace(/[^\d]/g, ''));
}

test.describe('Instagram follow reward', () => {
  test.setTimeout(120000);

  test('entering a handle, following, and checking verifies the follow and credits the reward', async ({ page }) => {
    // A blank popup opens for the Instagram deep link; keep it from being an unhandled page.
    page.on('popup', (popup) => popup.close().catch(() => {}));

    await page.goto('/');
    await dismissFirstVisit(page);
    await expect
      .poll(() => page.evaluate(() => window.__xchief && window.__xchief.mode), { timeout: 10000 })
      .toBe('server');

    const beforeCoins = await screenCoins(page);

    // Open the tasks screen.
    await page.locator('.nav-btn').nth(2).click();
    await expect(page.locator('.tasks')).toBeVisible({ timeout: 5000 });

    const instagramTask = page.locator('.task').filter({ hasText: 'Follow on Instagram' });
    await expect(instagramTask).toBeVisible();
    await instagramTask.locator('.task-btn').click();

    // Step 1: enter the handle of a fake account that is on page 1 of OUR follower list (the
    // primary our-followers proof), then tap Follow.
    const handleInput = page.locator('.ig-handle-input');
    await expect(handleInput).toBeVisible({ timeout: 5000 });
    await handleInput.fill('follower');
    await page.screenshot({ path: path.join(REPORT_DIR, '01-instagram-handle.png') });
    await page.getByRole('button', { name: 'Follow @xchief.global' }).click();

    // Step 2: tap "I followed, check". The tab regaining focus may auto-check first; tolerate the
    // button having already vanished.
    await page
      .getByRole('button', { name: 'I followed, check' })
      .click({ timeout: 5000 })
      .catch(() => {});

    await expect(page.locator('.instagram-status-done')).toBeVisible({ timeout: 10000 });
    await expect(instagramTask.locator('.task-state')).toBeVisible({ timeout: 10000 });
    await page.screenshot({ path: path.join(REPORT_DIR, '02-instagram-claimed.png') });

    await expect.poll(() => screenCoins(page), { timeout: 10000 }).toBe(beforeCoins + 300);
  });

  test('a first check that cannot confirm is refused, then a second check grants the reward', async ({ page }) => {
    // Owner policy (ticket K3): a genuine follower can still fail our read (freshness, privacy,
    // paging), so the second genuine check grants the reward - server-side, the client never
    // claims it. Here 'nonfollower' never confirms, the strictest case the policy forgives.
    page.on('popup', (popup) => popup.close().catch(() => {}));

    await page.goto('/');
    await dismissFirstVisit(page);
    await expect
      .poll(() => page.evaluate(() => window.__xchief && window.__xchief.mode), { timeout: 10000 })
      .toBe('server');

    const beforeCoins = await screenCoins(page);

    await page.locator('.nav-btn').nth(2).click();
    await expect(page.locator('.tasks')).toBeVisible({ timeout: 5000 });

    const instagramTask = page.locator('.task').filter({ hasText: 'Follow on Instagram' });
    await expect(instagramTask).toBeVisible();
    await instagramTask.locator('.task-btn').click();

    const handleInput = page.locator('.ig-handle-input');
    await expect(handleInput).toBeVisible({ timeout: 5000 });
    await handleInput.fill('nonfollower');
    await page.getByRole('button', { name: 'Follow @xchief.global' }).click();

    // First check: refused. The soft "we could not see the follow yet" hint appears and no reward
    // is credited.
    await page.getByRole('button', { name: 'I followed, check' }).click({ timeout: 5000 });
    await expect(page.locator('.modal .lead-error')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.instagram-status-done')).toHaveCount(0);
    expect(await screenCoins(page)).toBe(beforeCoins);

    // Second genuine check, past the per-player window: granted regardless.
    await page.waitForTimeout(1800);
    await page
      .getByRole('button', { name: 'I followed, check' })
      .click({ timeout: 5000 })
      .catch(() => {});

    await expect(page.locator('.instagram-status-done')).toBeVisible({ timeout: 15000 });
    await expect(instagramTask.locator('.task-state')).toBeVisible({ timeout: 10000 });
    await expect.poll(() => screenCoins(page), { timeout: 10000 }).toBe(beforeCoins + 300);
  });
});

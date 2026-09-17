// E2E for the Instagram follow reward (ticket B8). Runs against the dev server and the fake
// Instagram server configured in playwright.config.js.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

import { dismissFirstVisit } from './first-visit.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const REPORT_DIR = path.join(REPO_ROOT, 'docs', 'reports', 'b8');
fs.mkdirSync(REPORT_DIR, { recursive: true });

// Coins as rendered in the top balance chip, locale digits stripped to a number.
async function screenCoins(page) {
  const text = await page.locator('.balance-text').innerText();
  return Number(text.replace(/[^\d]/g, ''));
}

test.describe('Instagram follow reward', () => {
  test.setTimeout(120000);

  test('clicking the Instagram task, completing the fake OAuth flow, and returning shows the done state and credits the reward', async ({
    page,
  }) => {
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

    // The start endpoint redirects to the fake Instagram authorize, which redirects to the
    // local callback, which finally redirects back to the SPA with ?ig=done.
    await page.waitForURL('**/?ig=done', { timeout: 20000 });
    await page.screenshot({ path: path.join(REPORT_DIR, '01-instagram-done-home.png') });

    // Returning to the tasks screen should show the done banner and a claimed row.
    await page.locator('.nav-btn').nth(2).click();
    await expect(page.locator('.tasks')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('.instagram-status-done')).toBeVisible({ timeout: 5000 });
    await expect(instagramTask.locator('.task-state')).toBeVisible({ timeout: 10000 });
    await page.screenshot({ path: path.join(REPORT_DIR, '02-instagram-task-claimed.png') });

    const afterCoins = await screenCoins(page);
    expect(afterCoins).toBe(beforeCoins + 300);
  });
});

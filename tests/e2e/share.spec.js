// E2E for ticket U4: share my record - the profile modal, copy link, social shortcuts,
// and the public share page for a known token.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

import { dismissFirstVisit } from './first-visit.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const REPORT_DIR = path.join(REPO_ROOT, 'docs', 'reports', 'u4');

async function goProfile(page) {
  await page.getByRole('button', { name: /your profile|profile/i }).click();
  await expect(page.locator('.pf')).toBeVisible();
}

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

test.describe('share my record (U4)', () => {
  test.setTimeout(120000);

  test('profile share modal: copy link and Telegram shortcut', async ({ page }) => {
    await page.goto('/');
    await dismissFirstVisit(page);

    await goProfile(page);
    await page.getByRole('button', { name: /share my record/i }).click();
    await expect(page.locator('.share-modal')).toBeVisible();
    await page.screenshot({ path: path.join(REPORT_DIR, '01-share-modal.png') });

    // The URL field should be populated from the share_link frame.
    const urlInput = page.locator('.share-url-input');
    await expect(urlInput).toHaveValue(/\/s\/[A-Za-z0-9_-]{12}$/);
    const shareUrl = await urlInput.inputValue();

    // Copy button writes the clipboard.
    await page.getByRole('button', { name: /copy/i }).click();
    const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboardText).toBe(shareUrl);

    // Telegram shortcut carries the URL.
    const telegram = page.locator('a[aria-label="Telegram"]');
    const telegramHref = await telegram.getAttribute('href');
    expect(telegramHref).toMatch(/^https:\/\/t\.me\/share\/url\?url=/);
    expect(telegramHref).toContain(encodeURIComponent(shareUrl));

    await page.getByRole('button', { name: /close/i }).click();
    await expect(page.locator('.share-modal')).toHaveCount(0);
  });

  test('public share page shows the record and both CTAs', async ({ context }) => {
    // Open a fresh context so the share page reads the token with no prior session.
    const page = await context.newPage();

    // First, mint a share token through the API by asking the server directly.
    // Easier path: create a player with a known token via the test database is not available
    // in E2E, so we use the socket from the web app and then read the token back.
    await page.goto('/');
    await dismissFirstVisit(page);

    await page.getByRole('button', { name: /your profile|profile/i }).click();
    await page.getByRole('button', { name: /share my record/i }).click();
    const urlInput = page.locator('.share-url-input');
    await expect(urlInput).toHaveValue(/\/s\/[A-Za-z0-9_-]{12}$/);
    const shareUrl = await urlInput.inputValue();
    await page.close();

    // Now open the share URL in a brand-new page.
    const sharePage = await context.newPage();
    await sharePage.goto(shareUrl);
    await expect(sharePage.locator('.share-page')).toBeVisible();
    await expect(sharePage.locator('.share-card-record')).toBeVisible();
    // The page shows a primary "Play" CTA plus a secondary tournament/join CTA.
    const ctas = sharePage.locator('.share-cta');
    await expect(ctas).toHaveCount(2);
    await expect(ctas.first()).toBeVisible();
    await sharePage.screenshot({ path: path.join(REPORT_DIR, '02-share-page.png') });
  });

  test('unknown share token shows the unavailable card', async ({ page }) => {
    await page.goto('/s/this-token-is-not-real');
    await expect(page.locator('.share-page')).toBeVisible();
    await expect(page.locator('.share-card-empty')).toBeVisible();
    await expect(page.getByText(/this record is not available/i)).toBeVisible();
    await expect(page.locator('.share-cta')).toHaveCount(1);
  });
});

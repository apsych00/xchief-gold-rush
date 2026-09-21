// E2E for the image-share model: the profile "Share my record" modal renders a badge PNG
// client-side and either opens the OS share sheet with the image attached (navigator.share with
// files) or, where that is unavailable, offers a PNG download plus the join link as plain text.
// There is no public share page and no server token, so nothing here mints or reads one.
import { expect, test } from '@playwright/test';

import { dismissFirstVisit } from './first-visit.js';

async function openShareModal(page) {
  // The header keeps its one avatar control for a guest too, so reach Profile the way a player
  // actually does: tap it.
  await page.locator('.avatar-btn').click();
  await expect(page.locator('.pf')).toBeVisible();
  await page.getByRole('button', { name: /share my record/i }).click();
  await expect(page.locator('.share-modal')).toBeVisible();
  // The badge is drawn on a canvas and shown as an <img>; wait for it to render.
  await expect(page.locator('.share-badge-img')).toBeVisible();
}

test.describe('share my record (image)', () => {
  test.setTimeout(120000);

  test('fallback without file share: download button and a plain join link', async ({ page }) => {
    // Force the no-file-share branch (most desktops) so the fallback UI is what renders.
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'canShare', { value: () => false, configurable: true });
    });
    await page.goto('/');
    await dismissFirstVisit(page);
    await openShareModal(page);

    await expect(page.getByRole('button', { name: /download image/i })).toBeVisible();

    // The join link is plain, selectable text carrying the campaign UTM params - not a copy-link.
    const joinUrl = await page.locator('.share-join-url').innerText();
    expect(joinUrl).toMatch(/^https:\/\//);
    expect(joinUrl).toContain('utm_source=goldrush');
    expect(joinUrl).toContain('utm_campaign=goldrush');

    // No copy-link, no per-network intent buttons, no share URL input survive from the old model.
    await expect(page.locator('.share-url-input')).toHaveCount(0);
    await expect(page.locator('a[aria-label="Share to Telegram"]')).toHaveCount(0);

    await page.getByRole('button', { name: /close/i }).click();
    await expect(page.locator('.share-modal')).toHaveCount(0);
  });

  test('with file share: primary Share button hands a PNG file and the join url to navigator.share', async ({ page }) => {
    // Stub the Web Share API so the OS sheet never opens and we can inspect what was shared.
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'canShare', { value: () => true, configurable: true });
      Object.defineProperty(navigator, 'share', {
        configurable: true,
        value: async (data) => {
          const file = data.files && data.files[0];
          window.__shared = {
            url: data.url,
            hasText: typeof data.text === 'string' && data.text.length > 0,
            fileName: file ? file.name : null,
            fileType: file ? file.type : null,
            fileSize: file ? file.size : 0,
          };
        },
      });
    });
    await page.goto('/');
    await dismissFirstVisit(page);
    await openShareModal(page);

    // The primary action is a single Share button; no Download/link fallback in this branch.
    await expect(page.getByRole('button', { name: /download image/i })).toHaveCount(0);
    await page.getByRole('button', { name: /^Share$/ }).click();

    const shared = await page.waitForFunction(() => window.__shared).then((h) => h.jsonValue());
    expect(shared.fileName).toBe('xchief-gold-rush-record.png');
    expect(shared.fileType).toBe('image/png');
    expect(shared.fileSize).toBeGreaterThan(0);
    expect(shared.hasText).toBe(true);
    expect(shared.url).toContain('utm_source=goldrush');
  });
});

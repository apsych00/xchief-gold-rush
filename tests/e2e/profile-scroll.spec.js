// E2E for the profile screen's scroll fix: `.pf` used to squeeze every element (including the
// two action buttons) with `justify-content: space-between` and clamp()'d gaps, so once content
// grew past the space between the fixed top bar and the fixed bottom nav, everything - including
// "Share my record" and "Sign out" - compressed below its real height instead of overflowing.
// The fix lets `.pf` scroll its own content while the app shell (`.app`, `position: fixed`) and
// the nav stay put. Also covers the device/email line at the bottom of the screen, which is
// presentational (src/Profile.jsx renders it unconditionally from `profile.emailVerified` /
// `profile.display`, never a stray state bug) - a guest sees the device-bound copy.
import { expect, test } from '@playwright/test';

import { dismissFirstVisit } from './first-visit.js';

async function goProfile(page) {
  // The header keeps its one avatar control for a guest too, so reach Profile the way a player
  // actually does: tap it.
  await page.locator('.avatar-btn').click();
  await expect(page.locator('.pf')).toBeVisible();
}

test.describe('profile screen scroll and the device/email line', () => {
  test.setTimeout(60000);

  for (const viewport of [
    { width: 390, height: 844, label: 'reference (390x844)' },
    { width: 390, height: 640, label: 'short (390x640)' },
  ]) {
    test(`content scrolls, action buttons stay full height, bottom is reachable above the nav - ${viewport.label}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto('/');
      await dismissFirstVisit(page);
      await goProfile(page);

      // The app shell never scrolls (`.app` is `position: fixed; overflow: clip` by design) and
      // the bottom nav stays put - only `.pf` itself scrolls.
      const shellOverflow = await page.locator('.app').evaluate((el) => getComputedStyle(el).overflow);
      expect(shellOverflow).toBe('clip');
      const navBefore = await page.locator('.nav').boundingBox();

      // The two action buttons render at their real height, never compressed by the old
      // flex-shrink bug - CSS declares 44px (40px on the short-viewport compact rule), so
      // anything visibly smaller than that is the bug this fixes.
      const shareBtn = page.getByRole('button', { name: /share my record/i });
      const shareBox = await shareBtn.boundingBox();
      expect(shareBox.height, 'Share my record must not be squashed').toBeGreaterThanOrEqual(38);

      const signOutBtn = page.locator('.btn-signout');
      if (await signOutBtn.count()) {
        const signOutBox = await signOutBtn.boundingBox();
        expect(signOutBox.height, 'Sign out must not be squashed').toBeGreaterThanOrEqual(38);
      }

      // The content region scrolls instead of clipping: scrolling it to the end reaches the real
      // bottom of the content, and the nav is never scrolled away or overlapped.
      const pf = page.locator('.pf');
      await pf.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
      const reach = await pf.evaluate((el) => ({
        scrollTop: el.scrollTop,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
      }));
      expect(reach.scrollTop + reach.clientHeight, 'the bottom of the content must be reachable').toBeGreaterThanOrEqual(
        reach.scrollHeight - 1,
      );
      const navAfter = await page.locator('.nav').boundingBox();
      expect(navAfter).toEqual(navBefore);
      await expect(page.locator('.nav')).toBeVisible();

      // Share stays full height after scrolling too.
      const shareBoxAfter = await shareBtn.boundingBox();
      expect(shareBoxAfter.height).toBeGreaterThanOrEqual(38);
    });
  }

  test("a guest sees the device-bound line, not the signed-in player's email line", async ({ page }) => {
    await page.goto('/');
    await dismissFirstVisit(page);
    await goProfile(page);

    const foot = page.locator('.pf-foot');
    if (await foot.isVisible()) {
      await expect(foot).toHaveText('Progress is saved on this device.');
    }
  });
});

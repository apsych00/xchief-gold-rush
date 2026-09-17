// Shared across every spec in this suite (ticket B10, real content by C11): the web first-visit
// tour (src/App.jsx's TourPlaceholder) is three cards - Next advances, the last card's button is
// "Got it" - and the kiosk boot intro (src/KioskApp.jsx's KioskIntroModal) is one card whose
// button is "Start". Both render the same `.modal-backdrop .modal` shape and both sit in front
// of Play on a fresh page/session. Call this right after the first screen loads (web) or right
// after the attract tap (kiosk) - exactly where a real visitor would meet it - so existing specs
// see the app the same way a first-time player does, with no localStorage pre-seeding and no
// test-only bypass.
import { expect } from '@playwright/test';

export async function dismissFirstVisit(page) {
  const terminal = page.getByRole('button', { name: /^(Got it|Start)$/ });
  const next = page.getByRole('button', { name: 'Next', exact: true });
  try {
    await page.locator('.modal-backdrop').first().waitFor({ state: 'visible', timeout: 3000 });
  } catch {
    return; // this page/session already had its tour or intro dismissed
  }
  // The web tour opens on card 1, which offers only Next; walk forward until the terminal button
  // shows. The kiosk intro opens straight on its terminal "Start". Cards 1-4 is more than the
  // tour has, so a runaway loop cannot happen.
  for (let i = 0; i < 4; i += 1) {
    if (await terminal.isVisible().catch(() => false)) {
      await terminal.click();
      await expect(page.locator('.modal-backdrop')).toHaveCount(0);
      return;
    }
    if (await next.isVisible().catch(() => false)) {
      await next.click();
      continue;
    }
    return;
  }
}

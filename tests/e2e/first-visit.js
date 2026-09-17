// Shared across every spec in this suite (ticket B10): the web tour placeholder and the kiosk
// boot intro (src/App.jsx's TourPlaceholder, src/KioskApp.jsx's KioskIntroModal) both render the
// same `.modal-backdrop .modal` shape with one "Got it" button, and both now sit in front of
// Play on a fresh page/session. Call this right after the first screen loads (web) or right
// after the attract tap (kiosk) - exactly where a real visitor would meet it - so existing specs
// see the app the same way a first-time player does, with no localStorage pre-seeding and no
// test-only bypass.
import { expect } from '@playwright/test';

export async function dismissFirstVisit(page) {
  const gotIt = page.getByRole('button', { name: 'Got it' });
  try {
    await gotIt.waitFor({ state: 'visible', timeout: 3000 });
  } catch {
    return; // this page/session already had its tour or intro dismissed
  }
  await gotIt.click();
  await expect(page.locator('.modal-backdrop')).toHaveCount(0);
}

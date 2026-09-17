// Blind-ish E2E for ticket C3+C4 (docs/layers.md: "Web identity" / "Live, masked leaderboard").
// Same harness as tests/e2e/player-promises.spec.js: a running dev server (BASE_URL) plus the
// box game server (PORT), started by playwright.config.js's webServer entries or already
// running when this suite is invoked. The OTP code is read the same way a human tester would
// in dev - node scripts/peek-otp.mjs <email> against DATABASE_URL, never guessed or faked.
//
// Screenshots land in docs/reports/c3-c4/, each new state saved next to the existing screen or
// component it reuses (design fidelity rule, docs/layers.md).
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

import { dismissFirstVisit } from './first-visit.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const REPORT_DIR = path.join(REPO_ROOT, 'docs', 'reports', 'c3-c4');

function peekOtp(email) {
  const out = execFileSync('node', ['scripts/peek-otp.mjs', email], {
    cwd: REPO_ROOT,
    env: process.env,
    encoding: 'utf8',
  }).trim();
  expect(out, `no dev-captured OTP code found for ${email} - is DATABASE_URL set to the test database?`).not.toBe(
    'none',
  );
  return out;
}

async function goHome(page) {
  await page.getByRole('button', { name: 'Home' }).click();
}

async function goLeaderboard(page) {
  await page.getByRole('button', { name: 'Board' }).click();
  await expect(page.locator('.lb')).toBeVisible();
}

test.describe('web identity and the live, masked leaderboard (C3, C4)', () => {
  test.setTimeout(120000);

  test('OTP entry, an error, the verified header, and the leaderboard own row', async ({ page }) => {
    await page.goto('/');
    await dismissFirstVisit(page);

    // ---- 1. baseline: guest state on the leaderboard (existing screen: the marketing
    // LeadCapture "slim" widget, unrelated to this ticket, already lives here) ------------------
    await goLeaderboard(page);
    await expect(page.locator('.lb-row-me')).toBeVisible();
    await page.screenshot({ path: path.join(REPORT_DIR, '01-existing-leaderboard-guest-baseline.png') });

    // Existing error-state reference: the marketing LeadCapture's own invalid-email message,
    // same .lead-error class the new OTP modal reuses.
    const leadEmailInput = page.locator('.lead-slim input[type="email"]');
    if (await leadEmailInput.count()) {
      await leadEmailInput.fill('not-an-email');
      await page.locator('.lead-slim').getByRole('button', { name: /save|ثبت/i }).click();
      await expect(page.locator('.lead-slim .lead-error')).toBeVisible({ timeout: 3000 });
      await page.screenshot({ path: path.join(REPORT_DIR, '02-existing-lead-capture-error.png') });
    }

    // ---- 2. open the new OTP modal from the leaderboard's guest row ----------------------------
    await page.locator('.lb-row-me').click();
    await expect(page.locator('.modal-backdrop .modal')).toBeVisible();
    await page.screenshot({ path: path.join(REPORT_DIR, '03-otp-entry-email-step.png') });

    const email = `e2e-c3c4-${Date.now()}@example.com`;
    await page.locator('.modal input[type="email"]').fill(email);
    await page.locator('.modal').getByRole('button', { name: /send code/i }).click();

    // ---- 3. the code step, then a deliberate wrong code for the error-state screenshot --------
    await expect(page.locator('.modal .pin-input')).toBeVisible({ timeout: 10000 });
    await page.locator('.modal .pin-input').fill('00000000');
    await page.locator('.modal').getByRole('button', { name: /verify/i }).click();
    await expect(page.locator('.modal .lead-error')).toBeVisible({ timeout: 5000 });
    await page.screenshot({ path: path.join(REPORT_DIR, '04-otp-code-error-state.png') });

    // ---- 4. the real, dev-captured code verifies ------------------------------------------------
    const code = peekOtp(email);
    await page.locator('.modal .pin-input').fill(code);
    await page.locator('.modal').getByRole('button', { name: /verify/i }).click();
    await expect(page.locator('.modal .signup-done-title')).toBeVisible({ timeout: 10000 });
    await page.locator('.modal').getByRole('button', { name: /done/i }).click();
    await expect(page.locator('.modal-backdrop')).toHaveCount(0);

    // ---- 5. the header now shows the masked email, never the raw address ----------------------
    await expect(page.locator('.identity-bar')).toBeVisible({ timeout: 5000 });
    const headerText = await page.locator('.identity-bar').innerText();
    expect(headerText, 'the header must show a masked email, not the raw address').not.toContain(email);
    expect(headerText).toMatch(/\*{3,}/);
    await page.screenshot({ path: path.join(REPORT_DIR, '05-header-verified.png') });

    // ---- 6. the leaderboard's own row is now the real, masked row - highlighted, no synthetic
    // "you" row standing in for it -----------------------------------------------------------
    await goHome(page);
    await goLeaderboard(page);
    await expect(page.locator('.lb-row-me')).toBeVisible({ timeout: 5000 });
    const ownRowText = await page.locator('.lb-row-me').innerText();
    expect(ownRowText, "the leaderboard's own row must show the masked email, not the raw address").not.toContain(
      email,
    );
    expect(ownRowText).toMatch(/\*{3,}/);
    await page.screenshot({ path: path.join(REPORT_DIR, '06-leaderboard-own-row-highlighted.png') });

    // Sign out clears the token; the header identity line disappears again.
    await page.locator('.identity-bar').getByRole('button', { name: /sign out/i }).click();
    await expect(page.locator('.identity-bar')).toHaveCount(0, { timeout: 10000 });
  });
});

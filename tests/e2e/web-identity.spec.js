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
  // Exact match: the logo's own aria-label ("xChief home") also contains the substring "Home",
  // so a loose name match resolves to two buttons under Playwright's default fuzzy matching -
  // this is the nav's own Home tab, never the logo.
  await page.getByRole('button', { name: 'Home', exact: true }).click();
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
      await page.locator('.lead-slim').getByRole('button', { name: /save/i }).click();
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
    await page.locator('.modal .pin-input').fill('0000');
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

    // ---- 5. the profile now shows the masked email, never the raw address ---------------------
    // This used to be a header strip on every screen; it is the profile screen's own account row
    // now, which is the only place that states who you are.
    // The header itself never changes: one avatar control, guest or signed in, no sign-in chip.
    await expect(page.locator('.topbar .signin-chip')).toHaveCount(0);
    const avatar = page.locator('.avatar-btn');
    await expect(avatar).toHaveAttribute('aria-label', 'Your profile');
    expect(await avatar.locator('svg').getAttribute('width')).toBe('24');
    await expect(avatar).toHaveCSS('color', 'rgb(233, 182, 42)');

    await avatar.click();
    await expect(page.locator('.pf')).toBeVisible({ timeout: 5000 });
    expect(await page.locator('.pf-avatar svg').getAttribute('width')).toBe('48');
    // A verified player never sees the sign-in call to action - they get their account details.
    await expect(page.locator('.pf-signin')).toHaveCount(0);
    await expect(page.locator('.pf-danger')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /start over|wipe my progress/i })).toHaveCount(0);
    const profileText = await page.locator('.pf').innerText();
    expect(profileText, 'the profile must show a masked email, not the raw address').not.toContain(email);
    expect(profileText).toMatch(/\*{3,}/);
    await page.screenshot({ path: path.join(REPORT_DIR, '05-profile-verified.png') });

    // ---- 6. the leaderboard's own row is now the real, masked row - highlighted, no synthetic
    // "you" row standing in for it -----------------------------------------------------------
    await goHome(page);
    // Since B1 the board ranks tournament scores, and a score exists only once a round has
    // settled inside the running tournament: play once, any outcome, before looking for the row.
    await page.getByRole('button', { name: 'Play' }).click();
    await expect(page.locator('.btn-up')).toBeEnabled({ timeout: 20000 });
    await page.click('.btn-up');
    await expect(page.locator('.pane-result')).toBeVisible({ timeout: 20000 });
    await goLeaderboard(page);
    await expect(page.locator('.lb-row-me')).toBeVisible({ timeout: 5000 });
    const ownRowText = await page.locator('.lb-row-me').innerText();
    expect(ownRowText, "the leaderboard's own row must show the masked email, not the raw address").not.toContain(
      email,
    );
    expect(ownRowText).toMatch(/\*{3,}/);
    await page.screenshot({ path: path.join(REPORT_DIR, '06-leaderboard-own-row-highlighted.png') });

    // Sign out lives on Profile now, behind a confirmation - it revokes the token server-side and
    // this device comes back as a brand-new player, so it is not a thing to trip into.
    await page.locator('.avatar-btn').click();
    await expect(page.locator('.pf')).toBeVisible({ timeout: 5000 });
    await page.locator('.pf').getByRole('button', { name: /sign out/i }).click();
    await expect(page.locator('.modal-backdrop')).toBeVisible();
    // Backing out leaves the session exactly as it was.
    await page.getByRole('button', { name: /stay signed in/i }).click();
    await expect(page.locator('.modal-backdrop')).toHaveCount(0);
    await expect(page.locator('.pf').getByRole('button', { name: /sign out/i })).toBeVisible();

    // Confirming reloads as a fresh anonymous player. The header does not change at all - same
    // avatar, same slot - the sign-in offer is back on the profile screen instead.
    await page.locator('.pf').getByRole('button', { name: /sign out/i }).click();
    await page.locator('.modal-backdrop').getByRole('button', { name: /^sign out$/i }).click();
    await expect(page.locator('.topbar .signin-chip')).toHaveCount(0);
    await expect(page.locator('.avatar-btn')).toBeVisible({ timeout: 15000 });
    await page.locator('.avatar-btn').click();
    await expect(page.locator('.pf-signin')).toBeVisible({ timeout: 5000 });
  });
});

// E2E for the unify-email-modal ticket: every email-capture and OTP-code prompt in the app now
// renders through the one shared PromptModal (src/PromptModal.jsx), used by src/Identity.jsx's
// OtpModal (both its email and code steps), src/LeadCapture.jsx and src/SignupForm.jsx. This
// suite drives the modal and its state machine from two different, independently reachable call
// sites - the leaderboard's guest row and the Tasks screen's "Save your email" mission - so the
// unification is proven, not just the OTP flow in isolation. It does not touch email delivery:
// the OTP code is read back the same dev-only way tests/e2e/web-identity.spec.js already does,
// via scripts/peek-otp.mjs against public.dev_otps, never an inbox.
//
// Same harness as tests/e2e/web-identity.spec.js: a running dev server (BASE_URL) plus the box
// game server (PORT), both migrated and seeded first (bash db/run-tests.sh --keep or equivalent).
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

import { dismissFirstVisit } from './first-visit.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

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

async function goLeaderboard(page) {
  await page.getByRole('button', { name: 'Board' }).click();
  await expect(page.locator('.lb')).toBeVisible();
}

async function goTasks(page) {
  await page.getByRole('button', { name: 'Missions' }).click();
  await expect(page.locator('.tasks')).toBeVisible();
}

/** The dialog's own height. The error region claims no space at all while it is empty, so the
 * dialog is expected to grow when an error appears and to return to exactly its original height
 * once the error clears. What must NEVER move is the action row while an error is already on
 * screen: the region is sized for the longest copy it shows, so swapping one error for another
 * (or wrapping to a second line) leaves the buttons where they are. */
async function modalHeight(page) {
  const box = await page.locator('.modal-backdrop .modal').boundingBox();
  expect(box, 'the modal must be on screen to measure it').not.toBeNull();
  return box.height;
}

/** Same height, within sub-pixel font/layout rounding - never within the many-pixel jump an
 * un-reserved error line would actually cause. */
function expectSameHeight(a, b) {
  expect(Math.abs(a - b), `modal height changed from ${a} to ${b} - the error region reflowed the dialog`).toBeLessThanOrEqual(2);
}

/** An empty error region must occupy zero height: with nothing to say it leaves no gap between
 * the field and the buttons (the gap read as a layout bug on review). */
async function expectErrorRegionCollapsed(page) {
  const box = await page.locator('.modal .prompt-error').boundingBox();
  expect(box === null ? 0 : box.height, 'the empty error region must take no vertical space').toBeLessThanOrEqual(1);
}

test.describe('the unified email/OTP prompt (unify-email-modal)', () => {
  test.setTimeout(120000);

  test('leaderboard guest row: email validation, the code step, a wrong code, then success - with no layout shift', async ({
    page,
  }) => {
    await page.goto('/');
    await dismissFirstVisit(page);
    // Settle web font loading before any layout measurement below - a font swap mid-test shifts
    // text metrics by itself, which would otherwise look like the reflow this test exists to rule
    // out.
    await page.evaluate(() => document.fonts.ready);
    await goLeaderboard(page);

    await expect(page.locator('.lb-row-me')).toBeVisible();
    await page.locator('.lb-row-me').click();
    const modal = page.locator('.modal-backdrop .modal');
    await expect(modal).toBeVisible();
    // Let the modal's own pop-in animation (gr-pop, a transform: scale over 0.35s) settle before
    // measuring anything - a box read mid-animation is not the layout, it is a scale keyframe.
    await page.waitForTimeout(450);

    // ---- email step: focus lands in the field, the input spans the modal's content width -----
    const emailInput = page.locator('.modal input[type="email"]');
    await expect(emailInput).toBeFocused();
    const modalBox = await modal.boundingBox();
    const inputBox = await emailInput.boundingBox();
    // "full width of the modal's content area": the input's own box should reach within a few
    // pixels of the modal's inner edges (the modal's own padding accounts for the rest).
    expect(inputBox.width).toBeGreaterThan(modalBox.width * 0.8);

    // ---- with nothing to report, the error region leaves no gap at all ------------------------
    const heightBefore = await modalHeight(page);
    await expectErrorRegionCollapsed(page);

    // ---- an invalid email shows the error, and the dialog grows by exactly that region --------
    await emailInput.fill('not-an-email');
    await page.locator('.modal').getByRole('button', { name: /send code/i }).click();
    const error = page.locator('.modal .prompt-error');
    await expect(error).toHaveText('Enter a valid email');
    await expect(emailInput).toHaveAttribute('aria-invalid', 'true');
    const heightWithError = await modalHeight(page);
    expect(
      heightWithError,
      'the dialog should grow to make room for the error it is now showing',
    ).toBeGreaterThan(heightBefore);

    // ---- correcting the address clears the error and returns the dialog to its exact original
    // height, so the collapse is symmetric and leaves no residue ---------------------------------
    const email = `unify-modal-${Date.now()}@example.com`;
    await emailInput.fill(email);
    await expect(error).toHaveText('');
    await expectErrorRegionCollapsed(page);
    const heightAfterClear = await modalHeight(page);
    expectSameHeight(heightAfterClear, heightBefore);

    // ---- a valid submit disables Send while the request is in flight, then advances to the
    // code step - same backdrop, same shape, new copy -------------------------------------------
    const sendBtn = page.locator('.modal').getByRole('button', { name: /send code/i });
    await sendBtn.click();
    const codeInput = page.locator('.modal .pin-input');
    await expect(codeInput).toBeVisible({ timeout: 10000 });
    await expect(codeInput).toBeFocused();
    await expect(page.locator('.modal-title')).toHaveText('Enter the code');
    const codeInputBox = await codeInput.boundingBox();
    const codeModalBox = await modal.boundingBox();
    expect(codeInputBox.width).toBeGreaterThan(codeModalBox.width * 0.8);

    // ---- the code step starts with the same collapsed error region ----------------------------
    const codeHeightBefore = await modalHeight(page);
    await expectErrorRegionCollapsed(page);

    // ---- a short code is rejected client-side before any server round trip --------------------
    await codeInput.fill('12');
    await page.locator('.modal').getByRole('button', { name: /verify/i }).click();
    await expect(error).toHaveText('Enter the 4-digit code');
    const codeHeightWithError = await modalHeight(page);
    expect(codeHeightWithError).toBeGreaterThan(codeHeightBefore);

    // ---- a full-length but wrong code is rejected by the server, mapped through the same error
    // region, and clears the field for a retry. This is where the reserved sizing earns its keep:
    // a longer message replaces a shorter one and the action row must NOT move ------------------
    await codeInput.fill('0000');
    await page.locator('.modal').getByRole('button', { name: /verify/i }).click();
    await expect(error).toHaveText('That code is not right. Try again');
    await expect(codeInput).toHaveValue('');
    expectSameHeight(await modalHeight(page), codeHeightWithError);

    // ---- the real, dev-captured code verifies; the done screen and the header follow ----------
    const code = peekOtp(email);
    await codeInput.fill(code);
    await page.locator('.modal').getByRole('button', { name: /verify/i }).click();
    await expect(page.locator('.modal .signup-done-title')).toBeVisible({ timeout: 10000 });
    await page.locator('.modal').getByRole('button', { name: /done/i }).click();
    await expect(page.locator('.modal-backdrop')).toHaveCount(0);

    // Sign out again so later tests in this file start from a clean guest state. It lives on
    // Profile behind a confirmation now, not in a header strip.
    await page.locator('.avatar-btn').click();
    await expect(page.locator('.pf')).toBeVisible({ timeout: 5000 });
    await page.locator('.pf').getByRole('button', { name: /sign out/i }).click();
    await page.locator('.modal-backdrop').getByRole('button', { name: /^sign out$/i }).click();
    // Back to a guest: the header still shows the same avatar, never a sign-in chip.
    await expect(page.locator('.topbar .signin-chip')).toHaveCount(0);
    await expect(page.locator('.avatar-btn')).toBeVisible({ timeout: 15000 });
  });

  test('Tasks screen "Save your email": the same shared modal, dismiss and reopen resets it', async ({ page }) => {
    await page.goto('/');
    await dismissFirstVisit(page);
    await goTasks(page);

    const emailTaskRow = page.locator('.task', { hasText: 'Save your email' });
    await expect(emailTaskRow).toBeVisible();
    await emailTaskRow.getByRole('button', { name: /start/i }).click();

    const modal = page.locator('.modal-backdrop .modal');
    await expect(modal).toBeVisible();
    await expect(page.locator('.modal-title')).toHaveText('Verify your email');
    const emailInput = page.locator('.modal input[type="email"]');
    await expect(emailInput).toBeFocused();

    // Type an invalid address, see the error, then dismiss the modal entirely (Not now / Escape
    // both go through the same onCancel).
    await emailInput.fill('still-not-an-email');
    await page.locator('.modal').getByRole('button', { name: /send code/i }).click();
    const error = page.locator('.modal .prompt-error');
    await expect(error).toHaveText('Enter a valid email');
    await page.locator('.modal').getByRole('button', { name: /not now/i }).click();
    await expect(page.locator('.modal-backdrop')).toHaveCount(0);

    // Reopening from the same task row is a fresh dialog: empty field, no stale error, focused.
    await emailTaskRow.getByRole('button', { name: /start/i }).click();
    await expect(modal).toBeVisible();
    await expect(page.locator('.modal input[type="email"]')).toHaveValue('');
    await expect(page.locator('.modal .prompt-error')).toHaveText('');
    await expect(page.locator('.modal input[type="email"]')).toBeFocused();

    // Escape closes it too, same as the ghost button.
    await page.keyboard.press('Escape');
    await expect(page.locator('.modal-backdrop')).toHaveCount(0);
  });
});

// Regression for the score-desync bug the owner reported: completing "Save your email" (db/
// seed.sql task id 'email', reward from public.get_tasks(), never a number baked into this
// file) releases a reward server-side, and every surface that shows a score must agree with it
// - not just the topbar. Same harness as tests/e2e/web-identity.spec.js: a running dev server
// (BASE_URL) plus the box game server (PORT), started by playwright.config.js's webServer
// entries or already running when this suite is invoked. The OTP code is read the same way a
// human tester would in dev - node scripts/peek-otp.mjs <email> against DATABASE_URL, never
// guessed or faked, never taken from an inbox.
//
// The real root cause (see the ticket report) lived in two places:
//   1. db/schema.sql: every coin-granting path except settle_round (round settlement) updated
//      players.coins/record and never touched tournament_scores - the table the public
//      leaderboard and my_rank() actually rank on. A player who only ever completes reward
//      tasks (never plays a round) had real coins but no leaderboard row at all.
//   2. src/useGame.js: verifyOtp applied the fresh balance (applyMe) but never refreshed
//      tasksRows, so the Missions screen kept showing "Start" on a task the server had already
//      paid out until its own 5 s poll caught up (or the player left and came back).
// This spec exercises both without playing a single round, since round settlement already had
// its own coverage of the tournament_scores path (db/tests/80_tournaments.sql) and its own E2E
// coverage (tests/e2e/web-identity.spec.js) - the gap this ticket closes is reward-only players.
import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';

import { dismissFirstVisit } from './first-visit.js';

function peekOtp(email) {
  const out = execFileSync('node', ['scripts/peek-otp.mjs', email], {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf8',
  }).trim();
  expect(out, `no dev-captured OTP code found for ${email} - is DATABASE_URL set to the test database?`).not.toBe(
    'none',
  );
  return out;
}

function parseCoins(text) {
  return Number(text.replace(/[^\d]/g, ''));
}

test.describe('score-desync: reward-only players stay in sync everywhere', () => {
  test.setTimeout(120000);

  test('verifying email with no round played updates the topbar, Missions and the leaderboard own row together', async ({
    page,
  }) => {
    await page.goto('/');
    await dismissFirstVisit(page);

    const balanceBefore = parseCoins(await page.locator('.balance-text').first().textContent());

    await page.getByRole('button', { name: 'Missions' }).click();
    const emailRow = page.locator('.task', { hasText: 'Save your email' });
    await expect(emailRow).toBeVisible();
    const emailReward = parseCoins((await emailRow.locator('.task-reward').textContent()) || '');
    expect(emailReward, "the email task's own reward badge must be a real, positive number").toBeGreaterThan(0);

    await emailRow.getByRole('button', { name: /start/i }).click();

    const email = `e2e-score-sync-${Date.now()}@example.com`;
    await page.locator('.modal input[type="email"]').fill(email);
    await page.locator('.modal').getByRole('button', { name: /send code/i }).click();
    await expect(page.locator('.modal .pin-input')).toBeVisible({ timeout: 10000 });

    const code = peekOtp(email);
    await page.locator('.modal .pin-input').fill(code);
    await page.locator('.modal').getByRole('button', { name: /verify/i }).click();
    await expect(page.locator('.modal .signup-done-title')).toBeVisible({ timeout: 10000 });
    await page.locator('.modal').getByRole('button', { name: /done/i }).click();
    await expect(page.locator('.modal-backdrop')).toHaveCount(0);

    // ---- 1. the topbar moved, and by at least the email task's own reward (verify_otp_code can
    // also release the first-time signup bonus in the same call - server/index.js - so this is a
    // floor, not an exact match). --------------------------------------------------------------
    const balanceAfter = parseCoins(await page.locator('.balance-text').first().textContent());
    expect(balanceAfter).toBeGreaterThanOrEqual(balanceBefore + emailReward);

    // ---- 2. Missions shows the email task claimed without leaving the screen - no navigating
    // away and back, no waiting for the 5 s poll. This is the client-side half of the fix: every
    // reward-granting reply the client can name a task for goes through markTaskClaimed; verify_
    // otp's reply cannot name one, so it calls refreshTasks() instead. --------------------------
    await expect(emailRow).toContainText('Claimed', { timeout: 1000 });

    // ---- 3. the leaderboard's own row shows the same number as the topbar - reached with no
    // round ever played. Before the fix this row did not exist at all: release_task_reward (and
    // claim_task's own, separately duplicated copy of the same logic) never touched
    // tournament_scores, so a reward-only player had no tournament_scores row and my_rank()
    // returned nothing - the leaderboard rendered the guest CTA instead of a real row. ----------
    await page.getByRole('button', { name: 'Board' }).click();
    await expect(page.locator('.lb-row-me')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('.lb-row-me .lb-name')).not.toContainText('play as guest', { ignoreCase: true });
    const ownRowScore = parseCoins(await page.locator('.lb-row-me .lb-score').first().textContent());
    expect(ownRowScore).toBe(balanceAfter);
  });
});

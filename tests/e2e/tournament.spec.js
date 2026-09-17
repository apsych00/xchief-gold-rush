// E2E for tournaments as data (ticket B1, docs/tasks-marketing-lead.md A3). Same harness as
// tests/e2e/player-promises.spec.js and web-identity.spec.js: a running dev server (BASE_URL)
// plus the box game server, both migrated and seeded first (bash db/run-tests.sh --keep, then
// db/seed.sql - see playwright.config.js's own header).
//
// db/seed.sql's tournament t1 ("Gold Rush Week 1") runs 16-21 September 2026 Asia/Dubai; this
// suite runs inside that window (see TICKET.md's RESUME NOTE) and asserts against it directly
// rather than inserting its own row, so the screenshot and the header text both show exactly
// what a real visitor would see on the seeded campaign data.
//
// Screenshots land in docs/reports/b1/, the design-fidelity rule's evidence for this ticket's
// one new screen element (the tournament header on the existing leaderboard).
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { dismissFirstVisit } from './first-visit.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const REPORT_DIR = path.join(REPO_ROOT, 'docs', 'reports', 'b1');

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

test.describe('tournaments as data (B1)', () => {
  test.setTimeout(120000);

  test("the leaderboard header shows the seeded tournament; a verified player's own row appears after playing", async ({
    page,
  }) => {
    await page.goto('/');
    await dismissFirstVisit(page);
    await goLeaderboard(page);

    // ---- 1. the seeded tournament's header, fused into the one leaderboard card (ticket U2):
    // title, dates and prize all inside .lb-head; no separate prize image any more -----------------
    await expect(page.locator('.lb-head')).toBeVisible({ timeout: 10000 });
    const header = page.locator('.lb-head');
    // .lb-head renders before the first leaderboard frame lands, with the "No tournament
    // running" line; wait for the seeded tournament to arrive before reading it.
    await expect(header).toContainText('Gold Rush Week 1', { timeout: 10000 });
    const headerText = await header.innerText();
    expect(headerText).toContain('Leaderboard');
    expect(headerText).toContain('by record');
    expect(headerText).toContain('Gold Rush Week 1');
    expect(headerText).toContain('First prize');
    expect(headerText, 'the date range lives in the fused card now').toContain('Sep');
    await expect(page.locator('.lb-tournament-prize')).toHaveCount(0);
    await expect(page.locator('.lb-tournament-none')).toHaveCount(0);
    await page.screenshot({ path: path.join(REPORT_DIR, '01-tournament-header.png') });

    // The past/upcoming switcher lists both seeded tournaments (t1 live, t2 upcoming).
    const chips = page.locator('.lb-tournament-switcher .lang-btn');
    await expect(chips).toHaveCount(2);
    await page.screenshot({ path: path.join(REPORT_DIR, '02-tournament-switcher.png') });

    // ---- 2. verify an email, play one round, then find the own row on the tournament board -----
    await page.locator('.lb-row-me').click();
    await expect(page.locator('.modal-backdrop .modal')).toBeVisible();
    const email = `e2e-b1-${Date.now()}@example.com`;
    await page.locator('.modal input[type="email"]').fill(email);
    await page
      .locator('.modal')
      .getByRole('button', { name: /send code/i })
      .click();
    await expect(page.locator('.modal .pin-input')).toBeVisible({ timeout: 10000 });
    const code = peekOtp(email);
    await page.locator('.modal .pin-input').fill(code);
    await page
      .locator('.modal')
      .getByRole('button', { name: /verify/i })
      .click();
    await expect(page.locator('.modal .signup-done-title')).toBeVisible({ timeout: 10000 });
    await page.locator('.modal').getByRole('button', { name: /done/i }).click();
    await expect(page.locator('.modal-backdrop')).toHaveCount(0);

    // Play once so this player earns a tournament_scores row (any outcome - a settled round
    // always upserts one, db/schema.sql's settle_round).
    await page.getByRole('button', { name: 'Play' }).click();
    await expect(page.locator('.btn-up')).toBeEnabled({ timeout: 20000 });
    await page.click('.btn-up');
    await expect(page.locator('.pane-result')).toBeVisible({ timeout: 20000 });

    await goLeaderboard(page);
    await expect(page.locator('.lb-row-me')).toBeVisible({ timeout: 10000 });
    const ownRowText = await page.locator('.lb-row-me').innerText();
    expect(ownRowText, 'the own row is the masked email, not the raw address').not.toContain(email);
    await page.screenshot({ path: path.join(REPORT_DIR, '03-own-row-in-tournament.png') });
  });
});

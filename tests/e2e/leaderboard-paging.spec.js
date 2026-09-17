// E2E for the paged leaderboard, own row and badge tiers (tickets B2, B3,
// docs/tasks-marketing-lead.md A2, A3). Same harness as tests/e2e/tournament.spec.js: a running
// dev server (BASE_URL) plus the box game server, both migrated and seeded first
// (bash db/run-tests.sh --keep, then db/seed.sql - see playwright.config.js's own header).
//
// db/seed.sql's tournament t1 ("Gold Rush Week 1") runs 16-21 September 2026 Asia/Dubai; this
// suite runs inside that window and, like leaderboard.test.mjs, plants 25 fixture rows directly
// in tournament_scores (via tests.create_confirmed_player(), the same helper the pgTAP suite
// uses - loaded once, outside a transaction, by db/tests/00_helpers.sql, so it persists in this
// kept database) at records far above anything a fresh test player reaches in one round. That
// forces the fresh player's own row off page 1, which is exactly the scenario this ticket adds:
// the sticky own row, and Prev/Next paging.
//
// Screenshots land in docs/reports/b2-b3/, the design-fidelity rule's evidence for this
// ticket's new screen elements (badge icons, the pager, the sticky own row, the legend).
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import pg from 'pg';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const REPORT_DIR = path.join(REPO_ROOT, 'docs', 'reports', 'b2-b3');
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:test@localhost:55432/postgres';

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

test.describe('paged leaderboard, own row and badge tiers (B2, B3)', () => {
  test.setTimeout(120000);

  test('the own row pins to the bottom when off-page, pages, and the badge legend is visible', async ({ page }) => {
    const pool = new pg.Pool({ connectionString: DATABASE_URL });
    try {
      // 25 fixture players ranked far above anything a fresh player reaches from the 1000-coin
      // starting balance, so this test's own row lands off page 1.
      for (let i = 0; i < 25; i += 1) {
        const email = `e2e-b2-fill-${Date.now()}-${i}@example.com`;
        const { rows } = await pool.query('select tests.create_confirmed_player($1) as id', [email]);
        const { rowCount } = await pool.query(
          `insert into public.tournament_scores (tournament_id, player_id, record)
             select ct.id, $1, $2 from public.current_tournament() ct
           on conflict (tournament_id, player_id) do update set record = excluded.record`,
          [rows[0].id, 900000 + i],
        );
        expect(rowCount, 'a tournament must be currently running (db/seed.sql t1) for this fixture to land').toBe(1);
      }

      await page.goto('/');
      await goLeaderboard(page);

      // ---- 1. verify an email, play one round: a tournament_scores row is created at the
      // baseline balance, far below the 25 fixture rows above -----------------------------------
      await page.locator('.lb-row-me').click();
      await expect(page.locator('.modal-backdrop .modal')).toBeVisible();
      const email = `e2e-b2-me-${Date.now()}@example.com`;
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

      await page.getByRole('button', { name: 'Play' }).click();
      await expect(page.locator('.btn-up')).toBeEnabled({ timeout: 20000 });
      await page.click('.btn-up');
      await expect(page.locator('.pane-result')).toBeVisible({ timeout: 20000 });

      // ---- 2. the sticky own row: not one of the 20 rows on page 1, pinned at the bottom -------
      await goLeaderboard(page);
      await expect(page.locator('.lb-row-sticky')).toBeVisible({ timeout: 10000 });
      const stickyText = await page.locator('.lb-row-sticky').innerText();
      expect(stickyText, 'the sticky row is the masked email, not the raw address').not.toContain(email);
      await expect(page.locator('.lb-list .lb-row-me')).toHaveCount(0, 'the own row is not among the visible page rows');
      await page.screenshot({ path: path.join(REPORT_DIR, '01-sticky-own-row.png') });

      // ---- 3. paging: page 1 has exactly 20 rows, Next reaches page 2 ---------------------------
      await expect(page.locator('.lb-list .lb-row')).toHaveCount(20);
      await expect(page.locator('.lb-pager')).toBeVisible();
      await page.screenshot({ path: path.join(REPORT_DIR, '02-page-1-and-pager.png') });
      await page.getByRole('button', { name: 'Next' }).click();
      await expect(page.locator('.lb-pager-info')).toContainText('2', { timeout: 10000 });
      await page.screenshot({ path: path.join(REPORT_DIR, '03-page-2.png') });

      // ---- 4. the badge legend is visible, six tiers -------------------------------------------
      await expect(page.locator('.lb-legend')).toBeVisible();
      await expect(page.locator('.lb-legend-item')).toHaveCount(6);
      await page.screenshot({ path: path.join(REPORT_DIR, '04-badge-legend.png') });
    } finally {
      await pool.end();
    }
  });
});

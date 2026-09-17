// E2E for the guest note's placement (ticket U2): a logged-out web player sees the "Play as
// guest - add your email to be ranked" row where their own row would be - below the last listed
// row on a board that fits its container, pinned to the bottom of the list container (the
// `.lb-row-sticky` treatment) once the rows overflow it. Same harness as
// tests/e2e/leaderboard-paging.spec.js: a running dev server (BASE_URL) plus the box game server,
// both migrated and seeded first (bash db/run-tests.sh --keep, then db/seed.sql).
//
// The fits case selects db/seed.sql's upcoming tournament t2 ("Gold Rush Week 2"), which has no
// scores, so the list is empty and the guest row sits right under it. The overflow case plants 25
// fixture rows in the running tournament via tests.create_confirmed_player(), the same DB helper
// the paging spec uses, so page 1's 20 rows cannot fit.
//
// Screenshots land in docs/reports/u2/, the design-fidelity evidence for this ticket.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import pg from 'pg';
import { dismissFirstVisit } from './first-visit.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const REPORT_DIR = path.join(REPO_ROOT, 'docs', 'reports', 'u2');
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:test@localhost:55432/postgres';

async function goLeaderboard(page) {
  await page.getByRole('button', { name: 'Board' }).click();
  await expect(page.locator('.lb')).toBeVisible();
}

test.describe('the guest note takes the own-row slot (U2)', () => {
  test.setTimeout(120000);

  test('sits below the last listed row when the list fits its container', async ({ page }) => {
    await page.goto('/');
    await dismissFirstVisit(page);
    await goLeaderboard(page);
    // The upcoming tournament's board is empty, so nothing overflows the list.
    await page.getByRole('button', { name: 'Gold Rush Week 2' }).click();
    await expect(page.locator('.lb-head')).toContainText('Gold Rush Week 2');

    const guest = page.locator('.lb-list .lb-row-me');
    await expect(guest).toBeVisible({ timeout: 10000 });
    await expect(guest).toContainText('Play as guest');
    await expect(page.locator('.lb-row-sticky')).toHaveCount(0, 'a list that fits needs no pinned row');
    // The rank cell stays empty and the text is the normal row colour, never black-on-green.
    await expect(guest.locator('.lb-rank')).toHaveText('');
    const color = await guest.locator('.lb-name').evaluate((el) => getComputedStyle(el).color);
    expect(color).toBe('rgb(255, 255, 255)');
    await page.screenshot({ path: path.join(REPORT_DIR, '05-guest-fits.png') });
  });

  test('pins to the bottom of the list container when the rows overflow it', async ({ page }) => {
    const pool = new pg.Pool({ connectionString: DATABASE_URL });
    try {
      for (let i = 0; i < 25; i += 1) {
        const email = `e2e-u2-fill-${Date.now()}-${i}@example.com`;
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
      await dismissFirstVisit(page);
      await goLeaderboard(page);

      const pinned = page.locator('.lb-row-sticky');
      await expect(pinned).toBeVisible({ timeout: 10000 });
      await expect(pinned).toHaveClass(/lb-row-guest/);
      await expect(pinned).toContainText('Play as guest');
      await expect(pinned.locator('.lb-rank')).toHaveText('');
      await expect(page.locator('.lb-list .lb-row-me')).toHaveCount(0, 'the guest row is pinned, not a page row');
      await page.screenshot({ path: path.join(REPORT_DIR, '06-guest-overflow.png') });
    } finally {
      await pool.end();
    }
  });
});

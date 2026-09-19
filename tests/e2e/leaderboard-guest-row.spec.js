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
    await expect(guest).toContainText('playing as guest');
    await expect(page.locator('.lb-row-sticky')).toHaveCount(0, 'a list that fits needs no pinned row');
    // The guest row is a prompt, not a ranked entry, so no rank cell is rendered at all - its
    // width used to sit empty and unused ahead of the copy (bug: clipping fix).
    await expect(guest.locator('.lb-rank')).toHaveCount(0);
    const color = await guest.locator('.lb-name').evaluate((el) => getComputedStyle(el).color);
    expect(color).toBe('rgb(255, 255, 255)');
    // The full guest copy must always be visible - wrapping to two lines is fine, silent
    // clipping/ellipsis/overflow is not (bug: the string used to be cut off mid-word).
    const overflow = await guest.locator('.lb-name').evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      text: el.textContent,
    }));
    expect(overflow.scrollWidth, `guest note must not overflow its box: ${JSON.stringify(overflow)}`).toBeLessThanOrEqual(
      overflow.clientWidth,
    );
    expect(overflow.text).toBe("You're playing as guest - add your email to be ranked");
    await page.screenshot({ path: path.join(REPORT_DIR, '05-guest-fits.png') });
  });

  test('the guest note is never clipped, at phone widths down to 320px', async ({ page }) => {
    await page.goto('/');
    await dismissFirstVisit(page);
    await goLeaderboard(page);
    await page.getByRole('button', { name: 'Gold Rush Week 2' }).click();
    await expect(page.locator('.lb-head')).toContainText('Gold Rush Week 2');

    const guest = page.locator('.lb-list .lb-row-me');
    await expect(guest).toBeVisible({ timeout: 10000 });

    for (const width of [320, 360, 390, 460]) {
      await page.setViewportSize({ width, height: 844 });
      const nameEl = guest.locator('.lb-name');
      const box = await nameEl.evaluate((el) => ({
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        text: el.textContent.trim(),
      }));
      expect(box.scrollWidth, `width ${width}: horizontal clip ${JSON.stringify(box)}`).toBeLessThanOrEqual(
        box.clientWidth,
      );
      expect(box.scrollHeight, `width ${width}: vertical clip ${JSON.stringify(box)}`).toBeLessThanOrEqual(
        box.clientHeight + 1,
      );
      expect(box.text).toBe("You're playing as guest - add your email to be ranked");
    }
    await page.screenshot({ path: path.join(REPORT_DIR, '05b-guest-fits-320.png') });
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
      await expect(pinned).toContainText('playing as guest');
      await expect(pinned.locator('.lb-rank')).toHaveCount(0);
      await expect(page.locator('.lb-list .lb-row-me')).toHaveCount(0, 'the guest row is pinned, not a page row');
      const overflow = await pinned.locator('.lb-name').evaluate((el) => ({
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        text: el.textContent,
      }));
      expect(overflow.scrollWidth, `guest note must not overflow its box: ${JSON.stringify(overflow)}`).toBeLessThanOrEqual(
        overflow.clientWidth,
      );
      expect(overflow.text).toBe("You're playing as guest - add your email to be ranked");
      await page.screenshot({ path: path.join(REPORT_DIR, '06-guest-overflow.png') });
    } finally {
      await pool.end();
    }
  });
});

// Blind E2E for the kiosk streak QR/claim screen (default kiosk_streak_target is 3). Synthetic
// frames enter through the DEV-only socket hook, while the assertions exercise the same client
// rendering path as server frames.
import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import { WebSocket } from 'ws';

import { dismissFirstVisit } from './first-visit.js';

const KIOSK_SECRET = 'dev-kiosk-secret-0001';
const KIOSK_URL = `/?k=${KIOSK_SECRET}`;

// Overridable from the environment (same pattern as tests/e2e/kiosk.spec.js) so the suite can
// target a dev server on a non-default port when 8787 is taken by another worktree's stack;
// default stays exactly as .env has it.
function gameWsUrl() {
  // The environment wins over .env so a run on another port resets the kiosk the browser uses.
  if (process.env.VITE_GAME_WS) return process.env.VITE_GAME_WS.trim();
  const text = fs.readFileSync(new URL('../../.env', import.meta.url), 'utf8');
  const line = text.split(/\r?\n/).find((l) => l.startsWith('VITE_GAME_WS='));
  return line ? line.slice('VITE_GAME_WS='.length).trim() : null;
}

/** The dev kiosk is shared by every spec: end whatever session it is in before each test, over
 * an independent socket, so a session another spec left in 'playing' cannot hide the attract
 * screen this spec starts from. */
function resetKioskSession() {
  return new Promise((resolve, reject) => {
    const url = gameWsUrl();
    expect(url, 'VITE_GAME_WS is not set in .env').toBeTruthy();
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('timed out resetting the kiosk session'));
    }, 8000);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', kiosk: KIOSK_SECRET })));
    ws.on('message', (data) => {
      const frame = JSON.parse(data.toString());
      if (frame.type === 'welcome') ws.send(JSON.stringify({ type: 'kiosk_reset' }));
      if (frame.type === 'kiosk_session' && frame.state === 'idle') {
        clearTimeout(timer);
        ws.close();
        resolve(frame);
      }
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
const CLAIM_URL = 'http://localhost:5359/claim/b14-exact-claim-token-1234';

function settledFrame(streak, extra = {}) {
  return {
    type: 'round_settled',
    round_id: `b14-round-${streak}`,
    outcome: 'win',
    delta: 100,
    mult: streak >= 3 ? 3 : streak === 2 ? 2 : 1.5,
    coins: 1000 + streak * 100,
    streak,
    claim_url: null,
    claim_expires_at: null,
    coupons_exhausted: false,
    state: 'playing',
    start_price: 2000,
    end_price: 2001,
    ...extra,
  };
}

async function injectSettled(page, streak, extra = {}) {
  await page.evaluate(
    ({ frame, coins, state }) => {
      window.__xchief.inject(frame);
      window.__xchief.inject({ type: 'kiosk_session', coins, streak: frame.streak, state });
    },
    { frame: settledFrame(streak, extra), coins: 1000 + streak * 100, state: extra.state || 'playing' },
  );
}

/** The kiosk play screen does not print the streak as a number: the contract-visible effects
 * of a streak are the balance from the frame's coins and the lit combo indicator. */
async function expectDisplayedStreak(page, streak) {
  await expect(page.locator('.balance-text')).toHaveText((1000 + streak * 100).toLocaleString('en-US'));
  await expect(page.locator('.combo-on')).toHaveCount(1);
}

test.describe.serial('kiosk streak QR claim screen', () => {
  test.setTimeout(45000);

  test.beforeEach(async () => {
    await resetKioskSession();
  });

  test('shows the QR claim screen with no code, and the button resets to ATTRACT', async ({ page }) => {
    await page.goto(KIOSK_URL);
    await expect(page.getByText('Tap to play')).toBeVisible({ timeout: 10000 });
    await page.locator('.btn-start').click();
    await dismissFirstVisit(page);
    await expect(page.locator('.btn-up')).toBeEnabled({ timeout: 10000 });

    // Streaks below the default target of 3 (a real kiosk win would already show the QR screen
    // at streak 3, so only 1 and 2 are the plausible pre-win states here).
    for (const streak of [1, 2]) {
      await injectSettled(page, streak);
      await expectDisplayedStreak(page, streak);
    }

    await injectSettled(page, 0, {
      claim_url: CLAIM_URL,
      claim_expires_at: new Date(Date.now() + 86400000).toISOString(),
      state: 'won',
    });
    await expect(
      page.getByText('Congratulations! You won the xChief $100 bonus. Scan to claim your gift:'),
    ).toBeVisible({ timeout: 5000 });
    const qr = page.locator('.kiosk-qr');
    await expect(qr).toBeVisible();
    await expect
      .poll(() => qr.evaluate((element) => element.getClientRects().length))
      .toBe(1);
    await expect(page.getByRole('button', { name: "I've scanned it" })).toBeVisible();

    await page.getByRole('button', { name: "I've scanned it" }).click();
    await expect(page.getByText('Tap to play')).toBeVisible({ timeout: 10000 });
  });

  test('does not hide the QR screen before its own 20-second contract window', async ({ page }) => {
    await page.goto(KIOSK_URL);
    await expect(page.getByText('Tap to play')).toBeVisible({ timeout: 10000 });
    await page.locator('.btn-start').click();
    await dismissFirstVisit(page);
    await expect(page.locator('.btn-up')).toBeEnabled({ timeout: 10000 });

    await injectSettled(page, 0, {
      claim_url: CLAIM_URL,
      claim_expires_at: new Date(Date.now() + 86400000).toISOString(),
      state: 'won',
    });
    await expect(page.locator('.kiosk-qr')).toBeVisible({ timeout: 5000 });
    await page.waitForTimeout(15000);
    await expect(page.locator('.kiosk-qr')).toBeVisible();
  });
});

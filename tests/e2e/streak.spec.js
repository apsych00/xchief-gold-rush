// Blind E2E for the five-win kiosk streak. Synthetic frames enter through the DEV-only socket
// hook, while the assertions exercise the same client rendering path as server frames.
import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import { WebSocket } from 'ws';

const KIOSK_SECRET = 'dev-kiosk-secret-0001';
const KIOSK_URL = `/?k=${KIOSK_SECRET}`;

function gameWsUrl() {
  // A VITE_GAME_WS in the environment overrides .env, the same way kiosk.spec.js's own
  // gameWsUrl already does - this independent socket must point at the server the page under
  // test does, not whatever port .env happens to say, when the game server runs elsewhere.
  if (process.env.VITE_GAME_WS) return process.env.VITE_GAME_WS;
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
const COUPON = 'B14-EXACT-COUPON-1234';

function settledFrame(streak, extra = {}) {
  return {
    type: 'round_settled',
    round_id: `b14-round-${streak}`,
    outcome: 'win',
    delta: 100,
    mult: streak >= 3 ? 3 : streak === 2 ? 2 : 1.5,
    coins: 1000 + streak * 100,
    streak,
    coupon: null,
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

test.describe.serial('five-win kiosk streak', () => {
  test.setTimeout(45000);

  test.beforeEach(async () => {
    await resetKioskSession();
  });

  test('shows the exact coupon on one line and Claim resets to ATTRACT', async ({ page }) => {
    await page.goto(KIOSK_URL);
    await expect(page.getByText('Tap to play')).toBeVisible({ timeout: 10000 });
    await page.locator('.btn-start').click();
    await expect(page.locator('.btn-up')).toBeEnabled({ timeout: 10000 });

    for (const streak of [1, 2, 3, 4]) {
      await injectSettled(page, streak);
      await expectDisplayedStreak(page, streak);
    }

    await injectSettled(page, 5, { coupon: COUPON, state: 'won' });
    await expect(page.getByText('You won!')).toBeVisible({ timeout: 5000 });
    const code = page.getByText(COUPON, { exact: true });
    await expect(code).toBeVisible();
    await expect(code).toHaveText(COUPON);
    await expect
      .poll(() => code.evaluate((element) => element.getClientRects().length))
      .toBe(1);
    await expect(page.getByRole('button', { name: 'Claim' })).toBeVisible();

    await page.getByRole('button', { name: 'Claim' }).click();
    await expect(page.getByText('Tap to play')).toBeVisible({ timeout: 10000 });
  });

  test('does not hide the coupon modal before the 25-second contract window', async ({ page }) => {
    await page.goto(KIOSK_URL);
    await expect(page.getByText('Tap to play')).toBeVisible({ timeout: 10000 });
    await page.locator('.btn-start').click();
    await expect(page.locator('.btn-up')).toBeEnabled({ timeout: 10000 });

    await injectSettled(page, 5, { coupon: COUPON, state: 'won' });
    await expect(page.getByText(COUPON, { exact: true })).toBeVisible({ timeout: 5000 });
    await page.waitForTimeout(25000);
    await expect(page.getByText(COUPON, { exact: true })).toBeVisible();
  });
});

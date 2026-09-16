// E2E for the booth visitor flow (ticket C2, docs/layers.md). Runs against the dev recipe:
// bash db/run-tests.sh --keep, npm run server (PORT 8787, matching .env's VITE_GAME_WS), and a
// Vite dev server serving the client - see this repo's C2 delivery report for the exact ports
// used in this environment. The dev kiosk secret is dev-kiosk-secret-0001 (seeded).
//
// This suite shares one kiosk identity (one server-side session) across every test in the file,
// so it runs serially and resets that session over its own independent WebSocket before each
// test - the same "ask the server directly, not through the page" pattern player-promises.spec.js
// uses for get_me, applied here to kiosk_reset so tests never see each other's leftover state.
//
// The five-win WON scenario is rare to hit for real inside a test's time budget. It is driven
// the way the ticket allows: a synthetic round_settled (and its kiosk_session mirror) fed through
// the dev-only window.__xchief.inject hook (src/api/socket.js, DEV-guarded) - the exact frame
// shape the real server sends, run through the exact same client handler a real frame takes.
// Nothing about the client's own rendering is bypassed; only the input is synthetic.
import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import { WebSocket } from 'ws';

const KIOSK_SECRET = 'dev-kiosk-secret-0001';
const KIOSK_URL = `/?k=${KIOSK_SECRET}`;

function readEnv() {
  const out = {};
  const text = fs.readFileSync(new URL('../../.env', import.meta.url), 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0 && !line.trim().startsWith('#')) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}
const GAME_WS = readEnv().VITE_GAME_WS;

/** Ends whatever session dev-kiosk-secret-0001 currently has, over an independent socket - run
 * before every test so one test's leftover streak/coins/state can never leak into the next. */
function resetKioskSession() {
  return new Promise((resolve, reject) => {
    expect(GAME_WS, 'VITE_GAME_WS is not set in .env: the box game server is not configured').toBeTruthy();
    const ws = new WebSocket(GAME_WS);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('timed out resetting the kiosk session'));
    }, 8000);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', kiosk: KIOSK_SECRET })));
    ws.on('message', (data) => {
      let frame;
      try {
        frame = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (frame.type === 'welcome') {
        ws.send(JSON.stringify({ type: 'kiosk_reset' }));
      } else if (frame.type === 'kiosk_session') {
        clearTimeout(timer);
        ws.close();
        resolve(frame);
      } else if (frame.type === 'error') {
        clearTimeout(timer);
        ws.close();
        reject(Object.assign(new Error(frame.code), { code: frame.code }));
      }
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function tapToPlay(page) {
  await page.goto(KIOSK_URL);
  await expect
    .poll(() => page.evaluate(() => window.__xchief && window.__xchief.mode), {
      message: 'window.__xchief.mode must be "server" - the client is not wired to the game socket',
      timeout: 10000,
    })
    .toBe('server');
  await expect(page.getByText('Tap to play')).toBeVisible({ timeout: 10000 });
  await page.locator('.btn-start').click();
  await expect(page.locator('.btn-up')).toBeEnabled({ timeout: 20000 });
}

async function playRound(page, dir = 'up') {
  await page.click(`.btn-${dir}`);
  await expect(page.locator('.countdown')).toBeVisible({ timeout: 3000 });
  await expect(page.locator('.pane-result')).toBeVisible({ timeout: 20000 });
}

// The hard guarantee (docs/layers.md C2): none of the web's email/task/leaderboard/nav UI may
// ever exist in the DOM in kiosk mode, win or lose, broke or not.
function forbiddenUi(page) {
  return page.locator('.lead, .signup, .lb, .tasks, .nav, input[type="email"]');
}

test.describe.serial('kiosk visitor flow', () => {
  test.setTimeout(180000);

  test.beforeEach(async () => {
    await resetKioskSession();
  });

  test('1. ATTRACT -> tap -> play -> verdict, with no email/tasks/leaderboard UI', async ({ page }) => {
    await tapToPlay(page);
    await expect(forbiddenUi(page)).toHaveCount(0);

    await playRound(page, 'up');
    const text = await page.locator('.pane-result').innerText();
    expect(/WIN|MISS|FLAT/.test(text), `expected a server-decided verdict, got: ${text}`).toBe(true);
    await expect(forbiddenUi(page)).toHaveCount(0);
  });

  test('2. going broke shows the EXIT modal, and Done returns to ATTRACT', async ({ page }) => {
    test.setTimeout(300000);
    await tapToPlay(page);
    // Always the biggest affordable lever: useGame.js's own idle-lever effect keeps the
    // selection affordable as coins shrink, so betting max every round drives the session to
    // broke in the fewest rounds - and, since win/loss odds do not depend on the lever chosen,
    // the fewest rounds is also the least exposure to a real five-win streak landing first
    // (real market odds - not guaranteed not to happen, so a WON modal here is handled by
    // claiming it and continuing toward broke, not treated as a failure).
    await page.locator('.tick-5').click();

    let broke = false;
    for (let i = 0; i < 40 && !broke; i++) {
      await page.click(i % 2 === 0 ? '.btn-down' : '.btn-up');
      await expect(page.locator('.countdown')).toBeVisible({ timeout: 3000 });
      await Promise.race([
        page.locator('.pane-result').waitFor({ state: 'visible', timeout: 20000 }),
        page.getByText('That was your shot').waitFor({ state: 'visible', timeout: 20000 }),
        page.getByText('You won!').waitFor({ state: 'visible', timeout: 20000 }),
      ]);
      broke = await page.getByText('That was your shot').isVisible();
      if (broke) break;
      if (await page.getByText('You won!').isVisible()) {
        await page.getByRole('button', { name: 'Claim' }).click();
        await expect(page.getByText('Tap to play')).toBeVisible({ timeout: 10000 });
        await page.locator('.btn-start').click();
        await expect(page.locator('.btn-up')).toBeEnabled({ timeout: 20000 });
        await page.locator('.tick-5').click();
        continue;
      }
      await page.locator('.btn-again').click();
      await expect(page.locator('.btn-up')).toBeEnabled({ timeout: 10000 });
    }
    expect(broke, 'expected the kiosk session to go broke within 40 rounds betting the max lever').toBe(true);
    await expect(page.getByText(/You have used all your coins/)).toBeVisible();
    await expect(forbiddenUi(page)).toHaveCount(0);

    await page.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByText('Tap to play')).toBeVisible({ timeout: 10000 });
    await expect(forbiddenUi(page)).toHaveCount(0);
  });

  test('3. a server kiosk_session idle frame returns to ATTRACT immediately', async ({ page }) => {
    await tapToPlay(page);
    await playRound(page, 'up');

    await page.evaluate(() => {
      window.__xchief.inject({ type: 'kiosk_session', coins: 1000, streak: 0, state: 'idle' });
    });
    await expect(page.getByText('Tap to play')).toBeVisible({ timeout: 5000 });
    await expect(forbiddenUi(page)).toHaveCount(0);
  });

  test('4. a five-win streak shows the WON modal with the code, and Claim returns to ATTRACT', async ({ page }) => {
    await tapToPlay(page);

    await page.evaluate(() => {
      // The exact shape server/rounds.js sends for a kiosk round that lands a coupon, followed
      // by the mirror server/index.js sends right after it.
      window.__xchief.inject({
        type: 'round_settled',
        round_id: 'e2e-synthetic-round',
        outcome: 'win',
        delta: 300,
        mult: 3,
        coins: 1500,
        streak: 5,
        coupon: 'TESTCODE-1234',
        coupons_exhausted: false,
        state: 'won',
        start_price: 2000,
        end_price: 2001,
      });
      window.__xchief.inject({ type: 'kiosk_session', coins: 1500, streak: 5, state: 'won' });
    });

    await expect(page.getByText('You won!')).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('TESTCODE-1234')).toBeVisible();
    await expect(forbiddenUi(page)).toHaveCount(0);

    await page.getByRole('button', { name: 'Claim' }).click();
    await expect(page.getByText('Tap to play')).toBeVisible({ timeout: 10000 });
  });
});

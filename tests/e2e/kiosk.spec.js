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
  // The environment wins over .env so a run on another port resets the kiosk the browser uses.
  if (process.env.VITE_GAME_WS) return process.env.VITE_GAME_WS.trim();
  const text = fs.readFileSync(new URL('../../.env', import.meta.url), 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0 && !line.trim().startsWith('#')) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}
// Both overridable from the environment (same pattern as DATABASE_URL below) so the suite can
// target a dev server on a non-default port when 8787 is taken by another worktree's stack;
// defaults stay exactly as .env has them.
const GAME_WS = process.env.VITE_GAME_WS || readEnv().VITE_GAME_WS;
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:test@localhost:55432/postgres';

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

/** Sets the dev kiosk's session pot directly - the server owns coins, so a test that needs a
 * specific balance goes through the database, never the client. */
async function setSessionCoins(coins) {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  try {
    await pool.query(
      "update public.kiosks set session_coins = $2, session_state = 'playing', last_round_at = now() where id = public.verify_kiosk($1)",
      [KIOSK_SECRET, coins],
    );
  } finally {
    await pool.end();
  }
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

// D7 (docs/reports/redteam.md): a launch URL that lost its secret (`/?k=`) must render the
// kiosk's own error state, never the web app - independent of the shared-session serial suite
// below since this connection is never authenticated as any kiosk at all.
test('D7: /?k= (empty secret) shows the not-configured state, never the web app', async ({ page }) => {
  await page.goto('/?k=');
  await expect
    .poll(() => page.evaluate(() => window.__xchief && window.__xchief.mode), {
      message: 'window.__xchief.mode must be "server" - the client is not wired to the game socket',
      timeout: 10000,
    })
    .toBe('server');
  await expect(page.getByText('Kiosk not configured. Tell the booth staff.')).toBeVisible({ timeout: 10000 });
  await expect(forbiddenUi(page)).toHaveCount(0);
});

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
    // Deterministic: the session's pot is set below the smallest stake straight in the database
    // (the server owns it; there is no client path to coins), so the very first play is refused
    // as insufficient_coins, the server marks the session broke and pushes kiosk_session - the
    // exact frame the EXIT modal is driven by. No market luck involved.
    await tapToPlay(page);
    await setSessionCoins(50);
    await page.locator('.tick-1').click();
    await page.click('.btn-up');
    await expect(page.getByText('That was your shot')).toBeVisible({ timeout: 10000 });
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

  test('4. a five-win streak shows the QR claim screen with both texts, and the button returns to ATTRACT', async ({
    page,
  }) => {
    await tapToPlay(page);

    const claimUrl = 'http://localhost:5359/claim/e2e-synthetic-token';
    await page.evaluate((url) => {
      // The exact shape server/rounds.js sends for a kiosk round that reserves a coupon
      // (ticket C9), followed by the mirror server/index.js sends right after it - never a
      // code, only the one-time claim_url.
      window.__xchief.inject({
        type: 'round_settled',
        round_id: 'e2e-synthetic-round',
        outcome: 'win',
        delta: 300,
        mult: 3,
        coins: 1500,
        streak: 0,
        claim_url: url,
        claim_expires_at: new Date(Date.now() + 86400000).toISOString(),
        coupons_exhausted: false,
        state: 'won',
        start_price: 2000,
        end_price: 2001,
      });
      window.__xchief.inject({
        type: 'kiosk_session',
        coins: 1500,
        streak: 0,
        state: 'won',
        codes_left: 1,
        streak_target: 5,
        claim_url: url,
        claim_expires_at: new Date(Date.now() + 86400000).toISOString(),
      });
    }, claimUrl);

    await expect(
      page.getByText('Congratulations! You won the xChief $100 bonus. Scan to claim your gift:'),
    ).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('تبریک! شما برنده بونوس ۱۰۰ دلاری ایکس‌چیف شدید. برای دریافت هدیه اسکن کنید:')).toBeVisible();
    await expect(page.locator('.kiosk-qr')).toBeVisible();
    await expect(forbiddenUi(page)).toHaveCount(0);

    await page.getByRole('button', { name: "I've scanned it" }).click();
    await expect(page.getByText('Tap to play')).toBeVisible({ timeout: 10000 });
  });

  test('4b. the QR screen resets the booth on its own once its own countdown reaches zero, without a press', async ({
    page,
  }) => {
    await tapToPlay(page);
    // Shrink the QR screen's own timer (ticket C9) through the DEV-only
    // window.__xchief.kioskTiming.QR_MS property the ticket names - set BEFORE the win frame
    // lands, since the countdown effect reads it once, the moment the screen becomes 'won'.
    await page.evaluate(() => {
      window.__xchief.kioskTiming.QR_MS = 1200;
    });
    await page.evaluate(() => {
      window.__xchief.inject({
        type: 'round_settled',
        round_id: 'e2e-qr-timeout',
        outcome: 'win',
        delta: 300,
        mult: 3,
        coins: 1500,
        streak: 0,
        claim_url: 'http://localhost:5359/claim/e2e-qr-timeout-token',
        claim_expires_at: new Date(Date.now() + 86400000).toISOString(),
        coupons_exhausted: false,
        state: 'won',
        start_price: 2000,
        end_price: 2001,
      });
      window.__xchief.inject({ type: 'kiosk_session', coins: 1500, streak: 0, state: 'won', codes_left: 1 });
    });
    await expect(page.locator('.kiosk-qr')).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('Tap to play')).toBeVisible({ timeout: 5000 });
    await expect(forbiddenUi(page)).toHaveCount(0);
  });

  test('5. idle countdown (C2b): overlay after idle, pointer move hides it, zero returns to ATTRACT', async ({
    page,
  }) => {
    await tapToPlay(page);
    // Shrink both constants through the DEV-only window.__xchief.kioskTiming hook
    // (src/useKioskFlow.js) so the 20 s + 20 s product rule runs on a test-sized clock:
    // 1.5 s of no activity shows the overlay, which then counts down 2 s to the flush.
    await page.evaluate(() => window.__xchief.kioskTiming({ idleMs: 1500, countdownMs: 2000 }));

    const overlay = page.getByText('Still there?');
    await expect(overlay).toBeVisible({ timeout: 10000 });

    // Any activity - here a plain pointer move, no tap, no play - hides the overlay and
    // restarts the idle window.
    await page.mouse.move(60, 80);
    await page.mouse.move(180, 220);
    await expect(overlay).toBeHidden({ timeout: 5000 });

    // Idle again for the same 1.5 s: the overlay is back, counting from the top.
    await expect(overlay).toBeVisible({ timeout: 10000 });

    // Let the countdown reach zero untouched: flush animation, kiosk_reset to the server,
    // ATTRACT for the next visitor.
    await expect(page.getByText('Tap to play')).toBeVisible({ timeout: 15000 });
    await expect(forbiddenUi(page)).toHaveCount(0);
  });

  test('6. an empty coupon pool shows the no-codes modal, and it clears itself once one is restocked', async ({
    page,
  }) => {
    // The pool is shared across every kiosk (ticket C8, docs/layers.md), not per-kiosk state:
    // emptied and restored straight through the database, exactly like setSessionCoins does for
    // a kiosk's own coins, and restored in `finally` so no other test in this file ever sees an
    // empty pool it did not ask for.
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: DATABASE_URL });
    let availableBefore;
    try {
      const { rows } = await pool.query("select id from public.coupons where status = 'available'");
      availableBefore = rows;
      await pool.query("update public.coupons set status = 'claimed', claimed_at = now() where status = 'available'");

      await page.goto(KIOSK_URL);
      await expect
        .poll(() => page.evaluate(() => window.__xchief && window.__xchief.mode), {
          message: 'window.__xchief.mode must be "server" - the client is not wired to the game socket',
          timeout: 10000,
        })
        .toBe('server');

      await expect(page.getByText('All the prizes are gone')).toBeVisible({ timeout: 10000 });
      await expect(page.getByText(/Every \$100 code for today has been won/)).toBeVisible();
      await expect(page.locator('.btn-start')).toHaveCount(0);
      await expect(forbiddenUi(page)).toHaveCount(0);

      await page.screenshot({ path: 'docs/reports/c8/no-codes.png' });

      // The sweep (server/kiosk.js) only pushes on a crossing it actually observes between two
      // ticks, exactly like a member of staff restocking would hit in reality: it cannot see an
      // empty-then-refilled pool if both happen inside the same ~10 s tick. Give it one full
      // cycle to record the empty pool first, so the restock below is a genuine crossing on the
      // next tick, not a flicker invisible to a poll.
      await page.waitForTimeout(11000);

      await pool.query("update public.coupons set status = 'available', claimed_at = null where id = $1", [
        availableBefore[0].id,
      ]);

      // Not a page reload - the sweep's own next tick (server/kiosk.js) is what clears this,
      // well inside 15 s on the dev recipe's default 10 s interval.
      await expect(page.getByText('All the prizes are gone')).toBeHidden({ timeout: 15000 });
      await expect(page.getByText('Tap to play')).toBeVisible({ timeout: 15000 });
      await page.locator('.btn-start').click();
      await expect(page.locator('.btn-up')).toBeEnabled({ timeout: 20000 });
    } finally {
      if (availableBefore && availableBefore.length) {
        await pool.query("update public.coupons set status = 'available', claimed_at = null where id = any($1)", [
          availableBefore.map((r) => r.id),
        ]);
      }
      await pool.end();
    }
  });
});

// The claim page itself (ticket C9 decision 4): a real claim_links row, not a synthetic frame -
// scanning is simulated by opening claim_url in a second tab of the same browser context, the
// closest a headless run gets to a visitor's own phone. Independent of the serial kiosk suite
// above: it never touches a kiosk's own session state.
test('claim page: scanning a real claim_url shows the gift card once, and reopening shows claimed', async ({
  context,
}) => {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  const suffix = Date.now();
  const code = `E2E-CLAIM-${suffix}`;
  const token = `e2e-claim-token-${suffix}`;
  try {
    const { rows: couponRows } = await pool.query(
      "insert into public.coupons (code, status) values ($1, 'reserved') returning id",
      [code],
    );
    const { rows: kioskRows } = await pool.query("select id from public.kiosks where label = 'dev-kiosk'");
    await pool.query(
      "insert into public.claim_links (token, coupon_id, kiosk_id, expires_at) values ($1, $2, $3, now() + interval '24 hours')",
      [token, couponRows[0].id, kioskRows[0].id],
    );

    const claimPage = await context.newPage();
    await claimPage.goto(`/claim/${token}`);
    await expect(claimPage.getByText('Your xChief $100 bonus')).toBeVisible({ timeout: 10000 });
    await claimPage.locator('input[type="email"]').fill('e2e-claim@example.com');
    await claimPage.getByRole('button', { name: 'Get my code' }).click();
    await expect(claimPage.getByText(code)).toBeVisible({ timeout: 10000 });
    await expect(claimPage.getByText('Sent to e2e-claim@example.com')).toBeVisible();
    await claimPage.close();

    const reopenPage = await context.newPage();
    await reopenPage.goto(`/claim/${token}`);
    await expect(reopenPage.getByText(/claimed by/i)).toBeVisible({ timeout: 10000 });
    await expect(reopenPage.getByText(code)).toHaveCount(0); // reopening a claimed link never shows the code again
    await reopenPage.close();
  } finally {
    await pool.end();
  }
});

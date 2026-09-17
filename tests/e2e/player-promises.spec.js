// Blind E2E suite for the "Player-visible promises" in docs/test-contract.md, adapted for the
// box's game socket (docs/box-plan.md, docs/box-spec.md). Runs headless against the dev server
// (npm run dev, BASE_URL default http://localhost:5173) with the box's game server already
// running (PORT 8787) and VITE_GAME_WS pointed at it from .env - see playwright.config.js.
//
// Server-side verification recipe (ticket 5): the client's dev-only window.__xchief hook
// (src/api/socket.js, guarded by import.meta.env.DEV) exposes the player token the socket
// authenticated with; this file opens its own tiny WebSocket to the same server, authenticates
// with that same token, and sends get_me - the same round trip the app itself makes, run
// independently so the assertion cannot be fooled by anything the page renders.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { WebSocket } from 'ws';
import pg from 'pg';

const REPORT_DIR = path.join(fileURLToPath(new URL('../..', import.meta.url)), 'docs', 'reports', 'b6-b9');
fs.mkdirSync(REPORT_DIR, { recursive: true });

function readEnv() {
  const out = {};
  const text = fs.readFileSync(new URL('../../.env', import.meta.url), 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0 && !line.trim().startsWith('#')) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}
const ENV = readEnv();
// A VITE_GAME_WS in the environment (the ticket's own recipe: "VITE_GAME_WS on the Vite command
// line" when the game server runs on a non-default port) overrides .env the same way it already
// does for the app's own bundle - this file's independent verification socket must point at the
// same server the page under test does, not whatever .env happens to say.
const GAME_WS = process.env.VITE_GAME_WS || ENV.VITE_GAME_WS;

// Read the socket's player token off the page's dev-only hook the way the app itself holds it
// (src/api/socket.js sets window.__xchief.token once `welcome` lands).
async function tokenFromWindow(page) {
  const deadline = Date.now() + 10000;
  let token = await page.evaluate(() => window.__xchief && window.__xchief.token);
  while (!token && Date.now() < deadline) {
    await page.waitForTimeout(250);
    token = await page.evaluate(() => window.__xchief && window.__xchief.token);
  }
  return token;
}

/** Authenticates a fresh socket with `token` and returns the get_me row - a second, independent
 * client asking the server the same question the app asks itself. */
function getMeViaSocket(token) {
  return new Promise((resolve, reject) => {
    expect(GAME_WS, 'VITE_GAME_WS is not set in .env: the box game server is not configured').toBeTruthy();
    const ws = new WebSocket(GAME_WS);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('timed out waiting for get_me over the socket'));
    }, 8000);
    let authed = false;
    ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token })));
    ws.on('message', (data) => {
      let frame;
      try {
        frame = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (frame.type === 'welcome') {
        authed = true;
        ws.send(JSON.stringify({ type: 'get_me' }));
      } else if (authed && frame.type === 'me') {
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

async function getMe(page) {
  const token = await tokenFromWindow(page);
  expect(
    token,
    'client is not wired to the game socket: no window.__xchief.token after playing, ' +
      'so the server-side promise cannot be verified',
  ).toBeTruthy();
  return getMeViaSocket(token);
}

// Coins as rendered in the top balance chip, locale digits stripped to a number.
async function screenCoins(page) {
  const text = await page.locator('.balance-text').innerText();
  return Number(text.replace(/[^\d]/g, ''));
}

async function startGame(page) {
  await page.goto('/');
  await page.locator('.btn-start').click();
  // The direction buttons stay disabled until a live price is in.
  await expect(page.locator('.btn-up')).toBeEnabled({ timeout: 20000 });
}

// Play one round from idle and return { outcome, elapsed }.
async function playRound(page, dir = 'up') {
  const t0 = Date.now();
  await page.click(`.btn-${dir}`);
  await expect(page.locator('.countdown')).toBeVisible({ timeout: 3000 });
  // Promise: a verdict never appears sooner than ~5 s.
  await page.waitForTimeout(4400);
  await expect(page.locator('.pane-result'), 'a verdict appeared before ~5 s').toHaveCount(0);
  await expect(page.locator('.pane-result')).toBeVisible({ timeout: 20000 });
  const elapsed = Date.now() - t0;
  const text = await page.locator('.pane-result').innerText();
  const outcome = /WIN/.test(text) ? 'win' : /MISS/.test(text) ? 'lose' : /FLAT/.test(text) ? 'flat' : 'unknown';
  return { outcome, text, elapsed };
}

// Directly rewrites this player's coins in the database (docs/layers.md C7's own recipe): the
// only way to force "broke" deterministically without playing out a losing streak for real.
// The server is never told about this out of band - the next frame it sends (welcome/me/
// round_settled) simply reads the row the test just changed, same as any other write to it.
async function setCoinsInDb(playerId, coins) {
  const databaseUrl = process.env.DATABASE_URL;
  expect(databaseUrl, 'DATABASE_URL must be set for the broke-path test to reach the database directly').toBeTruthy();
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const { rowCount } = await client.query('update public.players set coins = $1 where id = $2', [coins, playerId]);
    expect(rowCount, `no players row for id ${playerId}`).toBe(1);
  } finally {
    await client.end();
  }
}

// Same dev-only lookup web-identity.spec.js uses: node scripts/peek-otp.mjs <email> against
// DATABASE_URL, never a guessed or faked code.
function peekOtp(email) {
  const out = execFileSync('node', ['scripts/peek-otp.mjs', email], { env: process.env, encoding: 'utf8' }).trim();
  expect(out, `no dev-captured OTP code found for ${email} - is DATABASE_URL set to the test database?`).not.toBe(
    'none',
  );
  return out;
}

test.describe('player-visible promises', () => {
  test.setTimeout(180000);

  test('1. server mode is active, and a played round shows a countdown then a verdict decided by the server, with screen coins equal to the server coins', async ({
    page,
  }) => {
    await startGame(page);
    await expect
      .poll(() => page.evaluate(() => window.__xchief && window.__xchief.mode), {
        message: 'window.__xchief.mode must be "server" - the client is not wired to the game socket',
        timeout: 10000,
      })
      .toBe('server');

    const settledBefore = await page.evaluate(() => (window.__xchief && window.__xchief.settledCount) || 0);
    const t0 = Date.now();
    await page.click('.btn-up');
    await expect(page.locator('.countdown')).toBeVisible({ timeout: 3000 });

    // Price ticks overwrite window.__xchief.lastFrame within milliseconds of the verdict, so
    // wait on the settle counter the dev hook keeps, which only round_settled moves.
    await page.waitForFunction(
      (before) => window.__xchief && (window.__xchief.settledCount || 0) > before,
      settledBefore,
      { timeout: 20000 },
    );
    const elapsed = Date.now() - t0;
    expect(elapsed, 'the verdict must not appear sooner than ~5 s').toBeGreaterThanOrEqual(4500);

    await expect(page.locator('.pane-result')).toBeVisible({ timeout: 5000 });
    const text = await page.locator('.pane-result').innerText();
    const outcome = /WIN/.test(text) ? 'win' : /MISS/.test(text) ? 'lose' : /FLAT/.test(text) ? 'flat' : 'unknown';
    expect(['win', 'lose', 'flat']).toContain(outcome);

    const me = await getMe(page);
    expect(await screenCoins(page), 'coins on screen must equal the server coins after settling').toBe(me.coins);
  });

  test('2. reloading mid-round still records exactly one settled round (no free retry)', async ({ page }) => {
    await startGame(page);
    const before = await getMe(page);
    console.log('[test2] before: user', String(before.id).slice(0, 8), 'rounds', before.rounds);

    await page.click('.btn-up');
    await expect(page.locator('.countdown')).toBeVisible({ timeout: 3000 });
    await page.waitForTimeout(1000);
    await page.reload();
    // The server round takes ~5 s from the click plus round-trip time; the reload drops the
    // page but the server's own timer still fires and settles it regardless.
    let after = await getMe(page);
    const deadline = Date.now() + 15000;
    while (after.rounds < before.rounds + 1 && Date.now() < deadline) {
      await page.waitForTimeout(1000);
      after = await getMe(page);
    }
    console.log('[test2] after: user', String(after.id).slice(0, 8), 'rounds', after.rounds);
    expect(after.id, 'the reload must resume the same player, not create a new one').toBe(before.id);
    expect(after.rounds, 'a round interrupted by a reload must still count as exactly 1 round').toBe(before.rounds + 1);
  });

  test('3. kiosk mode plays rounds with a verdict and never shows an email prompt', async ({ page }) => {
    await page.goto('/?k=dev-kiosk-secret-0001');
    await page.locator('.btn-start').click();
    await expect(page.locator('.btn-up')).toBeEnabled({ timeout: 20000 });

    // The email prompt is only observable once a win has happened, so play until
    // one does (8 attempts makes "never won" a sub-1% flake at ~50/50 odds).
    let won = false;
    const outcomes = [];
    for (let i = 0; i < 8 && !won; i++) {
      const { outcome } = await playRound(page, i % 2 === 0 ? 'up' : 'down');
      outcomes.push(outcome);
      won = outcome === 'win';
      if (i < 7) {
        await page.locator('.btn-again').click();
        await expect(page.locator('.btn-up')).toBeEnabled({ timeout: 10000 });
      }
    }
    console.log(`kiosk round outcomes: ${outcomes.join(', ')}; saw a win: ${won}`);
    // Give any late-rendering prompt a chance to appear before asserting absence.
    await page.waitForTimeout(2000);

    // In kiosk mode there must be no email capture anywhere: neither the
    // first-win lead card, nor the signup modal, nor any email input.
    const emailUi = page.locator('.lead, .signup, .modal-backdrop, input[type="email"]');
    await expect(
      emailUi,
      won
        ? 'a kiosk win must not trigger any email/signup prompt'
        : 'no email/signup prompt may appear in kiosk mode (no win was observed, so this is the weak pass)',
    ).toHaveCount(0);
  });

  test('4. claiming a task credits exactly the reward the server granted, and the balance shown matches the server (docs/layers.md C5; ticket B6+B7+B9 decision 5)', async ({
    page,
  }) => {
    // claim_task now only accepts kind='manual' tasks (db/schema.sql decision 5); every seeded
    // task has a server-released kind of its own (video/redirect/email/signup/instagram), so
    // this suite seeds its own manual fixture the same way test/integration-box does, rather
    // than reach for a task id whose kind no longer supports a direct client claim.
    const databaseUrl = process.env.DATABASE_URL;
    expect(databaseUrl, 'DATABASE_URL must be set to seed the manual test task').toBeTruthy();
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    const taskId = `e2e_manual_${Date.now()}`;
    try {
      await client.query(
        "insert into public.tasks (id, title, reward, kind) values ($1, 'E2E manual test task', 260, 'manual')",
        [taskId],
      );
    } finally {
      await client.end();
    }

    // Land on Home, not Game: the nav bar (and so the tasks tab) is hidden while a round is on
    // screen (App.jsx renders Nav only outside the 'game' screen) - see startGame() above for
    // the flow the other tests use instead.
    await page.goto('/');
    await expect
      .poll(() => page.evaluate(() => window.__xchief && window.__xchief.mode), {
        message: 'window.__xchief.mode must be "server" - the client is not wired to the game socket',
        timeout: 10000,
      })
      .toBe('server');
    const before = await getMe(page);

    // Nav order is fixed (home, game, tasks, lb) - see App.jsx's Nav component.
    await page.locator('.nav-btn').nth(2).click();
    await expect(page.locator('.tasks')).toBeVisible({ timeout: 5000 });

    // A 'manual' task has no i18n copy of its own; src/i18n.js's t() falls back to the raw key
    // for a missing entry (Identity.jsx's errorText relies on the same fallback), which is
    // enough to find this fixture's row uniquely.
    const task = page.locator('.task').filter({ hasText: `tasks.items.${taskId}.title` });
    await expect(task).toBeVisible({ timeout: 5000 });
    await task.locator('.task-btn').click();

    // The reward is the server's number, not a client guess (docs/layers.md C5): once the
    // claim reply lands the task shows "claimed" and the balance chip reflects the new coins.
    await expect(task.locator('.task-state')).toBeVisible({ timeout: 10000 });

    const after = await getMe(page);
    expect(after.coins, 'the server must have actually granted a reward').toBeGreaterThan(before.coins);
    expect(await screenCoins(page), 'coins on screen must equal the server coins after the claim').toBe(after.coins);
  });

  test('5. going broke on the web is never a dead end: the overlay shows from the server coins, and a free refill re-enables play with no reload (docs/layers.md C7)', async ({
    page,
  }) => {
    await startGame(page);
    const before = await getMe(page);

    // Force broke through the database, not by losing rounds for real (flaky, slow, and not
    // what this test is checking): 50 coins is below every lever's stake (100/200/500,
    // src/config.js's ECON.stakeBase x levers).
    await setCoinsInDb(before.id, 50);

    // The client only ever hears about this through a frame it already trusts - reload to force
    // a fresh `welcome`/`get_me` round trip, then re-enter the game screen the same way
    // startGame() does everywhere else in this file.
    await page.reload();
    await page.locator('.btn-start').click();

    const overlay = page.locator('.broke');
    await expect(overlay, 'the broke overlay must appear once the server reports coins below the smallest stake').toBeVisible({
      timeout: 20000,
    });
    expect(await screenCoins(page), 'the balance chip must show the server coins, not a locally-tracked count').toBe(50);

    // A fresh player has never used the one-time refill: it must be the way out, not a dead end.
    const refillBtn = overlay.locator('.btn-primary');
    await expect(refillBtn).toBeVisible();
    await refillBtn.click();

    const after = await getMe(page);
    expect(after.free_refill_used, 'the server must record the refill as used').toBe(true);
    expect(after.coins, 'the refill must actually raise the balance').toBeGreaterThan(50);
    await expect
      .poll(() => screenCoins(page), {
        message: 'the balance chip must reflect the refill without a reload',
        timeout: 10000,
      })
      .toBe(after.coins);

    // Play must be enabled again with no reload: the overlay is gone and the direction buttons
    // are no longer disabled.
    await expect(overlay, 'the overlay must clear itself once the balance can afford a round').toHaveCount(0);
    await expect(page.locator('.btn-up')).toBeEnabled({ timeout: 10000 });
    await expect(page.locator('.btn-down')).toBeEnabled({ timeout: 10000 });
  });

  test('6. watching the promo video to the end releases its reward from the server, shown as a toast (ticket B6)', async ({
    page,
  }) => {
    await page.goto('/');
    await expect
      .poll(() => page.evaluate(() => window.__xchief && window.__xchief.mode), { timeout: 10000 })
      .toBe('server');
    const before = await getMe(page);

    await page.locator('.nav-btn').nth(2).click();
    await expect(page.locator('.tasks')).toBeVisible({ timeout: 5000 });

    const videoTask = page.locator('.task').filter({ hasText: 'Watch the xChief video' });
    await expect(videoTask).toBeVisible();
    await videoTask.locator('.task-btn').click();

    // No VITE_PROMO_VIDEO_URL configured in this dev setup: VideoModal's fallback countdown
    // plays out for real (src/Tasks.jsx), reporting progress to the server on the same cadence
    // a real <video>'s onTimeUpdate would - report_video_progress (db/schema.sql) is what
    // actually decides when 90% has been crossed and releases the reward, never this screen.
    await expect(page.locator('.promo-fallback')).toBeVisible({ timeout: 3000 });
    await page.screenshot({ path: path.join(REPORT_DIR, '01-video-modal-playing.png') });
    await expect(page.locator('.modal-backdrop')).toHaveCount(0, { timeout: 25000 });

    await expect(page.locator('.toast')).toBeVisible({ timeout: 5000 });
    await expect(videoTask.locator('.task-state')).toBeVisible({ timeout: 5000 });
    await page.screenshot({ path: path.join(REPORT_DIR, '02-video-task-claimed-toast.png') });

    const after = await getMe(page);
    expect(after.coins, 'the server must have released the video task reward').toBeGreaterThan(before.coins);
    await expect.poll(() => screenCoins(page), { timeout: 5000 }).toBe(after.coins);
  });

  test('7. a redirect task opens its destination, refuses the reward before the 5 s window and grants it after (ticket B7)', async ({
    page,
    context,
  }) => {
    await page.goto('/');
    await expect
      .poll(() => page.evaluate(() => window.__xchief && window.__xchief.mode), { timeout: 10000 })
      .toBe('server');
    const before = await getMe(page);

    await page.locator('.nav-btn').nth(2).click();
    await expect(page.locator('.tasks')).toBeVisible({ timeout: 5000 });

    const telegramTask = page.locator('.task').filter({ hasText: 'Join the Telegram channel' });
    await expect(telegramTask).toBeVisible();

    // Returning (the tab regaining focus) under the 5 s window must grant nothing: the client
    // dispatches its own focus listener deterministically here rather than depending on a real
    // OS-level window-switch under headless Chromium, but the promise under test is the
    // server's return_task_visit refusal (db/schema.sql), not the browser's focus plumbing.
    // One window only - src/Tasks.jsx never re-arms it on a refused return (statusOf keeps
    // showing the same disabled "waiting" countdown from the original click until the real
    // window passes), so this is one task_start, two returns against the same window.
    const [popup] = await Promise.all([context.waitForEvent('page'), telegramTask.locator('.task-btn').click()]);
    await popup.waitForLoadState('domcontentloaded').catch(() => {});

    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForTimeout(500);
    const tooEarly = await getMe(page);
    expect(tooEarly.coins, 'returning under the 5 s window must not grant the reward').toBe(before.coins);
    await page.screenshot({ path: path.join(REPORT_DIR, '03-redirect-task-waiting.png') });

    await popup.close();
    await page.waitForTimeout(5200);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));

    await expect(telegramTask.locator('.task-state')).toBeVisible({ timeout: 5000 });
    await page.screenshot({ path: path.join(REPORT_DIR, '04-redirect-task-claimed.png') });
    const after = await getMe(page);
    expect(after.coins, 'past the 5 s window, the server must have released the reward').toBeGreaterThan(
      before.coins,
    );
    await expect.poll(() => screenCoins(page), { timeout: 5000 }).toBe(after.coins);
  });

  test('8. signing in with OTP releases the email (and first-time signup) reward from the server (ticket B9, gap G1)', async ({
    page,
  }) => {
    await page.goto('/');
    await expect
      .poll(() => page.evaluate(() => window.__xchief && window.__xchief.mode), { timeout: 10000 })
      .toBe('server');
    const before = await getMe(page);

    await page.locator('.nav-btn').nth(2).click();
    await expect(page.locator('.tasks')).toBeVisible({ timeout: 5000 });

    // decision 4 / gap G1: the email task's own "start" button opens the OTP screen now,
    // never a client claim_task('email') call.
    const emailTask = page.locator('.task').filter({ hasText: 'Save your email' });
    await expect(emailTask).toBeVisible();
    await emailTask.locator('.task-btn').click();
    await expect(page.locator('.modal-backdrop .modal')).toBeVisible({ timeout: 5000 });

    const email = `e2e-b9-${Date.now()}@example.com`;
    await page.locator('.modal input[type="email"]').fill(email);
    await page.locator('.modal').getByRole('button', { name: /send code/i }).click();

    await expect(page.locator('.modal .pin-input')).toBeVisible({ timeout: 10000 });
    const code = peekOtp(email);
    await page.locator('.modal .pin-input').fill(code);
    await page.locator('.modal').getByRole('button', { name: /verify/i }).click();
    await expect(page.locator('.modal .signup-done-title')).toBeVisible({ timeout: 10000 });
    await page.screenshot({ path: path.join(REPORT_DIR, '05-otp-verified-done.png') });
    await page.locator('.modal').getByRole('button', { name: /done/i }).click();
    await expect(page.locator('.modal-backdrop')).toHaveCount(0);

    // verify_otp_code releases both the email (200) and, on a first verification on this
    // device, the signup (1000) reward itself (db/schema.sql decision 4) - 1200 total (seed).
    const after = await getMe(page);
    expect(after.coins, 'verifying must release the email + signup rewards from the server').toBe(before.coins + 1200);
    await expect.poll(() => screenCoins(page), { timeout: 5000 }).toBe(after.coins);

    await expect(emailTask.locator('.task-state')).toBeVisible({ timeout: 10000 });
    // src/i18n.js's English copy for this task, not db/seed.sql's own title text (Tasks.jsx
    // renders from the i18n key, never the server row's raw title).
    const signupTask = page.locator('.task').filter({ hasText: 'Open an xChief account' });
    await expect(signupTask.locator('.task-state')).toBeVisible({ timeout: 5000 });
    await page.screenshot({ path: path.join(REPORT_DIR, '06-email-and-signup-claimed.png') });
  });
});

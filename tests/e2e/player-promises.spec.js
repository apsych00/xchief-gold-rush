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

import { dismissFirstVisit } from './first-visit.js';
const REPORT_DIR = path.join(fileURLToPath(new URL('../..', import.meta.url)), 'docs', 'reports', 'b6-b9');
const K4_REPORT_DIR = path.join(fileURLToPath(new URL('../..', import.meta.url)), 'docs', 'reports', 'k4');
fs.mkdirSync(REPORT_DIR, { recursive: true });
fs.mkdirSync(K4_REPORT_DIR, { recursive: true });

function readEnv() {
  const out = {};
  // The environment wins over .env so a run on another port resets the kiosk the browser uses.
  const text = fs.readFileSync(new URL('../../.env', import.meta.url), 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0 && !line.trim().startsWith('#')) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  if (process.env.VITE_GAME_WS) out.VITE_GAME_WS = process.env.VITE_GAME_WS.trim();
  return out;
}
const ENV = readEnv();
// Overridable from the environment (same pattern as DATABASE_URL below, and as
// tests/e2e/kiosk.spec.js already does) so the suite can target a dev server on a non-default
// port when 8787 is taken by another worktree's stack; default stays exactly as .env has it.
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
  // Web only: the tour placeholder (ticket B10) mounts as soon as Home does, before any tap, so
  // it must be dismissed before .btn-start is even clickable - unlike the kiosk flows below,
  // where the intro only appears as a result of the attract tap itself.
  await dismissFirstVisit(page);
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
    await dismissFirstVisit(page);
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

    // This test only needs the tasks tab, so it lands on Home rather than going through
    // startGame() the way the round-playing tests below do.
    await page.goto('/');
    await dismissFirstVisit(page);
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

    // The click sends free_refill over the socket; the server's `me` lands a moment later, so
    // poll the server state rather than reading it once right after the click.
    await expect
      .poll(async () => (await getMe(page)).free_refill_used, {
        timeout: 10000,
        message: 'the server must record the refill as used',
      })
      .toBe(true);
    const after = await getMe(page);
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

  test('7. a redirect task opens its destination and releases the reward within 1 s after the timer ends, with no focus event (ticket B7 / K4)', async ({
    page,
    context,
  }) => {
    await page.goto('/');
    await dismissFirstVisit(page);
    await expect
      .poll(() => page.evaluate(() => window.__xchief && window.__xchief.mode), { timeout: 10000 })
      .toBe('server');
    const before = await getMe(page);

    await page.locator('.nav-btn').nth(2).click();
    await expect(page.locator('.tasks')).toBeVisible({ timeout: 5000 });

    const telegramTask = page.locator('.task').filter({ hasText: 'Join the Telegram channel' });
    await expect(telegramTask).toBeVisible();

    const [popup] = await Promise.all([context.waitForEvent('page'), telegramTask.locator('.task-btn').click()]);
    await popup.waitForLoadState('domcontentloaded').catch(() => {});

    // K4: the client now sends task_return automatically when the 5 s window ends; no focus event
    // is needed. Wait the full window plus a small margin and assert the row flips to claimed.
    await page.screenshot({ path: path.join(K4_REPORT_DIR, '01-redirect-task-waiting.png') });
    await expect(telegramTask.locator('.task-state')).toBeVisible({ timeout: 6500 });
    await page.screenshot({ path: path.join(K4_REPORT_DIR, '02-redirect-task-claimed.png') });
    const after = await getMe(page);
    expect(after.coins, 'past the 5 s window, the server must have released the reward').toBeGreaterThan(
      before.coins,
    );
    await expect.poll(() => screenCoins(page), { timeout: 5000 }).toBe(after.coins);
  });

  test('8. the tasks tab is labelled Missions (ticket K4)', async ({ page }) => {
    await page.goto('/');
    await dismissFirstVisit(page);
    // Nav order is fixed (home, game, tasks, lb).
    await expect(page.locator('.nav-btn').nth(2)).toHaveText(/Missions/);
    await page.screenshot({ path: path.join(K4_REPORT_DIR, '03-missions-tab-title.png') });
  });

  test('9. a video mission plays the local hosted video, never touches youtube.com, and reports progress (ticket K4, self-host mission videos)', async ({
    page,
  }) => {
    // Acceptance: no request to youtube.com and no bot interstitial - the whole point of
    // self-hosting the mission videos. Fail loudly if anything in this test hits YouTube.
    const youtubeRequests = [];
    page.on('request', (req) => {
      if (/(^|\.)youtube(-nocookie)?\.com/.test(new URL(req.url()).hostname)) youtubeRequests.push(req.url());
    });

    // Fake the native <video> element's playback clock rather than waiting out 30 real seconds:
    // the src/duration/timeupdate/ended plumbing is exactly what src/Tasks.jsx's
    // useVideoMissionWatch listens to, so this exercises the real reporting path without a slow
    // test. Installed before the app loads so it is in place before VideoModal mounts the element.
    await page.addInitScript(() => {
      const proto = HTMLMediaElement.prototype;
      Object.defineProperty(proto, 'currentTime', {
        configurable: true,
        get() {
          return this.__t || 0;
        },
        set(v) {
          this.__t = v;
        },
      });
      Object.defineProperty(proto, 'duration', {
        configurable: true,
        get() {
          return this.__duration ?? 55;
        },
      });
      Object.defineProperty(proto, 'src', {
        configurable: true,
        get() {
          return this.getAttribute('src') || '';
        },
        set(v) {
          this.setAttribute('src', v);
          this.__t = 0;
          this.__duration = 55;
          clearInterval(this.__fakeTimer);
          // Advances 1 simulated second every 50 ms real time: 55 simulated seconds in ~2.75 s.
          this.__fakeTimer = setInterval(() => {
            this.__t += 1;
            this.dispatchEvent(new Event('timeupdate'));
            if (this.__t >= this.__duration) {
              clearInterval(this.__fakeTimer);
              this.dispatchEvent(new Event('ended'));
            }
          }, 50);
        },
      });
      proto.play = () => Promise.resolve();
    });

    await page.goto('/');
    await dismissFirstVisit(page);
    await expect
      .poll(() => page.evaluate(() => window.__xchief && window.__xchief.mode), { timeout: 10000 })
      .toBe('server');

    await page.locator('.nav-btn').nth(2).click();
    await expect(page.locator('.tasks')).toBeVisible({ timeout: 5000 });

    const videoMissionTask = page.locator('.task').filter({ hasText: 'Watch xChief videos' });
    await expect(videoMissionTask).toBeVisible();

    await videoMissionTask.locator('.task-btn').click();
    const player = page.locator('.youtube-player-wrap video.youtube-player');
    await expect(player).toBeVisible({ timeout: 5000 });
    // Non-seekable: no native controls attribute, so there is no seek bar to grab.
    expect(await player.getAttribute('controls'), 'the player must not expose a native seek bar').toBeNull();
    const src = await player.getAttribute('src');
    expect(src, 'the video mission must play a local file, not a YouTube id or URL').toMatch(/^\/ads\/videos\/.+\.mp4$/);
    // A brief settle so the modal's own open transition is finished before the report screenshot.
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(K4_REPORT_DIR, '04-video-mission-player.png') });

    // The fake clock ends after ~2.75 s; the modal closes on `ended` and reports progress.
    await expect(page.locator('.modal-backdrop')).toHaveCount(0, { timeout: 15000 });
    expect(youtubeRequests, `no request should reach YouTube: ${youtubeRequests.join(', ')}`).toHaveLength(0);
  });

  test('10. signing in with OTP releases the email (and first-time signup) reward from the server (ticket B9, gap G1)', async ({
    page,
  }) => {
    await page.goto('/');
    await dismissFirstVisit(page);
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

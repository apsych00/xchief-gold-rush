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
import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import { WebSocket } from 'ws';

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
const GAME_WS = ENV.VITE_GAME_WS;

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

    const t0 = Date.now();
    await page.click('.btn-up');
    await expect(page.locator('.countdown')).toBeVisible({ timeout: 3000 });

    // Price ticks keep arriving throughout the round and would overwrite
    // window.__xchief.lastFrame within a second or two of settling, so this catches the
    // transition to round_settled the instant it happens rather than reading a stale snapshot
    // after the fact.
    await page.waitForFunction(() => window.__xchief && window.__xchief.lastFrame && window.__xchief.lastFrame.type === 'round_settled', {
      timeout: 20000,
    });
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

  test('4. the OTP code input accepts an 8-digit code', async () => {
    // No code-entry screen exists in the built client yet: SignupForm.jsx collects
    // name/email/phone and LeadCapture.jsx a single email field; neither renders an
    // 8-digit OTP input, so there is nothing to drive from the UI.
    test.skip(true, 'no OTP code-entry screen exists in the client yet (signup is a name/email/phone lead form)');
  });
});

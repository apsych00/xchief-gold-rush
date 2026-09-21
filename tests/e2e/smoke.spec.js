// Layer 3 scaffold: proves the app boots and renders in a real browser against BASE_URL
// (default http://localhost:5173, a `npm run dev` or `npm run preview` server started separately).
// Ticket U1 adds the client-polish checks: exactly one WebSocket (the game socket), the avatar
// icon in both the top bar and the profile, and the wipe button gone from the profile.
import { expect, test } from '@playwright/test';

import { dismissFirstVisit } from './first-visit.js';

const GAME_WS = process.env.VITE_GAME_WS || 'auto';
const PAGE = new URL(process.env.BASE_URL || 'http://localhost:5173');
// Matches src/api/socket.js's own resolveWsUrl(): an explicit ws:// URL in dev, same-origin /ws
// behind Caddy (and in the 'auto' default).
const GAME_WS_URL = GAME_WS === 'auto' ? `${PAGE.protocol === 'https:' ? 'wss' : 'ws'}://${PAGE.host}/ws` : GAME_WS;

test('home screen renders the game', async ({ page }) => {
  await page.goto('/');
  await dismissFirstVisit(page);

  await expect(page).toHaveTitle(/xChief Gold Rush/);
  await expect(page.locator('.hero-art')).toBeVisible();
  await expect(page.getByRole('button', { name: /start the challenge/i })).toBeVisible();
});

// Ticket U1, decision 4: the client must open exactly one WebSocket, and it must be ours.
// Every price the client shows now comes from the game socket; the old direct upstream sources
// (relay, Finnhub, OKX, Binance) and the local fallback are gone. A round is played so a lazily
// opened socket would have had its chance to appear.
test('after a round the page has exactly one app WebSocket, the game socket', async ({ page }) => {
  const sockets = [];
  page.on('websocket', (ws) => sockets.push(ws.url()));

  await page.goto('/');
  await dismissFirstVisit(page);
  await page.locator('.btn-start').click();
  await expect(page.locator('.btn-up')).toBeEnabled({ timeout: 20000 });
  await page.click('.btn-up');
  await expect(page.locator('.pane-result')).toBeVisible({ timeout: 20000 });

  // Vite's dev client opens an HMR socket on the page origin; that is dev-server plumbing, not
  // the app. Anything else must be the one game socket.
  const hmr = new Set(
    sockets.filter((url) => {
      const u = new URL(url);
      // URL keeps the ws: scheme, so compare host, not origin (http: page vs ws: socket).
      return u.host === PAGE.host && u.pathname === '/' && url !== GAME_WS_URL;
    }),
  );
  const appSockets = sockets.filter((url) => !hmr.has(url));

  expect(
    appSockets,
    `every app WebSocket must be the game socket ${GAME_WS_URL}; saw ${JSON.stringify(sockets)}`,
  ).toEqual([GAME_WS_URL]);
  expect(
    sockets.filter((url) => /finnhub|okx|binance|kraken|gold-api|gold-relay/i.test(url)),
    `no upstream price socket may be opened; saw ${JSON.stringify(sockets)}`,
  ).toEqual([]);
});

// Ticket U1, decisions 1 and 2: the profile's wipe button is gone, and both avatars render the
// user icon (the top bar's aria-label is unchanged).
test('a guest is offered Sign in where a player gets their avatar', async ({ page }) => {
  await page.goto('/');
  await dismissFirstVisit(page);

  // The header's right-hand slot holds one control, not two: a guest is offered Sign in where a
  // signed-in player gets their avatar. Both are the same height, so the header never jumps.
  const signIn = page.locator('.topbar .signin-chip');
  await expect(signIn).toHaveCount(1);
  await expect(page.locator('.avatar-btn')).toHaveCount(0);
  // It stands in for the avatar, so it carries the avatar's own 36px footprint rather than the
  // balance chip's - the header must not change height when a guest signs in. What it shares with
  // the balance chip is the line they sit on.
  const chipBox = await page.locator('.topbar .balance-chip').boundingBox();
  const signInBox = await signIn.boundingBox();
  expect(signInBox.height, 'the guest control stands in for the 36px avatar').toBe(36);
  const centreOf = (b) => b.y + b.height / 2;
  expect(
    Math.abs(centreOf(signInBox) - centreOf(chipBox)),
    'the guest control must sit on the same line as the balance chip',
  ).toBeLessThanOrEqual(1);
  await page.screenshot({ path: 'docs/reports/u1/01-topbar-guest.png' });

  // Tapping it opens the one shared email prompt rather than navigating anywhere.
  await signIn.click();
  await expect(page.locator('.modal input[type="email"]')).toBeVisible();
  await page.keyboard.press('Escape');

  // Consequence of that slot being the sign-in offer: a guest has no route to the profile screen
  // at all. Its own assertions (the avatar glyph, the absence of any wipe/reset action) live in
  // tests/e2e/web-identity.spec.js now, which has a signed-in player to open it with.
  await expect(page.locator('.pf')).toHaveCount(0);
});

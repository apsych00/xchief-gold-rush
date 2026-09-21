// E2E for the URL-routing ticket: the browser/Android back button used to leave the site
// entirely from any bottom-nav screen, because every screen lived in one in-memory
// `state.screen` string with nothing touching the URL (src/useUrlRouting.js, src/useGame.js).
// This suite drives the same taps and the same hardware-back gesture a phone user would, and
// checks the URL and the screen underneath agree at every step.
//
// Part 2 of the ticket (back closes an open modal) was dropped - see this ticket's delivery
// report - so there is no modal-back-close case here; every other required case is covered.
//
// Same harness as tests/e2e/smoke.spec.js: a running dev server (BASE_URL) against the box game
// server.
import { expect, test } from '@playwright/test';

import { dismissFirstVisit } from './first-visit.js';

function pathnameOf(page) {
  return new URL(page.url()).pathname;
}

async function back(page) {
  await page.evaluate(() => window.history.back());
}

async function forward(page) {
  await page.evaluate(() => window.history.forward());
}

test.describe('URL routing for the five flat screens', () => {
  test('nav taps push history; repeated back retraces screens in order, in lockstep with the URL', async ({
    page,
  }) => {
    await page.goto('/');
    await dismissFirstVisit(page);
    expect(pathnameOf(page)).toBe('/');
    await expect(page.locator('.home')).toBeVisible();

    await page.getByRole('button', { name: 'Missions', exact: true }).click();
    await expect(page.locator('.tasks')).toBeVisible();
    expect(pathnameOf(page)).toBe('/missions');

    await page.getByRole('button', { name: 'Board', exact: true }).click();
    await expect(page.locator('.lb')).toBeVisible();
    expect(pathnameOf(page)).toBe('/board');

    // The game screen keeps the bottom nav now (ticket nav-on-play) - back must still retrace
    // through it via the same URL, same as every other screen.
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await expect(page.locator('.console')).toBeVisible();
    expect(pathnameOf(page)).toBe('/play');

    // Back once: /play -> /board, through goLeaderboard() (not a bare screen flip), so the board
    // is freshly loaded rather than showing whatever was on screen before.
    await back(page);
    await expect(page.locator('.lb')).toBeVisible();
    expect(pathnameOf(page)).toBe('/board');

    await back(page);
    await expect(page.locator('.tasks')).toBeVisible();
    expect(pathnameOf(page)).toBe('/missions');

    await back(page);
    await expect(page.locator('.home')).toBeVisible();
    expect(pathnameOf(page)).toBe('/');
  });

  test('forward after back replays the same screens', async ({ page }) => {
    await page.goto('/');
    await dismissFirstVisit(page);

    await page.getByRole('button', { name: 'Missions', exact: true }).click();
    await expect(page.locator('.tasks')).toBeVisible();
    await page.getByRole('button', { name: 'Board', exact: true }).click();
    await expect(page.locator('.lb')).toBeVisible();

    await back(page);
    await expect(page.locator('.tasks')).toBeVisible();
    expect(pathnameOf(page)).toBe('/missions');
    await back(page);
    await expect(page.locator('.home')).toBeVisible();
    expect(pathnameOf(page)).toBe('/');

    await forward(page);
    await expect(page.locator('.tasks')).toBeVisible();
    expect(pathnameOf(page)).toBe('/missions');

    await forward(page);
    await expect(page.locator('.lb')).toBeVisible();
    expect(pathnameOf(page)).toBe('/board');
  });

  test('a deep link to /board loads the board with data, and /missions loads missions', async ({ page }) => {
    await page.goto('/board');
    await dismissFirstVisit(page);
    expect(pathnameOf(page)).toBe('/board');
    await expect(page.locator('.lb')).toBeVisible();
    // "with data": the fetch that a bare screen flip would never trigger has actually landed -
    // either a real tournament header or the explicit "no tournament" copy, never the skeleton
    // rows this screen shows before its first fetch resolves. The session handshake (anonymous
    // sign-in, then the board fetch) is a couple of real round trips, so give it real time.
    await expect(page.locator('.lb-row-skeleton')).toHaveCount(0, { timeout: 15000 });
    await expect(page.locator('.lb-tournament')).toBeVisible();

    await page.goto('/missions');
    await dismissFirstVisit(page);
    expect(pathnameOf(page)).toBe('/missions');
    await expect(page.locator('.tasks')).toBeVisible();
    await expect(page.locator('.task').first()).toBeVisible({ timeout: 15000 });
  });

  test('an unknown path lands on home with the URL rewritten', async ({ page }) => {
    await page.goto('/this-path-does-not-exist');
    await dismissFirstVisit(page);
    expect(pathnameOf(page)).toBe('/');
    await expect(page.locator('.home')).toBeVisible();
  });

  // Caught on the live domain, invisible on a local stack: the boot dispatch waits on
  // ensureSession(), which takes as long as the network does. Locally that is a few
  // milliseconds and always beats the first tap; over the real domain it is hundreds, and a
  // visitor who tapped during that window was yanked back to the screen the URL named when the
  // page opened - and the yank pushed its own history entry, so a later back skipped a screen.
  // Holding the socket handshake open makes that window wide enough to test deterministically.
  test('a tap while the session is still connecting is not undone by the boot dispatch', async ({ page }) => {
    let openTheSocket;
    const held = new Promise((resolve) => {
      openTheSocket = resolve;
    });
    await page.routeWebSocket('**/ws', async (ws) => {
      await held;
      ws.connectToServer();
    });

    await page.goto('/');
    await dismissFirstVisit(page);
    await page.getByRole('button', { name: 'Missions', exact: true }).click();
    await expect(page.locator('.tasks')).toBeVisible();
    expect(pathnameOf(page)).toBe('/missions');

    // Let the connect finish. Whatever the boot path was, it must not move the visitor now.
    openTheSocket();
    await page.waitForTimeout(2000);
    await expect(page.locator('.tasks')).toBeVisible();
    expect(pathnameOf(page)).toBe('/missions');

    // And the stray entry must not be there either: one back leaves the app, it does not land
    // on a home screen the visitor never asked for.
    await back(page);
    await expect(page.locator('.tasks')).toHaveCount(0);
  });

  test('reserved paths are left alone: /kiosk is never touched or rewritten', async ({ page }) => {
    await page.goto('/kiosk');
    // The kiosk's own attract screen reuses the web Home screen's `.home` class (same visual
    // shell), so this checks the URL itself plus a kiosk-only marker rather than that class -
    // if this hook ever bounced a reserved path to '/' this would show up as a rewritten URL.
    expect(pathnameOf(page)).toBe('/kiosk');
    await expect(page.locator('.kiosk-attract-in')).toBeVisible();
    await expect(page.locator('.nav')).toHaveCount(0);
  });
});

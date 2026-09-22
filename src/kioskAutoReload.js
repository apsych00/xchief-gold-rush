/**
 * When it is safe for a booth tablet to reload itself to pick up a new deploy.
 *
 * Kept free of React and of any .jsx import on purpose: this is the part that decides whether
 * a visitor loses their round, so it has to be testable under plain node (test/unit/
 * kiosk-auto-reload.test.mjs). src/useKioskAutoReload.js wires it to the screen state.
 */

// A beat of attract before reloading, so a screen merely passing through 'attract' on its way
// somewhere else (a reset settling, a fresh session opening) is not mistaken for a device at rest.
export const SETTLE_MS = 3000;

// Survives the reload it triggers, which an in-memory flag cannot - see the loop note below.
export const ATTEMPT_KEY = 'goldrush.kiosk.reloadedFor';

// The only screens where a reload costs a visitor nothing. 'no_codes' is the same attract screen
// with the Play button removed (the prize pool ran dry), so it is equally idle.
const SAFE_SCREENS = new Set(['attract', 'no_codes']);

/**
 * Deliberately defaults to not reloading: every unknown screen is treated as a visitor
 * mid-game. Failing to update is a walk around the booth; updating at the wrong moment throws
 * away someone's game or their claim QR.
 *
 * `attemptedBuild` is what stops a reload loop, and it is not hypothetical - it was caught in
 * testing. If the served version.json ever disagrees with the bundle actually being served
 * (a half-finished deploy, a cached index.html, a CDN serving two generations at once), then
 * every reload lands on a page that is still "stale" and immediately reloads again. A tablet
 * in that state is useless for the rest of the show. So we record which build we reloaded
 * *for*, in storage that survives the reload, and never chase the same build twice: one
 * wasted reload, then the device settles and someone can look at it.
 */
export function shouldAutoReload({ enabled, screen, runningBuild, deployedBuild, attemptedBuild }) {
  if (!enabled) return false;
  // No answer from /version.json yet, or a build that predates the id (runningBuild 'dev' in
  // a dev server): nothing to compare, so nothing to do.
  if (!deployedBuild || !runningBuild || runningBuild === 'dev') return false;
  if (deployedBuild === runningBuild) return false;
  if (attemptedBuild === deployedBuild) return false;
  return SAFE_SCREENS.has(screen);
}

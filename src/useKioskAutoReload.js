/**
 * Zero-touch updates for the booth.
 *
 * A tablet left on /kiosk keeps running whatever bundle it loaded, so before this every deploy
 * during the exhibition meant walking the floor and reloading each device by hand. The web app
 * solves the same problem with a banner to tap (UpdateBanner), which is useless on a device
 * nobody is standing at.
 *
 * So the kiosk reloads itself, at the first genuinely idle moment and no other: the attract
 * screen, once it has been settled there for SETTLE_MS. The rule itself lives in
 * kioskAutoReload.js, where it can be tested without a browser. Waiting costs nothing - the
 * kiosk returns to attract by itself after every visitor, so an update lands within a visitor
 * or two rather than at the end of the day.
 */
import { useEffect, useRef } from 'react';
import { RUNNING_BUILD, reloadFresh, useDeployedBuildId } from './UpdateBanner.jsx';
import { ATTEMPT_KEY, SETTLE_MS, shouldAutoReload } from './kioskAutoReload.js';

export { SETTLE_MS, shouldAutoReload };

function readAttempt() {
  try {
    return window.sessionStorage.getItem(ATTEMPT_KEY);
  } catch {
    return null; // storage disabled: fall back to the in-memory guard below
  }
}

function writeAttempt(build) {
  try {
    window.sessionStorage.setItem(ATTEMPT_KEY, build);
  } catch {
    /* storage disabled: the in-memory guard is all we have */
  }
}

export function useKioskAutoReload(screen, { enabled = true } = {}) {
  const deployedBuild = useDeployedBuildId();
  // Backstop for the one case sessionStorage cannot cover (storage disabled): still no loop
  // within a single page load.
  const firedRef = useRef(false);

  useEffect(() => {
    const attemptedBuild = firedRef.current ? deployedBuild : readAttempt();
    if (
      !shouldAutoReload({
        enabled,
        screen,
        runningBuild: RUNNING_BUILD,
        deployedBuild,
        attemptedBuild,
      })
    ) {
      return undefined;
    }
    const timer = setTimeout(() => {
      firedRef.current = true;
      // Written before the reload, not after - after never runs.
      writeAttempt(deployedBuild);
      reloadFresh();
    }, SETTLE_MS);
    return () => clearTimeout(timer);
  }, [enabled, screen, deployedBuild]);

  return Boolean(deployedBuild && deployedBuild !== RUNNING_BUILD);
}

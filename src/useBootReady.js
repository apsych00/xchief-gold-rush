/**
 * When the splash is allowed to go away.
 *
 * Ready means the session has answered, so `profile.emailVerified` and everything else derived
 * from identity holds a real value rather than its initial guess. Web fonts are waited on too:
 * they settle in a few milliseconds from cache and they are what makes a cold load visibly
 * reflow.
 *
 * The timeout is the part that matters most. A splash that waits for the network is a splash
 * that can trap someone on a dead connection forever, so after BOOT_TIMEOUT_MS the app comes up
 * regardless. That is safe because the identity guards treat "not known yet" as "do not ask" -
 * the splash improves what the user sees, it is not what keeps the app correct.
 */
import { useEffect, useState } from 'react';

import { ensureSession } from './api/session.js';

/** Long enough to cover a normal mobile connect, short enough that a dead one is not a wall. */
export const BOOT_TIMEOUT_MS = 1500;
/** The CSS fade in styles.css (.splash-leaving). Kept in step with it by hand; it is one value. */
const FADE_MS = 260;

export function useBootReady() {
  // Two steps rather than one: `ready` starts the fade, `gone` unmounts once it has run. Skipping
  // the middle state would make the splash vanish instantly instead of fading.
  const [ready, setReady] = useState(false);
  const [gone, setGone] = useState(false);

  useEffect(() => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      setReady(true);
    };

    const fonts = document.fonts ? document.fonts.ready.catch(() => {}) : Promise.resolve();
    Promise.all([ensureSession().catch(() => null), fonts]).then(finish);
    const timer = setTimeout(finish, BOOT_TIMEOUT_MS);

    return () => {
      done = true;
      clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (!ready) return undefined;
    const timer = setTimeout(() => setGone(true), FADE_MS);
    return () => clearTimeout(timer);
  }, [ready]);

  return { leaving: ready, gone };
}

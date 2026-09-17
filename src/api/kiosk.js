/**
 * Kiosk identity and round play. The kiosk carries no auth session - its launch URL bakes in
 * a bearer secret (?k=...) that the server checks on the socket's first `auth` frame, so a
 * fixed booth device never needs to sign in.
 */
import { enabled as apiEnabled } from './client.js';
import { getKioskSecret, kioskReset, onKioskSession, play } from './socket.js';

export { getKioskSecret, kioskReset, onKioskSession };

/** True when this tab is a booth kiosk: server mode is on and the launch URL carries a `k`
 * parameter at all - presence, not truthiness (D7, docs/reports/redteam.md): a launch shortcut
 * that lost its query string (`?k=`) must still render the kiosk shell and its own error state,
 * never silently fall through to the full web app. Read once - a kiosk's launch URL is fixed, so
 * its secret never changes mid-session. */
export const IS_KIOSK = apiEnabled && getKioskSecret() !== null;

/** Sends play {dir, lever}; resolves with round_opened. server/index.js applies the kiosk's own
 * lever the same way it does for a web player (frame.lever ?? 1 for a kiosk identity). */
export function playKioskRound(dir, lever) {
  return play(dir, lever);
}

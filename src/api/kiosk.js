/**
 * Kiosk identity and round play. The kiosk carries no auth session - visiting /kiosk (ticket K1)
 * self-provisions a bearer secret that lives in device storage and rides the socket's first
 * `auth` frame, so a fixed booth device never needs to sign in (ticket S3 removed the older
 * `?k=<secret>` launch URL entirely).
 */
import { enabled as apiEnabled } from './client.js';
import { getKioskSecret, isKioskPath, kioskReset, onKioskSession, play, provisionKiosk } from './socket.js';

export { getKioskSecret, isKioskPath, kioskReset, onKioskSession, provisionKiosk };

/** True when this tab is a booth kiosk: the open kiosk route (/kiosk, ticket K1) and nothing
 * else - there is no other way to enter kiosk mode. */
export const IS_KIOSK = apiEnabled && isKioskPath();

/** Sends play {dir, lever}; resolves with round_opened. server/index.js applies the kiosk's own
 * lever the same way it does for a web player (frame.lever ?? 1 for a kiosk identity). */
export function playKioskRound(dir, lever) {
  return play(dir, lever);
}

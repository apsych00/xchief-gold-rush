/**
 * Kiosk identity and round play. The kiosk carries no auth session - its launch URL bakes in
 * a bearer secret (?k=...) that the server checks on the socket's first `auth` frame, so a
 * fixed booth device never needs to sign in.
 */
import { getKioskSecret, play } from './socket.js';

export { getKioskSecret };

/** Sends play {dir}; resolves with round_opened. The server ignores lever for a kiosk identity. */
export function playKioskRound(dir) {
  return play(dir);
}

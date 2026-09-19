/**
 * Web auth: play-first, upgrade to email later. The player's identity is the socket's own
 * player token (docs/layers.md C3a): connect() sends it (or nothing, for a fresh player) as
 * the first frame, and the server's `welcome` is what makes the connection usable - a token
 * older than 7 days is silently renewed there too. requestOtp/verifyOtp later set an email on
 * that same player id, so the row (and its score) carries over rather than starting fresh -
 * unless that email already belongs to a different, verified player, in which case verifyOtp
 * is a re-login: the server switches this socket to the existing player instead (its score is
 * what carries over then) and socket.js stores the fresh token that answer carries.
 */
import { enabled } from './client.js';
import {
  clearToken,
  connect,
  onStatus,
  requestOtp as socketRequestOtp,
  state,
  verifyOtp as socketVerifyOtp,
} from './socket.js';

let inflight = null;

/**
 * Opens the socket if needed and resolves once `welcome` has landed. Returns null when the API
 * is disabled. Single-flight: React StrictMode mounts the game hook twice in dev; connect()
 * itself is idempotent, but this still keeps one shared "wait for welcome" promise so callers
 * do not each set up their own listener.
 */
export function ensureSession() {
  if (!enabled) return Promise.resolve(null);
  if (!inflight) {
    inflight = new Promise((resolve) => {
      connect();
      if (state().connected) {
        resolve(state());
        return;
      }
      const off = onStatus((s) => {
        if (!s.connected) return;
        off();
        resolve(s);
      });
    }).finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

/** Stores a login code (length: src/config.js's OTP_CODE_LENGTH) against this player's email,
 * sent through Elastic (dev: dev_otps). */
export function requestOtp(email) {
  if (!enabled) throw Object.assign(new Error('api_disabled'), { code: 'api_disabled' });
  return socketRequestOtp(email);
}

/** Verifies the code from requestOtp and sets the email on this same player id (score kept) -
 * or, if that email already belongs to a different, verified player, logs into that player
 * instead (docs/layers.md C3a). Either way, whatever this resolves with is the new `me`. */
export function verifyOtp(email, code) {
  if (!enabled) throw Object.assign(new Error('api_disabled'), { code: 'api_disabled' });
  return socketVerifyOtp(email, code);
}

/** Drops the stored token and reloads: the next load's `auth` frame carries nothing, so the
 * server starts a brand-new anonymous player (docs/layers.md C3). The player can log back into
 * the same verified player from any device by requesting a fresh code for the same email
 * (docs/layers.md C3a: OTP on a known email is a login, not an error). */
export function signOut() {
  if (!enabled) return;
  clearToken();
  window.location.reload();
}

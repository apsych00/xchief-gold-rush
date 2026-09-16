/**
 * Web auth: play-first, upgrade to email later. The player's identity is the socket's own
 * player token (docs/box-plan.md 1.5): connect() sends it (or nothing, for a fresh player) as
 * the first frame, and the server's `welcome` is what makes the connection usable. requestOtp/
 * verifyOtp later set an email on that same player id, so the row (and its score) carries over
 * rather than starting fresh.
 */
import { enabled } from './client.js';
import { connect, onStatus, requestOtp as socketRequestOtp, state, verifyOtp as socketVerifyOtp } from './socket.js';

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

/** Stores an 8-digit code against this player's email, sent through Elastic (dev: dev_otps). */
export function requestOtp(email) {
  if (!enabled) throw Object.assign(new Error('api_disabled'), { code: 'api_disabled' });
  return socketRequestOtp(email);
}

/** Verifies the code from requestOtp and sets the email on this same player id. Score is kept. */
export function verifyOtp(email, code) {
  if (!enabled) throw Object.assign(new Error('api_disabled'), { code: 'api_disabled' });
  return socketVerifyOtp(email, code);
}

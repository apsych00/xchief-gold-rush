/**
 * Persisted 1-hour countdown for the signup mission (src/Tasks.jsx).
 *
 * The end timestamp is stored under a stable key so the timer survives tab closes
 * and app reloads. If storage is unavailable the timer simply lives in memory for
 * that session, the same graceful-degradation pattern src/api/socket.js uses.
 */
export const SIGNUP_TIMER_KEY = 'xchief.signup_timer_until';

export function readSignupTimer() {
  try {
    const raw = localStorage.getItem(SIGNUP_TIMER_KEY);
    const value = raw ? Number.parseInt(raw, 10) : NaN;
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

export function writeSignupTimer(until) {
  try {
    localStorage.setItem(SIGNUP_TIMER_KEY, String(until));
  } catch {
    /* storage unavailable: the timer lives only for this session */
  }
}

export function clearSignupTimer() {
  try {
    localStorage.removeItem(SIGNUP_TIMER_KEY);
  } catch {
    /* storage unavailable */
  }
}

/**
 * Persisted 3-minute unlock cooldown for the YouTube videos mission (src/Tasks.jsx).
 *
 * After the server releases one video's reward, the next video unlocks only once this
 * cooldown has passed. The end timestamp is stored under a stable key so the countdown
 * survives tab closes and reloads, exactly like signupTimer.js. If storage is unavailable
 * the timer simply lives in memory for that session, the same graceful-degradation pattern
 * src/api/socket.js uses. The cooldown only paces the UI: each reward is still released by
 * the server from validated watch time, once per device/email, so skipping it grants nothing.
 */
export const YOUTUBE_COOLDOWN_KEY = 'xchief.youtube_mission_cooldown_until';

export function readYoutubeCooldown() {
  try {
    const raw = localStorage.getItem(YOUTUBE_COOLDOWN_KEY);
    const value = raw ? Number.parseInt(raw, 10) : NaN;
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

export function writeYoutubeCooldown(until) {
  try {
    localStorage.setItem(YOUTUBE_COOLDOWN_KEY, String(until));
  } catch {
    /* storage unavailable: the cooldown lives only for this session */
  }
}

export function clearYoutubeCooldown() {
  try {
    localStorage.removeItem(YOUTUBE_COOLDOWN_KEY);
  } catch {
    /* storage unavailable */
  }
}

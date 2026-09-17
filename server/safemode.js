/**
 * Safe mode (ticket S18, docs/tickets/s18-safe-mode.md): a server-wide mode with three levels -
 * `normal`, `guarded`, `locked` - that shrinks what an unknown client can do while a flood is
 * under way, without touching players already connected. S2 (server/limits.js) already handles
 * one abusive IP; this is the answer for the rest of the threat model - a script spawning many
 * headless browsers or raw sockets from rotating IPs, none of which ever trips a single IP's own
 * budget.
 *
 * The level is held in memory for a zero-latency check on every auth (server/index.js), and
 * mirrored to a row in `public.settings` (key `safe_mode`, decision 1) so it survives a restart.
 * Two things change it, both landing through the same settings row so there is only ever one
 * source of truth:
 *
 *   - An operator runs `scripts/safe-mode.mjs <level>`, which writes the row directly. This
 *     module polls it every POLL_MS and adopts whatever it finds, tagging the change 'manual'.
 *   - The automatic escalation state machine below (decision 3) runs on the same poll tick,
 *     using the signals server/limits.js already tracks system-wide: new socket connections in
 *     the last minute, new anonymous-player attempts in the last 10 minutes, and the S2 block
 *     list's size. Tripping any one of them escalates one level and writes the row itself;
 *     spending DEESCALATE_AFTER_MS continuously below half of every threshold de-escalates one
 *     level. Thresholds are constants with env overrides (see THRESHOLDS below), chosen against
 *     the capacity targets in docs/box-architecture.md 5b (100 concurrent, 2,000 players/day) -
 *     see that constant's own comment for the margin.
 *
 * A manual write always wins on the poll that observes it: this module never overwrites an
 * operator's command with its own automatic judgement in the same tick, it only starts
 * evaluating escalation/de-escalation forward from whatever level was just written - exactly as
 * if the automatic state machine had reached that level by itself. This is also why a manual
 * `locked` does not stay locked forever on its own: after DEESCALATE_AFTER_MS of genuinely quiet
 * traffic it steps back down like any automatic lock would. Re-run the command to hold it.
 */

const SETTINGS_KEY = 'safe_mode';

export const LEVELS = ['normal', 'guarded', 'locked'];

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

const MINUTE = 60 * 1000;

// Escalation thresholds (ticket S18 decision 3). Measured headroom for a 100-concurrent,
// 2,000-players/day expo booth (docs/box-architecture.md 5b): the 100-socket load test saw
// ~17 rounds/s sustained with zero errors, and 2,000 players/day is ~1.4 signups/minute on
// average - even a very busy opening hour sits nowhere near these numbers, so normal traffic
// never trips them. A rotating-IP script trying to outrun S2 (30 connections/min, 10 anonymous
// players/10min, per IP) needs only a handful of source IPs to clear these aggregate numbers.
export const THRESHOLDS = {
  MAX_CONNECTIONS_PER_MIN: envInt('SAFE_MODE_MAX_CONNECTIONS_PER_MIN', 300),
  MAX_ANON_PLAYERS_PER_10MIN: envInt('SAFE_MODE_MAX_ANON_PLAYERS_PER_10MIN', 100),
  MAX_BLOCKED_IPS: envInt('SAFE_MODE_MAX_BLOCKED_IPS', 20),
  DEESCALATE_AFTER_MS: envInt('SAFE_MODE_DEESCALATE_AFTER_MS', 10 * MINUTE),
};

const POLL_MS = 5000; // decision 1: "the server polls it every 5 s"

/**
 * One evaluation step of the automatic escalation state machine, pure and side-effect free so a
 * unit test can drive it with an injected clock and no server, no database, no timers.
 *
 * `state` is `{level, belowHalfSince}` - `belowHalfSince` is the instant (ms) all three signals
 * were first seen continuously below half their threshold, or null while that is not true.
 * `signals` is `{connectionsPerMin, newAnonPlayersPer10Min, blockedIps}`. `t` is the current
 * instant (ms). Returns the next `{level, belowHalfSince}` state, plus `changed` and `reason`
 * when this step actually moved the level.
 */
export function nextAutomaticState(state, signals, t, thresholds = THRESHOLDS) {
  const idx = LEVELS.indexOf(state.level);

  let trippedReason = null;
  if (signals.connectionsPerMin > thresholds.MAX_CONNECTIONS_PER_MIN) trippedReason = 'auto:connections';
  else if (signals.newAnonPlayersPer10Min > thresholds.MAX_ANON_PLAYERS_PER_10MIN) trippedReason = 'auto:anon_players';
  else if (signals.blockedIps > thresholds.MAX_BLOCKED_IPS) trippedReason = 'auto:blocklist';

  if (trippedReason) {
    if (idx < LEVELS.length - 1) {
      return { level: LEVELS[idx + 1], belowHalfSince: null, changed: true, reason: trippedReason };
    }
    return { level: state.level, belowHalfSince: null, changed: false, reason: null }; // already locked
  }

  const allBelowHalf =
    signals.connectionsPerMin < thresholds.MAX_CONNECTIONS_PER_MIN / 2 &&
    signals.newAnonPlayersPer10Min < thresholds.MAX_ANON_PLAYERS_PER_10MIN / 2 &&
    signals.blockedIps < thresholds.MAX_BLOCKED_IPS / 2;

  if (!allBelowHalf) {
    return { level: state.level, belowHalfSince: null, changed: false, reason: null };
  }

  const since = state.belowHalfSince ?? t;
  if (t - since >= thresholds.DEESCALATE_AFTER_MS && idx > 0) {
    // Reset the grace window from here rather than leaving it at `since`: stepping down again
    // needs another full DEESCALATE_AFTER_MS of quiet, the same as the first step down did.
    return { level: LEVELS[idx - 1], belowHalfSince: t, changed: true, reason: 'auto:recovered' };
  }
  return { level: state.level, belowHalfSince: since, changed: false, reason: null };
}

/**
 * @param {object} deps
 * @param {typeof import('./ledger.js')} deps.ledger
 * @param {() => {connectionsPerMin: number, newAnonPlayersPer10Min: number, blockedIps: number}} deps.getSignals
 * @param {{fireSafeMode?: (level: string, reason: string) => Promise<void>}} [deps.alerts]
 * @param {(line: string) => void} [deps.log]
 * @param {() => number} [deps.now]
 * @param {number} [deps.pollIntervalMs]
 */
export function createSafeMode({ ledger, getSignals, alerts = null, log = console.log, now = Date.now, pollIntervalMs = POLL_MS } = {}) {
  let level = 'normal';
  let reason = 'startup';
  let atMs = now();
  let belowHalfSince = null;
  let lastSeenRaw = null; // the exact settings-row string this module has already accounted for
  let timer = null;

  function currentRaw() {
    return JSON.stringify({ level, reason, at: new Date(atMs).toISOString() });
  }

  async function persist() {
    const raw = currentRaw();
    await ledger.setSetting(SETTINGS_KEY, raw);
    lastSeenRaw = raw;
  }

  function applyExternal(parsed, restored) {
    if (level !== parsed.level) {
      log(`[safemode] level -> ${parsed.level} (${restored ? 'restored' : 'manual'})`);
      if (alerts) alerts.fireSafeMode(parsed.level, restored ? 'restored' : 'manual').catch(() => {});
    }
    level = parsed.level;
    reason = restored ? parsed.reason || 'restored' : 'manual';
    atMs = restored && parsed.at ? new Date(parsed.at).getTime() : now();
    belowHalfSince = null;
  }

  async function pollOnce() {
    let raw;
    try {
      raw = await ledger.getSetting(SETTINGS_KEY);
    } catch (err) {
      log(`[safemode] settings read failed: ${err.message}`);
      return;
    }

    if (raw === null) {
      // Nothing written yet (a fresh database): establish the baseline row.
      await persist().catch((err) => log(`[safemode] settings write failed: ${err.message}`));
      return;
    }

    if (raw !== lastSeenRaw) {
      // Either an operator wrote a fresh value, or (lastSeenRaw === null) this is the first
      // poll after a restart and the row already held a level from before it - decision 1's
      // "survives a restart". Either way it did not come from this module's own last write.
      const restored = lastSeenRaw === null;
      let parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        /* malformed row: ignore it, keep the in-memory level */
      }
      if (parsed && LEVELS.includes(parsed.level)) applyExternal(parsed, restored);
      lastSeenRaw = raw;
      return; // give the freshly adopted level one full poll cycle before judging it further
    }

    const result = nextAutomaticState({ level, belowHalfSince }, getSignals(), now());
    belowHalfSince = result.belowHalfSince;
    if (result.changed) {
      level = result.level;
      reason = result.reason;
      atMs = now();
      log(`[safemode] level -> ${level} (${reason})`);
      await persist().catch((err) => log(`[safemode] settings write failed: ${err.message}`));
      if (alerts) alerts.fireSafeMode(level, reason).catch(() => {});
    }
  }

  return {
    level: () => level,
    reason: () => reason,
    status: () => ({ level, reason }),
    /** ticket S18 decision 2 (locked): "except ... sockets with a token issued before the
     * lock" - null unless the current level is 'locked', in which case this is when it began. */
    lockedAtMs: () => (level === 'locked' ? atMs : null),

    start() {
      if (timer) return;
      pollOnce().catch((err) => log(`[safemode] poll failed: ${err.message}`));
      timer = setInterval(() => {
        pollOnce().catch((err) => log(`[safemode] poll failed: ${err.message}`));
      }, pollIntervalMs);
      timer.unref();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },

    // Test-only: drive one poll synchronously without waiting on the timer.
    _pollOnce: pollOnce,
  };
}

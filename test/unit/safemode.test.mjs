// Unit tests for the pure automatic escalation state machine (ticket S18,
// server/safemode.js's nextAutomaticState): normal/guarded/locked, one step at a time, driven by
// an injected clock and hand-built signals - no server, no database, no timers. The settings-row
// polling, the manual-vs-automatic wiring and the actual auth-time enforcement are covered by
// test/integration-box/safemode.test.mjs instead.
//
// Run: node --test test/unit/safemode.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { nextAutomaticState, LEVELS, THRESHOLDS } = await import('../../server/safemode.js');

const quiet = { connectionsPerMin: 0, newAnonPlayersPer10Min: 0, blockedIps: 0 };
const T0 = 1_800_000_000_000;

// --- escalation ------------------------------------------------------------------------------

test('normal escalates to guarded when connections per minute trips its threshold', () => {
  const state = { level: 'normal', belowHalfSince: null };
  const signals = { ...quiet, connectionsPerMin: THRESHOLDS.MAX_CONNECTIONS_PER_MIN + 1 };
  const result = nextAutomaticState(state, signals, T0);
  assert.equal(result.level, 'guarded');
  assert.equal(result.changed, true);
  assert.equal(result.reason, 'auto:connections');
});

test('guarded escalates to locked when anonymous players per 10 minutes trips its threshold', () => {
  const state = { level: 'guarded', belowHalfSince: null };
  const signals = { ...quiet, newAnonPlayersPer10Min: THRESHOLDS.MAX_ANON_PLAYERS_PER_10MIN + 1 };
  const result = nextAutomaticState(state, signals, T0);
  assert.equal(result.level, 'locked');
  assert.equal(result.reason, 'auto:anon_players');
});

test('the S2 block list tripping its threshold escalates one level, reason auto:blocklist', () => {
  const state = { level: 'normal', belowHalfSince: null };
  const signals = { ...quiet, blockedIps: THRESHOLDS.MAX_BLOCKED_IPS + 1 };
  const result = nextAutomaticState(state, signals, T0);
  assert.equal(result.level, 'guarded');
  assert.equal(result.reason, 'auto:blocklist');
});

test('locked never escalates further: already at the top level', () => {
  const state = { level: 'locked', belowHalfSince: null };
  const signals = { ...quiet, connectionsPerMin: THRESHOLDS.MAX_CONNECTIONS_PER_MIN + 1 };
  const result = nextAutomaticState(state, signals, T0);
  assert.equal(result.level, 'locked');
  assert.equal(result.changed, false);
});

test('exactly at a threshold does not trip it; one over does', () => {
  const state = { level: 'normal', belowHalfSince: null };
  const atThreshold = { ...quiet, connectionsPerMin: THRESHOLDS.MAX_CONNECTIONS_PER_MIN };
  assert.equal(nextAutomaticState(state, atThreshold, T0).changed, false);
  const overThreshold = { ...quiet, connectionsPerMin: THRESHOLDS.MAX_CONNECTIONS_PER_MIN + 1 };
  assert.equal(nextAutomaticState(state, overThreshold, T0).changed, true);
});

test('normal traffic (all signals at zero) never escalates', () => {
  const state = { level: 'normal', belowHalfSince: null };
  const result = nextAutomaticState(state, quiet, T0);
  assert.equal(result.changed, false);
  assert.equal(result.level, 'normal');
});

// --- de-escalation -----------------------------------------------------------------------------

test('guarded de-escalates to normal after DEESCALATE_AFTER_MS continuously below half every threshold', () => {
  // First tick below half: starts the clock, does not yet change level.
  const step1 = nextAutomaticState({ level: 'guarded', belowHalfSince: null }, quiet, T0);
  assert.equal(step1.changed, false);
  assert.ok(step1.belowHalfSince !== null);

  const justBefore = nextAutomaticState(
    { level: 'guarded', belowHalfSince: step1.belowHalfSince },
    quiet,
    T0 + THRESHOLDS.DEESCALATE_AFTER_MS - 1,
  );
  assert.equal(justBefore.changed, false, 'not yet - one ms short of the grace period');

  const atDeadline = nextAutomaticState(
    { level: 'guarded', belowHalfSince: step1.belowHalfSince },
    quiet,
    T0 + THRESHOLDS.DEESCALATE_AFTER_MS,
  );
  assert.equal(atDeadline.changed, true);
  assert.equal(atDeadline.level, 'normal');
  assert.equal(atDeadline.reason, 'auto:recovered');
});

test('normal never de-escalates further: already at the bottom level', () => {
  const state = { level: 'normal', belowHalfSince: T0 - THRESHOLDS.DEESCALATE_AFTER_MS - 1 };
  const result = nextAutomaticState(state, quiet, T0);
  assert.equal(result.changed, false);
  assert.equal(result.level, 'normal');
});

test('a signal rising back above half resets the below-half clock', () => {
  const started = nextAutomaticState({ level: 'guarded', belowHalfSince: null }, quiet, T0);
  assert.ok(started.belowHalfSince !== null);

  const busy = { ...quiet, connectionsPerMin: THRESHOLDS.MAX_CONNECTIONS_PER_MIN / 2 }; // exactly half: not "below" half
  const interrupted = nextAutomaticState({ level: 'guarded', belowHalfSince: started.belowHalfSince }, busy, T0 + 1000);
  assert.equal(interrupted.belowHalfSince, null, 'the clock resets, it does not merely pause');

  // Even DEESCALATE_AFTER_MS later, the reset clock means no de-escalation yet - it only just
  // restarted counting from the interruption.
  const laterStillQuiet = nextAutomaticState(
    { level: 'guarded', belowHalfSince: interrupted.belowHalfSince },
    quiet,
    T0 + 1000 + THRESHOLDS.DEESCALATE_AFTER_MS - 1,
  );
  assert.equal(laterStillQuiet.changed, false);
});

test('de-escalating restarts the grace window rather than cascading straight through every level', () => {
  const step1 = nextAutomaticState(
    { level: 'locked', belowHalfSince: T0 - THRESHOLDS.DEESCALATE_AFTER_MS },
    quiet,
    T0,
  );
  assert.equal(step1.changed, true);
  assert.equal(step1.level, 'guarded');
  assert.equal(step1.belowHalfSince, T0, 'the grace window restarts from this instant');

  const immediatelyAfter = nextAutomaticState({ level: 'guarded', belowHalfSince: step1.belowHalfSince }, quiet, T0 + 1);
  assert.equal(immediatelyAfter.changed, false, 'guarded->normal needs its own full grace period');
});

// --- env overrides -----------------------------------------------------------------------------

test('LEVELS is normal, guarded, locked in escalation order', () => {
  assert.deepEqual(LEVELS, ['normal', 'guarded', 'locked']);
});

test('a custom thresholds object overrides the module defaults for one call', () => {
  const tightThresholds = { ...THRESHOLDS, MAX_CONNECTIONS_PER_MIN: 5 };
  const state = { level: 'normal', belowHalfSince: null };
  const result = nextAutomaticState(state, { ...quiet, connectionsPerMin: 6 }, T0, tightThresholds);
  assert.equal(result.changed, true, 'trips the custom threshold, not the (much higher) module default');
});

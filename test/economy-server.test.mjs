// Pure re-derivation of the server-side economy math from supabase/migrations/0003_functions.sql
// (combo_mult, stake_for, and the settle_round win/lose formulas), cross-checked against the
// client's src/config.js. No dependencies beyond node:test - this is what keeps client and
// server from silently drifting apart when either side changes its combo table or stake rule.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COMBO_MAX, comboMult, ECON } from '../src/config.js';

// Mirrors: select (array[1, 1.5, 2, 3]::numeric[])[least(greatest(p_streak, 0), 3) + 1];
function serverComboMult(streak) {
  const table = [1, 1.5, 2, 3];
  const index = Math.min(Math.max(streak, 0), 3);
  return table[index];
}

// Mirrors: select 100 * p_lever;
function serverStakeFor(lever) {
  return 100 * lever;
}

// Mirrors the win branch of settle_round: v_delta := round(r.stake * v_mult)::int
function serverWinDelta(stake, priorStreak) {
  return Math.round(stake * serverComboMult(priorStreak));
}

// Mirrors the lose branch of settle_round: v_coins := greatest(0, p.coins - r.stake)
function serverLoseCoins(coins, stake) {
  return Math.max(0, coins - stake);
}

test('server combo table matches the client combo table for every streak the game reaches', () => {
  for (let streak = 0; streak <= 12; streak++) {
    assert.equal(serverComboMult(streak), comboMult(streak), `combo diverges at streak ${streak}`);
  }
  assert.equal(serverComboMult(3), COMBO_MAX);
});

test('server stake formula matches the client stake formula for every lever', () => {
  for (const lever of ECON.levers) {
    assert.equal(serverStakeFor(lever), ECON.stakeBase * lever, `stake diverges at lever ${lever}`);
  }
});

test('lever-5 win at streak 2 pays 1000, matching docs/backend-spec.md', () => {
  const stake = serverStakeFor(5);
  assert.equal(stake, 500);
  assert.equal(serverWinDelta(stake, 2), 1000);
});

test('win payouts follow 100, 150, 200, 300 at stake 100 across the combo table', () => {
  const stake = serverStakeFor(1);
  assert.deepEqual(
    [0, 1, 2, 3, 9].map((streak) => serverWinDelta(stake, streak)),
    [100, 150, 200, 300, 300],
  );
});

test('a loss floors coins at 0 and never goes negative', () => {
  assert.equal(serverLoseCoins(60, 100), 0);
  assert.equal(serverLoseCoins(1000, 500), 500);
});

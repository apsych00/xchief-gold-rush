// Contract tests for the economy rules, written blind from
// docs/test-contract.md ("Economy rules" section only).
// Run: node --test test/unit

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { newPlayer, comboMult, stakeFor, applyWin, applyLose, applyFlat, refill, canOpen } from './economy-oracle.mjs';

// --- New player -----------------------------------------------------------

test('new player starts at coins 1000, record 1000, streak 0', () => {
  const p = newPlayer();
  assert.equal(p.coins, 1000);
  assert.equal(p.record, 1000);
  assert.equal(p.streak, 0);
});

// --- Stake ----------------------------------------------------------------

test('stake is 100 x lever for levers 1, 2, 5', () => {
  assert.equal(stakeFor(1), 100);
  assert.equal(stakeFor(2), 200);
  assert.equal(stakeFor(5), 500);
});

// --- Combo multiplier (from the streak BEFORE the round) -------------------

test('combo multiplier at streak 0 is 1x', () => {
  assert.equal(comboMult(0), 1);
});

test('combo multiplier at streak 1 is 1.5x', () => {
  assert.equal(comboMult(1), 1.5);
});

test('combo multiplier at streak 2 is 2x', () => {
  assert.equal(comboMult(2), 2);
});

test('combo multiplier at streak 3 is 3x', () => {
  assert.equal(comboMult(3), 3);
});

test('combo multiplier at streak 4 is still 3x', () => {
  assert.equal(comboMult(4), 3);
});

// --- Win --------------------------------------------------------------------

test('win pays round(stake x multiplier) using the pre-round streak', () => {
  // streak 1 -> 1.5x, stake 200 -> delta 300.
  const p = { ...newPlayer(), streak: 1, coins: 1000 };
  const w = applyWin(p, 200);
  assert.equal(w.coins, 1300);
  assert.equal(w.streak, 2);
  assert.equal(w.wins, 1);
});

test('win payout is rounded to a whole number', () => {
  // stake 95 x 1.5 = 142.5 -> rounds to 143.
  // Ambiguity note: the contract says round() without defining the .5 case.
  // We take the literal JS Math.round (half rounds toward +infinity).
  const p = { ...newPlayer(), streak: 1, coins: 1000 };
  const w = applyWin(p, 95);
  assert.equal(w.coins, 1000 + 143);
});

test('win raises record only when coins exceed it', () => {
  const p = { ...newPlayer(), coins: 300, record: 1000, streak: 0 };
  const w = applyWin(p, 100); // +100 -> 400, still below record
  assert.equal(w.coins, 400);
  assert.equal(w.record, 1000);

  const hot = { ...newPlayer(), coins: 950, record: 1000, streak: 3 };
  const w2 = applyWin(hot, 500); // +1500 -> 2450, above record
  assert.equal(w2.coins, 2450);
  assert.equal(w2.record, 2450); // record = max(record, coins)
});

// --- Lose -------------------------------------------------------------------

test('lose subtracts the stake, resets streak, record unchanged', () => {
  const p = { ...newPlayer(), coins: 1000, record: 1200, streak: 3, wins: 5 };
  const l = applyLose(p, 200);
  assert.equal(l.coins, 800);
  assert.equal(l.streak, 0);
  assert.equal(l.record, 1200);
  assert.equal(l.wins, 5);
});

test('coins can hit exactly 0 on a lose', () => {
  const p = { ...newPlayer(), coins: 500, streak: 2 };
  const l = applyLose(p, 500);
  assert.equal(l.coins, 0);
});

test('coins never go below 0 on a lose', () => {
  const p = { ...newPlayer(), coins: 150 };
  const l = applyLose(p, 200);
  assert.equal(l.coins, 0);
});

test('record never decreases on a lose even when coins crash to 0', () => {
  const p = { ...newPlayer(), coins: 100, record: 5000, streak: 4 };
  const l = applyLose(p, 500);
  assert.equal(l.coins, 0);
  assert.equal(l.record, 5000);
});

// --- Flat -------------------------------------------------------------------

test('flat changes nothing', () => {
  const p = { ...newPlayer(), coins: 437, record: 9999, streak: 2, wins: 7 };
  const f = applyFlat(p);
  assert.equal(f.coins, 437);
  assert.equal(f.streak, 2);
  assert.equal(f.record, 9999);
  assert.equal(f.wins, 7);
});

// --- Refill -----------------------------------------------------------------

test('refill adds 300 coins when below 100', () => {
  const p = { ...newPlayer(), coins: 50 };
  const r = refill(p);
  assert.equal(r.coins, 350);
});

test('refill is refused at 100 coins or more', () => {
  const at100 = refill({ ...newPlayer(), coins: 100 });
  assert.equal(at100.coins, 100);

  const above = refill({ ...newPlayer(), coins: 101 });
  assert.equal(above.coins, 101);
});

test('refill only ever happens once per player', () => {
  const p = refill({ ...newPlayer(), coins: 10 });
  assert.equal(p.coins, 310);
  const drained = { ...p, coins: 5 };
  const second = refill(drained);
  assert.equal(second.coins, 5); // refused: already used
});

test('a refused refill does not consume the one-time refill', () => {
  // Refill attempt while >= 100 must leave the player still eligible.
  const p = { ...newPlayer(), coins: 1000 };
  const refused = refill(p);
  assert.equal(refused.coins, 1000);
  const later = refill({ ...refused, coins: 20 });
  assert.equal(later.coins, 320);
});

// --- canOpen: coin floor ------------------------------------------------------

test('a round cannot open when coins < stake', () => {
  const p = { ...newPlayer(), coins: 150 };
  assert.equal(canOpen(p, 2, 0), false); // stake 200 > 150
  assert.equal(canOpen(p, 5, 0), false); // stake 500 > 150
});

test('a round can open when coins equal stake exactly', () => {
  const p = { ...newPlayer(), coins: 500 };
  assert.equal(canOpen(p, 5, 0), true);
});

// --- canOpen: 60 rounds per rolling hour --------------------------------------

// Ambiguity note: the contract says "at most 60 rounds per player per rolling
// hour" but does not define whether the count passed to canOpen includes the
// round being opened. We follow the ticket's literal boundary: a request at
// 60 is allowed, a request at 61 is refused, reading the parameter as the
// round's position within the hour (60th round ok, 61st refused).

test('the 60th round in the hour is allowed', () => {
  const p = newPlayer();
  assert.equal(canOpen(p, 1, 60), true);
});

test('the 61st round in the hour is refused even with plenty of coins', () => {
  const p = { ...newPlayer(), coins: 100000 };
  assert.equal(canOpen(p, 1, 61), false);
});

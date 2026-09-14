// Pure-logic checks of the coin economy (run with `npm test`).
// Mirrors settle() in src/useGame.js against the tables in src/config.js.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COMBO_MAX, comboMult, ECON, levelFor, nextLevel } from '../src/config.js';

const stake = (lev) => ECON.stakeBase * lev;

/** Same rules as useGame.settle(): win pays stake × combo, loss costs stake, flat returns it. */
function settle(p, lev, outcome) {
  const s = stake(lev);
  if (outcome === 'flat') return { ...p, rounds: p.rounds + 1 };
  if (outcome === 'win') {
    const coins = p.coins + Math.round(s * comboMult(p.streak));
    return { ...p, coins, record: Math.max(p.record, coins), streak: p.streak + 1, rounds: p.rounds + 1 };
  }
  return { ...p, coins: Math.max(0, p.coins - s), streak: 0, rounds: p.rounds + 1 };
}

const fresh = () => ({ coins: ECON.startCoins, record: ECON.startCoins, streak: 0, rounds: 0 });

test('combo table pays 1, 1.5, 2, 3 and caps', () => {
  let p = fresh();
  const gains = [];
  for (let i = 0; i < 6; i++) {
    const before = p.coins;
    p = settle(p, 5, 'win');
    gains.push(p.coins - before);
  }
  assert.deepEqual(gains, [500, 750, 1000, 1500, 1500, 1500]);
  assert.equal(comboMult(99), COMBO_MAX);
});

test('a loss costs exactly the stake and resets the combo, record stays', () => {
  let p = fresh();
  p = settle(p, 2, 'win');
  p = settle(p, 2, 'win');
  const before = p;
  p = settle(p, 5, 'lose');
  assert.equal(p.coins, before.coins - 500);
  assert.equal(p.streak, 0);
  assert.equal(p.record, before.record);
});

test('flat keeps coins and combo', () => {
  let p = fresh();
  p = settle(p, 1, 'win');
  const before = p;
  p = settle(p, 1, 'flat');
  assert.equal(p.coins, before.coins);
  assert.equal(p.streak, before.streak);
});

test('coins never go negative and a reckless player is broke within a few rounds', () => {
  let p = fresh();
  let n = 0;
  while (p.coins >= ECON.brokeBelow && n < 20) {
    const lev = p.coins >= 500 ? 5 : p.coins >= 200 ? 2 : 1;
    p = settle(p, lev, 'lose');
    n++;
  }
  assert.ok(p.coins >= 0);
  assert.ok(n <= 4, `took ${n} rounds`);
  assert.ok(p.coins + ECON.freeRefill >= stake(1), 'free refill must make ×1 playable again');
});

test('max single win is bounded', () => {
  assert.equal(stake(5) * COMBO_MAX, 1500);
});

test('levels are monotonic and nextLevel points forward', () => {
  assert.equal(levelFor(0).id, 'rookie');
  assert.equal(levelFor(2000).id, 'trader');
  assert.equal(levelFor(9999).id, 'pro');
  assert.equal(levelFor(10000).id, 'chief');
  assert.equal(nextLevel(0).id, 'trader');
  assert.equal(nextLevel(10000), null);
});

test('50/50 play at ×1 drifts mildly upward, not explosively', () => {
  let sum = 0;
  const N = 3000;
  for (let k = 0; k < N; k++) {
    let p = fresh();
    for (let i = 0; i < 40 && p.coins >= ECON.brokeBelow; i++) p = settle(p, 1, Math.random() < 0.5 ? 'win' : 'lose');
    sum += p.coins;
  }
  const avg = sum / N;
  assert.ok(avg > ECON.startCoins, `avg ${avg.toFixed(0)} should be above start`);
  assert.ok(avg < ECON.startCoins * 2.5, `avg ${avg.toFixed(0)} should not explode`);
});

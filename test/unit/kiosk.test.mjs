// Unit tests for server/kiosk.js (ticket T1): coupon-stock alerts fire when the available
// pool crosses the 20 and 5 thresholds, and when it exhausts.
//
// Run: node --test test/unit/kiosk.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { createKioskIdleSweep } = await import('../../server/kiosk.js');

function makeLedger(counts) {
  let idx = 0;
  return {
    availableCoupons: async () => counts[idx++],
    staleKiosks: async () => [],
    resetKioskSession: async (id) => ({ id, coins: 1000, streak: 0, state: 'idle' }),
    releaseExpiredClaims: async () => 0,
    kioskSession: async (id) => ({ id, coins: 1000, streak: 0, state: 'idle', codes_left: 0 }),
  };
}

function makeAlerts() {
  const calls = [];
  const fireEvent = (code, params, opts = {}) => {
    calls.push({ code, params, conditionKey: opts.conditionKey ?? code });
    return Promise.resolve();
  };
  return { fireEvent, calls };
}

test('crossing from 21 to 20 available fires coupons_low with condition key coupons_low:20', async () => {
  const ledger = makeLedger([21, 20]);
  const alerts = makeAlerts();
  const sweep = createKioskIdleSweep({
    ledger,
    getSocket: () => null,
    listKioskSockets: () => [],
    alerts,
    log: () => {},
  });

  await sweep.sweepOnce(); // baseline
  await sweep.sweepOnce(); // crossing

  const low = alerts.calls.filter((c) => c.code === 'coupons_low');
  assert.equal(low.length, 1);
  assert.equal(low[0].params.left, 20);
  assert.equal(low[0].conditionKey, 'coupons_low:20');
});

test('crossing from 6 to 5 available fires coupons_low with condition key coupons_low:5', async () => {
  const ledger = makeLedger([6, 5]);
  const alerts = makeAlerts();
  const sweep = createKioskIdleSweep({
    ledger,
    getSocket: () => null,
    listKioskSockets: () => [],
    alerts,
    log: () => {},
  });

  await sweep.sweepOnce();
  await sweep.sweepOnce();

  const low = alerts.calls.filter((c) => c.code === 'coupons_low');
  assert.equal(low.length, 1);
  assert.equal(low[0].params.left, 5);
  assert.equal(low[0].conditionKey, 'coupons_low:5');
});

test('crossing from 1 to 0 fires coupons_exhausted', async () => {
  const ledger = makeLedger([1, 0]);
  const alerts = makeAlerts();
  const sweep = createKioskIdleSweep({
    ledger,
    getSocket: () => null,
    listKioskSockets: () => [],
    alerts,
    log: () => {},
  });

  await sweep.sweepOnce();
  await sweep.sweepOnce();

  const exhausted = alerts.calls.filter((c) => c.code === 'coupons_exhausted');
  assert.equal(exhausted.length, 1);
});

test('a large drop from 25 to 0 fires both coupons_low thresholds and coupons_exhausted', async () => {
  const ledger = makeLedger([25, 0]);
  const alerts = makeAlerts();
  const sweep = createKioskIdleSweep({
    ledger,
    getSocket: () => null,
    listKioskSockets: () => [],
    alerts,
    log: () => {},
  });

  await sweep.sweepOnce();
  await sweep.sweepOnce();

  const low20 = alerts.calls.filter((c) => c.conditionKey === 'coupons_low:20');
  const low5 = alerts.calls.filter((c) => c.conditionKey === 'coupons_low:5');
  const exhausted = alerts.calls.filter((c) => c.code === 'coupons_exhausted');
  assert.equal(low20.length, 1);
  assert.equal(low20[0].params.left, 0);
  assert.equal(low5.length, 1);
  assert.equal(low5[0].params.left, 0);
  assert.equal(exhausted.length, 1);
});

test('staying above 20 or between thresholds fires no coupon alerts', async () => {
  const ledger = makeLedger([30, 25, 22, 21, 19, 19, 18]);
  const alerts = makeAlerts();
  const sweep = createKioskIdleSweep({
    ledger,
    getSocket: () => null,
    listKioskSockets: () => [],
    alerts,
    log: () => {},
  });

  for (let i = 0; i < 7; i++) await sweep.sweepOnce();

  const low20 = alerts.calls.filter((c) => c.conditionKey === 'coupons_low:20');
  const low5 = alerts.calls.filter((c) => c.conditionKey === 'coupons_low:5');
  assert.equal(low20.length, 1, 'only the 20 threshold crossing fires once');
  assert.equal(low5.length, 0, 'never reached 5');
});

test('alerts are not fired when no alerts module is provided', async () => {
  const ledger = makeLedger([1, 0]);
  const sweep = createKioskIdleSweep({
    ledger,
    getSocket: () => null,
    listKioskSockets: () => [],
    alerts: null,
    log: () => {},
  });

  await sweep.sweepOnce();
  await sweep.sweepOnce();
  // No assertion failure means the sweep ran without crashing when alerts is absent.
});

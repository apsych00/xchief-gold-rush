/**
 * The booth reloads itself to pick up a deploy (src/kioskAutoReload.js). Two things can go
 * wrong, and neither is "it failed to update" - that just means someone walks the floor like
 * before.
 *
 * 1. It reloads while a visitor is playing, throwing away their round, or on the WON screen,
 *    destroying the claim QR they are still scanning.
 * 2. It reloads, lands on a page that still looks stale, and reloads again - forever. This one
 *    was caught in local testing before ship: an in-memory "already fired" flag does not
 *    survive the reload that clears it, so the tablet looped 25 times in 70 seconds.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { shouldAutoReload } from '../../src/kioskAutoReload.js';

const RUNNING = 'build-1';
const DEPLOYED = 'build-2';
const ready = {
  enabled: true,
  screen: 'attract',
  runningBuild: RUNNING,
  deployedBuild: DEPLOYED,
  attemptedBuild: null,
};

test('reloads from the attract screen, where no visitor is mid-game', () => {
  assert.equal(shouldAutoReload(ready), true);
});

test('reloads from no_codes - the same idle attract screen with the pool empty', () => {
  assert.equal(shouldAutoReload({ ...ready, screen: 'no_codes' }), true);
});

test('never reloads mid-round: that would throw away a real visitor’s game', () => {
  assert.equal(shouldAutoReload({ ...ready, screen: 'playing' }), false);
});

test('never reloads on the WON screen, which would destroy the claim QR being scanned', () => {
  assert.equal(shouldAutoReload({ ...ready, screen: 'won' }), false);
});

test('never reloads on the BROKE screen while the visitor is still reading it', () => {
  assert.equal(shouldAutoReload({ ...ready, screen: 'broke' }), false);
});

test('an unrecognised screen is treated as occupied, not as idle', () => {
  assert.equal(shouldAutoReload({ ...ready, screen: 'something-new' }), false);
  assert.equal(shouldAutoReload({ ...ready, screen: undefined }), false);
});

test('does nothing while the running build is already the deployed one', () => {
  assert.equal(shouldAutoReload({ ...ready, deployedBuild: RUNNING }), false);
});

test('does nothing before /version.json has answered', () => {
  assert.equal(shouldAutoReload({ ...ready, deployedBuild: null }), false);
});

test('never runs against a dev server, where there is no real build id', () => {
  assert.equal(shouldAutoReload({ ...ready, runningBuild: 'dev' }), false);
});

test('holds off while disabled - the socket is down or the kiosk is unauthorized', () => {
  assert.equal(shouldAutoReload({ ...ready, enabled: false }), false);
});

test('will not chase the same build twice, so a bad deploy cannot cause a reload loop', () => {
  // The reload already happened for this exact build and we are still running the old one:
  // version.json and the served bundle disagree. Stop, rather than loop forever.
  assert.equal(shouldAutoReload({ ...ready, attemptedBuild: DEPLOYED }), false);
});

test('a later deploy is still picked up after an earlier one was abandoned', () => {
  // Having given up on build-2 must not deafen the tablet to build-3.
  assert.equal(shouldAutoReload({ ...ready, deployedBuild: 'build-3', attemptedBuild: DEPLOYED }), true);
});

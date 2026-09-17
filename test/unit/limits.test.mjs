// Unit tests for server/limits.js (ticket S2): the sliding window and the block list, driven
// by an injected clock so a 10-minute window or a 15-minute block never means a slow test.
// No socket, no HTTP request, no database - clientIp() and the wiring into server/index.js are
// covered by test/integration-box/limits.test.mjs instead.
//
// Run: node --test test/unit/limits.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { createLimits, clientIp, LIMITS } = await import('../../server/limits.js');

/** A clock the test controls: starts at an arbitrary fixed instant and only moves when told to. */
function fakeClock(start = 1_800_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms), value: () => t };
}

// --- clientIp ------------------------------------------------------------------------------

test('clientIp prefers CF-Connecting-IP, then the first X-Forwarded-For hop, then the socket', () => {
  const withSocket = (headers) => ({ headers, socket: { remoteAddress: '9.9.9.9' } });

  assert.equal(
    clientIp(withSocket({ 'cf-connecting-ip': '1.1.1.1', 'x-forwarded-for': '2.2.2.2' }), true),
    '1.1.1.1',
  );
  assert.equal(clientIp(withSocket({ 'x-forwarded-for': '2.2.2.2, 3.3.3.3' }), true), '2.2.2.2');
  assert.equal(clientIp(withSocket({}), true), '9.9.9.9');
});

test('clientIp ignores the proxy headers entirely when trustProxy is false', () => {
  const req = { headers: { 'cf-connecting-ip': '1.1.1.1' }, socket: { remoteAddress: '9.9.9.9' } };
  assert.equal(clientIp(req, false), '9.9.9.9');
});

// --- sliding window: sockets and connection rate ------------------------------------------

test('the 21st open socket from one IP is refused; the 20th is not', () => {
  const clock = fakeClock();
  const limits = createLimits({ now: clock.now, log: () => {} });
  const ip = '10.0.0.1';

  for (let i = 0; i < LIMITS.MAX_SOCKETS_PER_IP; i++) {
    assert.equal(limits.checkNewConnection(ip), null, `socket ${i + 1} should be allowed`);
    limits.trackSocketOpen(ip);
    clock.advance(1); // stay well inside the per-minute connection window
  }
  assert.equal(limits.checkNewConnection(ip), 'too_many_sockets');
});

test('the 31st connection in a minute from one IP is refused; connections a minute apart are not', () => {
  const clock = fakeClock();
  const limits = createLimits({ now: clock.now, log: () => {} });
  const ip = '10.0.0.2';

  for (let i = 0; i < LIMITS.MAX_CONNECTIONS_PER_IP_PER_MIN; i++) {
    assert.equal(limits.checkNewConnection(ip), null, `connection ${i + 1} should be allowed`);
    limits.trackSocketClose(ip); // do not also trip MAX_SOCKETS_PER_IP - this test is only about the rate
  }
  assert.equal(limits.checkNewConnection('10.0.0.2'), 'too_many_connections');

  clock.advance(61_000); // a fresh minute: the window has fully rolled over
  assert.equal(limits.checkNewConnection('10.0.0.2'), null);
});

// --- min-interval: play and query cadence ---------------------------------------------------

test('play is refused inside PLAY_MIN_INTERVAL_MS and allowed once it has passed', () => {
  const clock = fakeClock();
  const limits = createLimits({ now: clock.now, log: () => {} });

  const first = limits.checkPlayRate('socket-1');
  assert.equal(first.allowed, true);

  clock.advance(LIMITS.PLAY_MIN_INTERVAL_MS - 1);
  const second = limits.checkPlayRate('socket-1');
  assert.equal(second.allowed, false);
  assert.ok(second.retryMs > 0 && second.retryMs <= 1);

  clock.advance(1);
  assert.equal(limits.checkPlayRate('socket-1').allowed, true);
});

test('play budgets are independent per socket', () => {
  const clock = fakeClock();
  const limits = createLimits({ now: clock.now, log: () => {} });
  assert.equal(limits.checkPlayRate('a').allowed, true);
  assert.equal(limits.checkPlayRate('b').allowed, true, "a fresh socket never inherits another socket's budget");
});

test('leaderboard/tasks/get_me each get their own once-a-second budget on the same socket', () => {
  const clock = fakeClock();
  const limits = createLimits({ now: clock.now, log: () => {} });

  assert.equal(limits.checkQueryRate('socket-1', 'leaderboard').allowed, true);
  assert.equal(limits.checkQueryRate('socket-1', 'leaderboard').allowed, false, 'second leaderboard call, same second');
  assert.equal(limits.checkQueryRate('socket-1', 'tasks').allowed, true, 'tasks has its own budget');
  assert.equal(limits.checkQueryRate('socket-1', 'get_me').allowed, true, 'get_me has its own budget');
});

// --- OTP: per-IP and per-email --------------------------------------------------------------

test(`the ${LIMITS.MAX_OTP_REQUESTS_PER_IP_PER_10MIN + 1}th OTP request from one IP in 10 minutes is refused`, () => {
  const clock = fakeClock();
  const limits = createLimits({ now: clock.now, log: () => {} });
  const ip = '10.0.0.3';
  for (let i = 0; i < LIMITS.MAX_OTP_REQUESTS_PER_IP_PER_10MIN; i++) {
    assert.equal(limits.checkOtpIp(ip).allowed, true);
  }
  const refused = limits.checkOtpIp(ip);
  assert.equal(refused.allowed, false);
  assert.ok(refused.retryMs > 0);
});

test(`the ${LIMITS.MAX_OTP_REQUESTS_PER_EMAIL_PER_10MIN + 1}th OTP request for one email in 10 minutes is refused, independent of IP`, () => {
  const clock = fakeClock();
  const limits = createLimits({ now: clock.now, log: () => {} });
  const email = 'player@example.com';
  for (let i = 0; i < LIMITS.MAX_OTP_REQUESTS_PER_EMAIL_PER_10MIN; i++) {
    assert.equal(limits.checkOtpEmail(email).allowed, true);
  }
  assert.equal(limits.checkOtpEmail(email).allowed, false);
});

// --- block list ------------------------------------------------------------------------------

test('an IP that trips the connection limit 5 times in 10 minutes is blocked, then unblocks after BLOCK_DURATION_MS', () => {
  const clock = fakeClock();
  const limits = createLimits({ now: clock.now, log: () => {} });
  const ip = '10.0.0.4';

  // Trip the per-minute connection limit BLOCK_TRIP_COUNT times, each in its own fresh minute
  // so only the connection-rate refusal (not the socket-count one) is what trips the block.
  // No advance after the last trip: that moment is exactly when the block is set, and the
  // timing assertions below measure forward from it.
  for (let trip = 0; trip < LIMITS.BLOCK_TRIP_COUNT; trip++) {
    for (let i = 0; i < LIMITS.MAX_CONNECTIONS_PER_IP_PER_MIN; i++) {
      assert.equal(limits.checkNewConnection(ip), null);
      limits.trackSocketClose(ip);
    }
    assert.equal(limits.checkNewConnection(ip), 'too_many_connections', `trip ${trip + 1}`);
    if (trip < LIMITS.BLOCK_TRIP_COUNT - 1) clock.advance(61_000); // roll the per-minute window over for the next trip
  }

  assert.equal(limits.isBlocked(ip), true, 'BLOCK_TRIP_COUNT trips inside BLOCK_TRIP_WINDOW_MS blocks the IP');
  assert.equal(limits.checkNewConnection(ip), 'blocked');

  clock.advance(LIMITS.BLOCK_DURATION_MS - 1);
  assert.equal(limits.isBlocked(ip), true, 'still blocked just before BLOCK_DURATION_MS elapses');

  clock.advance(1);
  assert.equal(limits.isBlocked(ip), false, 'unblocked once BLOCK_DURATION_MS has fully elapsed');
  assert.equal(limits.checkNewConnection(ip), null);
});

test('blockedIpsCount reflects only IPs currently blocked, not ones that have expired', () => {
  const clock = fakeClock();
  const limits = createLimits({ now: clock.now, log: () => {} });
  assert.equal(limits.blockedIpsCount(), 0);

  for (let trip = 0; trip < LIMITS.BLOCK_TRIP_COUNT; trip++) {
    for (let i = 0; i < LIMITS.MAX_CONNECTIONS_PER_IP_PER_MIN; i++) {
      limits.checkNewConnection('10.0.0.5');
      limits.trackSocketClose('10.0.0.5');
    }
    limits.checkNewConnection('10.0.0.5'); // the one over the limit: this is the trip
    if (trip < LIMITS.BLOCK_TRIP_COUNT - 1) clock.advance(61_000);
  }
  assert.equal(limits.blockedIpsCount(), 1);

  clock.advance(LIMITS.BLOCK_DURATION_MS + 1);
  assert.equal(limits.blockedIpsCount(), 0, 'expired blocks do not count even before the next sweep runs');
});

// --- sweep -------------------------------------------------------------------------------

test('sweep forgets a key once every hit in its window has aged out', () => {
  const clock = fakeClock();
  const limits = createLimits({ now: clock.now, log: () => {} });
  limits.checkOtpIp('10.0.0.6');
  clock.advance(10 * 60 * 1000 + 1);
  limits._sweep();
  // Nothing observable leaks the window's internal Map, so the behavioural proof is that a
  // fresh request right after the sweep gets the full budget again, exactly as it would have
  // without the sweep - this asserts the sweep did not corrupt state, not that it changed it.
  for (let i = 0; i < LIMITS.MAX_OTP_REQUESTS_PER_IP_PER_10MIN; i++) {
    assert.equal(limits.checkOtpIp('10.0.0.6').allowed, true);
  }
});

// --- /status.limits shape ------------------------------------------------------------------

test('stats() reports ips_active, refusals_1m and blocked_ips', () => {
  const clock = fakeClock();
  const limits = createLimits({ now: clock.now, log: () => {} });
  limits.trackSocketOpen('10.0.0.7');
  limits.trackSocketOpen('10.0.0.8');
  const stats = limits.stats();
  assert.deepEqual(Object.keys(stats).sort(), ['blocked_ips', 'ips_active', 'refusals_1m']);
  assert.equal(stats.ips_active, 2);
  assert.equal(stats.blocked_ips, 0);
});

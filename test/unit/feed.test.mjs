// Unit tests for server/feed.js. No network: most of this file drives the feed entirely
// through the _injectTick / _setConnected test hooks with an injected clock and never calls
// start(), so no upstream socket is ever opened. The Finnhub key rotation section near the end
// is the exception: it calls start() against a fake WebSocket (_WebSocket, an EventEmitter
// standing in for `ws`) to exercise connect()'s real handshake-rejection handling - still no
// real socket, no real Finnhub, ever.
// Run: node --test test/unit/feed.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { createFeed } from '../../server/feed.js';

const T0 = 1_700_000_000_000;
const round3 = (p) => Math.round(p * 1000) / 1000; // mirrors server/feed.js's 3-decimal publishing

// metaapiToken/metaapiAccountId default to null (not process.env) so these
// tests are isolated from whatever the box's real environment happens to
// have set; a test enables mt5 explicitly by passing both.
// Deterministic PRNG (mulberry32) so the quiet-market random walk is reproducible in tests.
// A real market lull is Math.random in production; here we seed it to assert exact behaviour.
function seededRandom(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function harness({
  finnhubToken = 'test-token',
  finnhubTokens = [],
  metaapiToken = null,
  metaapiAccountId = null,
  metaapiSymbol,
  mt5BridgeWs = null,
  feedRelayWs = null,
  random = seededRandom(1),
} = {}) {
  let clock = T0;
  const ticks = [];
  const feed = createFeed({
    finnhubToken,
    finnhubTokens,
    metaapiToken,
    metaapiAccountId,
    metaapiSymbol,
    mt5BridgeWs,
    feedRelayWs,
    onTick: (tick) => ticks.push(tick),
    now: () => clock,
    random,
  });
  return {
    feed,
    ticks,
    /** Advance the clock by dt, then inject a raw tick at the new time. */
    inject(id, raw, dt) {
      clock += dt;
      feed._injectTick(id, raw, clock);
    },
    advance(dt) {
      clock += dt;
    },
  };
}

// --- first tick ------------------------------------------------------------

test('first tick is published with offset 0, rounded to 3 decimals', () => {
  const h = harness({ finnhubToken: null });
  h.inject('okx', 4355.678, 0);
  assert.equal(h.ticks.length, 1);
  assert.equal(h.ticks[0].price, 4355.678);
  assert.equal(h.ticks[0].t, T0);
  assert.equal(h.ticks[0].quiet, false);
});

test('the published tick payload carries no source name (client rule)', () => {
  const h = harness();
  h.inject('finnhub', 4355, 0);
  assert.deepEqual(Object.keys(h.ticks[0]).sort(), ['price', 'quiet', 't']);
  assert.equal('source' in h.ticks[0], false);
});

// --- priority and active source ---------------------------------------------

test('the highest-priority fresh source wins: lower sources never publish', () => {
  const h = harness();
  h.inject('finnhub', 4355.0, 0);
  h.inject('finnhub', 4355.1, 1000);
  h.inject('okx', 4349.0, 500);
  h.inject('binance', 4348.0, 500);
  assert.equal(h.ticks.length, 2, 'only the two finnhub ticks are published');
  assert.equal(h.ticks[1].price, 4355.1);
  const st = h.feed.status();
  assert.equal(st.okx.raw, 4349.0, 'non-active sources still update raw state');
  assert.equal(st.okx.lastTickAt, T0 + 1500);
  assert.equal(st.binance.raw, 4348.0);
  assert.equal(h.feed.latest().source, 'finnhub');
});

test('demotion happens only after 10 s of silence', () => {
  const h = harness();
  h.inject('finnhub', 4355.0, 0);
  h.inject('okx', 4349.0, 9999); // finnhub silent 9.999 s: still active
  assert.equal(h.ticks.length, 1);
  h.inject('okx', 4349.5, 1); // exactly 10 s: still within the window
  assert.equal(h.ticks.length, 1);
  h.inject('okx', 4349.5, 501); // 10.501 s of silence: demoted, okx takes over
  assert.equal(h.ticks.length, 2);
  assert.equal(h.feed.latest().source, 'okx');
});

// --- continuity of the ONE published series ----------------------------------

test('published value is unchanged at a switch tick (finnhub -> okx)', () => {
  const h = harness();
  h.inject('finnhub', 4355.0, 0);
  h.inject('okx', 4349.0, 10500); // finnhub stale -> switch, okx offset anchors to 4355
  assert.equal(h.ticks.length, 2);
  assert.equal(h.ticks[1].price, 4355.0, 'no jump at the switch');
  assert.equal(h.ticks[1].t, T0 + 10500);
  h.inject('okx', 4349.1, 500); // subsequent okx movement carries through the offset
  assert.equal(h.ticks[2].price, 4355.1);
});

test('published value is unchanged switching back (okx -> finnhub)', () => {
  const h = harness();
  h.inject('finnhub', 4355.0, 0);
  h.inject('okx', 4349.0, 10500); // switch to okx, published 4355.0
  h.inject('okx', 4349.1, 500); // published 4355.1
  h.inject('finnhub', 4360.0, 100); // finnhub fresh again -> switch back
  assert.equal(h.ticks.at(-1).price, 4355.1, 'no jump switching back');
  assert.equal(h.feed.latest().source, 'finnhub');
  h.inject('finnhub', 4360.25, 100); // new offset -4.9 carries through
  assert.equal(h.ticks.at(-1).price, 4355.35);
});

test('offset persists across multiple switches with no jump anywhere', () => {
  const h = harness({ finnhubToken: null });
  h.inject('binance', 4348.0, 0);
  h.inject('okx', 4340.0, 100); // okx priority beats binance: switch, okx offset 8
  assert.equal(h.ticks.at(-1).price, 4348.0);
  h.inject('binance', 4350.0, 10500); // okx stale -> binance, offset -2
  assert.equal(h.ticks.at(-1).price, 4348.0);
  h.inject('okx', 4339.0, 200); // okx fresh again -> switch back, offset 9
  assert.equal(h.ticks.at(-1).price, 4348.0);
  assert.deepEqual(
    h.ticks.map((t) => t.price),
    [4348, 4348, 4348, 4348],
  );
});

// --- quiet flag ---------------------------------------------------------------

test('latest() is quiet only after 3 s with no published tick', () => {
  const h = harness({ finnhubToken: null });
  h.inject('okx', 4355, 0);
  assert.equal(h.feed.latest().quiet, false);
  h.advance(2999);
  assert.equal(h.feed.latest().quiet, false);
  h.advance(2);
  assert.equal(h.feed.latest().quiet, true);
});

test('quiet reflects the active source, not lower-priority ticks', () => {
  const h = harness();
  h.inject('finnhub', 4355, 0);
  h.inject('okx', 4349, 1000); // okx ticks, but finnhub is still the active source
  h.advance(2600);
  assert.equal(h.feed.latest().quiet, true, 'finnhub (active) has not ticked in 3.6 s');
  assert.equal(h.feed.latest().source, 'finnhub');
});

// --- quiet-market simulation --------------------------------------------------
// Off-hours the upstream keeps sending frequent ticks at the SAME price. Quiet is keyed on price
// MOVEMENT, not arrival, so the feed synthesizes a gentle walk around the last real price and the
// chart stays playable. The synthetic series is server-side only: rounds still settle on
// feed.latest(), which is the synthesized price, so the client can never influence it.

test('a flat upstream (same price repeated) goes quiet by movement and the series starts moving', () => {
  const h = harness();
  h.inject('finnhub', 4355, 0); // first real tick, anchor 4355
  // Same price every 200 ms. quiet is not arrival-based, so it must not stay live forever.
  for (let i = 0; i < 40; i++) h.inject('finnhub', 4355, 200);

  const synth = h.ticks.filter((t) => t.quiet);
  assert.ok(synth.length > 0, 'the market is reported quiet after ~3 s of a still price');
  // While within QUIET_MS of the last change the ticks are still flat and live.
  assert.equal(h.ticks[0].quiet, false);
  assert.equal(h.ticks[0].price, 4355);

  // The synthetic series actually moves - not every published price is 4355.
  const distinct = new Set(synth.map((t) => t.price));
  assert.ok(distinct.size > 1, 'the synthetic series is not flat');

  // ...and stays anchored: every synthetic price is within the amplitude of the real price.
  for (const t of synth) {
    assert.ok(Math.abs(t.price - 4355) <= 0.35 + 1e-9, `synthetic price ${t.price} drifted past the amplitude`);
  }

  // feed.latest() (what rounds.js reads to open and settle) is the moving, quiet price.
  const p = h.feed.latest();
  assert.equal(p.quiet, true);
  assert.equal(p.source, 'finnhub', 'still the real active source, no fabricated source name');
  assert.equal(p.price, h.ticks.at(-1).price, 'latest() is the last synthetic tick, not the raw upstream price');
});

test('the quiet flag is movement-based: a moving upstream never synthesizes', () => {
  const h = harness();
  let raw = 4355;
  for (let i = 0; i < 40; i++) {
    raw = round3(raw + 0.02); // a genuinely moving market, one real tick every 200 ms
    h.inject('finnhub', raw, 200);
  }
  assert.ok(
    h.ticks.every((t) => t.quiet === false),
    'a moving real price is never reported quiet',
  );
  // No synthetic drift: the published series is exactly the real series (offset 0 here).
  assert.equal(h.ticks.at(-1).price, raw);
  assert.equal(h.feed.latest().quiet, false);
});

test('when the real price moves again the real series resumes smoothly with no jump', () => {
  const h = harness();
  h.inject('finnhub', 4355, 0);
  for (let i = 0; i < 40; i++) h.inject('finnhub', 4355, 200); // go quiet and synthesize
  assert.equal(h.feed.latest().quiet, true);
  const lastSynth = h.ticks.at(-1).price;

  // The market wakes up: a real move of +0.20. The first real tick must not jump away from the
  // last synthetic value by more than the real move itself (the drift decays out, it does not snap).
  h.inject('finnhub', 4355.2, 200);
  const firstReal = h.ticks.at(-1);
  assert.equal(firstReal.quiet, false, 'a real move ends the quiet spell immediately');
  const step = Math.abs(firstReal.price - lastSynth);
  assert.ok(step <= 0.2 + 0.35 + 1e-9, `resume jump ${step} exceeds the real move plus the bounded residual`);

  // Keep moving; the residual glides out and the series converges onto the true real level.
  let raw = 4355.2;
  for (let i = 0; i < 30; i++) {
    raw = round3(raw + 0.05);
    h.inject('finnhub', raw, 200);
  }
  assert.equal(h.ticks.at(-1).quiet, false);
  assert.equal(h.ticks.at(-1).price, raw, 'no residual drift remains: published equals the real price');
});

test('quiet synthesis is gated on !idle so the idle re-anchor is never fought', () => {
  const h = harness();
  h.inject('finnhub', 4355, 0);
  h.feed.setIdle(true); // idle: the re-anchor owns the series, no synthesis
  for (let i = 0; i < 40; i++) h.inject('finnhub', 4355, 200);
  // offset is already 0 (finnhub was the first and only source), so idle re-anchor holds it flat.
  assert.ok(
    h.ticks.every((t) => t.price === 4355),
    'no synthetic movement while idle',
  );
  // The market is still reported quiet - it genuinely is - even though nothing is synthesized.
  assert.equal(h.feed.latest().quiet, true);
});

// --- re-anchor ----------------------------------------------------------------

test('idle re-anchor slides whichever source is active back to raw, bounded by 0.05 per tick (not just Finnhub)', () => {
  const h = harness();
  h.inject('finnhub', 4357, 0); // first tick: published 4357, offset 0
  h.inject('okx', 4349, 10600); // finnhub stale -> okx active, offset 8
  assert.equal(h.ticks.at(-1).price, 4357);

  h.feed.setIdle(true);
  h.inject('okx', 4349, 500); // idle, okx active, not a switch tick: offset decays 8 -> 7.95
  assert.equal(h.ticks.at(-1).price, 4356.95, 'okx decays too now, not just Finnhub');

  h.feed.setIdle(false);
  h.inject('okx', 4349, 500); // not idle: the offset is frozen
  assert.equal(h.ticks.at(-1).price, 4356.95);

  h.feed.setIdle(true);
  h.inject('finnhub', 4356, 500); // finnhub fresh -> switch back, offset 0.95; no decay on the switch tick
  assert.equal(h.ticks.at(-1).price, 4356.95);

  h.inject('finnhub', 4356, 500); // idle + finnhub active: offset 0.95 -> 0.9
  assert.equal(h.ticks.at(-1).price, 4356.9);

  let prev = 4356.9; // offset is positive, so the level slides DOWN to raw
  for (let i = 0; i < 20; i++) {
    h.inject('finnhub', 4356, 500);
    const p = h.ticks.at(-1).price;
    assert.ok(p <= prev + 1e-9, 'slides monotonically toward the true level');
    assert.ok(prev - p <= 0.05 + 1e-9, `step exceeds 0.05: ${prev} -> ${p}`);
    assert.ok(p >= 4356 - 1e-9, 'never overshoots the true level');
    prev = p;
  }
  assert.equal(prev, 4356, 'converges to true XAU');
});

test('the final decay step clamps at raw and never overshoots', () => {
  const h = harness();
  h.inject('okx', 4350, 0); // okx active first
  h.inject('okx', 4350, 100);
  h.inject('finnhub', 4356.02, 200); // finnhub takes over: offset -6.02, not a multiple of 0.05
  assert.equal(h.ticks.at(-1).price, 4350);
  h.feed.setIdle(true);
  let prev = 4350;
  for (let i = 0; i < 130; i++) {
    h.inject('finnhub', 4356.02, 500);
    const p = h.ticks.at(-1).price;
    assert.ok(p <= 4356.02 + 1e-9, 'never overshoots the true level');
    assert.ok(p >= prev - 1e-9, 'monotonic toward raw');
    assert.ok(p - prev <= 0.05 + 1e-9, `step exceeds 0.05: ${prev} -> ${p}`);
    prev = p;
  }
  assert.equal(prev, 4356.02, 'lands exactly on raw and stays');
});

// --- validation ---------------------------------------------------------------

test('invalid prices are dropped and never update source state', () => {
  const h = harness({ finnhubToken: null });
  for (const bad of [NaN, Infinity, -Infinity, 0, -5, 100, 100000, 1e9, '4355', null, undefined]) {
    h.inject('okx', bad, 1000);
  }
  assert.equal(h.ticks.length, 0);
  assert.equal(h.feed.latest(), null);
  const st = h.feed.status();
  assert.equal(st.okx.raw, null);
  assert.equal(st.okx.lastTickAt, null);
  h.inject('okx', 4355, 1000); // still usable afterwards
  assert.equal(h.ticks.length, 1);
  assert.equal(h.ticks[0].price, 4355);
});

test('invalid ticks do not keep a source fresh', () => {
  const h = harness();
  h.inject('finnhub', 4355, 0);
  h.inject('finnhub', NaN, 9999); // garbage must not extend finnhub's freshness
  h.inject('okx', 4349, 500); // finnhub's last VALID tick is now 10.499 s old
  assert.equal(h.ticks.length, 2, 'okx takes over because finnhub is stale');
  assert.equal(h.ticks.at(-1).price, 4355, 'still no jump at the switch');
  assert.equal(h.feed.latest().source, 'okx');
});

// --- mt5 source (priority 0) --------------------------------------------------
// mt5 only exists in status()/ingest() when both metaapiToken and
// metaapiAccountId are given (docs/mt5-feed.md); it is driven through the
// same _injectTick hook as every other source, no network involved.

function mt5Harness(opts = {}) {
  return harness({ metaapiToken: 'test-metaapi-token', metaapiAccountId: 'test-account-id', ...opts });
}

test('mt5 exists in status() only when both metaapiToken and metaapiAccountId are set', () => {
  const bare = harness();
  assert.deepEqual(Object.keys(bare.feed.status()), ['finnhub', 'okx', 'binance']);

  const tokenOnly = harness({ metaapiToken: 'tok' });
  assert.deepEqual(Object.keys(tokenOnly.feed.status()), ['finnhub', 'okx', 'binance'], 'account id missing: no mt5');

  const h = mt5Harness();
  assert.deepEqual(Object.keys(h.feed.status()), ['mt5', 'finnhub', 'okx', 'binance'], 'mt5 is priority 0');
});

// --- mt5 bridge route (server/feed-mt5-bridge.js), review b15-review.md #10 ---
// mt5BridgeWs is the alternative to MetaApi (docs/mt5-feed.md "Bridge route"):
// same mt5 source id and priority, wired through sourceDefs()'s else-if
// branch instead of the metaapiToken+metaapiAccountId branch above.

test('mt5BridgeWs alone produces an mt5 source at priority 0', () => {
  const h = harness({ mt5BridgeWs: 'ws://mt5:8765' });
  assert.deepEqual(h.feed.status(), {
    mt5: { connected: false, lastTickAt: null, raw: null },
    finnhub: { connected: false, lastTickAt: null, raw: null, keyIndex: 0, keyCount: 1 },
    okx: { connected: false, lastTickAt: null, raw: null },
    binance: { connected: false, lastTickAt: null, raw: null },
  });
  h.inject('mt5', 4360.0, 0);
  assert.equal(h.ticks.length, 1);
  assert.equal(h.feed.latest().source, 'mt5');
});

test('MetaApi wins when both metaapiToken/metaapiAccountId and mt5BridgeWs are configured', () => {
  const h = harness({ metaapiToken: 'tok', metaapiAccountId: 'acct', mt5BridgeWs: 'ws://mt5:8765' });
  assert.deepEqual(Object.keys(h.feed.status()), ['mt5', 'finnhub', 'okx', 'binance'], 'still exactly one mt5 source');
  // Not directly observable which adapter backs it from status() alone (by design - the
  // client and the operator health endpoint never know); sourceDefs() precedence is
  // exercised properly by createMt5Source vs createMt5BridgeSource each owning distinct
  // modules, so this only re-confirms the id/priority contract is unaffected either way.
  h.inject('mt5', 4360.0, 0);
  assert.equal(h.ticks.length, 1);
  assert.equal(h.feed.latest().source, 'mt5');
});

test('mt5BridgeWs runs through ingest() identically to MetaApi: priority, demotion, continuity', () => {
  const h = harness({ mt5BridgeWs: 'ws://mt5:8765' });
  h.inject('mt5', 4360.0, 0);
  h.inject('finnhub', 4358.0, 100); // finnhub ticks too, but mt5 is priority 0: never published
  assert.equal(h.ticks.length, 1);
  h.inject('finnhub', 4358.1, 10500); // mt5 stale > 10s -> finnhub takes over, no jump
  assert.equal(h.ticks.length, 2);
  assert.equal(h.ticks.at(-1).price, 4360.0);
  assert.equal(h.feed.latest().source, 'finnhub');
  h.inject('mt5', 4362.0, 100); // mt5 fresh again -> switches back, offset anchors, no jump
  assert.equal(h.ticks.at(-1).price, 4360.0);
  assert.equal(h.feed.latest().source, 'mt5');
  h.inject('mt5', 4362.5, 100); // subsequent mt5 movement carries through the offset
  assert.equal(h.ticks.at(-1).price, 4360.5);
});

test('mt5 outranks finnhub when both are fresh', () => {
  const h = mt5Harness();
  h.inject('mt5', 4356.789, 0); // mt5 ticks first: baseline, offset 0
  h.inject('finnhub', 4358.0, 100); // finnhub ticks too, but mt5 is priority 0: never published
  h.inject('mt5', 4357.0, 100); // mt5 ticks again: still the active source
  assert.equal(h.ticks.length, 2, 'only the two mt5 ticks are published');
  assert.equal(h.ticks.at(-1).price, 4357.0);
  assert.equal(h.feed.status().finnhub.raw, 4358.0, 'finnhub raw still updates while it is not active');
  assert.equal(h.feed.latest().source, 'mt5');
});

test('demotion after 10 s of mt5 silence hands over to finnhub, continuous', () => {
  const h = mt5Harness();
  h.inject('mt5', 4360.0, 0);
  h.inject('finnhub', 4358.0, 9999); // mt5 silent 9.999 s: still active
  assert.equal(h.ticks.length, 1);
  h.inject('finnhub', 4358.1, 501); // 10.5 s of mt5 silence: demoted, finnhub takes over
  assert.equal(h.ticks.length, 2);
  assert.equal(h.ticks.at(-1).price, 4360.0, 'no jump at the switch');
  assert.equal(h.feed.latest().source, 'finnhub');
  h.inject('finnhub', 4358.3, 500); // finnhub movement carries the anchored offset
  assert.equal(h.ticks.at(-1).price, 4360.2);
});

test('switching back to mt5 after demotion is continuous', () => {
  const h = mt5Harness();
  h.inject('mt5', 4360.0, 0);
  h.inject('finnhub', 4358.0, 10500); // mt5 stale -> finnhub active, published stays 4360.0
  assert.equal(h.ticks.at(-1).price, 4360.0);
  h.inject('mt5', 4362.0, 100); // mt5 fresh again -> switches back, offset anchors to 4360.0
  assert.equal(h.ticks.at(-1).price, 4360.0, 'no jump switching back to mt5');
  assert.equal(h.feed.latest().source, 'mt5');
  h.inject('mt5', 4362.5, 100); // subsequent mt5 movement carries through the offset
  assert.equal(h.ticks.at(-1).price, 4360.5);
});

test('invalid mt5 prices are dropped and never update source state or freshness', () => {
  const h = mt5Harness();
  for (const bad of [NaN, Infinity, -Infinity, 0, -5, 100, 100000, 1e9, '4355', null, undefined]) {
    h.inject('mt5', bad, 1000);
  }
  assert.equal(h.ticks.length, 0);
  const st = h.feed.status();
  assert.equal(st.mt5.raw, null);
  assert.equal(st.mt5.lastTickAt, null);
  h.inject('mt5', 4360, 1000); // still usable afterwards
  assert.equal(h.ticks.length, 1);
  assert.equal(h.ticks[0].price, 4360);
});

// --- mt5 is the source of truth: it never carries an offset (the ticket bug) ---
// server/feed.js published raw + offset[active]; on a switch the incoming source was anchored
// to the last published value so the level never jumps. The decay that was supposed to correct
// that anchor back to 0 only ever fired for Finnhub, so mt5 - the broker's own feed, the one
// source that must always be truth - could stay anchored to a stand-in's wrong level forever.
// That is exactly what happened: gold closed for the weekend, a crypto price carried the app,
// and when the broker reconnected Monday it stayed anchored ~$7 below its own raw price with no
// path back to correct. These tests drive that scenario and assert it self-heals.

test('mt5 becoming active while idle publishes its raw price immediately - no offset inherited, not even for one tick', () => {
  const h = mt5Harness();
  h.inject('okx', 4345.0, 0); // a stand-in carries the price (mt5, finnhub both down)
  h.feed.setIdle(true); // nobody is mid-round
  h.inject('mt5', 4352.396, 500); // the broker feed returns
  assert.equal(h.ticks.at(-1).price, 4352.396, 'published equals raw immediately, not anchored to the stand-in level');
  assert.equal(h.feed.latest().source, 'mt5');
});

test('mt5 returning mid-round still anchors like a stand-in (no jump), then snaps to raw the moment it is safe', () => {
  const h = mt5Harness();
  h.inject('okx', 4345.225, 0); // a stand-in carries a wrong level
  h.inject('mt5', 4352.164, 500); // broker returns mid-round (not idle): anchored, no jump
  assert.equal(h.ticks.at(-1).price, 4345.225, 'no jump - a round in flight is not distorted');
  assert.equal(h.feed.latest().source, 'mt5');

  h.inject('mt5', 4352.396, 100); // still not idle: the inherited offset carries through unchanged
  assert.equal(h.ticks.at(-1).price, 4345.457, 'round3(4352.396 + (-6.939))');

  h.feed.setIdle(true); // the round ends and nothing else starts within 2 s
  h.inject('mt5', 4352.5, 500); // correction fires now, in one step, not gradually
  assert.equal(h.ticks.at(-1).price, 4352.5, 'the stuck offset is gone in one tick, matching raw exactly');
});

test('regression: the Monday-open bug - broker returns after a weekend stand-in, the offset does not stick', () => {
  const h = mt5Harness();
  // Weekend: mt5 and Finnhub are both down, a crypto price several dollars off carries the app.
  h.inject('binance', 4338.0, 0);
  h.feed.setIdle(true);
  for (let i = 0; i < 5; i++) h.inject('binance', 4338.0, 1000); // idle all weekend, no round anywhere

  // Market reopens: the broker feed reconnects while the game is still idle.
  h.inject('mt5', 4352.164, 1000);
  assert.equal(h.ticks.at(-1).price, 4352.164, 'published raw immediately, not anchored to the stale crypto level');

  h.inject('mt5', 4352.2, 1000); // keeps ticking: must not drift back off raw
  assert.equal(h.ticks.at(-1).price, 4352.2);

  h.feed.setIdle(false); // a player starts a round
  h.inject('mt5', 4352.5, 1000);
  assert.equal(h.ticks.at(-1).price, 4352.5, 'still exactly raw - there was never an offset left to correct');
});

// --- status(), lifecycle guards, test hooks ---------------------------------

test('status() reports per-source connected/lastTickAt/raw and _setConnected drives it', () => {
  const h = harness();
  assert.equal(h.feed.latest(), null);
  assert.deepEqual(Object.keys(h.feed.status()), ['finnhub', 'okx', 'binance'], 'priority order');
  assert.deepEqual(h.feed.status().okx, { connected: false, lastTickAt: null, raw: null });
  h.feed._setConnected('okx', true);
  assert.equal(h.feed.status().okx.connected, true);
  h.feed._setConnected('okx', false);
  assert.equal(h.feed.status().okx.connected, false);
});

test('unknown sources cannot be injected or connected', () => {
  const h = harness();
  h.feed._injectTick('nope', 4355, T0);
  h.feed._setConnected('nope', true);
  assert.equal(h.ticks.length, 0);
  assert.equal(h.feed.latest(), null);
  assert.equal('nope' in h.feed.status(), false);
});

test('no finnhub token means no finnhub source at all', () => {
  const h = harness({ finnhubToken: null });
  assert.deepEqual(Object.keys(h.feed.status()), ['okx', 'binance']);
  h.inject('finnhub', 4355, 0);
  assert.equal(h.ticks.length, 0, 'an unconfigured finnhub tick is ignored');
  h.inject('okx', 4349, 100);
  assert.equal(h.ticks.length, 1);
});

test('stop() is safe before start and idempotent without any socket activity', () => {
  // start() opens real upstream sockets, so it is not exercised here;
  // stop() alone must never throw and must leave the feed usable for tests.
  const h = harness();
  h.feed.stop();
  h.feed.stop();
  h.inject('okx', 4355, 0);
  assert.equal(h.ticks.length, 1);
});

test('FEED_RELAY_WS replaces the direct Finnhub socket with the relay at the same tier', () => {
  const h = harness({ finnhubToken: null, feedRelayWs: 'ws://relay.test/ws' });
  assert.deepEqual(Object.keys(h.feed.status()), ['finnhub', 'okx', 'binance'], 'relay stands in as the finnhub tier');
  h.feed._injectTick('finnhub', 4300.5, T0);
  assert.equal(h.ticks.length, 1);
  assert.equal(h.feed.latest().source, 'finnhub');
});

test('FEED_RELAY_WS wins over a Finnhub token: one socket per key, held by the relay', () => {
  const h = harness({ finnhubToken: 'test-token', feedRelayWs: 'ws://relay.test/ws' });
  assert.deepEqual(Object.keys(h.feed.status()), ['finnhub', 'okx', 'binance'], 'exactly one finnhub tier');
});

// --- Finnhub key rotation (connect()'s ws.on('error', ...), server/feed.js) -----------------
// A fake WebSocket (a plain EventEmitter) stands in for `ws`, so these drive the exact events
// `ws` itself emits (verified against node_modules/ws/lib/websocket.js: a rejected handshake is
// an 'error' with message "Unexpected server response: <code>", nothing else) without opening
// any socket, real or fake-network. feed.start() is called - the only tests in this file that do.

class FakeWebSocket extends EventEmitter {
  constructor(url) {
    super();
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  send() {}
  close() {}
}

function finnhubSockets() {
  return FakeWebSocket.instances.filter((s) => s.url.startsWith('wss://ws.finnhub.io'));
}

function rotationHarness({ finnhubTokens, finnhubToken } = {}) {
  FakeWebSocket.instances = [];
  const ticks = [];
  const feed = createFeed({
    finnhubToken,
    finnhubTokens,
    onTick: (t) => ticks.push(t),
    _WebSocket: FakeWebSocket,
  });
  return { feed, ticks };
}

test('a 429 (handshake rejection) advances to the next key, then reconnects on it after the existing backoff', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = rotationHarness({ finnhubTokens: ['key-a', 'key-b'] });
  h.feed.start();

  assert.equal(finnhubSockets().length, 1);
  assert.equal(finnhubSockets()[0].url, 'wss://ws.finnhub.io?token=key-a');
  assert.deepEqual(h.feed.status().finnhub, {
    connected: false,
    lastTickAt: null,
    raw: null,
    keyIndex: 0,
    keyCount: 2,
  });

  finnhubSockets()[0].emit('error', new Error('Unexpected server response: 429'));
  assert.equal(
    h.feed.status().finnhub.keyIndex,
    1,
    'advances past the refused key immediately, before the socket even closes',
  );
  finnhubSockets()[0].emit('close');

  // No key was ever opened, so this is the first-ever failure: attempt 1, delay 1000 * 2**1 = 2000ms
  // (server/feed.js retry()) - the same schedule any other source's first failure gets.
  t.mock.timers.tick(1999);
  assert.equal(finnhubSockets().length, 1, 'does not reconnect before the backoff elapses');
  t.mock.timers.tick(1);
  assert.equal(finnhubSockets().length, 2, 'reconnects once the backoff elapses');
  assert.equal(finnhubSockets()[1].url, 'wss://ws.finnhub.io?token=key-b', 'reconnects using the next key');

  h.feed.stop();
});

test('an unrelated socket error does not advance the key: same key, same backoff, retried in place', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = rotationHarness({ finnhubTokens: ['key-a', 'key-b'] });
  h.feed.start();

  finnhubSockets()[0].emit('error', new Error('connect ECONNREFUSED 1.2.3.4:443'));
  assert.equal(h.feed.status().finnhub.keyIndex, 0, 'a network error is not a key refusal');
  finnhubSockets()[0].emit('close');

  t.mock.timers.tick(2000);
  assert.equal(finnhubSockets().length, 2);
  assert.equal(finnhubSockets()[1].url, 'wss://ws.finnhub.io?token=key-a', 'retries the same key, not the next one');

  h.feed.stop();
});

test('the key list cycles: after every key is refused it comes back round instead of giving up', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = rotationHarness({ finnhubTokens: ['key-a', 'key-b', 'key-c'] });
  h.feed.start();

  let delay = 2000; // first failure is attempt 1: 1000 * 2**1
  for (let i = 0; i < 3; i++) {
    const sock = finnhubSockets().at(-1);
    sock.emit('error', new Error('Unexpected server response: 429'));
    sock.emit('close');
    t.mock.timers.tick(delay);
    delay *= 2; // retry()'s backoff doubles each attempt (capped at 30 s, never reached here)
  }

  assert.equal(finnhubSockets().length, 4, 'one initial connection plus three reconnects');
  assert.deepEqual(
    finnhubSockets().map((s) => s.url),
    [
      'wss://ws.finnhub.io?token=key-a',
      'wss://ws.finnhub.io?token=key-b',
      'wss://ws.finnhub.io?token=key-c',
      'wss://ws.finnhub.io?token=key-a', // wrapped
    ],
  );
  assert.equal(h.feed.status().finnhub.keyIndex, 0);

  h.feed.stop();
});

test('all keys refused: finnhub never ticks, but okx (lower priority) still serves a price', () => {
  // Pure ingest-pipeline check, no sockets needed: a finnhub source that is configured but has
  // never ticked (exactly what "every key refused" looks like from ingest()'s perspective, since
  // a refused handshake never reaches onTick) is indistinguishable from one that is still
  // connecting - pickActive() only ever looks at lastTickAt, so the fallback picks up exactly as
  // it does today. This is the same degrade path as an unconfigured Finnhub (see the "no finnhub
  // token" test above), reached here through the rotation feature's failure mode instead.
  const h = harness({ finnhubToken: null, finnhubTokens: ['key-a', 'key-b', 'key-c'] });
  assert.deepEqual(Object.keys(h.feed.status()), ['finnhub', 'okx', 'binance']);
  h.inject('okx', 4349.0, 0);
  assert.equal(h.ticks.length, 1);
  assert.equal(h.feed.latest().source, 'okx', 'the game keeps running on the fallback');
  assert.equal(h.feed.status().finnhub.connected, false);
  assert.equal(
    h.feed.status().finnhub.lastTickAt,
    null,
    'finnhub never ticked - exactly what "every key refused" looks like',
  );
});

test('no key material reaches status() or a log line, only the key index and count', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const warnCalls = [];
  t.mock.method(console, 'warn', (...args) => {
    warnCalls.push(args.map(String).join(' '));
  });

  const h = rotationHarness({ finnhubTokens: ['top-secret-key-a', 'top-secret-key-b'] });
  h.feed.start();

  finnhubSockets()[0].emit('error', new Error('Unexpected server response: 429'));
  finnhubSockets()[0].emit('close');
  t.mock.timers.tick(2000);
  finnhubSockets().at(-1).emit('error', new Error('Unexpected server response: 401'));
  finnhubSockets().at(-1).emit('close');
  t.mock.timers.tick(4000);

  const statusJson = JSON.stringify(h.feed.status());
  assert.ok(!statusJson.includes('top-secret-key'), 'status() carries no key material');

  const logged = warnCalls.join('\n');
  assert.ok(!logged.includes('top-secret-key'), 'no log line carries a key, not even truncated');
  assert.ok(logged.includes('key 0 refused'), 'the log still names which index was refused');
  assert.ok(logged.includes('key 1 refused'), 'and the second refusal too');

  h.feed.stop();
});

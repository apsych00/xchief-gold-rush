// Unit tests for server/alerts.js (ticket T1): the event catalogue, the Telegram payload
// shape, and the integration with server/limits.js for the block-list alert.
//
// Run: node --test test/unit/alerts.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { createAlerts, ALERT_CATALOGUE } = await import('../../server/alerts.js');

function fakeClock(start = 1_800_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms), value: () => t };
}

function fakeFetch() {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return { ok: true };
  };
  return { fetch: fn, calls };
}

function callText(call) {
  const body = call.init.body;
  if (body instanceof URLSearchParams) return body.get('text') || '';
  if (typeof body === 'string') {
    try {
      return JSON.parse(body).text || '';
    } catch {
      return body;
    }
  }
  return '';
}

// --- catalogue -----------------------------------------------------------------------------

test('every catalogue event has code, severity, message and recommendation', () => {
  for (const [key, entry] of Object.entries(ALERT_CATALOGUE)) {
    assert.equal(entry.code, key, 'code must match the catalogue key');
    const severity = typeof entry.severity === 'function' ? entry.severity({ level: 'guarded' }) : entry.severity;
    assert.ok(['info', 'warn', 'critical'].includes(severity), `${key} has a valid severity`);
    assert.ok(entry.message, `${key} has a message`);
    assert.ok(
      typeof entry.message === 'function' || typeof entry.message === 'string',
      `${key} message is a function or string`,
    );
    assert.ok(entry.recommendation !== undefined, `${key} has a recommendation field`);
  }
});

test('safe_mode_changed severity is warn for guarded and critical for locked', () => {
  const entry = ALERT_CATALOGUE.safe_mode_changed;
  assert.equal(typeof entry.severity, 'function');
  assert.equal(entry.severity({ level: 'guarded' }), 'warn');
  assert.equal(entry.severity({ level: 'locked' }), 'critical');
  assert.equal(entry.severity({ level: 'normal' }), 'warn');
});

// --- Telegram payload shape ----------------------------------------------------------------

test('telegram alert is sent with parse_mode HTML and disable_web_page_preview', async () => {
  const originalToken = process.env.TELEGRAM_BOT_TOKEN;
  const originalChat = process.env.TELEGRAM_CHAT_ID;
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  process.env.TELEGRAM_CHAT_ID = '-123';

  const { fetch, calls } = fakeFetch();
  const alerts = createAlerts({ fetch, log: () => {} });
  await alerts.fireEvent('server_started');

  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.ok(call.url.includes('/bottest-token/sendMessage'), 'url contains the bot token path');
  assert.ok(call.init.body instanceof URLSearchParams, 'body is URLSearchParams');
  assert.equal(call.init.body.get('chat_id'), '-123');
  assert.equal(call.init.body.get('parse_mode'), 'HTML');
  assert.equal(call.init.body.get('disable_web_page_preview'), 'true');
  assert.ok(call.init.body.get('text').includes('<b>[info] Gold Rush</b>'), 'text uses HTML bold');

  if (originalToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = originalToken;
  if (originalChat === undefined) delete process.env.TELEGRAM_CHAT_ID;
  else process.env.TELEGRAM_CHAT_ID = originalChat;
});

test('telegram message omits the Do line when the event has no recommendation', async () => {
  const originalToken = process.env.TELEGRAM_BOT_TOKEN;
  const originalChat = process.env.TELEGRAM_CHAT_ID;
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  process.env.TELEGRAM_CHAT_ID = '-123';

  const { fetch, calls } = fakeFetch();
  const alerts = createAlerts({ fetch, log: () => {} });
  await alerts.fireEvent('feed_recovered');

  const text = calls[0].init.body.get('text');
  assert.ok(!text.includes('Do:'), 'no recommendation line for events with none');
  assert.ok(text.includes('Price feed recovered'));

  if (originalToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = originalToken;
  if (originalChat === undefined) delete process.env.TELEGRAM_CHAT_ID;
  else process.env.TELEGRAM_CHAT_ID = originalChat;
});

test('telegram message includes the recommendation line when the event has one', async () => {
  const originalToken = process.env.TELEGRAM_BOT_TOKEN;
  const originalChat = process.env.TELEGRAM_CHAT_ID;
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  process.env.TELEGRAM_CHAT_ID = '-123';

  const { fetch, calls } = fakeFetch();
  const alerts = createAlerts({ fetch, log: () => {} });
  await alerts.fireEvent('coupons_exhausted');

  const text = calls[0].init.body.get('text');
  assert.ok(text.includes('<i>Do:</i>'), 'recommendation line is present');
  assert.ok(text.includes('Kiosks now show the out-of-codes screen'));

  if (originalToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = originalToken;
  if (originalChat === undefined) delete process.env.TELEGRAM_CHAT_ID;
  else process.env.TELEGRAM_CHAT_ID = originalChat;
});

// --- webhook + Telegram together -----------------------------------------------------------

test('both webhook and telegram fire when both are configured', async () => {
  const originalWebhook = process.env.ALERT_WEBHOOK_URL;
  const originalToken = process.env.TELEGRAM_BOT_TOKEN;
  const originalChat = process.env.TELEGRAM_CHAT_ID;
  process.env.ALERT_WEBHOOK_URL = 'https://hooks.example.com/goldrush';
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  process.env.TELEGRAM_CHAT_ID = '-123';

  const { fetch, calls } = fakeFetch();
  const alerts = createAlerts({ fetch, log: () => {} });
  await alerts.fireEvent('deploy_done', { sha: 'a1b2c3d' });

  assert.equal(calls.length, 2);
  const urls = calls.map((c) => c.url);
  assert.ok(
    urls.some((u) => u.includes('hooks.example.com')),
    'webhook was called',
  );
  assert.ok(
    urls.some((u) => u.includes('telegram.org')),
    'telegram was called',
  );

  if (originalWebhook === undefined) delete process.env.ALERT_WEBHOOK_URL;
  else process.env.ALERT_WEBHOOK_URL = originalWebhook;
  if (originalToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = originalToken;
  if (originalChat === undefined) delete process.env.TELEGRAM_CHAT_ID;
  else process.env.TELEGRAM_CHAT_ID = originalChat;
});

// --- integration with limits.js: block list alert -----------------------------------------

test('block list alert fires once when an IP is blocked and again when it clears', async () => {
  const { createLimits, LIMITS } = await import('../../server/limits.js');
  const originalWebhook = process.env.ALERT_WEBHOOK_URL;
  const originalToken = process.env.TELEGRAM_BOT_TOKEN;
  const originalChat = process.env.TELEGRAM_CHAT_ID;
  delete process.env.ALERT_WEBHOOK_URL;
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  process.env.TELEGRAM_CHAT_ID = '-123';

  const clock = fakeClock();
  const limits = createLimits({ now: clock.now, log: () => {} });
  const { fetch, calls } = fakeFetch();
  const alerts = createAlerts({
    latest: () => null,
    blockedCount: limits.blockedIpsCount,
    now: clock.now,
    fetch,
    log: () => {},
  });

  const ip = '10.0.0.1';

  // Trip the per-minute connection limit BLOCK_TRIP_COUNT times, each in its own fresh minute.
  for (let trip = 0; trip < LIMITS.BLOCK_TRIP_COUNT; trip++) {
    for (let i = 0; i < LIMITS.MAX_CONNECTIONS_PER_IP_PER_MIN; i++) {
      assert.equal(limits.checkNewConnection(ip), null);
      limits.trackSocketClose(ip);
    }
    assert.equal(limits.checkNewConnection(ip), 'too_many_connections', `trip ${trip + 1}`);
    if (trip < LIMITS.BLOCK_TRIP_COUNT - 1) clock.advance(61_000);
  }

  await alerts._checkBlocklist();

  const blockedCalls = calls.filter((c) => callText(c).includes('IP(s) currently blocked'));
  assert.equal(blockedCalls.length, 1, 'ip_blocked alert fires once');
  assert.ok(callText(blockedCalls[0]).includes('1 IP(s)'));

  // Advance past the block duration so the IP is no longer blocked.
  clock.advance(LIMITS.BLOCK_DURATION_MS + 1);
  calls.length = 0;
  await alerts._checkBlocklist();

  const clearedCalls = calls.filter((c) => callText(c).includes('Block list cleared'));
  assert.equal(clearedCalls.length, 1, 'ip_blocks_cleared alert fires once when the list clears');

  if (originalWebhook === undefined) delete process.env.ALERT_WEBHOOK_URL;
  else process.env.ALERT_WEBHOOK_URL = originalWebhook;
  if (originalToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = originalToken;
  if (originalChat === undefined) delete process.env.TELEGRAM_CHAT_ID;
  else process.env.TELEGRAM_CHAT_ID = originalChat;
});

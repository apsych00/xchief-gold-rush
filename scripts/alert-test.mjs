/**
 * Operator verification script for Telegram/webhook alerts (ticket T1).
 *
 *   node scripts/alert-test.mjs <event>
 *
 * On the box, run through the server container:
 *   npm run box:alert-test -- <event>
 *
 * It fires one catalogue event through every configured transport, ignoring the 5-minute
 * throttle so an operator can verify the bot from the box immediately. Set TELEGRAM_BOT_TOKEN
 * and TELEGRAM_CHAT_ID (and optionally ALERT_WEBHOOK_URL) in .env.box first.
 */

import { ALERT_CATALOGUE, createAlerts } from '../server/alerts.js';

const USAGE = `usage: node scripts/alert-test.mjs <event>

events: ${Object.keys(ALERT_CATALOGUE).join(', ')}`;

const code = process.argv[2];
if (!code || !ALERT_CATALOGUE[code]) {
  console.error(USAGE);
  process.exit(1);
}

// Default parameters for each event so the operator only has to name the event.
const DEFAULT_PARAMS = {
  feed_silence: { ageSeconds: 90 },
  safe_mode_changed: { level: 'guarded', reason: 'manual' },
  ip_blocked: { count: 3 },
  coupons_low: { left: 20 },
  deploy_done: { sha: 'test-sha' },
};

const alerts = createAlerts();
await alerts.fireEvent(code, DEFAULT_PARAMS[code] ?? {});
console.log(`alert ${code} posted through configured transports`);

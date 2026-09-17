/**
 * Alerting for the box (docs/layers.md D1): a phone-visible ping when the price feed goes
 * silent, the server (re)starts, safe mode changes, IPs get blocked, or the coupon pool runs
 * low. Best-effort - a failed transport is logged and never crashes the process; there is no
 * retry queue or delivery guarantee, this is a nice-to-have on top of /status and the ops page,
 * not the source of truth.
 *
 * Two transports are supported, each optional and independent:
 *   - Webhook (ALERT_WEBHOOK_URL): ntfy.sh topic URL or Slack/Discord incoming webhook.
 *   - Telegram (TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID): sendMessage with parse_mode HTML.
 *
 * Every alert is defined in the exported ALERT_CATALOGUE so operators and deploy scripts can
 * reference the same event codes and copy the server uses.
 */

const SILENCE_MS = 60000; // no published tick for this long counts as feed silence
const CHECK_INTERVAL_MS = 10000;
const REPEAT_SUPPRESS_MS = 5 * 60 * 1000; // at most one alert per condition per 5 minutes

const TELEGRAM_API = 'https://api.telegram.org/bot';

/**
 * The canonical event catalogue. Each entry is a code, a severity, a one-line message and a
 * one-line recommendation (empty when no action is needed). Message and recommendation may be
 * functions of the event parameters or static strings.
 */
export const ALERT_CATALOGUE = {
  server_started: {
    code: 'server_started',
    severity: 'info',
    message: () => 'Server started',
    recommendation: () => '',
  },
  feed_silence: {
    code: 'feed_silence',
    severity: 'critical',
    message: ({ ageSeconds }) => `Price feed silent for ${ageSeconds}s`,
    recommendation: () =>
      'Check /status feed age; if MetaApi/MT5, check the bridge container; the game refuses rounds while silent',
  },
  feed_recovered: {
    code: 'feed_recovered',
    severity: 'info',
    message: () => 'Price feed recovered',
    recommendation: () => '',
  },
  safe_mode_changed: {
    code: 'safe_mode_changed',
    severity: ({ level }) => (level === 'locked' ? 'critical' : 'warn'),
    message: ({ level, reason }) => `Safe mode -> ${level} (${reason})`,
    recommendation: () =>
      'Look at /ops: if kiosk rounds continue and anonymous signups spiked, it is an attack: leave the level or lock; if it is a busy booth, node scripts/safe-mode.mjs normal',
  },
  ip_blocked: {
    code: 'ip_blocked',
    severity: 'warn',
    message: ({ count }) => `${count} IP(s) currently blocked`,
    recommendation: () => 'No action unless the count keeps rising; then Cloudflare rate rule',
  },
  ip_blocks_cleared: {
    code: 'ip_blocks_cleared',
    severity: 'info',
    message: () => 'Block list cleared',
    recommendation: () => '',
  },
  coupons_low: {
    code: 'coupons_low',
    severity: 'warn',
    message: ({ left }) => `${left} coupon(s) left`,
    recommendation: () => "Load more codes: docs/box-deploy.md 'Prize codes'",
  },
  coupons_exhausted: {
    code: 'coupons_exhausted',
    severity: 'critical',
    message: () => 'Coupon pool exhausted',
    recommendation: () => 'Kiosks now show the out-of-codes screen; load codes',
  },
  deploy_done: {
    code: 'deploy_done',
    severity: 'info',
    message: ({ sha }) => `Deploy complete: ${sha}`,
    recommendation: () => '',
  },
  deploy_failed: {
    code: 'deploy_failed',
    severity: 'critical',
    message: () => 'Deploy failed',
    recommendation: () => 'Run deploy/rollback.sh',
  },
};

function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function resolve(fnOrValue, params) {
  return typeof fnOrValue === 'function' ? fnOrValue(params) : fnOrValue;
}

function buildPlainText(severity, message, recommendation) {
  let text = `[${severity}] Gold Rush\n${message}`;
  if (recommendation) text += `\nDo: ${recommendation}`;
  return text;
}

function buildHtml(severity, message, recommendation) {
  const safeMessage = escapeHtml(message);
  let text = `<b>[${severity}] Gold Rush</b>\n${safeMessage}`;
  if (recommendation) {
    text += `\n<i>Do:</i> ${escapeHtml(recommendation)}`;
  }
  return text;
}

async function postWebhook(fetch, url, text) {
  const isNtfy = url.includes('ntfy');
  const headers = isNtfy ? { 'Content-Type': 'text/plain' } : { 'Content-Type': 'application/json' };
  const body = isNtfy ? text : JSON.stringify({ text });
  const res = await fetch(url, { method: 'POST', headers, body });
  if (!res.ok) throw new Error(`webhook responded ${res.status}`);
}

async function postTelegram(fetch, token, chatId, text) {
  const url = `${TELEGRAM_API}${encodeURIComponent(token)}/sendMessage`;
  const params = new URLSearchParams();
  params.set('chat_id', String(chatId));
  params.set('text', text);
  params.set('parse_mode', 'HTML');
  params.set('disable_web_page_preview', 'true');
  const res = await fetch(url, { method: 'POST', body: params });
  if (!res.ok) throw new Error(`telegram responded ${res.status}`);
}

/**
 * @param {object} deps
 * @param {() => { t: number } | null} deps.latest - feed.latest, read for silence detection
 * @param {() => number} [deps.blockedCount] - server/limits.js's blockedIpsCount(), read for the
 *   ticket S2 block-list alert (decision 5: "the alerts module posts one line when the block
 *   list is non-empty and again when it clears").
 * @param {(line: string) => void} [deps.log]
 * @param {() => number} [deps.now]
 * @param {typeof fetch} [deps.fetch] - test hook; defaults to globalThis.fetch
 */
export function createAlerts({
  latest,
  blockedCount = () => 0,
  log = console.log,
  now = Date.now,
  fetch = globalThis.fetch,
} = {}) {
  const webhookUrl = process.env.ALERT_WEBHOOK_URL || null;
  const telegramToken = process.env.TELEGRAM_BOT_TOKEN || null;
  const telegramChatId = process.env.TELEGRAM_CHAT_ID || null;
  const telegramEnabled = Boolean(telegramToken && telegramChatId);
  const lastSentAt = new Map(); // condition -> timestamp of the last post
  let silenceOngoing = false;
  let blocklistOngoing = false;
  let timer = null;

  /**
   * Fire a catalogue event through every configured transport. Each distinct `conditionKey`
   * gets its own REPEAT_SUPPRESS_MS window - a feed that stays silent for a weekend must not
   * write a line every ten seconds, while coupons_low at 20 and coupons_low at 5 are treated
   * as separate conditions so both can reach the operator.
   *
   * Failures are logged and swallowed; callers never need to catch.
   */
  async function fireEvent(code, params = {}, { conditionKey = code } = {}) {
    const entry = ALERT_CATALOGUE[code];
    if (!entry) {
      log(`[alert] unknown event code: ${code}`);
      return;
    }

    const last = lastSentAt.get(conditionKey);
    if (last !== undefined && now() - last < REPEAT_SUPPRESS_MS) return;
    lastSentAt.set(conditionKey, now());

    const severity = resolve(entry.severity, params);
    const message = resolve(entry.message, params);
    const recommendation = resolve(entry.recommendation, params);

    const plainText = buildPlainText(severity, message, recommendation);
    log(`[alert] ${code}: ${plainText.replaceAll('\n', ' | ')}`);

    if (webhookUrl) {
      try {
        await postWebhook(fetch, webhookUrl, plainText);
      } catch (err) {
        log(`[alert] webhook failed for ${code}: ${err.message}`);
      }
    }

    if (telegramEnabled) {
      try {
        const htmlText = buildHtml(severity, message, recommendation);
        await postTelegram(fetch, telegramToken, telegramChatId, htmlText);
      } catch (err) {
        log(`[alert] telegram failed for ${code}: ${err.message}`);
      }
    }
  }

  async function checkSilence() {
    const p = latest();
    const ageMs = p ? now() - p.t : Infinity;
    if (ageMs > SILENCE_MS) {
      await fireEvent('feed_silence', { ageSeconds: Math.round(ageMs / 1000) });
      silenceOngoing = true;
    } else {
      if (silenceOngoing) {
        lastSentAt.delete('feed_silence'); // the next silence is a new event, alert on it promptly
        await fireEvent('feed_recovered');
      }
      silenceOngoing = false;
    }
  }

  async function checkBlocklist() {
    const n = blockedCount();
    if (n > 0) {
      await fireEvent('ip_blocked', { count: n });
      blocklistOngoing = true;
    } else {
      if (blocklistOngoing) {
        lastSentAt.delete('ip_blocked'); // the next block list is a new event, alert on it promptly
        await fireEvent('ip_blocks_cleared');
      }
      blocklistOngoing = false;
    }
  }

  return {
    /**
     * Fire any catalogue event by code. Used by server/kiosk.js for coupon threshold alerts and
     * by scripts/alert-test.mjs for operator verification.
     */
    fireEvent,
    /** Ticket S18 decision 3: "escalate one level and post an alert" - server/safemode.js calls
     * this on every level change, manual or automatic. Each level gets its own
     * REPEAT_SUPPRESS_MS window, same as every other condition here, so an operator toggling
     * between guarded and locked a few times still gets a line for each distinct move. */
    fireSafeMode(level, reason) {
      return fireEvent('safe_mode_changed', { level, reason }, { conditionKey: `safe_mode_changed:${level}` });
    },
    /** Fire the one-off start alert and begin polling for feed silence and the block list. */
    start() {
      fireEvent('server_started').catch(() => {});
      timer = setInterval(() => {
        checkSilence().catch(() => {});
        checkBlocklist().catch(() => {});
      }, CHECK_INTERVAL_MS);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    /** Test hook: whether the feed is currently considered silent. */
    _isSilenceOngoing() {
      return silenceOngoing;
    },
    /** Test hook: run the block-list check on demand instead of waiting on the timer. */
    _checkBlocklist: checkBlocklist,
  };
}

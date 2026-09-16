/**
 * Alerting for the box (docs/layers.md D1): a phone-visible ping when the price feed goes
 * silent or the server (re)starts. Best-effort - a failed webhook is logged and never crashes
 * the process; there is no retry queue or delivery guarantee, this is a nice-to-have on top of
 * /status and the ops page, not the source of truth.
 *
 * ALERT_WEBHOOK_URL is optional. Two shapes are supported, detected by the URL:
 *   - ntfy.sh topic URL (contains 'ntfy'): POST the plain text message as the body.
 *   - Slack/Discord-style incoming webhook: POST JSON { text }.
 */

const SILENCE_MS = 60000; // no published tick for this long counts as feed silence
const CHECK_INTERVAL_MS = 10000;
const REPEAT_SUPPRESS_MS = 5 * 60 * 1000; // at most one alert per condition per 5 minutes

async function postAlert(url, text) {
  const isNtfy = url.includes('ntfy');
  const headers = isNtfy ? { 'Content-Type': 'text/plain' } : { 'Content-Type': 'application/json' };
  const body = isNtfy ? text : JSON.stringify({ text });
  const res = await fetch(url, { method: 'POST', headers, body });
  if (!res.ok) throw new Error(`webhook responded ${res.status}`);
}

/**
 * @param {object} deps
 * @param {() => { t: number } | null} deps.latest - feed.latest, read for silence detection
 * @param {(line: string) => void} [deps.log]
 * @param {() => number} [deps.now]
 */
export function createAlerts({ latest, log = console.log, now = Date.now } = {}) {
  const webhookUrl = process.env.ALERT_WEBHOOK_URL || null;
  const lastSentAt = new Map(); // condition -> timestamp of the last webhook post
  let silenceOngoing = false;
  let timer = null;

  /**
   * Logged and (if a webhook is configured) posted, at most once per condition per
   * REPEAT_SUPPRESS_MS - a feed that stays silent for a weekend must not write a line every
   * ten seconds.
   */
  async function fire(condition, text) {
    const last = lastSentAt.get(condition);
    if (last !== undefined && now() - last < REPEAT_SUPPRESS_MS) return;
    lastSentAt.set(condition, now());
    log(`[alert] ${condition}: ${text}`);
    if (!webhookUrl) return;
    try {
      await postAlert(webhookUrl, text);
    } catch (err) {
      log(`[alert] webhook failed for ${condition}: ${err.message}`);
    }
  }

  function checkSilence() {
    const p = latest();
    const ageMs = p ? now() - p.t : Infinity;
    if (ageMs > SILENCE_MS) {
      fire('feed_silence', `Gold Rush: price feed silent for ${Math.round(ageMs / 1000)}s`).catch(() => {});
      silenceOngoing = true;
    } else {
      if (silenceOngoing) {
        lastSentAt.delete('feed_silence'); // the next silence is a new event, alert on it promptly
        fire('feed_recovered', 'Gold Rush: price feed recovered').catch(() => {});
      }
      silenceOngoing = false;
    }
  }

  return {
    /** Fire the one-off start alert and begin polling for feed silence. */
    start() {
      fire('server_start', 'Gold Rush: server started').catch(() => {});
      timer = setInterval(checkSilence, CHECK_INTERVAL_MS);
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
  };
}

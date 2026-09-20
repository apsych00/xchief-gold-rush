/**
 * The idle sweep for kiosk visitor sessions (ticket C1, docs/layers.md).
 *
 * A visitor who walks away mid-session - mid-streak, after the win modal, after going broke -
 * leaves the kiosk in whatever state it was in. Nothing else brings it back to attract mode
 * for the next person: the client only resets on an explicit `kiosk_reset` frame (Claim/Done
 * pressed). This sweep is the silent third ending docs/layers.md calls for: every interval, any
 * kiosk whose session is not already idle and whose last round is older than the idle
 * threshold gets reset_kiosk_session, exactly as if Claim or Done had been pressed, and the
 * result is pushed to its live socket so the screen returns to attract mode without a click.
 *
 * The same interval also watches the prize pool (ticket C8, docs/layers.md): staff loading
 * more coupons is the only way an empty pool ever recovers, and nothing else tells a kiosk that
 * happened. Every tick reads the live available-coupon count; when it crosses zero in either
 * direction since the last tick, every currently connected kiosk gets a fresh `kiosk_session`
 * push (its own coins/streak/state, mirrored the same way ledger.kioskSession always reads it)
 * so the no-codes screen appears or clears on its own, without a reload.
 *
 * idleMs and intervalMs default to the product values (60 s idle, checked every 10 s) but are
 * constructor arguments so tests can shrink both instead of waiting a minute.
 */

const IDLE_MS = 60000;
const SWEEP_INTERVAL_MS = 10000;

/**
 * @param {object} deps
 * @param {typeof import('./ledger.js')} deps.ledger
 * @param {(kind: 'player'|'kiosk', id: string) => import('ws').WebSocket | undefined} deps.getSocket
 * @param {() => Iterable<[string, import('ws').WebSocket]>} [deps.listKioskSockets] every
 *   currently connected kiosk id/socket pair, for the pool-crossing broadcast below.
 * @param {{fireEvent?: (code: string, params?: object, opts?: object) => Promise<void>}} [deps.alerts]
 *   optional alerts module for coupon-stock events (ticket T1).
 * @param {number} [deps.idleMs]
 * @param {number} [deps.intervalMs]
 * @param {(line: string) => void} [deps.log]
 */
export function createKioskIdleSweep({
  ledger,
  getSocket,
  listKioskSockets = () => [],
  alerts = null,
  idleMs = IDLE_MS,
  intervalMs = SWEEP_INTERVAL_MS,
  log = console.log,
}) {
  let timer = null;
  // null until the first tick has observed a baseline: only a genuine crossing after that
  // triggers the broadcast, not the sweep's own startup.
  let lastCodesLeftZero = null;
  // The actual previous count, tracked so coupon-stock alerts can detect threshold crossings.
  let lastCodesLeft = null;

  /** Pushes a fresh kiosk_session to every connected kiosk when the pool just crossed zero,
   * either way, and posts low-stock alerts to the configured transports (ticket T1). Runs every
   * tick alongside the idle reset below, not only when kiosks are stale. */
  async function checkCoupons() {
    let codesLeft;
    try {
      codesLeft = await ledger.availableCoupons();
    } catch (err) {
      log(`kiosk idle sweep: coupon count failed: ${err.message}`);
      return;
    }
    const isZero = codesLeft === 0;
    if (lastCodesLeftZero === null) {
      lastCodesLeftZero = isZero;
      lastCodesLeft = codesLeft;
      return;
    }
    if (alerts && lastCodesLeft !== null) {
      if (lastCodesLeft > 20 && codesLeft <= 20) {
        alerts.fireEvent('coupons_low', { left: codesLeft }, { conditionKey: 'coupons_low:20' }).catch(() => {});
      }
      if (lastCodesLeft > 5 && codesLeft <= 5) {
        alerts.fireEvent('coupons_low', { left: codesLeft }, { conditionKey: 'coupons_low:5' }).catch(() => {});
      }
      if (lastCodesLeft > 0 && codesLeft === 0) {
        alerts.fireEvent('coupons_exhausted').catch(() => {});
      }
    }
    lastCodesLeft = codesLeft;
    if (isZero === lastCodesLeftZero) return;
    lastCodesLeftZero = isZero;
    for (const [kioskId, ws] of listKioskSockets()) {
      if (!ws || ws.readyState !== ws.OPEN) continue;
      try {
        const session = await ledger.kioskSession(kioskId);
        ws.send(JSON.stringify({ type: 'kiosk_session', ...session }));
      } catch (err) {
        log(`kiosk idle sweep: coupon-crossing push to ${kioskId} failed: ${err.message}`);
      }
    }
  }

  /** One pass over every stale kiosk, the claim-link expiry release, and the pool-crossing
   * check. Exposed so tests can drive it without waiting on the timer. */
  async function sweepOnce() {
    const staleIds = await ledger.staleKiosks(idleMs);
    for (const kioskId of staleIds) {
      try {
        const session = await ledger.resetKioskSession(kioskId);
        const ws = getSocket('kiosk', kioskId);
        if (ws && ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: 'kiosk_session', ...session }));
        }
      } catch (err) {
        log(`kiosk idle sweep: reset of ${kioskId} failed: ${err.message}`);
      }
    }
    // ticket C9: a claim link nobody scanned within its 30-day window releases its coupon back to
    // 'available' - run before checkCoupons() below so a release that crosses the pool from
    // empty to non-empty is exactly the crossing that push observes.
    try {
      const released = await ledger.releaseExpiredClaims();
      if (released) log(`released ${released} expired claim link(s) back to the pool`);
    } catch (err) {
      log(`kiosk idle sweep: claim release failed: ${err.message}`);
    }
    await checkCoupons();
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => {
        sweepOnce().catch((err) => log(`kiosk idle sweep failed: ${err.message}`));
      }, intervalMs);
      timer.unref();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    sweepOnce,
  };
}

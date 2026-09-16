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
 * idleMs and intervalMs default to the product values (60 s idle, checked every 10 s) but are
 * constructor arguments so tests can shrink both instead of waiting a minute.
 */

const IDLE_MS = 60000;
const SWEEP_INTERVAL_MS = 10000;

/**
 * @param {object} deps
 * @param {typeof import('./ledger.js')} deps.ledger
 * @param {(kind: 'player'|'kiosk', id: string) => import('ws').WebSocket | undefined} deps.getSocket
 * @param {number} [deps.idleMs]
 * @param {number} [deps.intervalMs]
 * @param {(line: string) => void} [deps.log]
 */
export function createKioskIdleSweep({
  ledger,
  getSocket,
  idleMs = IDLE_MS,
  intervalMs = SWEEP_INTERVAL_MS,
  log = console.log,
}) {
  let timer = null;

  /** One pass over every stale kiosk. Exposed so tests can drive it without waiting on the timer. */
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

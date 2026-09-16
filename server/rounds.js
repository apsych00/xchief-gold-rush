/**
 * Round lifecycle for the box game server (docs/box-plan.md 1.3, docs/box-spec.md 1.3).
 *
 * play() opens a round against the current price and arms a 5-second timer held in memory,
 * keyed by round id. At fire it reads whatever the feed is publishing now - a quiet market
 * settles flat, there is no re-check for staleness - and settles through the ledger. The
 * verdict is pushed to the identity's live socket if one is open; otherwise it is kept as a
 * pending verdict and handed to index.js to deliver once, right after the identity's next
 * `welcome`.
 *
 * `feed.setIdle()` tracks whether any round is open anywhere: idle after 2 s with none open,
 * which is what lets feed.js start re-anchoring finnhub's offset back toward the true price.
 */

const ROUND_MS = 5000;
const IDLE_MS = 2000;

/**
 * @param {object} deps
 * @param {import('./feed.js').Feed} deps.feed
 * @param {typeof import('./ledger.js')} deps.ledger
 * @param {(kind: 'player'|'kiosk', id: string) => import('ws').WebSocket | undefined} deps.getSocket
 * @param {(line: string) => void} [deps.log]
 * @param {() => number} [deps.now]
 */
export function createRoundManager({ feed, ledger, getSocket, log = console.log, now = Date.now }) {
  const pending = new Map(); // `${kind}:${id}` -> the round_settled frame not yet delivered
  let openCount = 0;
  let idleTimer = null;

  function roundOpened() {
    openCount += 1;
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    feed.setIdle(false);
  }

  function roundClosed() {
    openCount = Math.max(0, openCount - 1);
    if (openCount === 0 && !idleTimer) {
      idleTimer = setTimeout(() => {
        idleTimer = null;
        feed.setIdle(true);
      }, IDLE_MS);
    }
  }

  function send(ws, frame) {
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
  }

  /** dir/lever validation is the database's job (bad_dir/bad_lever); this only guards the feed. */
  async function play(kind, id, { dir, lever }) {
    const p = feed.latest();
    if (!p) {
      const err = new Error('feed_stale');
      err.code = 'feed_stale';
      throw err;
    }

    const startedAt = now();
    const opened =
      kind === 'player'
        ? await ledger.call('open_round', id, dir, lever, p.price, p.source)
        : await ledger.call('open_kiosk_round', id, dir, p.price, p.source);

    const roundId = opened.round_id;
    roundOpened();

    setTimeout(async () => {
      const end = feed.latest();
      // feed.latest() is only null before the feed's very first tick ever; a round could not
      // have opened without one. Guarded anyway: void rather than settle on a made-up price.
      if (!end) {
        log(`round ${roundId} ${kind}:${id} voided: no price to settle against`);
        try {
          await ledger.call('void_round', roundId);
        } catch (err) {
          log(`round ${roundId} void_round failed: ${err.message}`);
        }
        roundClosed();
        return;
      }

      let settled;
      try {
        settled =
          kind === 'player'
            ? await ledger.settlePlayerRound(id, roundId, end.price)
            : await ledger.call('settle_kiosk_round', roundId, end.price);
      } catch (err) {
        log(`round ${roundId} ${kind}:${id} settle failed: ${err.code || err.message}`);
        roundClosed();
        return;
      }
      roundClosed();

      const ms = now() - startedAt;
      log(`round ${roundId} ${kind}:${id} ${settled.outcome} ${p.price}->${end.price} ${ms}ms`);

      const frame = { type: 'round_settled', round_id: roundId, ...settled };
      const ws = getSocket(kind, id);
      if (ws && ws.readyState === ws.OPEN) {
        send(ws, frame);
      } else {
        pending.set(`${kind}:${id}`, frame);
      }
    }, ROUND_MS);

    return { round_id: roundId, start_price: p.price, start_at: startedAt };
  }

  /** Take (and clear) the one pending verdict for an identity, if any. */
  function takePending(kind, id) {
    const key = `${kind}:${id}`;
    const frame = pending.get(key);
    if (frame) pending.delete(key);
    return frame;
  }

  return { play, takePending };
}

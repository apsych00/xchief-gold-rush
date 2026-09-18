/**
 * Accumulated watch-time math for the YouTube mission player (ticket K4).
 *
 * A tick reads the player's current time and adds the delta to the running total, but each tick
 * is capped at 1.5 s so a programmatic seek cannot credit skipped time. Rewinds and pauses add
 * nothing; they simply reset the previous-time marker.
 */
export function accumulateWatchTime({ current, previous, accumulated }) {
  const delta = current - previous;
  if (delta <= 0) return accumulated;
  return accumulated + Math.min(delta, 1.5);
}

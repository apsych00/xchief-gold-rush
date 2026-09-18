/**
 * The /s/<token> public share page's one HTTP call (ticket U4). Plain fetch, not the game
 * socket - a share page has no game session of its own.
 */
import { apiUrl } from './client.js';

/** GET /api/share/<token>: {display, record, rank, tier, tournament_title} or 404. */
export async function getShareStatus(token) {
  const res = await fetch(apiUrl(`/api/share/${encodeURIComponent(token)}`));
  if (res.status === 404) {
    throw Object.assign(new Error('not_found'), { code: 'not_found' });
  }
  return res.json();
}

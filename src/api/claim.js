/**
 * The /claim/<token> page's two HTTP calls (ticket C9, docs/tickets/c9-qr-claim.md decision 4).
 * Plain fetch, not the game socket - a claim page is a one-off web-mode screen with no game
 * session of its own, so it never opens src/api/socket.js's WebSocket at all.
 */
import { apiUrl } from './client.js';

/** GET /api/claim/<token>: {state: 'ready'|'claimed'|'expired'|'invalid', expires_at?, email_masked?}. */
export async function getClaimStatus(token) {
  const res = await fetch(apiUrl(`/api/claim/${encodeURIComponent(token)}`));
  return res.json();
}

/**
 * POST /api/claim/<token> {email}: resolves with {code} on success, rejects with an Error whose
 * .code is the server's error (invalid_email, invalid, expired, already_claimed, rate_limited,
 * internal) - the same shape src/api/socket.js's own request() rejections use.
 */
export async function submitClaim(token, email) {
  const res = await fetch(apiUrl(`/api/claim/${encodeURIComponent(token)}`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) {
    throw Object.assign(new Error(body.error || 'internal'), { code: body.error || 'internal' });
  }
  return body;
}

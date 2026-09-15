/**
 * Kiosk identity and round play. The kiosk carries no auth session - its
 * launch URL bakes in a bearer secret (?k=...) that the server checks on
 * every call, so a fixed booth device never needs to sign in.
 */
import { supabaseAnonKey, supabaseUrl } from './client.js';

/** Reads the kiosk bearer secret from the launch URL, if present. */
export function getKioskSecret() {
  return new URLSearchParams(window.location.search).get('k');
}

/** POSTs {secret, dir} to play-round-kiosk. Resolves with {outcome, streak, coupon}. */
export async function playKioskRound(dir) {
  const secret = getKioskSecret();
  const res = await fetch(`${supabaseUrl}/functions/v1/play-round-kiosk`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: supabaseAnonKey,
    },
    body: JSON.stringify({ secret, dir }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || 'unknown_error');
    err.code = body.error || 'unknown_error';
    throw err;
  }
  return body;
}

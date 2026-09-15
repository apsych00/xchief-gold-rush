/**
 * Web auth: play-first, upgrade to email later. The player starts on an
 * anonymous Supabase session so a round can be played before any signup;
 * requestOtp/verifyOtp later link an email to that same auth.uid(), so the
 * players row (and its score) carries over rather than starting fresh.
 */
import { enabled, supabase } from './client.js';

function authError(error) {
  const err = new Error(error.message);
  err.code = error.code || error.message;
  return err;
}

let inflight = null;

/**
 * Signs in anonymously if there is no session yet. Returns the session, or null when the API
 * is disabled. Single-flight: React StrictMode mounts the game hook twice in dev, and two
 * concurrent calls would each see "no session" and mint two anonymous users, the second
 * silently replacing the first (and its score).
 */
export function ensureSession() {
  if (!enabled) return Promise.resolve(null);
  if (!inflight) {
    inflight = (async () => {
      const { data: getData, error: getErr } = await supabase.auth.getSession();
      if (getErr) throw authError(getErr);
      if (getData.session) return getData.session;
      const { data, error } = await supabase.auth.signInAnonymously();
      if (error) throw authError(error);
      return data.session;
    })().finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

/**
 * Links an email to the current anonymous user. Supabase treats this as an
 * email change on that user, so it sends a one-time code to the new address
 * and the auth.uid() - and the players row it keys - stays the same.
 */
export async function requestOtp(email) {
  if (!enabled) throw Object.assign(new Error('api_disabled'), { code: 'api_disabled' });
  const { error } = await supabase.auth.updateUser({ email });
  if (error) throw authError(error);
}

/** Verifies the code from requestOtp. The code is 8 digits, not Supabase's default 6. */
export async function verifyOtp(email, token) {
  if (!enabled) throw Object.assign(new Error('api_disabled'), { code: 'api_disabled' });
  const { data, error } = await supabase.auth.verifyOtp({ email, token, type: 'email_change' });
  if (error) throw authError(error);
  return data.session;
}

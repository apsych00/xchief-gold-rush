/**
 * Instagram Basic Display / Graph API adapter for the Instagram follow reward (ticket B8).
 *
 * No live Instagram call is made from this file when INSTAGRAM_API_BASE is set; that is how
 * tests point the adapter at test/fakes/instagram.mjs.
 *
 * The adapter is intentionally thin: it only knows how to build the authorize URL, exchange a
 * code, and read the user's own id/username. It never decides whether a reward is owed - that
 * lives in server/index.js and the ledger.
 */

function configured() {
  return Boolean(
    process.env.INSTAGRAM_APP_ID && process.env.INSTAGRAM_APP_SECRET && process.env.INSTAGRAM_REDIRECT_URI,
  );
}

function notConfigured() {
  return { ok: false, code: 'not_configured' };
}

function apiBase() {
  return process.env.INSTAGRAM_API_BASE || 'https://api.instagram.com';
}

function graphBase() {
  return process.env.INSTAGRAM_API_BASE || 'https://graph.instagram.com';
}

/**
 * Build the Instagram OAuth authorize URL.
 * Returns {ok:false, code:'not_configured'} when the Instagram env is incomplete.
 */
export function authorizeUrl({ state }) {
  if (!configured()) return notConfigured();
  const url = new URL('/oauth/authorize', apiBase());
  url.searchParams.set('client_id', process.env.INSTAGRAM_APP_ID);
  url.searchParams.set('redirect_uri', process.env.INSTAGRAM_REDIRECT_URI);
  url.searchParams.set('scope', 'user_profile');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', state);
  return { ok: true, url: url.toString() };
}

/**
 * Exchange an Instagram authorization code for an access token.
 * Returns {ok:true, access_token, user_id} or {ok:false, code}.
 */
export async function exchangeCode({ code }) {
  if (!configured()) return notConfigured();
  const body = new URLSearchParams();
  body.set('client_id', process.env.INSTAGRAM_APP_ID);
  body.set('client_secret', process.env.INSTAGRAM_APP_SECRET);
  body.set('grant_type', 'authorization_code');
  body.set('redirect_uri', process.env.INSTAGRAM_REDIRECT_URI);
  body.set('code', code);

  let res;
  try {
    res = await fetch(`${apiBase()}/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
  } catch {
    return { ok: false, code: 'network_error' };
  }

  let data;
  try {
    data = await res.json();
  } catch {
    return { ok: false, code: 'api_error' };
  }

  if (!res.ok) {
    return { ok: false, code: normalizeError(data) };
  }

  if (!data.access_token) {
    return { ok: false, code: 'api_error' };
  }

  return { ok: true, access_token: String(data.access_token), user_id: data.user_id ? String(data.user_id) : null };
}

/**
 * Read the authenticated Instagram user's id and username.
 * Returns {ok:true, id, username} or {ok:false, code}.
 */
export async function readMe({ token }) {
  if (!configured()) return notConfigured();
  const url = new URL('/me', graphBase());
  url.searchParams.set('fields', 'id,username');
  url.searchParams.set('access_token', token);

  let res;
  try {
    res = await fetch(url.toString());
  } catch {
    return { ok: false, code: 'network_error' };
  }

  let data;
  try {
    data = await res.json();
  } catch {
    return { ok: false, code: 'api_error' };
  }

  if (!res.ok) {
    return { ok: false, code: normalizeError(data) };
  }

  if (!data.id || !data.username) {
    return { ok: false, code: 'api_error' };
  }

  return { ok: true, id: String(data.id), username: String(data.username) };
}

/** 'configured' if the three required values are present, otherwise 'not_configured'. */
export function status() {
  return configured() ? 'configured' : 'not_configured';
}

function normalizeError(data) {
  if (data && data.error_type) {
    return String(data.error_type).toLowerCase();
  }
  if (data && data.error && data.error.type) {
    return String(data.error.type).toLowerCase();
  }
  if (data && data.error && data.error.message) {
    const msg = String(data.error.message).toLowerCase();
    if (msg.includes('access token')) return 'invalid_token';
    if (msg.includes('code')) return 'invalid_code';
  }
  return 'api_error';
}

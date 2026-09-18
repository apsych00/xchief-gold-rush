/**
 * BoxAPI Instagram data-API adapter for the Instagram follow reward (ticket K3, replacing B8's
 * OAuth adapter). See docs/boxapi-instagram-data-api.md.
 *
 * The mechanism is a read, not a login: the player gives their handle, follows us on Instagram,
 * and the server proves the follow by reading our own account's numeric id and then their
 * following list off BoxAPI - the client never asserts it followed. That decision (release the
 * reward or not) lives in server/index.js and the ledger; this file only knows how to ask
 * BoxAPI questions and shape the answers.
 *
 * No live BoxAPI call is made when BOXAPI_BASE points elsewhere; that is how tests point the
 * adapter at test/fakes/boxapi.mjs.
 *
 * The token is only ever read from process.env.BOXAPI_TOKEN and put on the Authorization header;
 * it is never logged and never returned.
 */

// Our own account's numeric id changes about never, and resolving it costs one BoxAPI call, so
// it is cached in memory for a day (ticket K3 decision 2). Keyed on the handle so a config change
// to INSTAGRAM_HANDLE invalidates it on its own.
const OUR_ID_TTL_MS = 24 * 60 * 60 * 1000;
let ourIdCache = null; // { handle, id, at }

// How many of the follower's following rows to read when checking for us (ticket K3 decision 2).
const FOLLOWING_COUNT = 200;

function configured() {
  return Boolean(process.env.BOXAPI_TOKEN);
}

/** 'configured' once BOXAPI_TOKEN is set, otherwise 'not_configured' (drives /status.instagram
 * and the task's "coming soon" state, exactly like B8's adapter did). */
export function status() {
  return configured() ? 'configured' : 'not_configured';
}

/** The base URL, always with a trailing slash so `${base()}user/get_following` is well formed. */
function base() {
  const raw = process.env.BOXAPI_BASE || 'https://boxapi.ir/api/instagram/';
  return raw.endsWith('/') ? raw : `${raw}/`;
}

/** Our own Instagram handle (INSTAGRAM_HANDLE), normalized the same way a player handle is. */
export function ourHandle() {
  return String(process.env.INSTAGRAM_HANDLE || '')
    .trim()
    .toLowerCase()
    .replace(/^@+/, '');
}

function notConfigured() {
  return { ok: false, code: 'not_configured' };
}

/**
 * One POST to `${base()}${action}` with the Bearer token and a JSON body (the shape every BoxAPI
 * endpoint uses except GET /api/my, which this adapter never calls). Returns {ok:true, data} or
 * {ok:false, code} - a transport failure is 'network_error', an unparseable/failed response is
 * 'api_error', a 404 is 'not_found', a 401/403 is 'unauthorized'.
 */
async function apiPost(action, params) {
  if (!configured()) return notConfigured();
  let res;
  try {
    res = await fetch(`${base()}${action}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.BOXAPI_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(params),
    });
  } catch {
    return { ok: false, code: 'network_error' };
  }

  let data;
  try {
    data = await res.json();
  } catch {
    return { ok: false, code: res.ok ? 'api_error' : httpErrorCode(res.status) };
  }

  if (!res.ok) {
    return { ok: false, code: httpErrorCode(res.status) };
  }
  return { ok: true, data };
}

function httpErrorCode(statusCode) {
  if (statusCode === 404) return 'not_found';
  if (statusCode === 401 || statusCode === 403) return 'unauthorized';
  return 'api_error';
}

/**
 * BoxAPI wraps every response as { status:"done", response:{ status_code, content_type,
 * body:{ status:"ok", user:{...} } } } (verified against the live API). Unwrap `response.body`
 * first, then read `user`; the extra fallbacks keep the fake and any envelope drift working.
 */
function pickBody(data) {
  return data?.response?.body ?? data?.data ?? data ?? null;
}
function pickUser(data) {
  const body = pickBody(data);
  return body?.user ?? body?.data?.user ?? body ?? null;
}

function pickId(u) {
  const raw = u && (u.id ?? u.pk ?? u.pk_id ?? u.user_id);
  return raw == null ? null : String(raw);
}

/**
 * user/get_info_by_username: resolve a handle to its numeric id, username and privacy flag.
 * Returns {ok:true, id, username, is_private} or {ok:false, code} ('not_found' when the handle
 * names no account).
 */
export async function getUserByUsername({ username }) {
  const res = await apiPost('user/get_info_by_username', { username });
  if (!res.ok) return res;
  const u = pickUser(res.data);
  const id = pickId(u);
  if (!id) return { ok: false, code: 'not_found' };
  return {
    ok: true,
    id,
    username: u.username ? String(u.username) : username,
    is_private: Boolean(u.is_private ?? u.private ?? u.is_private_account),
  };
}

/**
 * The following list is a page of user rows; like pickUser above, the array may sit under
 * `users`, `data.users`, `items` or `data` itself. Returns the set of ids and lowercased
 * usernames it contains so the caller can look for us by either.
 */
function pickUserList(data) {
  const body = pickBody(data);
  const list = body?.users ?? body?.data?.users ?? body?.items ?? (Array.isArray(body) ? body : []);
  return Array.isArray(list) ? list : [];
}

/**
 * user/get_following: read up to `count` accounts the given id follows. Returns
 * {ok:true, ids:Set<string>, usernames:Set<string>} or {ok:false, code}.
 */
export async function getFollowing({ id, count = FOLLOWING_COUNT }) {
  const res = await apiPost('user/get_following', { id, count });
  if (!res.ok) return res;
  const ids = new Set();
  const usernames = new Set();
  for (const u of pickUserList(res.data)) {
    const uid = pickId(u);
    if (uid) ids.add(uid);
    if (u && u.username) usernames.add(String(u.username).toLowerCase());
  }
  return { ok: true, ids, usernames };
}

/** Resolve our own account's numeric id, from the 24 h cache when it is fresh. */
async function resolveOurId() {
  const handle = ourHandle();
  if (!handle) return { ok: false, code: 'not_configured' };
  const now = Date.now();
  if (ourIdCache && ourIdCache.handle === handle && now - ourIdCache.at < OUR_ID_TTL_MS) {
    return { ok: true, id: ourIdCache.id };
  }
  const info = await getUserByUsername({ username: handle });
  if (!info.ok) return info;
  ourIdCache = { handle, id: info.id, at: now };
  return { ok: true, id: info.id };
}

/** Test-only: drop the cached own-account id so a suite can re-resolve within one process. */
export function resetCache() {
  ourIdCache = null;
}

/**
 * Prove that `handle` follows our account (ticket K3 decision 2). Resolves our own id first
 * (cached), then their id, then reads their following list and looks for us in it. Returns
 * {ok:true} when the follow is visible, otherwise {ok:false, reason} where reason is one the
 * client has copy for ('not_following', 'private', 'not_found') or a generic upstream failure
 * ('not_configured', 'network_error', 'unauthorized', 'api_error').
 */
export async function verifyFollow({ handle }) {
  if (!configured()) return { ok: false, reason: 'not_configured' };

  const ours = await resolveOurId();
  if (!ours.ok) {
    // Our own handle failing to resolve is a configuration problem, not the player's fault.
    return { ok: false, reason: ours.code === 'not_found' ? 'not_configured' : ours.code };
  }

  const them = await getUserByUsername({ username: handle });
  if (!them.ok) return { ok: false, reason: them.code };
  if (them.is_private) return { ok: false, reason: 'private' };

  const following = await getFollowing({ id: them.id, count: FOLLOWING_COUNT });
  if (!following.ok) return { ok: false, reason: following.code };

  const follows = following.ids.has(ours.id) || following.usernames.has(ourHandle());
  return follows ? { ok: true } : { ok: false, reason: 'not_following' };
}

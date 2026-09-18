/**
 * BoxAPI Instagram data-API adapter for the Instagram follow reward (ticket K3, replacing B8's
 * OAuth adapter). See docs/boxapi-instagram-data-api.md.
 *
 * The mechanism is a read, not a login: the player gives their handle, follows us on Instagram,
 * and the server proves the follow off BoxAPI - the client never asserts it followed. That
 * decision (release the reward or not) lives in server/index.js and the ledger; this file only
 * knows how to ask BoxAPI questions and shape the answers.
 *
 * The primary proof reads OUR OWN account's follower list newest-first (user/get_followers): a
 * brand-new follower lands at the top of it, so it is the freshest signal we can get, it is
 * immune to the player following 200+ accounts (their following cap never applies) and it works
 * even when the player's own account is private (we read our follower list, never theirs). The
 * player's own following list (user/get_following) is kept as a secondary signal for a public
 * player who is not yet visible near the top of our followers.
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

// How many of the player's following rows to read on the secondary check (ticket K3 decision 2).
const FOLLOWING_COUNT = 200;

// How many rows to request per page of OUR follower list, and how many newest-first pages to
// scan per read (~150 rows over 3 pages). The real API returns ~49 rows a page with has_more, so
// this caps the scan at the freshest slice rather than paging through ~13,850 followers.
const FOLLOWERS_PAGE_COUNT = 50;
const FOLLOWERS_PAGE_CAP = 3;

// BoxAPI's follower list lags a just-made follow by a few seconds. Within one check we read our
// followers a small number of times a short delay apart before giving up, so "follow then come
// straight back and check" still confirms. Both are env-tunable (tests set the delay to 0 to run
// the retry loop instantly); total stays well under ~15s. INSTAGRAM_FOLLOWERS_READS counts the
// first read too, so the default is one read plus two retries.
function followerReads() {
  const raw = process.env.INSTAGRAM_FOLLOWERS_READS;
  const n = raw != null && raw !== '' ? Number(raw) : 3;
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 3;
}
function retryDelayMs() {
  const raw = process.env.INSTAGRAM_RETRY_DELAY_MS;
  const n = raw != null && raw !== '' ? Number(raw) : 2500;
  return Number.isFinite(n) && n >= 0 ? n : 2500;
}
const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

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

// A follower page carries the rows plus paging metadata under `response.body`. The cursor field
// name is not pinned in the docs, so read the ones BoxAPI/Instagram are known to use; whichever
// is present is echoed back as `max_id` on the next request. has_more likewise has a couple of
// spellings across envelopes.
function pickCursor(body) {
  return body?.next_max_id ?? body?.next_cursor ?? body?.max_id ?? body?.end_cursor ?? null;
}
function pickHasMore(body) {
  return Boolean(body?.has_more ?? body?.more_available ?? false);
}

/**
 * user/get_followers: read one newest-first page of the given id's followers. `max_id` pages
 * deeper (absent for the first page). Returns {ok:true, ids, usernames, hasMore, cursor} or
 * {ok:false, code}.
 */
export async function getFollowers({ id, count = FOLLOWERS_PAGE_COUNT, max_id = null }) {
  const params = max_id ? { id, count, max_id } : { id, count };
  const res = await apiPost('user/get_followers', params);
  if (!res.ok) return res;
  const body = pickBody(res.data);
  const ids = new Set();
  const usernames = new Set();
  for (const u of pickUserList(res.data)) {
    const uid = pickId(u);
    if (uid) ids.add(uid);
    if (u && u.username) usernames.add(String(u.username).toLowerCase());
  }
  return { ok: true, ids, usernames, hasMore: pickHasMore(body), cursor: pickCursor(body) };
}

/**
 * Scan up to FOLLOWERS_PAGE_CAP newest-first pages of OUR follower list for the player, following
 * the has_more cursor. Short-circuits the moment the player's id or username appears. Returns
 * {ok:true, found} normally; {ok:false, code} only when the very first page fails - a later page
 * failing after some were read is treated as "not found here" so the caller can still try the
 * secondary signal.
 */
async function ourFollowersInclude(ourId, theirId, theirHandle) {
  let cursor = null;
  for (let page = 0; page < FOLLOWERS_PAGE_CAP; page += 1) {
    const res = await getFollowers({ id: ourId, max_id: cursor });
    if (!res.ok) return page === 0 ? { ok: false, code: res.code } : { ok: true, found: false };
    if ((theirId && res.ids.has(theirId)) || (theirHandle && res.usernames.has(theirHandle))) {
      return { ok: true, found: true };
    }
    if (!res.hasMore || !res.cursor) break;
    cursor = res.cursor;
  }
  return { ok: true, found: false };
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
 * (cached), then the player's id. The primary proof reads OUR follower list newest-first over a
 * few pages, retried a few times a short delay apart to ride out BoxAPI's freshness lag on a
 * just-made follow. A public player who is not yet visible near the top of our followers gets a
 * secondary check against their own following list. Returns {ok:true} when the follow is visible
 * in either, otherwise {ok:false, reason} where reason is one the client has copy for
 * ('not_following', 'private', 'not_found') or a generic upstream failure ('not_configured',
 * 'network_error', 'unauthorized', 'api_error').
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
  const theirHandle = them.username ? String(them.username).toLowerCase() : String(handle).toLowerCase();

  // PRIMARY: our newest followers, retried for freshness. Remember an upstream error only while
  // no read ever succeeded, so a real transport/auth failure surfaces its own reason rather than
  // being flattened to 'not_following'.
  const reads = followerReads();
  let scannedOk = false;
  let upstreamError = null;
  for (let attempt = 0; attempt < reads; attempt += 1) {
    const scan = await ourFollowersInclude(ours.id, them.id, theirHandle);
    if (scan.ok) {
      scannedOk = true;
      if (scan.found) return { ok: true };
    } else if (!upstreamError) {
      upstreamError = scan.code;
    }
    if (attempt < reads - 1) await sleep(retryDelayMs());
  }

  // SECONDARY: a public player's own following list still proves a follow. Skipped for a private
  // account, whose following is hidden - the primary path already covered the private case.
  if (!them.is_private) {
    const following = await getFollowing({ id: them.id, count: FOLLOWING_COUNT });
    if (following.ok) {
      scannedOk = true;
      if (following.ids.has(ours.id) || following.usernames.has(ourHandle())) return { ok: true };
    } else if (!upstreamError) {
      upstreamError = following.code;
    }
  }

  // Never read our followers (or their following) successfully: report the upstream failure, not
  // a false "not following".
  if (!scannedOk && upstreamError) return { ok: false, reason: upstreamError };
  return { ok: false, reason: them.is_private ? 'private' : 'not_following' };
}

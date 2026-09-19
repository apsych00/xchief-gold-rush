/**
 * Fake BoxAPI Instagram data-API server for ticket K3 tests (replaces the B8 OAuth fake in
 * test/fakes/instagram.mjs). Mirrors the endpoints server/instagram.js calls, in the documented
 * shape: POST JSON with a Bearer token (docs/boxapi-instagram-data-api.md).
 *
 * Usage:
 *   const fake = await startFakeBoxApi(0);
 *   process.env.BOXAPI_TOKEN = 'fake-token';
 *   process.env.BOXAPI_BASE = `${fake.url}/`;
 *   process.env.INSTAGRAM_HANDLE = 'xchief.global';
 *   // run tests
 *   await fake.stop();
 *
 * Endpoints (all POST JSON, Authorization: Bearer required):
 *   POST /user/get_info_by_username { username } -> { data: { user: { id, username, is_private } } }
 *     404 when the handle names no seeded account.
 *   POST /user/get_followers { id, count, max_id? } -> { data: { users, user_count, has_more, next_max_id } }
 *     Newest-first, paged with a small fixed page size so a handful of seeded rows still exercises
 *     the adapter's multi-page scan. max_id is the start index of the next page.
 *   POST /user/get_following { id, count } -> { data: { users: [ { id, username }, ... ] } }
 *   GET  /health -> { ok: true } (for Playwright/ready checks)
 *
 * Follower model (ticket K3 primary path): our own account carries an ordered `followers` list
 * (newest-first). A brand-new follower lands at the top. `pending` marks a handle that BoxAPI has
 * not surfaced yet - it is withheld from get_followers until our follower list has been read
 * `appearAfterReads` times, modelling the freshness lag the adapter retries through.
 *
 * Seeded accounts (override or extend with addAccount / setFollowers / setPendingFollower):
 *   xchief.global   - our own account. INSTAGRAM_HANDLE in tests points here.
 *   follower        - public, sits on page 1 of our followers AND follows us back (both paths).
 *   privatefollower - private, sits on page 1 of our followers (the our-followers path is immune
 *                     to a private player account, since we read OUR list, never theirs).
 *   deeppager       - public, sits on page 3 of our followers (exercises paging).
 *   beyondcap       - public, sits past the scan cap (proves the cap holds - not confirmed).
 *   secondaryonly   - public, NOT in our followers but follows us (exercises the secondary path).
 *   nonfollower     - public, in neither list (not_following).
 *   privateuser     - private, in neither list (private).
 *   freshfollower   - public, only surfaced after a couple of reads (exercises the retry).
 * An unregistered handle answers 404 so the adapter yields 'not_found'.
 */

import { createServer } from 'node:http';
import { URL } from 'node:url';

// Our own handle in tests. The default follower list below hangs off this account.
const OUR_HANDLE = 'xchief.global';

// A deliberately small page so a handful of seeded followers still spans several pages and the
// adapter's newest-first, capped, paged scan is genuinely exercised.
const FAKE_FOLLOWERS_PAGE_SIZE = 3;

const DEFAULT_ACCOUNTS = [
  // Our own account. Its `followers` list is what the primary check reads, newest-first.
  {
    username: OUR_HANDLE,
    id: '1000',
    is_private: false,
    following: [],
    // Newest-first. Page size 3: page 1 = idx 0-2, page 2 = idx 3-5, page 3 = idx 6-8, ...
    // deeppager is on page 3 (found within the 3-page cap); beyondcap is on page 4 (not).
    followers: [
      'privatefollower',
      'follower',
      'filler1',
      'filler2',
      'filler3',
      'filler4',
      'deeppager',
      'filler5',
      'filler6',
      'beyondcap',
    ],
  },
  // Public, page 1 of our followers, and follows us back.
  { username: 'follower', id: '2001', is_private: false, following: [OUR_HANDLE] },
  // Public, in neither list.
  { username: 'nonfollower', id: '2002', is_private: false, following: ['someoneelse'] },
  // Private, in neither list -> 'private'.
  { username: 'privateuser', id: '2003', is_private: true, following: [OUR_HANDLE] },
  // Private, but ON page 1 of our followers -> confirmed by the our-followers path despite privacy.
  { username: 'privatefollower', id: '2004', is_private: true, following: [] },
  // Public, NOT in our followers, but follows us -> confirmed by the secondary path.
  { username: 'secondaryonly', id: '2005', is_private: false, following: [OUR_HANDLE] },
  // Public, page 3 of our followers -> confirmed only by paging.
  { username: 'deeppager', id: '2006', is_private: false, following: ['someoneelse'] },
  // Public, page 4 of our followers -> past the scan cap, never confirmed.
  { username: 'beyondcap', id: '2007', is_private: false, following: ['someoneelse'] },
  // Public; the retry test seeds it as a pending follower to model BoxAPI freshness lag.
  { username: 'freshfollower', id: '2008', is_private: false, following: ['someoneelse'] },
  // Filler followers, only there to push deeppager/beyondcap onto later pages.
  { username: 'filler1', id: '3001', is_private: false, following: [] },
  { username: 'filler2', id: '3002', is_private: false, following: [] },
  { username: 'filler3', id: '3003', is_private: false, following: [] },
  { username: 'filler4', id: '3004', is_private: false, following: [] },
  { username: 'filler5', id: '3005', is_private: false, following: [] },
  { username: 'filler6', id: '3006', is_private: false, following: [] },
];

function norm(username) {
  return String(username || '')
    .trim()
    .toLowerCase()
    .replace(/^@+/, '');
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function createFakeBoxApi() {
  let server = null;
  let url = null;
  let calls = 0; // total requests this fake has answered (ticket K3 second-try grant tests: the
  // second-or-later check must never call out at all, and this is what proves it)
  const byUsername = new Map(); // normalized username -> account
  const byId = new Map(); // id -> account
  const pending = new Map(); // normalized handle -> appearAfterReads (get_followers read count)
  const readCounts = new Map(); // account id -> how many times its follower list's page 1 was read

  function addAccount(account) {
    const username = norm(account.username);
    const resolved = {
      username,
      id: String(account.id),
      is_private: Boolean(account.is_private),
      following: (account.following || []).map(norm),
      followers: (account.followers || []).map(norm),
    };
    byUsername.set(username, resolved);
    byId.set(resolved.id, resolved);
    return resolved;
  }

  function reset() {
    byUsername.clear();
    byId.clear();
    pending.clear();
    readCounts.clear();
    calls = 0;
    for (const account of DEFAULT_ACCOUNTS) addAccount(account);
  }

  // Total requests answered since the last reset() (health checks excluded). Ticket K3: the
  // second-or-later instagram_check must grant without calling BoxAPI at all.
  function callCount() {
    return calls;
  }

  // Replace an account's ordered (newest-first) follower list. Used by the retry test to isolate a
  // single follower from the default paging fixture.
  function setFollowers(username, handles) {
    const account = byUsername.get(norm(username));
    if (account) account.followers = (handles || []).map(norm);
  }

  // Mark a handle as not yet surfaced by BoxAPI: it is withheld from get_followers until our
  // follower list has been read `appearAfterReads` times (models the freshness lag).
  function setPendingFollower(handle, appearAfterReads) {
    pending.set(norm(handle), Number(appearAfterReads) || 0);
  }

  // {id, username} rows, fabricating an id for any handle with no seeded account (its exact id
  // does not matter to the adapter).
  function rowsFor(handles) {
    return handles.map((handle) => {
      const target = byUsername.get(handle);
      return { id: target ? target.id : `x-${handle}`, username: handle };
    });
  }

  async function start(port = 0) {
    reset();
    server = createServer(async (req, res) => {
      const parsed = new URL(req.url, 'http://localhost');
      try {
        if (parsed.pathname === '/health' && req.method === 'GET') {
          sendJson(res, 200, { ok: true });
          return;
        }
        calls += 1;

        // Every data endpoint is a POST that must carry the Bearer token (never inspected for a
        // value here - only that the adapter sent one).
        const auth = req.headers['authorization'] || '';
        if (!auth.startsWith('Bearer ')) {
          sendJson(res, 401, { error: 'unauthorized' });
          return;
        }
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method_not_allowed' });
          return;
        }

        let params = {};
        try {
          const raw = await readBody(req);
          params = raw ? JSON.parse(raw) : {};
        } catch {
          sendJson(res, 400, { error: 'bad_request' });
          return;
        }

        if (parsed.pathname === '/user/get_info_by_username') {
          const account = byUsername.get(norm(params.username));
          if (!account) {
            sendJson(res, 404, { error: 'not_found' });
            return;
          }
          sendJson(res, 200, {
            data: { user: { id: account.id, username: account.username, is_private: account.is_private } },
          });
          return;
        }

        if (parsed.pathname === '/user/get_followers') {
          const account = byId.get(String(params.id));
          if (!account) {
            sendJson(res, 404, { error: 'not_found' });
            return;
          }
          // A first page (no max_id) counts as one read of this account's follower list; that read
          // count is what a pending follower's appearAfterReads is measured against.
          const firstPage = params.max_id == null;
          const priorReads = readCounts.get(account.id) || 0;
          if (firstPage) readCounts.set(account.id, priorReads + 1);
          // Withhold any follower still pending at this read count (freshness lag).
          const visible = account.followers.filter((handle) => {
            const threshold = pending.get(handle);
            return threshold == null || priorReads >= threshold;
          });
          const size = Math.min(Number(params.count) || FAKE_FOLLOWERS_PAGE_SIZE, FAKE_FOLLOWERS_PAGE_SIZE);
          const start = firstPage ? 0 : Number(params.max_id) || 0;
          const slice = visible.slice(start, start + size);
          const nextStart = start + size;
          const hasMore = nextStart < visible.length;
          sendJson(res, 200, {
            data: {
              users: rowsFor(slice),
              user_count: visible.length,
              has_more: hasMore,
              ...(hasMore ? { next_max_id: String(nextStart) } : {}),
            },
          });
          return;
        }

        if (parsed.pathname === '/user/get_following') {
          const account = byId.get(String(params.id));
          if (!account) {
            sendJson(res, 404, { error: 'not_found' });
            return;
          }
          sendJson(res, 200, { data: { users: rowsFor(account.following) } });
          return;
        }

        res.writeHead(404);
        res.end();
      } catch (err) {
        console.error('[fake-boxapi] error', err);
        sendJson(res, 500, { error: 'internal' });
      }
    });

    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, () => {
        server.off('error', reject);
        resolve();
      });
    });

    const address = server.address();
    url = `http://localhost:${address.port}`;
    return { url };
  }

  async function stop() {
    if (!server) return;
    await new Promise((resolve) => server.close(resolve));
    server = null;
    url = null;
    byUsername.clear();
    byId.clear();
    pending.clear();
    readCounts.clear();
  }

  return {
    start,
    stop,
    addAccount,
    setFollowers,
    setPendingFollower,
    reset,
    callCount,
    get url() {
      return url;
    },
  };
}

/** Convenience: start and return the fake with a bound stop helper. */
export async function startFakeBoxApi(port = 0) {
  const fake = createFakeBoxApi();
  await fake.start(port);
  return fake;
}

/** If run directly, start on a default port so it can be a standalone process for Playwright. */
const isMain = process.argv[1] && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href;
if (isMain) {
  const fake = createFakeBoxApi();
  await fake.start(Number(process.env.FAKE_BOXAPI_PORT) || 9877);
  console.log(`[fake-boxapi] listening on ${fake.url}`);
}

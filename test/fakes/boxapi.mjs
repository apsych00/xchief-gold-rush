/**
 * Fake BoxAPI Instagram data-API server for ticket K3 tests (replaces the B8 OAuth fake in
 * test/fakes/instagram.mjs). Mirrors the two endpoints server/instagram.js calls, in the
 * documented shape: POST JSON with a Bearer token (docs/boxapi-instagram-data-api.md).
 *
 * Usage:
 *   const fake = await startFakeBoxApi(0);
 *   process.env.BOXAPI_TOKEN = 'fake-token';
 *   process.env.BOXAPI_BASE = `${fake.url}/`;
 *   process.env.INSTAGRAM_HANDLE = 'xchief';
 *   // run tests
 *   await fake.stop();
 *
 * Endpoints (all POST JSON, Authorization: Bearer required):
 *   POST /user/get_info_by_username { username } -> { data: { user: { id, username, is_private } } }
 *     404 when the handle names no seeded account.
 *   POST /user/get_following { id, count } -> { data: { users: [ { id, username }, ... ] } }
 *   GET  /health -> { ok: true } (for Playwright/ready checks)
 *
 * Seeded accounts (override or extend with addAccount): our own handle, a public follower, a
 * public non-follower, and a private account. An unregistered handle answers 404 so the adapter
 * yields 'not_found'.
 */

import { createServer } from 'node:http';
import { URL } from 'node:url';

const DEFAULT_ACCOUNTS = [
  // Our own account. INSTAGRAM_HANDLE in tests points here.
  { username: 'xchief', id: '1000', is_private: false, following: [] },
  // A public account that follows us: get_following returns our account in its list.
  { username: 'follower', id: '2001', is_private: false, following: ['xchief'] },
  // A public account that does not follow us.
  { username: 'nonfollower', id: '2002', is_private: false, following: ['someoneelse'] },
  // A private account: the adapter refuses before ever reading the (hidden) following list.
  { username: 'privateuser', id: '2003', is_private: true, following: ['xchief'] },
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
  const byUsername = new Map(); // normalized username -> account
  const byId = new Map(); // id -> account

  function addAccount(account) {
    const username = norm(account.username);
    const resolved = {
      username,
      id: String(account.id),
      is_private: Boolean(account.is_private),
      following: (account.following || []).map(norm),
    };
    byUsername.set(username, resolved);
    byId.set(resolved.id, resolved);
    return resolved;
  }

  function reset() {
    byUsername.clear();
    byId.clear();
    for (const account of DEFAULT_ACCOUNTS) addAccount(account);
  }

  // Build the {id, username} rows for one account's following list, fabricating an id for any
  // handle that has no seeded account of its own (its exact id does not matter to the adapter).
  function followingRows(account) {
    return account.following.map((handle) => {
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

        if (parsed.pathname === '/user/get_following') {
          const account = byId.get(String(params.id));
          if (!account) {
            sendJson(res, 404, { error: 'not_found' });
            return;
          }
          sendJson(res, 200, { data: { users: followingRows(account) } });
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
  }

  return {
    start,
    stop,
    addAccount,
    reset,
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

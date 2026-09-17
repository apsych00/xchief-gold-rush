/**
 * Fake Instagram OAuth + Graph API server for ticket B8 tests.
 *
 * Usage:
 *   const fake = await startFakeInstagram(9876);
 *   process.env.INSTAGRAM_API_BASE = fake.url;
 *   // run tests
 *   await fake.stop();
 *
 * Endpoints mirror the real Instagram paths the adapter expects:
 *   GET  /oauth/authorize   -> 302 to redirect_uri?code=...&state=...
 *   POST /oauth/access_token -> { access_token, user_id } or an Instagram-shaped error
 *   GET  /me?fields=id,username&access_token=... -> { id, username }
 *   GET  /health -> { ok: true } (for Playwright/ready checks)
 *
 * Error injection: send `code=invalid_code` (or any code containing `invalid_`) to the
 * token endpoint to get a matching error_type in the adapter's error format.
 */

import { createServer } from 'node:http';
import { URL, URLSearchParams } from 'node:url';

const ACCOUNTS = new Map(); // access_token -> { id, username }
const CODES = new Map(); // authorization code -> { access_token, user_id }

// Real Instagram user ids are globally unique, so the fake must not hand out the same ids after
// a process restart: the E2E suite reuses one kept dev database (db/run-tests.sh --keep), and a
// deterministic base made every second run's account collide with the first run's
// (`instagram_accounts.ig_user_id` is the primary key, so the callback answered already_claimed).
// A per-process random base keeps ids unique; issueCode({ id }) still lets a test pin an exact id.
const ID_BASE = 1000000000 + Math.floor(Math.random() * 100000000);

function nextId() {
  return String(ID_BASE + ACCOUNTS.size);
}

function generateCode() {
  return `fake-code-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
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

export function createFakeInstagram() {
  let server = null;
  let url = null;

  /**
   * Pre-register an account and authorization code. Tests use this to force the same
   * Instagram user_id to appear from a second device/player.
   */
  function issueCode(account = {}) {
    const code = generateCode();
    const token = `fake-token-${code}`;
    const resolved = {
      id: account.id || nextId(),
      username: account.username || `fake_user_${ACCOUNTS.size + 1}`,
    };
    ACCOUNTS.set(token, resolved);
    CODES.set(code, { access_token: token, user_id: resolved.id });
    return { code, token, account: resolved };
  }

  async function start(port = 0) {
    server = createServer(async (req, res) => {
      const parsed = new URL(req.url, 'http://localhost');
      try {
        if (parsed.pathname === '/health' && req.method === 'GET') {
          sendJson(res, 200, { ok: true });
          return;
        }
        if (parsed.pathname === '/oauth/authorize' && req.method === 'GET') {
          const redirectUri = parsed.searchParams.get('redirect_uri');
          const state = parsed.searchParams.get('state');
          if (!redirectUri || !state) {
            sendJson(res, 400, { error_type: 'invalid_request', code: 400, error_message: 'missing params' });
            return;
          }
          const code = generateCode();
          const token = `fake-token-${code}`;
          const account = { id: nextId(), username: `fake_user_${ACCOUNTS.size + 1}` };
          ACCOUNTS.set(token, account);
          CODES.set(code, { access_token: token, user_id: account.id });
          const location = `${redirectUri}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
          res.writeHead(302, { Location: location });
          res.end();
          return;
        }
        if (parsed.pathname === '/oauth/access_token' && req.method === 'POST') {
          const body = await readBody(req);
          const params = new URLSearchParams(body);
          const clientId = params.get('client_id');
          const clientSecret = params.get('client_secret');
          const code = params.get('code');
          if (!clientId || !clientSecret) {
            sendJson(res, 400, { error_type: 'invalid_client', code: 400, error_message: 'bad client' });
            return;
          }
          if (!code || !CODES.has(code) || code.includes('invalid_')) {
            sendJson(res, 400, { error_type: 'invalid_code', code: 400, error_message: 'bad code' });
            return;
          }
          sendJson(res, 200, CODES.get(code));
          return;
        }
        if (parsed.pathname === '/me' && req.method === 'GET') {
          const token = parsed.searchParams.get('access_token');
          if (!token || !ACCOUNTS.has(token)) {
            sendJson(res, 400, { error_type: 'invalid_token', code: 400, error_message: 'bad token' });
            return;
          }
          sendJson(res, 200, ACCOUNTS.get(token));
          return;
        }
        res.writeHead(404);
        res.end();
      } catch (err) {
        console.error('[fake-instagram] error', err);
        sendJson(res, 500, { error_type: 'api_error', code: 500, error_message: 'internal' });
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
    ACCOUNTS.clear();
    CODES.clear();
  }

  return {
    start,
    stop,
    issueCode,
    get url() {
      return url;
    },
  };
}

/** Convenience: start and return the fake with a bound stop helper. */
export async function startFakeInstagram(port = 0) {
  const fake = createFakeInstagram();
  await fake.start(port);
  return fake;
}

/** If this file is run directly, start on a default port so it can be used as a standalone process. */
const isMain = process.argv[1] && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href;
if (isMain) {
  const fake = createFakeInstagram();
  await fake.start(Number(process.env.FAKE_INSTAGRAM_PORT) || 9876);
  console.log(`[fake-instagram] listening on ${fake.url}`);
}

/**
 * Whether the app talks to the box game server (docs/box-plan.md, docs/box-spec.md) over
 * src/api/socket.js. `enabled` gates every other module in src/api/ and priceFeed.js's server
 * mode: when VITE_GAME_WS is unset (local UI work with no backend, or a preview build with no
 * server), the rest of the app falls back to the local-only behaviour in useGame.js untouched.
 */
const env = import.meta.env || {};

export const gameWsUrl = env.VITE_GAME_WS || '';

export const enabled = Boolean(gameWsUrl);

/**
 * The HTTP origin for the game server's own /api/* routes (ticket C9's claim page, src/api/
 * claim.js) - same-origin ('') in production behind Caddy, same as socket.js's own 'auto'
 * default. A dev recipe that points VITE_GAME_WS at an explicit ws://host:port (Vite and the
 * game server on separate ports, docs/tickets/c9-qr-claim.md's dev recipe) needs the matching
 * http://host:port instead, or every /api/claim/* fetch would hit the Vite dev server itself.
 */
function resolveApiBase() {
  if (!gameWsUrl || gameWsUrl === 'auto') return '';
  try {
    const u = new URL(gameWsUrl);
    const proto = u.protocol === 'wss:' ? 'https:' : 'http:';
    return `${proto}//${u.host}`;
  } catch {
    return '';
  }
}

export const apiBase = resolveApiBase();

export function apiUrl(path) {
  return `${apiBase}${path}`;
}

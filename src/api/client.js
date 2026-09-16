/**
 * Whether the app talks to the box game server (docs/box-plan.md, docs/box-spec.md) over
 * src/api/socket.js. `enabled` gates every other module in src/api/ and priceFeed.js's server
 * mode: when VITE_GAME_WS is unset (local UI work with no backend, or a preview build with no
 * server), the rest of the app falls back to the local-only behaviour in useGame.js untouched.
 */
const env = import.meta.env || {};

export const gameWsUrl = env.VITE_GAME_WS || '';

export const enabled = Boolean(gameWsUrl);

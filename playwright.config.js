// E2E: targets a running app (BASE_URL) plus the box game server the client now talks to over
// VITE_GAME_WS (docs/box-plan.md, docs/box-spec.md). Both are started below; reuse whichever
// you already have running.
//
// The game server needs a migrated, seeded database first - run once, before this suite:
//   bash db/run-tests.sh --keep
// (leaves a throwaway postgres:16 on localhost:55432, user postgres, password test - see that
// script's own header). DATABASE_URL below points at exactly that; override it if you kept the
// container on a different port.
import { defineConfig, devices } from '@playwright/test';

const BASE_URL = process.env.BASE_URL || 'http://localhost:5173';
const GAME_SERVER_PORT = process.env.PORT || '8787';
// The Vite port follows BASE_URL so parallel checkouts can each run the suite on their own port.
const VITE_PORT = new URL(BASE_URL).port || '5173';
const GAME_SERVER_URL = `http://localhost:${GAME_SERVER_PORT}/health`;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  // One worker: every spec shares one game server, one database and one dev kiosk identity, so
  // two files running at once reset each other's sessions mid-round.
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'node server/index.js',
      url: GAME_SERVER_URL,
      reuseExistingServer: true,
      timeout: 30_000,
      env: {
        PORT: GAME_SERVER_PORT,
        PLAYER_TOKEN_SECRET: process.env.PLAYER_TOKEN_SECRET || 'dev-secret',
        DATABASE_URL: process.env.DATABASE_URL || 'postgresql://postgres:test@localhost:55432/postgres',
        // Every spec talks to the server from 127.0.0.1, so the per-IP windows (ticket S2) would
        // refuse the suite itself; they are exercised on their own terms in
        // test/integration-box/limits.test.mjs. Same override as the integration harness.
        TRUST_PROXY: '0',
        MAX_ANON_PLAYERS_PER_IP_PER_10MIN: '1000',
        MAX_CONNECTIONS_PER_IP_PER_MIN: '1000',
        MAX_SOCKETS_PER_IP: '1000',
        MAX_OTP_REQUESTS_PER_IP_PER_10MIN: '1000',
        // Ticket B13: a fresh Playwright browser context has no stored device token on its one
        // `auth` frame - the server mints and returns one, but the client only ever presents it
        // back on the *next* connection - so every reward claim in this suite is a "no-device"
        // claim, and every spec shares this one loopback IP. Without this override the shared
        // 3-per-IP-per-hour budget (server/limits.js) starves whichever reward-claiming test
        // runs 4th or later, exactly like the four budgets above it.
        MAX_REWARD_CLAIMS_PER_IP_PER_HOUR_NO_DEVICE: '1000',
      },
    },
    {
      // Start the app if nothing is listening; reuse a dev server you already have running.
      command: `npm run dev -- --port ${VITE_PORT} --strictPort`,
      url: BASE_URL,
      reuseExistingServer: true,
      timeout: 60_000,
    },
  ],
});

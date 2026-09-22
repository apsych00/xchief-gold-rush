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
const FAKE_BOXAPI_PORT = process.env.FAKE_BOXAPI_PORT || '9877';
const FAKE_BOXAPI_URL = `http://localhost:${FAKE_BOXAPI_PORT}`;

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
        // Ticket C9: the server builds absolute claim links from PUBLIC_URL; without it a kiosk
        // session that owns an open claim_link crashes when the idle sweep or a frame tries to
        // build claim_url. Point it at the same origin the Vite dev server is serving the SPA from.
        PUBLIC_URL: process.env.PUBLIC_URL || BASE_URL,
        // Every spec talks to the server from 127.0.0.1, so the per-IP windows (ticket S2) would
        // refuse the suite itself; they are exercised on their own terms in
        // test/integration-box/limits.test.mjs. Same override as the integration harness.
        TRUST_PROXY: '0',
        MAX_ANON_PLAYERS_PER_IP_PER_10MIN: '1000',
        MAX_CONNECTIONS_PER_IP_PER_MIN: '1000',
        MAX_SOCKETS_PER_IP: '1000',
        MAX_OTP_REQUESTS_PER_IP_PER_10MIN: '1000',
        // Instagram follow reward via BoxAPI (ticket K3). The E2E suite points the adapter at the
        // fake BoxAPI server defined below; our own handle is the account the fake seeds as
        // 'xchief.global'. The three timing overrides keep the follow check snappy and let the
        // second-try grant spec make two genuine checks without a 20 s wait: a short freshness
        // retry delay, two reads per check, and a short per-player check window.
        BOXAPI_TOKEN: process.env.BOXAPI_TOKEN || 'fake-token',
        BOXAPI_BASE: process.env.BOXAPI_BASE || `${FAKE_BOXAPI_URL}/`,
        INSTAGRAM_HANDLE: process.env.INSTAGRAM_HANDLE || 'xchief.global',
        INSTAGRAM_RETRY_DELAY_MS: process.env.INSTAGRAM_RETRY_DELAY_MS || '200',
        INSTAGRAM_FOLLOWERS_READS: process.env.INSTAGRAM_FOLLOWERS_READS || '2',
        INSTAGRAM_CHECK_INTERVAL_MS: process.env.INSTAGRAM_CHECK_INTERVAL_MS || '1500',
        // Ticket B13: the no-device reward window (legacy clients only; a fresh browser is bound to
        // the device minted at auth). Raised here like the four per-IP budgets above so the suite's
        // shared loopback address can never trip it.
        MAX_REWARD_CLAIMS_PER_IP_PER_HOUR_NO_DEVICE: '1000',
        // Ticket K1: open kiosk route. On by default for the suite. Since S3 retired the
        // ?k=<secret> launch URL, /kiosk is the only way a test can reach kiosk mode at all, so
        // leaving this off silently fails every kiosk spec in its first helper. This is the test
        // server's own environment; the box still defaults to off and is switched on deliberately.
        KIOSK_OPEN_PROVISION: process.env.KIOSK_OPEN_PROVISION || '1',
        KIOSK_OPEN_MAX: process.env.KIOSK_OPEN_MAX || '50',
      },
    },
    {
      // Start the app if nothing is listening; reuse a dev server you already have running.
      command: `npm run dev -- --port ${VITE_PORT} --strictPort`,
      url: BASE_URL,
      reuseExistingServer: true,
      timeout: 60_000,
      env: {
        VITE_GAME_WS: process.env.VITE_GAME_WS || `ws://localhost:${GAME_SERVER_PORT}/ws`,
      },
    },
    {
      // Fake BoxAPI Instagram data-API server for ticket K3 E2E tests.
      command: 'node test/fakes/boxapi.mjs',
      url: `${FAKE_BOXAPI_URL}/health`,
      reuseExistingServer: true,
      timeout: 10_000,
      env: {
        FAKE_BOXAPI_PORT: String(FAKE_BOXAPI_PORT),
      },
    },
  ],
});

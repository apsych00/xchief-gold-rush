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
const GAME_SERVER_URL = `http://localhost:${GAME_SERVER_PORT}/health`;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
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
      },
    },
    {
      // Start the app if nothing is listening; reuse a dev server you already have running.
      command: 'npm run dev -- --port 5173 --strictPort',
      url: BASE_URL,
      reuseExistingServer: true,
      timeout: 60_000,
    },
  ],
});

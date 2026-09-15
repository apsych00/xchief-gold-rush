// E2E scaffold. Targets a running app (BASE_URL) rather than starting one itself, since the
// backend it will eventually exercise (Supabase local stack) isn't wired into CI yet - see the
// TODO block in tests/e2e/smoke.spec.js for the flows that unlock once it is.
import { defineConfig, devices } from '@playwright/test';

const BASE_URL = process.env.BASE_URL || 'http://localhost:5173';

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
});

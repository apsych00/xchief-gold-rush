// Layer 3 scaffold: proves the app boots and renders in a real browser against BASE_URL
// (default http://localhost:5173, a `npm run dev` or `npm run preview` server started separately).
// Deliberately shallow - no backend-dependent flows yet, see the TODO block below.
import { expect, test } from '@playwright/test';

test('home screen renders the game', async ({ page }) => {
  await page.goto('/');

  await expect(page).toHaveTitle(/xChief Gold Rush/);
  await expect(page.locator('.hero-art')).toBeVisible();
  await expect(page.getByText('In 5 seconds, does gold go up or down?')).toBeVisible();
  await expect(page.locator('.btn-start')).toBeVisible();
});

// TODO: flows to add once the Supabase backend (local stack or a deployed dev project) is
// reachable from CI and the client is wired to it. Each needs seeded/disposable test data:
//   - Play a round and see a server-issued verdict (win/lose/flat) rendered, not a client guess.
//   - OTP login: request a code, read it from the local Mailpit/Inbucket inbox, verify, land
//     signed in.
//   - Task claim happens once only: claiming the same task twice is rejected the second time.
//   - Kiosk 5-win streak yields exactly one coupon code, and a repeat streak cannot reclaim it.

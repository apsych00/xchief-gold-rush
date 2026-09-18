# OC Report: Signup mission redirect + 1-hour timer

## What changed

- `src/signupTimer.js` (new): stable localStorage helpers for the signup countdown.
  - Key: `xchief.signup_timer_until`
  - `readSignupTimer()`, `writeSignupTimer(until)`, `clearSignupTimer()`

- `src/Tasks.jsx`
  - Removed `signup` from the OTP/identity branch; the row is now handled by the redirect path.
  - `beginRedirect` detects `row.id === 'signup'`, writes the 1-hour end timestamp to localStorage, and uses a 1-hour window instead of the server's 5-second window.
  - On mount, the stored end timestamp is read back. If it is in the future, the mission shows the remaining time and a `setTimeout` fires `task_return` when it expires. If it is already past, `task_return` is attempted immediately.
  - Added `formatCountdown(ms)` for `h:mm:ss` / `mm:ss` display.
  - Added a cleanup effect: once the server marks the signup task `claimed`, the persisted timer and pending return state are cleared.

- `src/i18n.js`
  - Added `tasks.signupWaiting` for both languages so the disabled timer button reads naturally (`{t} left` / `{t} مانده`).

- `db/seed.sql` and `supabase/seed.sql`
  - Changed the `signup` task from `kind = 'signup'` / `requires_email = true` to `kind = 'redirect'` with URL `https://my.xchief.com/registration?utm_source=goldrush&utm_campaign=goldrush`.
  - Updated seed comments and the `on conflict` update clause to include `kind` and `url`.

- `db/schema.sql`
  - Updated the comment describing task kinds to note that signup is now a redirect task.

## How the 1-hour timer persists across reload

When the player taps the signup mission, `beginRedirect` calls `startTaskVisit('signup')`. After the server acknowledges the visit, it stores `Date.now() + 60 * 60 * 1000` under `xchief.signup_timer_until` and starts the UI countdown.

On component mount, `readSignupTimer()` is checked:

- Future timestamp -> restore `waiting['signup']`, show the remaining time, and schedule `tryReturn('signup')` for the exact remaining duration.
- Past timestamp -> add `'signup'` to pending returns and call `tryReturn('signup')` right away.
- Missing timestamp -> behave normally; the row is available to tap.

A separate effect watches `tasksRows`; once `signup.claimed` becomes true, the storage key is removed and the pending return state is cleaned up.

## How the reward releases

The reward uses the existing redirect-and-return path:

1. Client: `startTaskVisit('signup')` -> server records a row in `public.task_visits`.
2. Client opens `https://my.xchief.com/registration?utm_source=goldrush&utm_campaign=goldrush` in a new tab (`target=_blank`, `noopener`).
3. After the 1-hour window, client calls `returnTaskVisit('signup')`.
4. Server: `return_task_visit('signup')` checks `task_visits.started_at`, sees at least 5 s (in practice 1 hour) have elapsed, and calls `release_task_reward('signup')`, which credits the coins and marks the task claimed.
5. The `me` reply flows through `useGame.js`, which updates `tasksRows` and toasts the reward.

This required a minimal server-side change: the `signup` task's `kind` must be `redirect` and its `url` must be the registration URL, because `start_task_visit` and `return_task_visit` only accept `kind = 'redirect'`.

## Uncertainties / follow-ups

- The server still enforces a 5-second minimum in `return_task_visit`. The client overrides the window to 1 hour for signup, so the minimum is naturally satisfied. I did not change the server's `window_ms` response because the task asked for the minimal server change consistent with the existing redirect flow.

- I left `'signup'` in the `check (kind in (...))` constraint in `db/schema.sql` even though the seeded row no longer uses it. Removing it would be cleaner but is not strictly necessary and could break any environment where an old signup kind row still exists.

- The trader/broke signup prompt in `src/App.jsx` still calls `onOpenIdentity()` for unverified players. The task scope was the Missions/Tasks UI, so I did not change that prompt. If the marketing team wants the same external-link behavior there, it needs a separate ticket.

- I did not run the full test suites (per instructions). The seed change turns signup into a redirect task, so existing tests that expect signup to be released by OTP verify (e.g., `tests/e2e/player-promises.spec.js`) will likely need updating. `npm run lint` and `npm run build` both pass.

- The `supabase/seed.sql` had been inserting tasks without `kind`/`url`, so those rows previously defaulted to `manual`/`null`. I preserved that behavior for all non-signup rows in `supabase/seed.sql` while adding the columns, to avoid changing other task behaviors in that seed path.

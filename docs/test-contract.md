# Test contract

The only document a test author receives. It states what the system promises - never how it is built. Test authors must not open `supabase/migrations/`, `supabase/functions/`, or `src/api/`. If a promise here is ambiguous, ask; do not peek.

## Economy rules

- New player: `coins = 1000`, `record = 1000`, `streak = 0`.
- Stake = `100 x lever`, lever in {1, 2, 5}. A round cannot open if `coins < stake`.
- Combo multiplier depends on the streak **before** the round: streak 0 -> 1x, 1 -> 1.5x, 2 -> 2x, 3 or more -> 3x.
- Win: `coins += round(stake x multiplier)`, `streak += 1`, `wins += 1`. `record = max(record, coins)`.
- Lose: `coins = max(0, coins - stake)`, `streak = 0`. `record` unchanged.
- Flat (end price equals start price): coins, streak, record unchanged.
- Every settled round increments `rounds`. A voided round changes nothing.
- Free refill: `+300` coins, once per player, only when `coins < 100`.
- Task reward is granted once per task per player; tasks with `repeat_ms` may be claimed again after that interval. The `signup` task requires a confirmed email.
- Rate limit: at most 60 rounds per player per rolling hour - the check counts rounds already opened in the last hour, so the 60th open succeeds and the 61st is refused.
- Rounding: `round()` is half-away-from-zero (Postgres `round(numeric)`), so 142.5 -> 143; identical to `Math.round` for positive values.
- Leaderboard: top 10 by `record` descending, ties broken by earliest update; only players with a confirmed email appear; exposes exactly `display_name`, `record`, `rank`.

## Access rules (Postgres roles `anon` and `authenticated`)

- No client role can insert, update, or delete on any table.
- No client role can select `kiosks` or `coupons`.
- `authenticated` can select only its own row in `players`, `rounds`, `task_claims`; `tasks` is readable by both roles.
- `open_round`, `settle_round`, `void_round`, `verify_kiosk`, `open_kiosk_round`, `settle_kiosk_round`, `ensure_player` are **not executable** by `anon` or `authenticated`.
- `get_me`, `claim_task`, `free_refill` are executable by `authenticated` only; `leaderboard` by both.

## Database function contracts (Postgres, schema `public`)

| Function | Returns | Raises |
|---|---|---|
| `open_round(p_player uuid, p_dir text, p_lever int, p_start_price numeric)` | json `{round_id, stake, start_price}` | `bad_dir`, `bad_lever`, `bad_price` (null or <= 0), `insufficient_coins`, `rate_limited`, `round_in_flight` (a second open round for the same player) |
| `settle_round(p_round uuid, p_end_price numeric)` | json `{outcome, delta, mult, coins, streak, record, start_price, end_price}` with outcome in win/lose/flat | `bad_price`, `round_not_open` (already settled, unknown, or a kiosk round) |
| `void_round(p_round uuid)` | void; marks an open round `void`, no ledger change | - |
| `verify_kiosk(p_secret text)` | the kiosk's uuid for an active kiosk whose secret matches | `kiosk_unauthorized` (wrong, revoked, or shorter than 16 chars) |
| `open_kiosk_round(p_kiosk uuid, p_dir text, p_start_price numeric)` | json `{round_id, start_price}` | `bad_dir`, `bad_price`, `kiosk_unauthorized`, `round_in_flight` |
| `settle_kiosk_round(p_round uuid, p_end_price numeric)` | json `{outcome, streak, coupon}`; on the 5th consecutive win `coupon` is a code, the coupon row becomes `claimed` with `claimed_by_kiosk` set, and streak resets to 0; lose resets streak; flat leaves it | `bad_price`, `round_not_open` |
| `get_me()` | the caller's `players` row, created if absent | `unauthenticated` |
| `claim_task(p_task text)` | json `{coins, reward}` | `unauthenticated`, `unknown_task`, `email_required`, `already_claimed` |
| `free_refill()` | json `{coins, reward: 300}` | `unauthenticated`, `refill_unavailable` |
| `leaderboard()` | rows `(display_name, record, rank)` | - |

Concurrency promises: two concurrent claims of the last available coupon yield one code and one `null`; a coupon is never claimed twice; an open round older than 30 s is voided automatically when the same player or kiosk opens a new one.

Fixtures a test may create directly as `postgres`: rows in `auth.users` (an `email_confirmed_at` set or null), `players`, `kiosks` (store `crypt(secret, gen_salt('bf'))` from the `extensions` schema), `coupons`, `tasks`.

## HTTP function contracts (`https://<project>.supabase.co/functions/v1/`)

All accept `POST` JSON and answer JSON; all answer `OPTIONS` with CORS headers.

- `price` -> `200 {symbol, price, t, source}` or `503 {error: "no_price_source"}`. `t` is epoch milliseconds.
- `play-round` (header `Authorization: Bearer <user jwt>`) body `{dir, lever}` -> `200` with the settle json. Errors: `401 unauthenticated`, `400 bad_dir|bad_lever|bad_request`, `409 insufficient_coins|round_in_flight`, `429 rate_limited`, `503 feed_stale`. The response arrives no sooner than 5 seconds after the request; a settled round is recorded even if the caller disconnects.
- `play-round-kiosk` (no auth header) body `{secret, dir}` -> `200 {outcome, streak, coupon}`. Errors: `401 kiosk_unauthorized`, `400 bad_dir`, `409 round_in_flight`, `503 feed_stale`.
- `otp-email` (called by Supabase Auth) body `{user: {email}, email_data: {token}}` -> `200 {}`; `401 invalid_signature` when a signing secret is configured and the signature is wrong; `400 bad_request` when email or token is missing.

## Client module contracts (`src/api/`)

- `enabled`: true only when both `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are set. When false, the game runs fully offline with local scoring.
- `playRound(dir, lever)` resolves to the settle json; rejects with an `Error` whose `.code` is one of the HTTP error codes above.
- `playKioskRound(dir)` resolves to `{outcome, streak, coupon}`.
- `getMe()`, `claimTask(id)`, `freeRefill()`, `getLeaderboard()` mirror the database functions; rejections carry `.code`.
- `requestOtp(email)` then `verifyOtp(email, code)` upgrade an anonymous session to an email session without changing the user id; the 8-digit code is required.

## Player-visible promises (end-to-end)

- Pressing Up or Down shows a 5-second countdown, then a verdict; coins on screen equal the server's `coins` afterwards.
- A dropped connection mid-round never yields a free retry that avoids a loss.
- On a kiosk, the 5th consecutive win displays a code exactly once; the 6th round starts a fresh streak.
- After entering a verified email, the same score appears on the leaderboard under the player's name.

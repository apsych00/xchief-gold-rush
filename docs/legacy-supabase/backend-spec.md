# Backend spec - xChief Gold Rush

Source of truth for the Supabase backend. Encodes the locked decisions. Implementation lives in `supabase/`.

## Invariants (non-negotiable)

1. The server decides every outcome; the client never reports its own result.
2. Supabase owns the entire coin ledger; every coin mutation goes through a server function.
3. A round is one held-open Edge Function call: read a fresh relay price, wait 5s on the server clock, read a fresh price, decide, write, reply.
4. The relay is a read-only price source (`GET /price`); it is never modified.
5. The leaderboard ranks peak balance (`record`).
6. Anti-fraud bar: resist casual poking for ~2 weeks, not Fort Knox. RLS blocks all direct client writes; one round in flight per identity; a stale price voids the round.

## Economy (server is the authority; mirrors `src/config.js`)

- `startCoins = 1000`, `stakeBase = 100`, `levers = [1,2,5]` -> stakes 100/200/500.
- Combo multiplier by prior streak: `[1, 1.5, 2, 3]`, index `min(streak, 3)`.
- Win: `coins += round(stake * comboMult(prevStreak))`; `streak += 1`; `record = max(record, coins)`; `wins += 1`.
- Lose: `coins = max(0, coins - stake)`; `streak = 0`.
- Flat (`start == end`): no coin change; streak unchanged.
- Free refill: `+300` once, only when `coins < 100` and not yet used.
- Tasks: reward per the `tasks` table; one claim per task, or once per `repeat_ms`.
- Soft rate cap: 60 rounds/hour per player (server-enforced, best-effort).

## Tables

All tables have RLS enabled. Clients never write directly; writes happen inside `SECURITY DEFINER` functions and Edge Functions using the service role.

- **players** - `id uuid pk` (= `auth.uid()`), `display_name text`, `email text`, `coins int default 1000`, `record int default 1000`, `streak int default 0`, `best_streak int default 0`, `wins int default 0`, `rounds int default 0`, `free_refill_used bool default false`, `created_at`, `updated_at`.
- **rounds** - `id uuid pk`, `player_id uuid null`, `kiosk_id uuid null`, `dir text`, `lever int`, `stake int`, `start_price numeric`, `end_price numeric`, `start_at timestamptz`, `end_at timestamptz`, `outcome text` (`win|lose|flat|void`), `delta int`, `mult numeric`, `status text default 'open'` (`open|settled`), `created_at`.
  - Partial unique index `uniq_open_round_per_player on rounds(player_id) where status='open'` and the same for `kiosk_id` -> enforces one round in flight per identity.
- **tasks** - `id text pk`, `reward int`, `repeat_ms bigint null`, `requires_email bool default false`. Seeded from `config.js`.
- **task_claims** - `id uuid pk`, `player_id uuid`, `task_id text`, `claimed_at timestamptz`, `reward int`.
- **kiosks** - `id uuid pk`, `label text`, `secret_hash text`, `status text default 'active'` (`active|revoked`), `streak int default 0`, `created_at`.
- **coupons** - `id uuid pk`, `code text unique`, `status text default 'available'` (`available|claimed`), `claimed_by_kiosk uuid null`, `claimed_at timestamptz null`, `created_at`.

### Leaderboard view

`leaderboard` - `select display_name, record, rank() over (order by record desc)` from players where `email is not null`, limited to top 10. `security_invoker = false` so it can read `players` past RLS but exposes only safe columns. `grant select` to `anon, authenticated`.

## RLS policies

- **players**: `select` where `id = auth.uid()`. No client insert/update/delete.
- **rounds**: `select` where `player_id = auth.uid()` (own history). No client writes.
- **task_claims**: `select` where `player_id = auth.uid()`. No client writes.
- **tasks**: `select` to `authenticated` (read config). No writes.
- **kiosks**: no policies -> deny all to anon/authenticated (service role only).
- **coupons**: no policies -> deny all (service role only).

## Functions

### Edge: `play-round` (web, held-open)

1. Verify caller JWT -> `user`. Reject if none.
2. Validate `dir in (up,down)`, `lever in (1,2,5)`.
3. RPC `open_round(user_id, dir, lever, start_price)` - upserts the player row, checks `coins >= stake` and the hourly cap, inserts a round `status='open'` (unique index rejects a second open round -> `round_in_flight`). Start price read from relay `/price`; if stale (`> 3s old`) -> void, return `feed_stale`.
4. `await sleep(5000)`.
5. Read relay `/price` again -> `end_price`; if stale -> RPC `void_round(round_id)`, return `feed_stale`.
6. RPC `settle_round(round_id, end_price)` - atomically computes outcome + economy, updates player (`coins/record/streak/best_streak/wins/rounds`), marks round `settled`, returns the verdict.
7. Reply `{ outcome, delta, coins, streak, record, start_price, end_price }`.

Client disconnect after step 3 does not dodge the loss: the function runs to completion server-side and settles.

### Edge: `play-round-kiosk`

1. Validate kiosk secret -> `kiosk` (hash compare, `status='active'`). Reject otherwise.
2. Validate `dir`.
3. `open_round` for the kiosk (start price, one-in-flight per kiosk).
4. Wait 5s; read end price (stale -> void).
5. RPC `settle_kiosk_round(round_id, end_price)`:
   - Win -> `kiosks.streak += 1`; if `streak == 5` atomically claim one coupon (`update coupons set status='claimed' ... where id = (select id from coupons where status='available' limit 1 for update skip locked) returning code`) and reset `streak = 0`.
   - Lose -> `streak = 0`. Flat -> unchanged.
6. Reply `{ outcome, streak, coupon? }`. Coins/levers are ignored for kiosk (client cosmetic only; kiosk is unranked).

### Edge: `otp-email` (Supabase Send Email Hook)

Receives the Auth hook payload `{ user, email_data: { otp / token, ... } }`. POSTs to `https://api.elasticemail.com/v2/email/send` with `apikey=ELASTIC_API_KEY`, `to=<email>`, `from=OTP_SENDER`, `template=gold_rush_otp`, `merge_otp_code=<otp>`. Returns 200 on success. Never logs the code.

### RPC (SECURITY DEFINER): `claim_task(task_id)`

Auth via `auth.uid()`. Looks up `tasks`; if `requires_email` and the user is not email-verified -> reject. Checks `task_claims` for a prior claim within `repeat_ms` -> reject if too soon. Inserts a claim, adds `reward` to `coins` and bumps `record`. Returns new balance. (`signup` task is `requires_email = true`.)

### RPC (SECURITY DEFINER): `free_refill()`

Auth via `auth.uid()`. If `free_refill_used` or `coins >= 100` -> reject. Else `coins += 300`, `free_refill_used = true`, bump `record`. Returns new balance.

## Auth

- Email OTP (Supabase built-in). Web journey: play-first via anonymous sign-in, upgraded to email on OTP verify (pending final confirm; schema is identical either way since players keys on `auth.uid()`).
- Kiosk: bearer secret baked into the launch URL, stored as a hash in `kiosks`, checked on every kiosk call.

## Seed

- `tasks` from `config.js` (ids, rewards, repeat_ms, `signup.requires_email = true`).
- `coupons` from the provided code list (test codes in dev).
- one `kiosks` row with a generated secret (hash stored; raw secret handed over once for the launch URL).

## Directory layout

```
supabase/
  config.toml
  migrations/
    0001_schema.sql          -- tables + indexes
    0002_rls.sql             -- enable RLS + policies + leaderboard view
    0003_functions.sql       -- open_round, settle_round, settle_kiosk_round, void_round, claim_task, free_refill
  functions/
    play-round/index.ts
    play-round-kiosk/index.ts
    otp-email/index.ts
  seed.sql
tests/                        -- pgTAP for DB, Deno tests for functions, Playwright for E2E
```

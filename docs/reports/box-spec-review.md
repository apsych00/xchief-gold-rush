# Adversarial review: `docs/box-spec.md` (the one-box design)

- Target: `docs/box-spec.md` as it stands in this worktree, read against `docs/backend-spec.md`,
  `docs/test-contract.md`, `docs/journeys-and-architecture.md`, `docs/reports/redteam.md`,
  `relay/server.js`, `supabase/migrations/0001..0007`, `supabase/tests/*`, `test/*`, `tests/e2e/*`,
  `src/useGame.js`, `src/priceFeed.js`, `src/api/*`, `src/leads.js`, `vercel.json`, `api/lead.js`.
- Reviewer model (confirmed in transcript, `message.model`): `claude-opus-5` (Opus).
- Date: 2026-09-16. Method: static read only. Nothing was built, modified or committed.
  `.env` was never opened; the two test harnesses that read it were read as source, not run.
- Brief respected: findings are tagged **L1** when they would make the first playtest
  non-functional, non-smooth, or wrong in a way that is expensive to undo. Pure security items are
  pushed into Layer 2 ticket suggestions at the end, not used to block Layer 1.

---

## Bad news first

The spec's single most load-bearing sentence is wrong, and it is wrong in the direction that costs
the most time:

> `supabase/migrations/0001..0007` -> `db/migrations/` with **one edit**: `players.id` no longer
> references `auth.users`; `ensure_player` takes the email from `players`. Grants and revokes
> naming `anon`/`authenticated` are dropped.

That is not one edit and it is not sufficient. On plain Postgres, migration `0002` **fails to
apply at all** (it creates policies `to authenticated`, a role that does not exist, whose
expressions call `auth.uid()`, a function that does not exist). Four of the server functions cannot
execute (`get_me`, `claim_task`, `free_refill` read `auth.uid()`; `ensure_player`, and therefore
`open_round` through it, reads `auth.users`). The proposed replacement for `ensure_player` is
circular: its job is to create the `players` row, so "takes the email from `players`" means a
brand-new player's first `open_round` raises `unknown_user`. And the migration edits also touch the
`requires_email` gate, the pgTAP fixtures, and four pgTAP suites whose entire subject is the roles
being deleted.

Worse, the spec's own dev plan hides this: *"until Docker is repaired on this machine it runs
against the existing dev database through `DATABASE_URL`"*. That database is the Supabase dev
project. It **has** `auth.users`, `auth.uid()`, `anon` and `authenticated`. Layer 1 would be built
and demoed green against the one database in the world where this class of bug is invisible, and
would break the first time it meets `postgres:16`. That is precisely the "halfway through the
build" failure this review was commissioned to prevent.

Second: the feed rules as written make a cross-source round the **default** outcome rather than an
edge case, and make `feed_stale` dead code. Details in B1. That one breaks the game's fairness
invariant in production, silently, for free, several times an hour.

Third: moving the host off Vercel deletes `/api/lead` with no replacement, and `src/leads.js`
swallows the failure (`.catch(() => {})`). Every email capture and every in-game xChief signup -
the campaign's commercial purpose - is lost with no error anywhere. The spec does not mention it.

---

## Severity table

| # | Sev | Layer | Finding |
|---|-----|-------|---------|
| B1 | **Blocker** | L1 | 3 s fallback + "latest tick at T0+5000" settles rounds across XAU and PAXG, and makes `feed_stale` unreachable |
| B2 | **Blocker** | L1 | Migrations do not apply and four functions do not run off Supabase: `auth.uid()`, `auth.users`, roles `anon`/`authenticated`, `create policy ... to authenticated` |
| B3 | **Blocker** | L1 | Leaving Vercel deletes `/api/lead`; `src/leads.js` swallows the error, so all leads and signups vanish silently |
| B4 | **Blocker** | L1 | "Run against the existing dev database" means developing against Supabase, which hides B2 until deploy day |
| H1 | High | L1 | 60 rounds/hour server cap makes the stated acceptance run ("nine browsers play for ten minutes with zero errors") fail by construction |
| H2 | High | L1 | Multi-kiosk is unspecified: 5 kiosk browsers on one secret share one identity, so they collide on `round_in_flight` and on one coupon streak |
| H3 | High | L1 | The client feed is an independent, partly **simulated** price stream (quiet layer, demo mode, direct OKX/Binance/Kraken sockets). Chart and verdict will disagree. `src/priceFeed.js` is never named in the spec |
| H4 | High | L1 | Kiosk verdicts are computed on the client today (`applyVerdict` uses `priceRef.current` as the end price and does the coin math locally); the spec does not say to remove it |
| H5 | High | L1 | If a timer fires after the 30 s ring buffer has rolled past T0+5000, "latest tick" settles from an unrelated price. Must void |
| H6 | High | L1 | No booth fallback: one VPS behind venue wifi. If the expo network drops, the game and the coupons are dead with no local mode |
| H7 | High | L1 | Coupon exhaustion silently eats a five-win streak (`v_code` null, streak still reset to 0). The spec files this as cosmetic L2 |
| H8 | High | L1 | The first-connect bootstrap is unspecified: `auth {token}` is defined but there is no frame for "I have no token" and no frame that delivers one |
| H9 | High | L1 | "The existing suites with the role edits" / "existing Playwright promises, unchanged in intent" understates a near-total rewrite; done lazily it produces a green suite that tests nothing |
| M1 | Medium | L1 | `otp_codes(email, code_hash, expires_at, player_id)` does not exist in any migration and conflicts with `dev_otps(email, token)` |
| M2 | Medium | L1 | No unique index on `players.email`. S4 (merge rule) is L2, so duplicates accumulate before the rule exists |
| M3 | Medium | L1 | Every anonymous player is named `Player`; nothing sets a display name on OTP verify. A leaderboard of ten "Player" rows |
| M4 | Medium | L1 | No request correlation id: `error {code}` cannot be attributed to the frame that caused it |
| M5 | Medium | L1 | Ring buffer sized in seconds, not entries; no broadcast throttle. The PAXG fallback ticks far faster than XAU, so the weekend path is also the highest-load path |
| M6 | Medium | L1 | pgTAP is not in `postgres:16` and `00_helpers.sql` asks for `with schema extensions`; `db/tests/` cannot run as specified |
| M7 | Medium | L1 | Caddyfile sketch has no SPA `try_files`, no cache-control parity with `vercel.json` (stale kiosk bundles), and no defined path for getting a build into `/srv/app` while the marketing lead owns the frontend |
| M8 | Medium | L1 | The client countdown is anchored to the click, not to `round_opened.start_at` / `start_price`; wrong start line plus a visible freeze at 0.0 |
| M9 | Medium | L1 | `pending_verdict` is implied to live in memory; a restart loses it and coins jump with no explanation. It is already in `rounds` |
| M10 | Medium | L1 | `src/api/client.js` `enabled` is `Boolean(VITE_SUPABASE_URL && VITE_SUPABASE_ANON_KEY)`. Unchanged, the whole app silently runs offline-with-local-scoring and every screen looks correct |
| M11 | Medium | L1 | Kiosk streak never resets between players; the journey doc's "next player starts fresh" is not implemented and the box spec inherits the gap |
| M12 | Medium | L1 | Forex silence is not only the weekend: there is a daily broker break around 21:00-22:00 UTC, and the Friday close moves with DST. Do not hardcode the schedule |
| M13 | Medium | L1 | Planned load is 100 concurrent; the acceptance run is 9 browsers. Nothing in Layer 1 exercises the stated capacity |
| L1a | Low | L1 | `PLAYER_TOKEN_SECRET` must make the process refuse to start when unset, not fall back to a default |
| L1b | Low | L1 | `broadcast()` never checks `bufferedAmount`; a wedged kiosk socket grows unbounded |
| L1c | Low | L1 | Use a monotonic clock for the 5 s and the buffer; `Date.now()` steps under NTP |
| L1d | Low | L1 | Finnhub forex (`OANDA:XAU_USD`) is a paid-tier symbol, and Finnhub sends its own `ping` frames. Confirm the plan, or the "9 ticks per 5 s" premise is not reproducible |
| L1e | Low | L1 | `scripts/gen-kiosk.mjs`, `load-coupons.mjs`, `peek-otp.mjs`, `export-coupons.mjs` are Supabase-only. The lead needs all four at the booth |
| L1f | Low | L1 | `supabase/config.toml` sets `otp_length = 6` while the contract and the spec say 8 digits |
| L1g | Low | L2 | The hourly cap counts voided rounds against the player (carry-over of redteam F5) |
| L1h | Low | L1 | "Flat" needs a one-line definition: exact equality **on the same source**, no epsilon deadband |

---

## 1. The feed

### B1 (Blocker, L1) - the 3 s fallback and the settle rule combine into cross-source rounds

The spec states two rules that contradict each other:

- *"Fallback chain when Finnhub is silent for 3 s: OKX PAXG mid, then Binance PAXG mid."*
- *"If no tick has arrived in the last 3 s at either moment, the round is void (`feed_stale`)."*

If Finnhub goes quiet for 3 s, the feed has **already** promoted PAXG, so "the last tick" is a
fresh PAXG tick and the round is not void. `feed_stale` therefore cannot fire while any PAXG
exchange is alive - which is always, because PAXG trades 24/7. The stale-void path is dead code,
and the actual behaviour is: a round that opened on XAU/USD at 4355.60 settles on PAXG/USDT at
4348.10. That is a guaranteed "down", decided by the source switch, not by the market.

`relay/server.js` makes this concrete. `onTick` writes `state.price` from whichever source is
currently best, with no memory of what the previous source was:

```js
const best = bestSource();
if (!best || best.id !== src.id) return;
state.price = parsed.price;
state.symbol = src.symbol;   // flips XAU/USD -> PAXG/USD mid-stream
```

and promotion back to Finnhub happens on the very next Finnhub tick, because `lastTick` is updated
for demoted sources too. With a 3 s threshold, XAU quote gaps of 3-10 s are routine outside the
London/New York overlap, so the feed will flap between sources many times an hour, mispricing every
round open at each flap.

Note also that the relay ships `STALE_MS = 20000`, not 3000. The spec's 3 s is a change, and it is
the change that turns an occasional event into a constant one.

**Fix (L1, cheap now, expensive later):** pin a round to a source.

1. Every ring-buffer entry carries `{price, t, sourceId}`.
2. `open_round` records the `sourceId` of its start tick on the round.
3. At `T0+5000`, settle from the **latest tick of that same source** at or before `T0+5000`.
4. If that source has no tick within 3 s of `T0+5000`, the round is `feed_stale` and voids. This
   restores `feed_stale` as a live path and makes a cross-source round structurally impossible.
5. Raise the promotion/demotion threshold to something like 10 s, and never switch the *published*
   source while a round is open against it; a switch affects only rounds opened after it.

### On "latest tick at T0+5000" versus the alternatives

| Rule | Settles on time | End price freshness | Feel |
|---|---|---|---|
| Latest tick at or before `T0+5000` (the spec) | Yes, exactly | 0-550 ms stale at 9 ticks/5 s | Best; verdict lands as the countdown ends |
| First tick at or after `T0+5000` | No, late by 0-550 ms (unbounded if quiet) | Perfectly fresh | Adds a variable dead pause; worse |
| Mid or VWAP of the last N ticks | Yes | n/a | Destroys "I watched the line go up"; do not |

The spec picked the right one. Keep it, and add the two things it is missing: the source pin (B1)
and the buffer-coverage guard (H5). Also state that the server sends its chosen `start_price` and
`end_price` in `round_opened` / `round_settled` and that the client renders **those**, snapping its
chart to them, rather than whatever tick it happened to hold.

### What "flat" should mean at 9 ticks per 5 s (L1h)

Flat = `end_price = start_price` exactly, on the same source. Do not add an epsilon deadband: an
epsilon is what recreates the 40 % flat problem that killed the serverless design. At OANDA XAU
2-decimal quoting with ~9 distinct changes per 5 s, exact equality should be low single-digit
percent; on a PAXG mid (a full float) it is effectively zero. The acceptance run should **record the
observed flat rate** rather than assert a threshold nobody has measured yet.

One honest consequence to write down: with the source pin, a 5 s window in which the pinned source
produced only the opening tick yields `start = end` -> flat, and that is correct. Flat means "no new
information", not "no move".

### H5 (High, L1) - the timer can outlive the buffer

`setTimeout(5000)` under a stalled event loop, a saturated pg pool, or a container pause can fire
well after `T0+5000`. A 30 s buffer at ~1.8 ticks/s holds roughly 54 entries; once the buffer has
rolled past `T0+5000` there is no correct end price, but "latest tick" still returns one - an
arbitrary later price. **Rule to add: if the buffer no longer covers `T0+5000`, void the round.**
This is the same honesty argument the spec already makes for restart-voids-open-rounds.

### M5 (Medium, L1) - buffer and broadcast sizing assume the XAU tick rate

The buffer is specified in seconds and the fan-out is unthrottled. XAU at ~1.8 ticks/s is nothing;
OKX `tickers` and Binance `bookTicker` on PAXG deliver several updates per second each, and the
fallback is live exactly when both are. At 100 clients that is the difference between ~180 frames/s
and a few thousand. Cap the buffer by entries as well as seconds, and coalesce the broadcast to at
most ~20 ticks/s (the UI redraws at 60 fps from local interpolation anyway). Pre-serialize once per
tick, as `relay/server.js` already does.

### M12 (Medium, L1) - the closure window is not only the weekend

The spec hardcodes *"Fri 22:00 UTC to Sun 22:00 UTC"*. Two corrections: the Friday close moves with
US daylight saving (21:00 UTC in summer), and most brokers have a **daily** break of roughly an hour
around 21:00-22:00 UTC. So the source switch is a daily event, not a weekly one. Do not encode a
calendar at all - detect silence, which the design already does. Just size the threshold for it (B1)
and label the source on screen, which the spec already says.

### L1d (Low, L1) - confirm the Finnhub plan

`OANDA:XAU_USD` over `wss://ws.finnhub.io` is not on Finnhub's free tier; a free token accepts the
subscribe and then delivers nothing, and the box would run on PAXG permanently while the config says
"Finnhub enabled". The measured "~9 distinct changes per 5 s" implies a paid key. Confirm which key
the box will hold, and have the server log per-source tick counts once a minute so this failure is
visible rather than silent. Finnhub also sends `{"type":"ping"}` frames; `parse()` already ignores
them, keep it that way.

---

## 2. Rounds in memory

**Timer accuracy at 100 concurrent (fine).** 100 outstanding `setTimeout`s is nothing for Node;
timer drift is single-digit ms. At 100 players on 5 s rounds the steady state is ~20 opens/s and ~20
settles/s, about 40 pg round trips per second. A 4 vCPU box with a small pool handles that with room
to spare. The risk is not the timer count, it is what runs between the timer firing and the settle
landing.

**Event-loop stalls during pg calls (real, manageable).** Everything is async, so a slow pg call does
not block other timers - it delays that one settle. Two things the spec must add:

- A pool size and a `statement_timeout`. Without one, a single lock wait (`select ... for update` on
  a hot player row) can pin a connection and cascade into missed settles.
- What the server does when `settle_round` throws. The spec is silent. It must distinguish
  `round_not_open` (already settled - log and drop, at-most-once held) from a transport error (retry
  once, then void and tell the client).

**At-most-once settlement (held, by the DB).** `settle_round` takes `select ... for update` on the
round and rejects anything not `status='open'`, so a double fire raises `round_not_open`. Keep that
as the guarantee; do **not** add an in-memory "already settled" set as the primary guard.

**Restart voids open rounds (correct, with one caveat).** As written it is a blanket
`update rounds set outcome='void' where status='open'`. That is right for one process and wrong the
moment compose ever runs two containers during a redeploy. State "exactly one game server process"
as an invariant in the spec, because the whole design (in-memory rounds, in-memory timers, one
upstream socket) depends on it.

**The 30 s orphan void versus in-memory timers (benign, one hole).** `0004` voids a player's
leftovers only when that same player opens a new round. With the box's boot-void, orphans are rare.
The residual is redteam F3 unchanged: a failed settle leaves an open round that later voids, erasing
a loss. On the box this is *more* reachable than on Supabase, because the settle is a plain
`setTimeout` in a process the operator restarts by hand. Mitigation is H5 plus logging every orphan
void as an audit line, so an unexpected rate is visible (this is what S7's alerting should watch).

**M9 (Medium, L1) - `pending_verdict` must not live only in memory.** The spec says *"on the next
`auth`, the server sends `me` and, once, any `round_settled` the client missed"*. Two problems:
"once" loses the verdict if the client reconnects twice in a row (a mobile network handover does
exactly this), and a restart between settle and reconnect loses it entirely - the player sees their
coins change with no round. The verdict is already durable: it is the last `settled` row in
`rounds`. Specify: on `auth`, the server sends `me` plus the player's most recent settled round as
`round_settled` when its id differs from the client's `last_round_id` (sent in the `auth` frame).
Idempotent, restart-proof, no extra state.

---

## 3. The socket protocol

The frame list is close to complete. What is missing:

**H8 (High, L1) - there is no way to get a first token.** `auth {token}` and `auth {kiosk}` are
specified; 1.5 says *"First visit: the server creates an anonymous player and returns a player
token"* but no frame carries it and `hello` does not include it. A builder stops here. Specify
exactly one of: `auth {}` (no token) -> server mints a player and replies `me {..., token}`; or a
distinct `hello_anon` request. Also specify what happens when `auth {token}` carries a token signed
with a rotated secret: treat as absent, mint a new player, do not error the socket.

**M4 (Medium, L1) - no correlation id.** `error {code}` is unattributable. A client with `get_me`
and `play` in flight cannot tell which failed, and `useGame` needs to know whether to cancel the
countdown. Add a client-supplied `req_id` on every client frame, echoed on `round_opened`, `me`,
`leaderboard` and `error`. Two lines now; a protocol version bump later.

**Ordering (fine).** A WebSocket preserves order per connection, so `round_opened` always precedes
`round_settled`. `price` frames interleave; the client must ignore them for settlement and use the
server's `end_price`.

**Backpressure at 100 clients (fine at XAU rates; add the guard anyway).** ~1.8 frames/s x 100
clients is trivial. `broadcast()` in `relay/server.js` sends without checking `bufferedAmount`; on
expo wifi a wedged kiosk accumulates. Add: skip the price frame when `bufferedAmount` exceeds a
threshold. Dropping a price tick is harmless; dropping `round_settled` is not, so never skip
non-price frames.

**What the client shows between open and settle - and M8.** This is the smoothness question and the
spec answers it only half way. Today `useGame.startRound` sets `start = priceRef.current` at click
time and starts `performance.now()`. On the box:

- the server's start price is the tick it saw at `open_round`, which is not the tick the client held
  at click time, so the chart's start line is wrong;
- the client's countdown starts at click, the server's at `open_round`, so the client reaches 0.0
  roughly 50-250 ms before the verdict can exist, and then holds at "0.0" until `round_settled`
  lands at 5.0-5.3 s.

A frozen "0.0" on every single round is exactly what the lead will call unsmooth. Fix in L1: on
`round_opened`, re-anchor `state.start` to `start_price` and restart the countdown from `start_at`,
and make the last ~400 ms a "settling" animation rather than a number that stops. "Under 50 ms on
the box" is a fine target for `round_opened`; specify what the client does when it is slow - if
`round_opened` has not arrived within 1 s, cancel the visual round and show the error, rather than
running a 5 s countdown for a round that may not exist.

---

## 4. Login

**H8** above covers the missing bootstrap frame. Beyond it:

**M1 (Medium, L1) - `otp_codes` does not exist.** The spec names
`otp_codes(email, code_hash, expires_at, player_id)`. No migration creates it. `0006` creates
`dev_otps(email, token, created_at)` with a plaintext token - a different table for a different
purpose. Decide: one table with `code_hash` plus a dev-only plaintext column, or two. Either way it
needs `db/migrations/0008_otp_codes.sql` written now, not discovered mid-build. Specify the index
(`email, created_at desc`), the expiry sweep, and that a successful verify marks the row used so a
code cannot be replayed inside its 10 minutes.

**OTP without Elastic in dev (works, but not "as today").** "As today" meant the Supabase auth hook
wrote `dev_otps`. On the box there is no hook; the game server generates, stores and sends the code
itself. That is simpler and better - say so explicitly, and say that `scripts/peek-otp.mjs` must be
ported to `DATABASE_URL` or the dev login loop has no way to read the code (L1e).

**M2 (Medium, L1) - add `unique (lower(email)) where email is not null` on `players` now.** The
merge rule is correctly deferred to S4, but the *constraint* is not a security control, it is a
data-shape decision. Without it two players can both verify the same address and both appear on a
prize leaderboard, and by the time S4 is built the data is already ambiguous. Adding the index in L1
costs one line and turns the problem into a clean `email_taken` error that S4 then replaces with a
merge.

**M3 (Medium, L1) - display names.** `ensure_player` derives `display_name` from the email local
part; an anonymous box player has no email, so every player is `Player`. The leaderboard then shows
ten rows of "Player", and `useGame.refreshLeaderboard` filters rows by `display_name === me`, so it
would hide all of them. Specify: `verify_otp` sets `display_name` from the email local part when it
is still the default, and/or the client asks for a name at the email prompt. This is visible on the
first screenshot the lead takes.

**L1f** - `supabase/config.toml` says `otp_length = 6`; the contract says 8. On the box the server
generates the code, so pick 8 and delete the ambiguity.

---

## 5. Kiosk auth and multi-kiosk

**H2 (High, L1) - multi-kiosk is undefined, and the acceptance run depends on it.** The criterion is
*"nine browsers (5 kiosk, 4 web) play for ten minutes with zero errors"*. Kiosk identity is the
`kiosks` row. If those five browsers share one launch secret:

- they share `uniq_open_round_per_kiosk`, so the second concurrent `play` gets `round_in_flight` -
  the demo produces errors continuously, by construction;
- they share `kiosks.streak`, so five players' wins pool into one coupon streak and the $100 goes to
  whoever happens to press at the right moment.

The spec must state: **one `kiosks` row and one launch secret per physical device**, how many devices
the booth will have, and that `scripts/gen-kiosk.mjs` is ported to `DATABASE_URL` (L1e) so the lead
can mint them alone.

**M11 (Medium, L1) - the streak never resets between players.**
`journeys-and-architecture.md` promises *"Next player starts fresh"*. Nothing implements it:
`settle_kiosk_round` resets only on a loss or on a coupon. Player A wins four and walks away; player
B wins one and takes the $100. At a booth this happens on day one. Cheapest honest fix in L1: reset
the kiosk streak after N seconds of kiosk idleness (the server holds the socket, so it knows), or on
an explicit "new player" tap. Pick one and write it down.

**Kiosk auth itself (held, and improved by the box).** `verify_kiosk` bcrypt-compares against every
active kiosk row; on the box it runs **once per socket** instead of once per round, which is strictly
better than the Supabase design. Keep `length < 16 -> kiosk_unauthorized`. With one row per device
the linear scan is irrelevant.

**H7 (High, L1) - coupon exhaustion is not cosmetic.** The seed loads 100 codes. When they run out,
`settle_kiosk_round` returns `coupon: null` **and still resets the streak to 0**. The player wins
five in a row in front of a crowd, the screen says nothing, and their streak is gone. S9 files this
as a Layer 2 product decision; the silent streak reset is a Layer 1 correctness bug. Minimum for L1:
return a distinct marker (`coupon: null, coupon_exhausted: true`), do not reset the streak on
exhaustion, and log it loudly. The message wording can stay S9.

---

## 6. The migration edits (the real trap)

### B2 (Blocker, L1) - the full dependency list

Every place the SQL reaches for something that exists only inside Supabase:

| File | Code | Breaks how |
|---|---|---|
| `0001_schema.sql` | `players.id uuid primary key references auth.users (id)` | `relation "auth.users" does not exist` - the spec catches this one |
| `0002_rls.sql` | `revoke ... from anon, authenticated` (x2) | `role "anon" does not exist` - spec catches it |
| `0002_rls.sql` | `create policy players_select_own ... for select to authenticated using (id = auth.uid())` | **Two** failures: the role, and `function auth.uid() does not exist` at policy-creation time. The spec does **not** catch it (it says "grants and revokes") |
| `0002_rls.sql` | `rounds_select_own`, `task_claims_select_own`, `tasks_select_all` | same |
| `0002_rls.sql` | `grant select on public.leaderboard to anon, authenticated` | same |
| `0003_functions.sql` | `ensure_player`: `select email, email_confirmed_at ... from auth.users`, `raise 'unknown_user'` | Every `open_round`, `get_me`, `claim_task`, `free_refill` goes through it. **This is the one that silently breaks round opening** |
| `0003_functions.sql` | `get_me()`: `if auth.uid() is null`, `where id = auth.uid()` | Function does not exist off Supabase |
| `0003_functions.sql` | `claim_task()`: `v_uid uuid := auth.uid()` **and** `select email_confirmed_at from auth.users` for `requires_email` | The `signup` task gate has no source of truth on the box |
| `0003_functions.sql` | `free_refill()`: `v_uid uuid := auth.uid()` | same |
| `0003_functions.sql` | trailing `revoke ... from public, anon, authenticated` (x3 blocks) | role errors |
| `0004_orphan_rounds.sql` | `revoke ... from public, anon, authenticated` | role errors |
| `0005_lint_and_crypt.sql` | `set search_path = public, extensions`; `revoke/grant ... anon, authenticated` | role errors (a non-existent schema in a search_path is harmlessly ignored) |
| `0006_dev_otps.sql` | `revoke all ... from public, anon, authenticated` | role errors |
| `0007_claim_task_lock.sql` | `auth.uid()`, `auth.users`, `revoke/grant ... anon, authenticated` | same as `0003` |
| `supabase/tests/00_helpers.sql` | `create extension pgtap with schema extensions`; `insert into auth.users (instance_id, aud, role, ...)` | pgTAP is not in `postgres:16`; `extensions` schema absent; every fixture identity is an `auth.users` row |
| `supabase/tests/10,15,20,45` | `set local role anon` / `authenticated` | The entire subject of four of nine suites |

### The cheap fix the spec missed: emulate, do not amputate

Deleting the roles and re-signing the functions means changing the signature of `get_me`,
`claim_task` and `free_refill` to take a player id - which moves identity **from the session into an
argument**, deletes four pgTAP suites, invalidates the "Access rules" section of
`docs/test-contract.md`, and makes Layer 2's S5 (least privilege) a from-scratch job.

The alternative is about twenty lines and keeps `0001..0007` almost byte-identical:

```sql
-- db/migrations/0000_supabase_compat.sql  (runs first)
create schema if not exists auth;
create schema if not exists extensions;
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;

-- Identity comes from the transaction's setting, never from an argument.
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('app.player_id', true), '')::uuid
$$;

-- Only what ensure_player reads. The game server owns this table.
create table auth.users (
  id uuid primary key,
  email text,
  email_confirmed_at timestamptz
);
```

The game server then wraps every client-identity RPC in an explicit transaction that runs
`select set_config('app.player_id', $1, true)` (`true` = `SET LOCAL`, so it cannot leak across pool
checkouts) before calling `get_me()` / `claim_task()` / `free_refill()`. The invariant is
*strengthened*, not weakened: the client still cannot name its own identity, and the server-only
functions (`open_round`, `settle_round`, ...) keep taking the id as an argument exactly as they do
now, because the server is their only caller.

`create extension pgcrypto` resolves into `public` on vanilla Postgres, and `0005`'s
`search_path = public, extensions` keeps working once the `extensions` schema exists.

What this buys: `0001..0007` need one real edit (drop the `references auth.users` clause, because on
the box the `auth.users` row is written after the player row, not before), the pgTAP suites run
unchanged, `docs/test-contract.md` stays true, and S5 has a foundation. What it costs: an `auth`
schema on a box with no auth service, which reads oddly and must be commented as a deliberate
compatibility shim.

If the orchestrator prefers the clean break, that is defensible - but the spec must then say so and
budget for: new signatures for three functions, a rewrite of `ensure_player`, a
`players.email is not null` replacement for the `requires_email` gate, deletion of four pgTAP
suites, replacement fixtures in `00_helpers.sql`, and an edit to `docs/test-contract.md`. It is not
"one edit" under either option.

### B4 (Blocker, L1) - do not develop against the Supabase dev database

*"until Docker is repaired on this machine it runs against the existing dev database through
`DATABASE_URL`"* guarantees B2 stays invisible. That database has `auth.users`, `auth.uid()` and
both roles, so every function works there and fails on `postgres:16`. It also means the box server
and the still-deployed Supabase edge functions write the same ledger concurrently.

Repairing Docker is on the critical path. If it is genuinely blocked, the fallback is a local
Postgres 16 (any install, no Docker) with a throwaway database - not Supabase. Getting the shim or
the rewrite right on real Postgres is the first ticket, before any server code.

---

## 7. Docker, compose and Caddy

**Caddy and WebSockets: fine.** Caddy v2's `reverse_proxy` upgrades WebSockets with no extra
directives, and there is no default idle timeout to trip over. The 25 s server ping already in
`relay/server.js` handles intermediaries that do have one. Keep it.

**M7 (Medium, L1) - what the Caddyfile sketch is missing.**

- `try_files {path} /index.html` for the SPA, or every deep link and every kiosk reload 404s.
- Cache-control parity with `vercel.json`: `index.html`, `/af/index.html`, `version.json` and
  `manifest.webmanifest` must be `no-store`, `/assets/*` immutable. Without this a kiosk that
  reloads after a deploy can hold a stale `index.html` pointing at deleted hashed assets, and a
  booth device stuck on an old bundle is an expensive way to learn about caching.
- Matcher order: `handle /ws*` before the file server, or the static handler claims it.
- `tls <domain>` requires public DNS and inbound 80/443 at first boot. State the dev and offline
  profiles (`tls internal`, or an http-only compose override), or the first `docker compose up` on a
  laptop fails on certificate issuance.
- **How does the built app get into `/srv/app`?** The marketing lead owns the frontend and is
  actively changing it. Today they push and Vercel deploys. The spec never replaces that loop. If
  the answer is "an agent rsyncs a build", the lead is now blocked on an agent for every asset
  change. Answer this before Layer 1, because it changes who can ship.

**B3 (Blocker, L1) - `/api/lead` disappears.** `api/lead.js` is a Vercel serverless function;
`src/leads.js` posts to `/api/lead` and swallows every failure:

```js
function ship(payload) {
  fetch('/api/lead', { method: 'POST', /* ... */ }).catch(() => {});
}
```

On the box, Caddy's file server answers `/api/lead` with 404, the `.catch` eats it, and every email
capture and in-game xChief signup is lost with no error in any log. That is the campaign's
commercial output. Either keep Vercel as the frontend host and point only `/ws` at the box, or port
`api/lead.js` into the game server as a route (it is short, and needs `LEAD_WEBHOOK_URL` /
`LEAD_WEBHOOK_SECRET` in the box env). Decide in the spec; do not discover it at the booth.

**M6 (Medium, L1) - `postgres:16` cannot run the DB tests.** The official image ships contrib (so
`pgcrypto` is fine) but not pgTAP. `db/tests/` therefore needs either a small Dockerfile
(`FROM postgres:16` plus `postgresql-16-pgtap`) or a decision to drop pgTAP and port the assertions
to Node integration tests against `DATABASE_URL`. The spec assumes the suites just run.

**Compose details to pin now:** a named `pgdata` volume (a bind mount on a VPS with the wrong uid is
the classic first-boot failure), `restart: unless-stopped` on all three services, `depends_on` with a
Postgres healthcheck so the server does not boot-void against a database that is not up, `shm_size`
for Postgres, and bounded log rotation (a month of price-tick logging on an 8 GB VPS will fill the
disk at json-file defaults).

---

## 8. The Layer 1 test list - how a broken build looks green

The list is directionally right and materially incomplete. The dangerous part is the two
reassurances:

> pgTAP: the existing suites with the role edits.
> E2E: the existing Playwright promises, unchanged in intent.

**H9 (High, L1).** Neither is true.

- `test/integration/*.test.mjs` (4 files) target
  `https://<project>.supabase.co/functions/v1/...` with an anon key read from `.env`. On the box
  there are no HTTP function endpoints at all. These four files are **dead**, not edited.
- `tests/e2e/player-promises.spec.js` verifies server state by reading the Supabase session token
  from a `sb-*-auth-token` localStorage key and POSTing to `/rest/v1/rpc/get_me`. The box has no REST
  API. Its whole blind server-side verification recipe must be replaced - most likely by a second
  WebSocket client inside the test, or by `psql`. Note the file currently fails closed with a good
  message ("client is not wired to Supabase..."); a lazy port that deletes that assertion is exactly
  how this goes green while testing nothing.
- Four of nine pgTAP suites (`10_rls_writes_denied`, `15_rls_select_denied`, `20_leaderboard_view`,
  `45_function_grants`) exist **to test the roles being deleted**. Under the shim they survive
  unchanged; under the clean break they must be deleted, and deleting them removes the only
  automated proof that the service-only functions are not client-callable.
- `00_helpers.sql` creates every fixture identity by inserting into `auth.users`. Under the clean
  break both helpers need rewriting.

**Missing tests that would otherwise let a broken build look green:**

1. **Server-mode assertion.** `src/api/client.js` gates everything on
   `Boolean(VITE_SUPABASE_URL && VITE_SUPABASE_ANON_KEY)` (M10). If the port forgets to redefine
   `enabled`, the app runs fully offline with local scoring and **every screen looks perfect**: coins
   move, streaks build, the countdown works, a kiosk even shows a win. The E2E suite must assert,
   first, that the app is in server mode and that a round's coins came from a `round_settled` frame.
2. **Same-source settlement.** Feed a synthetic tick stream that switches source mid-round; assert
   the round voids with `feed_stale` and never settles across sources (B1).
3. **Buffer coverage.** Fire a settle after the buffer has rolled past `T0+5000`; assert void (H5).
4. **Restart mid-round.** Kill the process with an open round; assert it voids on boot, the client
   gets clean state on reconnect, and the player can immediately play again.
5. **Reconnect verdict delivery.** Disconnect at T+1 s, reconnect at T+8 s, assert exactly one
   `round_settled` for that round; then reconnect twice in a row and assert it is still delivered
   (M9).
6. **Two kiosk browsers on one secret** -> the second gets `round_in_flight` (H2). This test exists
   to prove the provisioning decision, not to pass.
7. **Coupon exhaustion.** Drain the coupon table, then win five in a row; assert the streak is not
   silently reset and the client is told (H7).
8. **Rate cap versus the acceptance run.** Play 70 rounds and assert the documented behaviour at
   round 61 (H1) - whatever that decision turns out to be.
9. **Economy reconciliation over a real socket.** Play 50 scripted rounds against a deterministic
   feed; assert the client's displayed coins equal the DB's `players.coins` at every step. The pgTAP
   suites prove `settle_round` in isolation; nothing today proves the socket path preserves it end to
   end.
10. **Load.** 100 concurrent sockets, ~20 rounds/s, for 10 minutes: assert p99 `round_opened`
    < 100 ms, zero missed verdicts, zero settles later than 300 ms past target, memory flat. The
    stated capacity is 100 concurrent (M13); nine browsers does not test it.
11. **Lint and format over `server/` and `db/`**, wired into `npm run lint` and CI. Note `npm test`
    currently runs only `test/economy.test.mjs`, and `test:all` excludes `test:integration` and
    `test:e2e`. Whatever the new layout is, one command must run everything.

---

## 9. What the client actually needs - and it is more than the spec says

Section 1.6 says *"Same module shape. `game.js` and `kiosk.js` speak the socket instead of HTTP;
`session.js` uses the player token."* The real list:

- **`src/priceFeed.js` is not mentioned at all, and it is the biggest change (H3).** As written it
  opens its own sockets to OKX, Binance (x2) and Kraken **directly from the browser** alongside the
  relay, races them, and contains a **simulation layer**:

  ```js
  const QUIET_AFTER_MS = 3000;
  const QUIET_AMPLITUDE = 0.35; // max drift from the real price, in dollars
  ```

  After 3 s without a price change it fabricates micro-moves around the last real price every 120 ms,
  and `deliver()` suppresses real-but-unchanged quotes while simulating. The server has no such
  layer. So in exactly the market conditions where the server would call a round flat or void, the
  player's chart shows a confident move and the verdict contradicts it. There is also `startDemo()`,
  which invents prices outright. For a game with real prizes and a booth audience, the client must
  render **only** the server's tick stream: one socket, no independent sources, no quiet layer, no
  demo mode while in server mode. That is a rewrite of `priceFeed.js`, not a refactor, and the spec
  should name it.
- **One shared connection.** `startPriceFeed` and `api/game.js` must use the same socket instance
  (the spec's "one WebSocket" requires it). That is a new `src/api/socket.js` with connect, auth,
  reconnect-with-backoff, request/response by `req_id`, and a subscriber list. No existing module has
  that shape.
- **`useGame.startRound` must be restructured (M8).** Today it optimistically sets `start` from the
  local price and starts the countdown at click, then awaits one promise. It becomes: send `play`,
  await `round_opened`, re-anchor `start`/`start_at`, run the countdown, apply `round_settled`, plus
  a timeout path when `round_opened` does not arrive.
- **`applyVerdict` must stop doing kiosk math (H4).** Today the kiosk branch takes
  `endPrice = priceRef.current ?? cur.start` and computes coins, multiplier and stake locally from
  `verdict.outcome`. The end price a booth player sees is therefore the client's own last tick, not
  the price the server judged, so the chart and the verdict will visibly disagree. Since the box's
  `round_settled` carries `start_price` and `end_price` for both modes, delete the client math and
  render the server's numbers. This is the invariant, not a nicety.
- **`session.js`** loses `@supabase/supabase-js` entirely (anonymous sign-in, `updateUser`,
  `verifyOtp`). The dependency comes out of `package.json` once `client.js` goes.
- **`client.js` `enabled`** must be redefined (M10), and must default to **enabled**, so a
  misconfiguration produces a visible error rather than a silently offline game.
- **`refreshLeaderboard`** filters the player's own row by `display_name`; with M3 unfixed it hides
  every row.
- **The client's local hourly cap** (`roundsInLastHour`, `ECON.maxRoundsPerHour`) must agree with the
  server's or be removed. Two independent caps drifting apart produce a `toast('limit')` with no
  server error behind it.

---

## 10. Silent spots that will bite the first playtest

**H1 (High, L1) - the acceptance run cannot pass as written.** `open_round` raises `rate_limited` at
60 rounds per rolling hour. A 5 s round plus the result screen plus a tap is roughly 8-10 s, so a web
browser playing continuously hits 60 rounds somewhere between minute 8 and minute 10. The criterion
is *"nine browsers (5 kiosk, 4 web) play for ten minutes with zero errors"*. The four web browsers
will hit `rate_limited` inside the window. (Kiosk rounds are not capped - `open_kiosk_round` has no
counter - which is its own asymmetry worth stating.) Decide now: raise the cap, exempt a playtest
flag, or accept and document that the run ends at 60 rounds. Do not discover it during the demo.

**H6 (High, L1) - the booth has no fallback.** Everything now runs on one VPS reached over the expo
venue's wifi. Expo networks are hostile: captive portals, blocked outbound ports, saturated 2.4 GHz.
If it drops, the kiosks show nothing and no coupons can be issued, and the lead - alone at the booth
- has no recourse. The five-vendor design had the same exposure, so this is not a regression, but the
box makes a local fallback *possible* for the first time: the same `docker compose` on a mini PC at
the booth, on the booth LAN, with its own coupon slice. Whether or not it is built, the spec must
state the decision, because "we will add it later" stops being true once the codes are loaded.

**Ops the lead cannot do alone (L1e).** `scripts/gen-kiosk.mjs`, `revoke-kiosk.mjs`,
`list-kiosks.mjs`, `load-coupons.mjs`, `export-coupons.mjs` and `peek-otp.mjs` all talk to Supabase.
At the expo the lead needs at minimum: mint a kiosk, list kiosks, revoke a kiosk, see remaining
coupons, export claimed coupons. Port them to `DATABASE_URL` in Layer 1. S7 (runbook) is correctly
L2, but the *tools* the runbook refers to have to exist.

**`PLAYER_TOKEN_SECRET` (L1a).** The process must refuse to start when it is unset. A dev default
that reaches production is an S1 hole created in L1, and one line prevents it.

**Clock (L1c).** Use monotonic time for the 5 s window and for buffer ages. `Date.now()` steps when
NTP corrects a fresh VPS, and a backwards step makes every open round settle instantly or never.

**Two documents go stale on merge.** `docs/backend-spec.md` invariant 3 ("a round is one held-open
Edge Function call") and `docs/journeys-and-architecture.md` diagram 3 both describe the design being
replaced. `docs/test-contract.md` is the load-bearing one: its "Access rules" and "HTTP function
contracts" sections are about to become false, and test authors are told to trust it without reading
the implementation. It must be updated in the same change as the build, or the next test author
writes the wrong tests in good faith.

---

## Questions the orchestrator must answer before building

1. **Shim or clean break?** Do we add `0000_supabase_compat.sql` (an `auth` schema, `auth.uid()`
   backed by `SET LOCAL app.player_id`, a three-column `auth.users`, and the `anon`/`authenticated`
   roles), keeping `0001..0007` and all nine pgTAP suites nearly unchanged - or do we re-sign
   `get_me`/`claim_task`/`free_refill` to take a player id and delete four suites? Answer this first;
   every other DB ticket depends on it.
2. **Where does Layer 1 development run?** Repaired Docker, a native Postgres 16, or something else -
   but explicitly **not** the Supabase dev database, which hides the entire class of bug in question.
   If Docker cannot be repaired this week, what is the substitute?
3. **When a round's start tick and its T0+5000 tick come from different sources, what happens?** My
   recommendation is void with `feed_stale`. Confirm, because it determines whether the ring buffer
   stores a source per entry and whether `rounds` gains a `source` column - a schema decision that is
   cheap now and awkward later.
4. **What is the source demotion threshold, and may it change while a round is open?** 3 s makes
   flapping constant. I propose 10 s, and never switching the published source for a round already
   open against it.
5. **Does the box serve the frontend, or does Vercel keep it?** If the box serves it: how does the
   marketing lead deploy a change without an agent, and who ports `api/lead.js` so lead capture does
   not silently die?
6. **How many physical kiosks, and one `kiosks` row each - confirmed?** And when does a kiosk streak
   reset between players: idle timeout, explicit reset, or never (current behaviour)?
7. **What is the rate cap during the acceptance run and during the campaign?** 60/hour makes the
   stated ten-minute nine-browser run fail. Raise it, flag it, or change the criterion.
8. **What does the player see when the coupon pool is empty, and does the streak survive?** I
   recommend: streak survives, distinct error code, loud server log. Wording can stay S9.
9. **Exact first-connect frames.** Write the exchange for a browser with no token, a browser with a
   valid token, a browser with a token signed by a rotated secret, and a kiosk. One paragraph removes
   a day of ambiguity.
10. **Does `round_settled` carry `start_price`/`end_price` for kiosk rounds too?** It must, so the
    client can stop computing them (H4).
11. **Is the Finnhub key on a plan that includes `OANDA:XAU_USD`?** If not, the "~9 ticks per 5 s"
    premise does not hold and the box runs on PAXG permanently.
12. **One game server process, forever?** In-memory rounds, in-memory timers and one upstream socket
    all assume it. Say so in the spec so nobody "scales" it later and voids live rounds on redeploy.
13. **Is a local booth fallback in or out?** Deciding after the coupon codes are loaded means
    splitting them retroactively.
14. **Who updates `docs/test-contract.md`, and when?** If it lags the build, blind test authors write
    tests for a system that no longer exists.

---

## Recommended edits to the spec

Concrete replacement text. Each is a Layer 1 edit unless marked.

**1.1 Feed - replace the ring-buffer and fallback bullets with:**

> - Each ring-buffer entry is `{price, t, sourceId}`, capped at both 30 s and 2000 entries.
> - A round records the `sourceId` of its start tick. Its end price is the latest tick **from that
>   same source** at or before `T0+5000`.
> - The round is void (`feed_stale`) when: that source has no tick within 3 s of `T0+5000`; or the
>   buffer no longer covers `T0+5000` (a late timer); or the published source changed between open
>   and settle. A round is never settled across two price sources.
> - A source is demoted after 10 s of silence, not 3 s, and a demotion never changes the source of a
>   round already open against it.
> - Price frames are coalesced to at most 20 per second and serialized once per tick.
> - Flat means `end_price = start_price` exactly, on the same source. No epsilon deadband. The
>   acceptance run records the observed flat rate rather than asserting a threshold.
> - Silence detection is by observation only; no market calendar is hardcoded. Broker feeds also go
>   quiet for roughly an hour daily around 21:00-22:00 UTC, not just at the weekend.
> - The server logs per-source tick counts once a minute so a dead upstream is visible.

**1.2 Socket protocol - add:**

> Every client frame carries a `req_id`; the server echoes it on `round_opened`, `me`, `leaderboard`
> and `error`. First connect with no token: the client sends `auth {}`, the server mints an anonymous
> player and replies `me {..., token}`; the client stores the token and uses
> `auth {token, last_round_id}` from then on. A token that fails HMAC verification is treated as
> absent (a new player is minted) and never errors the socket. `round_settled` carries `start_price`
> and `end_price` for kiosk rounds as well as web rounds.

**1.3 Rounds - replace the disconnect and restart bullets with:**

> - Exactly one game server process. In-memory rounds, in-memory timers and the single upstream
>   socket all depend on it; compose must never run two.
> - On `auth`, the server sends `me` plus the player's or kiosk's most recent settled round as
>   `round_settled` when its id differs from the client's `last_round_id`. The verdict is read from
>   `rounds`, not held in memory, so a restart cannot lose it.
> - `settle_round` raising `round_not_open` is logged and dropped (at-most-once is enforced by the
>   row lock inside the function, not by server state). A transport error retries once, then voids.
> - The pg pool has a fixed size and a `statement_timeout`; every orphan void is logged as an audit
>   line.
> - The kiosk streak resets after N seconds of kiosk idleness, so the next player at the booth starts
>   fresh.

**1.4 Ledger - replace the "one edit" sentence with:**

> `supabase/migrations/0001..0007` move to `db/migrations/` behind a new `0000_supabase_compat.sql`
> that creates the `auth` and `extensions` schemas, the `anon`, `authenticated` and `service_role`
> roles, a three-column `auth.users` the game server owns, and `auth.uid()` reading
> `current_setting('app.player_id', true)`. The game server wraps every client-identity RPC in a
> transaction that runs `set_config('app.player_id', <id>, true)` first, so identity still never comes
> from a function argument on the client path. The only edit to the existing migrations is dropping
> `players.id`'s `references auth.users (id)`. A new `0008_otp_codes.sql` adds
> `otp_codes(email, code_hash, expires_at, player_id, used_at)` and a unique index
> `players (lower(email)) where email is not null`. `db/tests/` runs pgTAP from a `FROM postgres:16`
> image with `postgresql-16-pgtap` installed. Development runs against Postgres 16, never against the
> Supabase dev project.

**1.5 Login - add:**

> `verify_otp` sets `players.email` and, when `display_name` is still the default, sets it from the
> email local part. A verified email already held by another player is refused with `email_taken`
> until S4 defines the merge. A successful verify marks the `otp_codes` row used so the code cannot be
> replayed inside its 10 minutes. The process refuses to start without `PLAYER_TOKEN_SECRET`.

**1.6 Client - replace the section with:**

> `src/priceFeed.js` is rewritten: one shared socket to the box, no browser-side exchange sources, no
> quiet-market simulation layer, no demo mode while in server mode. A new `src/api/socket.js` owns
> connect, auth, backoff and `req_id` correlation; `game.js` and `kiosk.js` become thin wrappers over
> it; `session.js` drops `@supabase/supabase-js`; `client.js`'s `enabled` defaults to true so a
> misconfigured build fails loudly instead of running offline. `useGame.startRound` sends `play`,
> waits for `round_opened`, re-anchors `start`/`start_at` to the server's values, and cancels the
> visual round if `round_opened` has not arrived within 1 s. `applyVerdict` stops computing kiosk
> coins and end prices and renders the server's numbers in both modes. The client's local hourly cap
> is removed in favour of the server's.

**1.7 Layout, run and deploy - add:**

> The Caddyfile includes `try_files {path} /index.html`, the `/ws*` matcher before the file server,
> and the cache-control rules from `vercel.json` (`no-store` on `index.html`, `/af/index.html`,
> `version.json`, `manifest.webmanifest`; immutable on `/assets/*`). `api/lead.js` is ported into the
> game server as `POST /api/lead` with `LEAD_WEBHOOK_URL` and `LEAD_WEBHOOK_SECRET`, or Vercel keeps
> the frontend - one of the two, decided before build. Compose uses a named `pgdata` volume,
> `restart: unless-stopped`, a Postgres healthcheck the server waits on, and bounded log rotation.
> `gen-kiosk`, `revoke-kiosk`, `list-kiosks`, `load-coupons`, `export-coupons` and `peek-otp` are
> ported to `DATABASE_URL`. One `kiosks` row and launch secret per physical device.

**1.8 Tests - replace the last three bullets with the eleven cases in section 8 of this review**, and
add up front: *"`test/integration/*` is deleted (its endpoints no longer exist);
`tests/e2e/player-promises.spec.js` keeps its assertions but replaces its server-side verification
recipe; the first assertion of the E2E suite is that the app is in server mode."*

**Layer 2 table - add:**

| # | Ticket |
|---|---|
| S12 | Coupon audit and reconciliation: which kiosk issued which code when, plus an alert at N codes remaining |
| S13 | OTP verify-attempt limiting (5 tries per code, then invalidate) - distinct from S2's send limits |
| S14 | Kiosk hygiene: a kiosk browser never persists a player token, and per-player UI state is cleared between players |
| S15 | Least privilege (extends S5): an `app` role that may only execute the game functions, keeping the `anon`/`authenticated` pgTAP access suites as the regression proof |
| S16 | Leaderboard integrity at prize time: one row per verified email, enforced by the L1 unique index, with an export that proves it |

**Move to Layer 1 from Layer 2:** the coupon-exhaustion behaviour in S9. The silent streak reset is a
correctness bug, not cosmetics - the wording stays S9.

---

## Verdict

**Build Layer 1 with these changes.** The shape is right: one process, one upstream socket, one
fan-out, rounds on the server's own clock, the verdict pushed down the socket the player is already
on. It removes the 6-7 s hold and the coarse-feed flat problem, and it keeps the invariant intact.

But do not dispatch it as written. Four things must be resolved in the spec first, because each is
either invisible until deploy day or expensive to retrofit:

1. **B2 + B4** - decide shim versus clean break, and move development off the Supabase dev database.
   Otherwise the build looks finished and then does not run.
2. **B1** - pin a round to its price source. Without it the game silently mis-settles rounds in
   production and `feed_stale` never fires.
3. **B3** - decide the frontend host and the fate of `/api/lead`, before lead capture disappears
   without an error message.
4. **H1 + H2** - the stated acceptance run fails on the rate cap and on shared kiosk identity. Fix
   the spec or fix the criterion, but do not run the demo into them.

The rest of the High and Medium findings are each an hour or two now and a day or two later. The ones
I would not compromise on, because they are what the lead will actually see, are H3 (the client is
simulating prices the server does not know about), H4 (kiosk verdicts computed on the client) and M8
(the countdown freezing at 0.0 on every round).

Layer 2 as written is a sound deferral list. Its only misfiling is the coupon-exhaustion behaviour,
which is a Layer 1 correctness bug wearing a cosmetic label.

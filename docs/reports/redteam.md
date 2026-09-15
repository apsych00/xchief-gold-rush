# Red-team review: xChief Gold Rush backend

Adversarial security review of the Supabase backend (migrations, edge functions, `src/api/`) against the eight invariants in the task brief and the promises in `docs/backend-spec.md` / `docs/test-contract.md`.

- Target: live dev project `https://umcsewvppeymbvrxffoi.supabase.co`, attacked with only the public anon key from `.env.public` and the dev kiosk secret `dev-kiosk-secret-0001`.
- Reviewer model (confirmed in transcript, `message.model`): `claude-opus-5[1m]` (Opus).
- Date: 2026-09-15.
- Method: static read of all SQL, edge functions, and client modules, plus live attacks with `node`/`fetch` as an anonymous player. No file was modified; nothing was committed. `.env` was never opened.

## Bad news first

There is no Critical, High, or Medium finding. Every core invariant held under live attack: the client cannot call any write RPC, cannot read kiosks/coupons/dev_otps, cannot feed its own price, cannot dodge a loss by disconnecting, cannot open two rounds at once, cannot forge an OTP hook, and cannot double-claim a task. The findings below are Low and Info hardening items. Two of them (F1, F2) are latent defects that hold today only because of an implicit lock and a correctly-set secret; they would turn into real holes under a plausible future change or a misconfiguration, so they are worth fixing now.

## Findings

| # | Severity | Title | Status on live project |
|---|----------|-------|------------------------|
| F1 | Low | `claim_task` once-only protection is incidental, not enforced | Held (could not reproduce a double-claim) |
| F2 | Low | `otp-email` fails open when the hook secret is unset | Held (secret is configured; forged requests rejected) |
| F3 | Low | 30s orphan-void is a residual loss-dodge only if server settle fails | Held (disconnect still settled server-side) |
| F4 | Info | OTP send has no captcha; project-wide email rate limit can lock out logins | Partially observed (rate limit fired at 429) |
| F5 | Info | Hourly rate cap counts voided rounds against the player | Matches spec; minor fairness |
| F6 | Info | Permission-denied errors leak internal function names | Held (harmless; names are already in the client bundle) |

### F1 (Low) - `claim_task` relies on an implicit lock, not a constraint, to be once-only

`public.claim_task` checks `select max(claimed_at) from task_claims ...` and then inserts a claim and adds the reward. There is no unique index on `task_claims(player_id, task_id)` and no explicit lock taken before the check. In read-committed isolation this is a classic time-of-check-to-time-of-use race: two transactions that both run their `select max()` before either commits would both see "no prior claim" and both pay out.

I tried to break it. Fresh anonymous user, 24 concurrent `claim_task('instagram')` calls (reward 300, one-time), repeated three times:

```
$ node race2.mjs
attempt 1: 200s=1/24 coins=[{"coins":1300}] claim_rows=1 expected coins=1300 rows=1
attempt 2: 200s=1/24 coins=[{"coins":1300}] claim_rows=1 expected coins=1300 rows=1
attempt 3: 200s=1/24 coins=[{"coins":1300}] claim_rows=1 expected coins=1300 rows=1
```

Exactly one claim succeeded each time; coins went 1000 -> 1300 and there was one `task_claims` row. It held.

Why it held: `claim_task` calls `ensure_player(v_uid)` near the top, which runs `insert into players ... on conflict (id) do update set ... updated_at = now()`. The `DO UPDATE` takes a row-level lock on that player's row and holds it to commit, so concurrent `claim_task` calls for the same player serialize on that row before they reach the `max(claimed_at)` check. `free_refill` is protected the same way by an explicit `select ... for update` on the player row.

The risk is that this protection is a side effect, not a stated guarantee. If `ensure_player` were ever optimized to skip the upsert when the row already exists (a natural change), the lock would disappear and the double-claim would open up immediately, with no test guarding it.

Fix: make the guarantee explicit. Either add a `unique (player_id, task_id)` for one-time tasks (or a partial/expression index keyed to the repeat window) and handle `unique_violation` as `already_claimed`, or take `select ... from players where id = v_uid for update` before the `max(claimed_at)` check, mirroring `free_refill`. The lock approach also covers repeatable tasks cleanly.

### F2 (Low) - `otp-email` sends mail (or stores the code) without verifying the signature when the secret is unset

`supabase/functions/otp-email/index.ts` verifies the standard-webhooks signature only when `SEND_EMAIL_HOOK_SECRET` is set. When it is empty it logs a warning and falls through to parse the body and act on it. If `ELASTIC_API_KEY` is set at the same time, an unauthenticated caller could POST `{user:{email}, email_data:{token}}` and make Elastic Mail send a message from the campaign sender to any address with an attacker-chosen "code" - a phishing and spam primitive. When `ELASTIC_API_KEY` is unset it instead writes the attacker's `{email, token}` into `dev_otps`.

I tried a forged hook (no signature headers) against the live project:

```
$ node rt.mjs   # otp-email with a body but no webhook-signature header
"fn_otp_forged": { "status": 401, "body": "{\"error\":\"invalid_signature\"}" }
"fn_otp_missing": { "status": 401, "body": "{\"error\":\"invalid_signature\"}" }
```

It held: the dev project has `SEND_EMAIL_HOOK_SECRET` configured, so the forged request was rejected before the body was read. The invariant "the OTP hook cannot be abused to send arbitrary mail or leak codes" is currently satisfied.

The defect is that the code fails open. The safe behavior is to fail closed: if the function will ever have a mail provider configured, it should refuse to run without a verified signature rather than warn and continue. Recommend requiring `SEND_EMAIL_HOOK_SECRET` (return 401/500 when it is absent) so a future deploy that forgets to set it cannot silently become an open mail relay.

### F3 (Low) - the 30s orphan-void is a residual loss-dodge, but not one a client can trigger

`open_round` / `open_kiosk_round` void any of the caller's own rounds still `open` and older than 30s before opening a new one. This is correct self-healing for a crashed edge invocation, but it is also the only path where an opened round produces no ledger effect. If an attacker could make the `settle_round` step not run for a losing round, the leftover open round would later be voided and the loss erased.

I tried to trigger it by dropping the client mid-round:

```
$ node play.mjs
B client drop: {"aborted":"AbortError"}
B rounds before=0 after=1 coins before=1000 after=1500 (a settled round was recorded despite the drop)
```

The client aborted at 1.5s, well before the 5s settle. Seven seconds later the player's `rounds` had incremented and the round was settled server-side. The disconnect did not dodge anything, because the wait-and-settle is registered with `EdgeRuntime.waitUntil` and runs to completion independent of the socket. It held.

The residual risk is a genuine server-side failure of `settle_round` (isolate eviction, an unhandled throw in the settle path) leaving the round open to be voided later. A client cannot cause that, and the price feed has a relay/OKX/Binance fallback chain so "make the feed stale at settle time" is not client-controllable either. This stays Low: document the residual, and consider recording an audit event whenever `open_round` voids a leftover so an unexpected rate can be noticed.

### F4 (Info) - OTP send has no captcha and the email rate limit is project-wide

`requestOtp` calls `supabase.auth.updateUser({ email })`, which is Supabase's native email-change flow. Any anonymous user can trigger a code to an arbitrary address. The code is delivered to that address, not to the caller, so this is not account takeover or a code leak, but it is an unsolicited-mail primitive, and there is no captcha in front of it.

Observed live:

```
$ node misc.mjs
updateUser email-change: 429 {"code":429,"error_code":"over_email_send_rate_limit","msg":"email rate limit exceeded"}
```

The auth email rate limit fired. That is the mitigation, but it is a project-wide budget: an attacker who spends it on junk addresses can also block legitimate players from receiving their login codes for the window. The dev `config.toml` sets `email_sent = 2` per hour, which is a dev value; the point for production is to confirm the cloud project's auth rate limits are high enough for ~1000 users/day without being so high that a spammer runs up the Elastic Mail bill. Consider a captcha on the email step for the public web build.

### F5 (Info) - the hourly cap counts voided rounds

`open_round` computes `v_recent` as `count(*) from rounds where player_id = ... and created_at > now() - interval '1 hour'` with no filter on `status`/`outcome`, so rounds that were voided (stale feed) still count against the player's 60/hour. This matches the test contract wording ("counts rounds already opened in the last hour"), so it is intended, but a player who hits a run of stale-feed voids burns quota for rounds that never affected their balance. Fairness nit, not a security issue.

### F6 (Info) - permission-denied errors name the internal function

Calling a service-only RPC returns `permission denied for function open_round` (etc.). This confirms function names to an attacker. Harmless here because those names already ship in the client bundle and in `docs/`, but noted for completeness.

## What held (with evidence)

All results below are from the live dev project as an anonymous player holding only the public anon key.

**Invariant 5 - no client can call the service-only RPCs.** All seven denied with `42501 permission denied`, both as `authenticated` (403) and as `anon` (401):

```
$ node rt.mjs
rpc_open_round        403 permission denied for function open_round
rpc_settle_round      403 permission denied for function settle_round
rpc_void_round        403 permission denied for function void_round
rpc_verify_kiosk      403 permission denied for function verify_kiosk
rpc_open_kiosk_round  403 permission denied for function open_kiosk_round
rpc_settle_kiosk_round 403 permission denied for function settle_kiosk_round
rpc_ensure_player     403 permission denied for function ensure_player
rpc_open_round (anon) 401 permission denied for function open_round
```

Calling `settle_round` / `settle_kiosk_round` directly to forge a win or claim a coupon is therefore impossible from the client. This also closes the `ensure_player` spoof: it is `SECURITY DEFINER` and takes an arbitrary uuid, but it is not executable by any client role, and its only callers pass `auth.uid()` (RPCs) or the JWT-verified user id (edge function), never a body value.

**Invariant 5 - restricted tables are unreadable; own-row reads are scoped by RLS.**

```
rest_kiosks    403 permission denied for table kiosks
rest_coupons   403 permission denied for table coupons
rest_dev_otps  403 permission denied for table dev_otps
rest_players (unfiltered)          -> only the caller's own row
players?id=eq.<other user's id>    -> 200 []   (RLS blocks)
rounds / task_claims               -> only the caller's own rows
```

**Invariant 1 / price - the client cannot feed its own price.** `play-round` reads the price from the relay/price function itself and ignores the body. A round played with a body full of chosen values used the live relay price and lost anyway:

```
$ node play.mjs
C price-spoof: livePrice~ 4298.2 => 200
   {"outcome":"lose","delta":-500,"mult":1,"coins":500,"streak":0,"record":1000,
    "start_price":4298.1,"end_price":4298}
   (body carried start_price:1, end_price:999999, coins:1000000, stake:1 - all ignored)
```

**Invariant 2 - one round in flight per identity.** Two concurrent `play-round` calls for the same user: one settled, one refused.

```
A concurrent#1: 200 {"outcome":"win",...,"streak":1}
A concurrent#2: 409 {"error":"round_in_flight"}
```

**Invariant 3 - a dropped connection does not dodge a loss.** See F3 evidence: client aborted at 1.5s, server still settled the round (`rounds` 0 -> 1).

**Invariant 6 - tasks cannot be replayed or claimed without eligibility.** `signup` (requires_email) refused for an unconfirmed anonymous user; the double-claim race produced exactly one claim (see F1).

```
claim signup (no email): 400 {"message":"email_required"}
```

**Invariant 7 - the OTP hook cannot be abused.** Forged hook requests without a valid signature are rejected `401 invalid_signature` (see F2). There is no client-reachable path that reads `dev_otps`.

**Invariant 8 - the price path cannot be fed a chosen price.** Covered by the F3/price-spoof evidence; the `price` function validates every source (`price` finite, `> 100`, `< 100000`, timestamp within 3s) and the round functions re-read it at start and settle.

**Coupon eligibility (invariant 4).** Coupon issuance lives only in `settle_kiosk_round`, which no client can call. The claim is atomic (`update ... where id = (select ... for update skip locked) returning code`), one coupon per fifth consecutive server-validated win, streak reset to 0 after. The one-round-in-flight index on `kiosk_id` prevents concurrent kiosk settlements, so a single kiosk cannot claim two coupons for one streak. Kiosk auth held: wrong, short, and empty secrets all returned `401 kiosk_unauthorized`, and a valid dev-secret round settled server-side.

```
kiosk wrong secret: 401 kiosk_unauthorized
kiosk short secret: 401 kiosk_unauthorized
kiosk valid round:  200 {"outcome":"lose","streak":0,"coupon":null}
```

**Auth boundary.** A missing token, a garbage token, and the anon key presented as a bearer token were all rejected `401 unauthenticated`, so a client cannot masquerade as a user with the public key alone.

```
play no-auth:        401 unauthenticated
play garbage jwt:    401 unauthenticated
play anon-key-as-jwt:401 unauthenticated
```

**Leaderboard exposes only safe columns.** `leaderboard()` is a `SECURITY DEFINER` function returning `(display_name, record, rank)`; the old view is dropped, so `rest/v1/leaderboard` 404s, and asking the RPC for extra columns fails:

```
leaderboard extra-col select: 400 column pgrst_call.coins does not exist
```

**Code-level checks that passed review.** Every `SECURITY DEFINER` function pins `search_path` (`public`, and `public, extensions` for `verify_kiosk` so `crypt()` resolves - confirmed live by clean kiosk auth rather than a 500). `combo_mult`/`stake_for` reference no schema objects, so their unpinned search_path is irrelevant. Coin/record arithmetic uses `greatest(...)` and `max(0, ...)` consistently; the returned `record` matches the row update in every branch. Kiosk secrets are stored only as bcrypt hashes and compared with `crypt(p_secret, secret_hash)`.

## Verdict

The backend clears the stated bar - "resist casual poking for about two weeks" - comfortably. Every outcome-deciding and coupon-deciding path is server-only and unreachable from the client, RLS scopes reads correctly, the one-round-in-flight and disconnect protections work as specified, and the OTP hook rejects forged requests. I found no way, as a player holding the public key and the kiosk secret, to influence coins/streak/record/coupon eligibility, to dodge a loss, to read restricted tables, or to double-claim a task or coupon.

The two items worth acting on before the campaign are defense-in-depth, not open holes: make `claim_task`'s once-only behavior explicit with a lock or unique constraint (F1) so it does not depend on an incidental upsert lock, and make `otp-email` fail closed when the hook secret is absent (F2) so a future misconfiguration cannot turn it into an open mail relay. Neither is exploitable on the current dev project.

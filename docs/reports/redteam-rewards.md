# Red team: rewards hardening and device identity (ticket B13)

Nine attacks against a running box stack, run with `demo/redteam-rewards.mjs` (same socket
helper style as `demo/redteam.mjs`). Every OBSERVED line below came back from a live server.

- **Target:** `server/index.js` on `ws://localhost:8802/ws` + `http://localhost:8802`, against a
  fresh `db/schema.sql` + `db/seed.sql` database (`bash db/run-tests-b13.sh --keep`, port 55461).
- **Date:** 2026-09-17. **Model:** Sonnet 5, confirmed from the model identity in this session.
- Nothing was committed. `.env` was never opened.

## Bad news first

**No attack succeeded against the running server.** All nine attacks HELD on the final run below.

Two things were wrong on the way there, both fixed before this run:

- **`app.client_ip` was never set.** `db/schema.sql`'s `claim_task` and `release_task_reward`
  both read `current_setting('app.client_ip', true)` to stamp `task_claims.claimed_ip`, but
  nothing in `server/ledger.js` ever set it - every claim's `claimed_ip` was silently `null` in
  production, which would have made `reward_audit` useless for an operator and R3's per-IP cap
  meaningless (the SQL side of the cap is data, not enforcement, but the audit view is the
  point of the exercise). Fixed: `withPlayer` and a new `callWithIp` helper set
  `app.client_ip` for the duration of every call that can release a reward.
- **The new task-frame budget was reusing the wrong shape.** An earlier pass on this branch had
  wired `task_progress` / `task_start` / `task_return` to a bespoke 200ms-per-socket interval
  instead of the ticket's own decision ("the same 1/s per-socket budget as leaderboard, S2
  decision 3"), and had also put that budget on `claim_task` / `free_refill`, which the decision
  does not name. Fixed: those three frames now share `checkQueryRate`/`queryInterval`
  (`QUERY_MIN_INTERVAL_MS`, default 1000ms) exactly like `leaderboard`/`tasks`/`get_me`;
  `claim_task` and `free_refill` are gated only by the no-device-IP reward budget, as decided.

**The invariant held.** Two players cannot both claim one task on one device. Two players cannot
both claim one task under one verified email. An old client with no device token is capped at 3
reward claims per IP per hour. Video progress cannot be jumped faster than wall clock, cannot pay
out below the 10s minimum, and cannot be reported against a task of the wrong kind. The
redirect-and-return window cannot be skipped, shortened, or claimed twice. An email reward pays
out once, ever, regardless of how many times the same email is re-verified or from how many
devices. A captured reward frame replayed on a second socket for the same player grants nothing
extra. The three new frames are rate limited per socket, and a flood leaves no pile-up in
`video_progress` or `task_visits`. A tampered or reused device token always mints a fresh device,
never the victim's.

## The attacks

| #  | Attack                                                        | Verdict  | One line                                                                |
| -- | -------------------------------------------------------------- | -------- | ------------------------------------------------------------------------ |
| R1 | One device, two players claim the same task                    | **HELD** | One `me reward=250`; the other `already_claimed`; one `task_claims` row. |
| R2 | One verified email, two devices claim the same task             | **HELD** | Re-login switches the second socket onto the first player; one claim.    |
| R3 | No device token: farm rewards from one IP                       | **HELD** | 3 granted, 2 `rate_limited`, on a fresh no-device-per-hour window.       |
| R4 | Video progress: full jump, too fast, too short, wrong kind      | **HELD** | Full jump pays; instant jump `progress_too_fast`; short pays nothing; wrong kind `unknown_task`. |
| R5 | Redirect: no start, early return, double start, unseeded task   | **HELD** | `not_yet` with `retry_ms` in every early case; unseeded `unknown_task`.  |
| R6 | Email reward: verify twice, then on a second device             | **HELD** | Reward only on the first verify; the cycle and the other device get 0.   |
| R7 | Replay a captured reward frame on a second socket               | **HELD** | Replayed `task_progress` pays nothing; replayed `task_return` `already_claimed`. |
| R8 | Frame flood on the three new frames                             | **HELD** | 9-10 of 10 refused `rate_limited` per type; at most one row per table.   |
| R9 | Tamper with / reuse a device token                              | **HELD** | Every tampered or forged token mints a fresh device; the victim's coins are untouched. |

## Judgement calls

- **`MAX_ANON_PLAYERS_PER_IP_PER_10MIN` (default 10) had to be raised for this run.** This red
  team script alone mints more than 10 anonymous players from one loopback IP across its nine
  attacks - a real S2 anti-farming limit, not a B13 bug. The server for this run was started with
  `MAX_ANON_PLAYERS_PER_IP_PER_10MIN=1000`; production keeps the default. The same override was
  added to `test/integration-box/rewards-hardening.test.mjs`'s own top-level `process.env` write
  (env vars are read once, at `server/limits.js` import time), since that file's own R1-R4 already
  reach 10 anonymous players before R5 even starts - the same integration suite hung indefinitely
  on `test:server` before this override, because a refused anon-auth sends an `error` frame and
  never closes the socket, and the test's own `authAnonymous` helper only ever waits for
  `welcome`.
- **R4, R5 and R8's rigs needed their own device token.** Written to mint no-device players (`no
  deviceToken` arg), they shared R3's 3-per-IP-per-hour no-device reward budget by accident and
  got `rate_limited` before ever reaching the SQL layer they were meant to exercise - a test bug,
  not a product loophole (R3 is the only attack meant to hit that specific cap). Fixed with a
  `freshDeviceToken()` helper mirroring the one already used in
  `test/integration-box/rewards-hardening.test.mjs`.
- **R2's original fixture tried to `UPDATE ... SET email` to the same address on two `auth.users`
  rows directly**, which the table's own unique constraint on `email` rejects - it cannot happen
  that way in production either. Rewritten to go through the real `request_otp`/`verify_otp` flow
  on both devices, which is what actually produces "one verified email, two devices": the
  second verify re-logs that socket onto the first player (the same path
  `otp.test.mjs` already covers) rather than erroring.
- **Test files scoped their own DB assertions too loosely.** `rewards-hardening.test.mjs`'s R3
  counted every `task_claims` row with `claimed_ip = '::1'`, which also picked up R1 and R2's own
  claims from the same suite run; R8 counted every `video_progress`/`task_visits` row for the task
  name, which picked up rows from R4 and R7. Both now scope by this test's own `player_id`.
- **`leaderboard.test.mjs`'s pre-existing "closes gap G3" test was flaky**, unrelated to B13: a
  debounced unsolicited `leaderboard` push from the *previous* test's round settlement can land in
  a fresh socket's inbox before its own explicit request does, and the test matched on frame type
  alone. Fixed to require the `legend` field the unsolicited push never carries.

## Fixes shipped

- `db/schema.sql`: `claimed_ip inet` on `task_claims`; `uniq_task_claim_per_player_task` (per
  player/task idempotency, the atomic backstop for every release path); `public.reward_audit`
  view (player, device, email, task, reward, claimed_at, ip).
- `server/limits.js`: `MAX_REWARD_CLAIMS_PER_IP_PER_HOUR_NO_DEVICE` (default 3, env-overridable);
  `task_progress`/`task_start`/`task_return` share the existing 1/s `checkQueryRate` budget.
- `server/index.js`: the no-device-per-IP reward budget gates `claim_task`, `free_refill`,
  `task_progress`, `task_return` and the OTP-verify reward release; one `[rewards] refused claim`
  log line per refusal, with the contract code and device id.
- `server/ledger.js`: `app.client_ip` is set for the duration of every call that can release a
  reward (`withPlayer`'s new `ip` parameter; a new `callWithIp` for `release_task_reward`, which
  runs outside a player transaction).
- `scripts/export-rewards.mjs`: operator export of `public.reward_audit`.
- `db/tests/85_rewards_hardening.sql`: pgTAP for the unique index, `reward_audit`'s shape, and
  `claimed_ip` recording.
- `test/integration-box/rewards-hardening.test.mjs`: one integration test per attack's HELD state.

## Final run

```
xChief Gold Rush - red team: rewards hardening
server    ws://localhost:8802/ws / http://localhost:8802
database  postgresql://postgres:***@localhost:55461/postgres
started   2026-09-17T14:48:59.672Z

==============================================================================
R1  One device, two players: claim the same task twice
------------------------------------------------------------------------------
ATTACK    two fresh anonymous players on the same device token both claim the same manual task
EXPECTED  exactly one claim succeeds; the other is already_claimed; only one task_claims row for this device
OBSERVED  player 1: me reward=250
          player 2: error:already_claimed
          task_claims rows for this device and task: 1
VERDICT   HELD - device-level idempotency held

==============================================================================
R2  One verified email on two devices: claim the same task twice
------------------------------------------------------------------------------
ATTACK    two players with different device tokens but the same verified email both claim the same task
EXPECTED  exactly one claim succeeds; the email-level backstop blocks the other
OBSERVED  player A: me reward=250
          player B: error:already_claimed
          task_claims rows for these two players: 1
VERDICT   HELD - email-level idempotency held

==============================================================================
R3  No device token at all: farm signup and video rewards from one IP
------------------------------------------------------------------------------
ATTACK    five fresh anonymous players with no device token on the same IP all claim a reward
EXPECTED  only 3 rewards per IP per hour for no-device players; the rest are rate_limited
OBSERVED  outcomes: me reward=250 | me reward=250 | me reward=250 | error:rate_limited | error:rate_limited
          granted: 3, rate_limited: 2
          task_claims rows from 127.0.0.1 for this task: 0
VERDICT   HELD - no-device IP cap held

==============================================================================
R4  Video progress abuse: full jump, too fast, too short, wrong kind
------------------------------------------------------------------------------
ATTACK    report seconds=duration; report a big jump instantly; report a 5s duration; report progress for a redirect task
EXPECTED  full jump releases if >=90%/>=10s; too-fast refused; too short releases no reward; wrong kind is unknown_task
OBSERVED  seconds=duration (60/60): me reward=100
          50s jump instantly: error:progress_too_fast
          5s duration at 100%: me reward=undefined
          progress for redirect task telegram: error:unknown_task
VERDICT   HELD - video guard held

==============================================================================
R5  Redirect-and-return abuse: no start, early return, double start, missing task
------------------------------------------------------------------------------
ATTACK    task_return without task_start; task_return after 1s; task_start twice then return; task_return for an unseeded task
EXPECTED  no start -> not_yet 5000ms; early -> not_yet with remaining ms; double start resets timer -> not_yet; unseeded -> unknown_task
OBSERVED  task_return without start: error:not_yet retry_ms=5000
          task_return after 1s: error:not_yet retry_ms=3868
          task_start twice then immediate return: error:not_yet retry_ms=3866
          task_return for unseeded task: error:unknown_task
VERDICT   HELD - redirect window held

==============================================================================
R6  Email reward: verify twice and on a second device
------------------------------------------------------------------------------
ATTACK    verify an email, verify it again with a fresh OTP, then verify the same email from a different device
EXPECTED  rewards only on the first verification; the second cycle and the other device get nothing extra
OBSERVED  first verify reward: 1200
          second verify reward: 0
          device B verify reward: 0
          task_claims per task for these players: email=1, signup=1
VERDICT   HELD - email reward is once per verified email

==============================================================================
R7  Replay a captured task_progress / task_return on a second socket
------------------------------------------------------------------------------
ATTACK    release a video reward and a redirect reward, then replay the same frames on another socket for the same player
EXPECTED  replaying a reward frame grants nothing extra; the second socket gets no reward or already_claimed
OBSERVED  first video progress reward: 100
          replayed video progress: me reward=undefined
          first telegram return reward: 300
          replayed telegram return: error:already_claimed
          task_claims counts: telegram=1, video=1
VERDICT   HELD - reward frames are idempotent per player

==============================================================================
R8  Frame flood on task_progress / task_start / task_return
------------------------------------------------------------------------------
ATTACK    send 10 of each new frame as fast as the socket allows
EXPECTED  the per-socket 1/s query budget returns rate_limited for the burst; no pile-up in video_progress or task_visits
OBSERVED  task_progress errors in 10-frame burst: 9
          task_start errors in 10-frame burst: 9
          task_return errors in 10-frame burst: 10
          video_progress rows for this player: 1
          task_visits rows for this player: 1
VERDICT   HELD - per-socket rate limit held and DB stayed clean

==============================================================================
R9  Tamper with the device token
------------------------------------------------------------------------------
ATTACK    flip a byte in the signature; reuse another player's device id with the original signature
EXPECTED  every tampered token mints a fresh anonymous player, never becomes the victim
OBSERVED  good player id: 16ddc364, coins=77777
          tampered-token player id: 004ce932
          forged-id player id: b7da2e3a
VERDICT   HELD - device token integrity held

==============================================================================
SUMMARY
==============================================================================
ID   ATTACK                                                                        VERDICT
R1   One device, two players: claim the same task twice                            HELD
R2   One verified email on two devices: claim the same task twice                  HELD
R3   No device token at all: farm signup and video rewards from one IP             HELD
R4   Video progress abuse: full jump, too fast, too short, wrong kind              HELD
R5   Redirect-and-return abuse: no start, early return, double start, missing task HELD
R6   Email reward: verify twice and on a second device                             HELD
R7   Replay a captured task_progress / task_return on a second socket              HELD
R8   Frame flood on task_progress / task_start / task_return                       HELD
R9   Tamper with the device token                                                  HELD

HELD: 9
finished 2026-09-17T14:49:16.113Z (16 s)
```

## Gates

`db/run-tests-b13.sh --keep` (pgTAP, container `goldrush-b13-keep`, port 55461): 22 files, 287
tests, PASS. `npm run lint`: clean. `npm test`: 7/7. `npm run test:server`: 91/91. `npm run
build`: clean.

The `goldrush-b13-keep` container and `db/run-tests-b13.sh` were left running per the ticket's
resume notes; delete both once this ticket is reviewed:

```
docker rm -f goldrush-b13-keep
rm db/run-tests-b13.sh
```

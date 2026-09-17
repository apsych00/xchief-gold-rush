TICKET B13: hardening pass on rewards and device identity.

Read AGENTS.md, .claude/agents/builder.md, docs/TRACKER.md (B13, B5, B6, B7, B9, S2), docs/reports/redteam.md (method and the attack table; reuse demo/redteam.mjs's socket helpers), db/schema.sql (devices, task_claims, video_progress, task_visits, release_task_reward, report_video_progress, start_task_visit, return_task_visit, claim_task, free_refill), server/index.js (task_progress, task_start, task_return, claim_task, free_refill frames), server/limits.js, server/ledger.js, test/integration-box/tasks.test.mjs, db/tests/75_tasks_and_refill.sql, db/tests/80_device_identity.sql. Never open a file named .env. Never commit. Work only in this worktree.

This is an attack-then-fix ticket. First attack, then fix what breaks, then prove the fix. Every attack is a script under demo/redteam-rewards.mjs (same style as demo/redteam.mjs, `--only` filter), with a HELD / LOOPHOLE verdict line each.

Attacks to run (add any you think of; report them all):
R1 one device, two players (clear the player token, keep the device token): claim the same task twice.
R2 one verified email on two devices: claim the same task twice.
R3 no device token at all (old client): how many times can one IP farm the signup and video rewards with fresh anonymous players in 10 minutes.
R4 video: report seconds=duration in one frame; report progress faster than wall clock; report a 5 s duration; report progress for a task of another kind.
R5 redirect: task_return without task_start; task_return after 1 s; task_start twice then one return; task_return for a task never seeded.
R6 email reward: verify the same email twice (two OTP cycles) and count rewards; verify on device A then device B.
R7 replay: resend a captured task_progress / task_return frame on a second socket for the same player.
R8 frame flood on the three new frames against the per-socket budget (S2): expect rate_limited, no DB pile-up.
R9 tamper with the device token (flip a byte, reuse another player's): expect a fresh device, never someone else's.

Fixes, decided (do not redesign): every refusal is a contract code (extend KNOWN_ERROR_CODES); `task_progress`, `task_start`, `task_return` get the same 1/s per-socket budget as leaderboard (S2 decision 3); a device with no token is limited to 3 reward claims per IP per hour (a new in-memory window in server/limits.js, env-overridable) so old clients cannot farm; per-player per-task idempotency on every release path in SQL (a unique index where it is missing); an audit view `public.reward_audit` (player, device, email, task, reward, claimed_at, ip) plus `scripts/export-rewards.mjs` for the operator; log one line per refused claim with the code and the device id.
Tests: pgTAP for each SQL guard; integration for each attack's HELD state; the red-team script's final run pasted into docs/reports/redteam-rewards.md with the table of verdicts. Dev DB: copy db/run-tests.sh with PORT=55461 and container goldrush-b13-keep; server on PORT=8802. Never set FINNHUB_TOKEN. Delete the copy and container when done. Gates unpiped: lint, unit, pgTAP, test:server, build. Report: bad news first (every LOOPHOLE found, fixed or not), judgement calls, files touched, gate outputs.

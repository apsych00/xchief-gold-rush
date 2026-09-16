# Progress - box build, Layer 1

Updated by the orchestrator at every milestone. Read top to bottom; the table is the truth, the log below is the history.

**Where to play it:** not yet. First playable milestone = ticket 5 merged (client on the socket). Then: `bash db/run-tests.sh --keep`, `npm run server`, `npm run dev`, open http://localhost:5173 (kiosk: `/?k=dev-kiosk-secret-0001`).

## Tickets

| # | Ticket | Status | Proof |
|---|---|---|---|
| 1 | Database on stock postgres:16 (compat layer + box rules) | done | 85/85 pgTAP, re-run by orchestrator |
| 2 | Price feed - one continuous published series | done | 17 unit tests; live: 39 Finnhub ticks / 15 s, max step $0.30, all 3 sources hot |
| 3 | Game server core (socket, in-memory rounds, ledger, /api/lead) | done | 12 integration tests; round_opened < 20 ms, settled 5016-5292 ms |
| 4 | Login codes (OTP) with dev capture | done | 101/101 pgTAP, 16 integration tests |
| 5 | Client on the socket, LIVE/QUIET badge, server verdicts | building (Sonnet) | - |
| 6 | docker compose + Caddy + deploy doc + ops scripts | done | compose validated locally; migrate.mjs idempotent |
| 6b | Schema squash into one clean db/schema.sql | queued (after 5) | - |
| 7a | Acceptance runner: 9 browsers + 100-socket load script | building (OpenCode) | - |
| 7 | Acceptance run: 5 kiosks + 4 web, 10 min; then 100 sockets | queued (after 5, 6b, 7a) | - |

Layer 2 (S1-S17, security and hardening) starts only after 7 passes. Spec: `box-spec.md`; plan and decisions: `box-plan.md`; review: `reports/box-spec-review.md`.

## Defects found and fixed along the way

- SQL: `create or replace` with a new argument list left the old overload installed (would have shadowed every server call). Fixed in 0008. Found by the DB worker.
- `feed.js` crashed the process on shutdown if a socket was mid-handshake. Fixed at source.
- `settle_round` did not return `best_streak`. Fixed in 0010.
- `verify_otp_code` could not both raise and persist an attempt counter (a raise rolls back the update). Returns a status instead. Found by the OTP builder.
- pgTAP suites from the Supabase lane used `throws_ok` with the wrong argument order and assumed a seed coupon that no longer existed. Fixed; that is why they never went green before.

## Log

- 2026-09-16 morning: layered spec, Opus review (4 Blockers, 10 Highs) folded into the plan before any code. Feed decision changed to one continuous series. MT5 feed card added.
- 2026-09-16: tickets 1-4 and 6 built, verified, merged. Tickets 5 and 7a in flight.

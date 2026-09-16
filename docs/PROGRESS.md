# Progress - box build, Layer 1

Updated by the orchestrator at every milestone. The table is the truth; the log is the history.

## Where to play it: now, locally

The stack is running from `C:\Users\Kayhan Azadi\orca\workspaces\xchief-gold-rush\box`:

- **Web:** http://localhost:5173
- **Kiosk:** http://localhost:5173/?k=dev-kiosk-secret-0001
- **Health:** http://localhost:8787/health

To start it yourself after a reboot, in that folder: `bash db/run-tests.sh --keep` (local Postgres), then `npm run server` with `DATABASE_URL=postgresql://postgres:test@localhost:55432/postgres PLAYER_TOKEN_SECRET=dev-secret PORT=8787` **and `FINNHUB_TOKEN=<the Finnhub key from .env>`** in the environment (without the key the server falls back to PAXG, which barely moves - sluggish, mostly flat), then `npm run dev`. The `.env` there already has `VITE_GAME_WS` set.

What to look for: one WebSocket in the console (ours), no exchange sockets, the badge reads LIVE or QUIET MARKET with no source name, the verdict lands as the countdown ends, and the server log (`/tmp/gamesrv.log`) shows each round settling at ~5.0 s.

## Tickets

| # | Ticket | Status | Proof |
|---|---|---|---|
| 1 | Database on stock postgres:16 (compat layer + box rules) | done | 101/101 pgTAP, re-run by orchestrator |
| 2 | Price feed - one continuous published series | done | 17 unit tests; live: 39 Finnhub ticks / 15 s, max step $0.30 |
| 3 | Game server core (socket, in-memory rounds, ledger, /api/lead) | done | 16 integration tests; round_opened < 20 ms, settled 5013-5292 ms |
| 4 | Login codes (OTP) with dev capture | done | 16 pgTAP + 4 integration tests |
| 5 | Client on the socket, LIVE/QUIET badge, server verdicts | done | E2E 4/4 on the socket, re-run by orchestrator; local mode unchanged |
| 6 | docker compose + Caddy + deploy doc + ops scripts | done | compose validated; migrate.mjs idempotent |
| 6b | Schema squash into one clean db/schema.sql | done | 101/101 pgTAP; catalog diff old vs new: identical |
| 7a | Acceptance runner: 9 browsers + 100-socket load script | building (OpenCode) | - |
| 7 | Acceptance run: 5 kiosks + 4 web, 10 min; then 100 sockets | queued (after 7a) | - |

Also merged: the marketing lead's "Play screen polish" commit from the old remote, no conflicts.

Layer 2 (S1-S17, security and hardening) starts only after 7 passes. Spec: `box-spec.md`; plan and decisions: `box-plan.md`; review: `reports/box-spec-review.md`.

## Defects found and fixed along the way

- SQL: `create or replace` with a new argument list left the old overload installed. Fixed in 0008. Found by the DB worker.
- `feed.js` crashed the process on shutdown if a socket was mid-handshake. Fixed at source.
- `settle_round` did not return `best_streak`. Fixed in 0010.
- `verify_otp_code` could not both raise and persist an attempt counter. Returns a status instead. Found by the OTP builder.
- Kiosk verdicts went to whichever socket authenticated last on that kiosk id. Now routed to the socket that opened the round. Found by the client builder.
- pgTAP suites from the Supabase lane used `throws_ok` with the wrong argument order and assumed a seed coupon that no longer existed. Fixed; that is why they never went green before.

## Known gaps (not blocking Layer 1)

- No OTP code-entry screen exists in the UI yet (the marketing lead's side); the socket frames and server are ready.
- `claim_task` / `free_refill` frames return a fresh `me` but no `reward` field; the client derives the toast from the coin delta.

## Log

- 2026-09-16 morning: layered spec, Opus review (4 Blockers, 10 Highs) folded into the plan before any code. Feed decision changed to one continuous series. MT5 feed card added.
- 2026-09-16: tickets 1-6 built, verified, merged. Game playable locally on the box stack. 6b done. 7a in flight.
- 2026-09-16: first hands-on: chart sluggish and flat - the local server had been started without FINNHUB_TOKEN and ran on the PAXG fallback. Restarted with the key: Finnhub connected, ~5-9 published changes per 5 s.

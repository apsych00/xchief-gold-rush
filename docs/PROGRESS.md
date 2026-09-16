# Progress - box build

Updated by the orchestrator at every milestone. The table is the truth; the log is the history. Branch: `dev` (pushed to `AIT-ERP/xChief-Gold-Rush`).

## Where to play it: now, locally

The stack runs from the main checkout `D:\K Studio\projects\x-chief\repos\xchief-gold-rush` (branch `dev`):

Production-shaped (docker compose: Postgres + game server + Caddy), on this machine:

- **Web:** http://localhost:8080
- **Kiosk:** http://localhost:8080/?k=dev-kiosk-secret-0001
- **Health:** http://localhost:8080/health

Start/stop: `docker compose --env-file .env.box -f docker-compose.yml -f docker-compose.local.yml up -d --build` / `down`. Logs: `... logs -f server`. The old dev recipe (vite on 5173 + `npm run server`) still works for UI work, but never run it at the same time as the compose stack: they fight over the single Finnhub connection.

Dev-only alternative, in that folder: `bash db/run-tests.sh --keep` (local Postgres), then `npm run server` with `DATABASE_URL=postgresql://postgres:test@localhost:55432/postgres PLAYER_TOKEN_SECRET=dev-secret PORT=8787` **and `FINNHUB_TOKEN=<the Finnhub key from .env>`** in the environment (without the key the server falls back to PAXG, which barely moves), then `npm run dev`. `.env` already has `VITE_GAME_WS` set.

Demo (headed, tiled): `npm run demo -- --seconds 120`. Load: `npm run load -- --sockets 100 --seconds 120`.

## Layer 1 - functional and smooth: DONE

| # | Ticket | Status | Proof |
|---|---|---|---|
| 1 | Database on stock postgres:16 (compat layer + box rules) | done | 101/101 pgTAP, re-run by orchestrator |
| 2 | Price feed - one continuous published series | done | 17 unit tests; live: 39 Finnhub ticks / 15 s, max step $0.30 |
| 3 | Game server core (socket, in-memory rounds, ledger, /api/lead) | done | 16 integration tests; round_opened < 20 ms, settled 5013-5292 ms |
| 4 | Login codes (OTP) with dev capture | done | 16 pgTAP + 4 integration tests |
| 5 | Client on the socket, LIVE/QUIET badge, server verdicts | done | E2E 4/4 on the socket, re-run by orchestrator; local mode unchanged |
| 6 | docker compose + Caddy + deploy doc + ops scripts | done | compose validated; migrate.mjs idempotent |
| 6b | Schema squash into one clean db/schema.sql | done | 101/101 pgTAP on the squashed schema; catalog diff old vs new: identical |
| 7a | Acceptance runner: 9 browsers + 100-socket load script | done | |
| 7 | Acceptance run | done | **Load, 100 sockets / 90 s: PASS** - 1528 rounds, round_opened p95 8 ms, settled p95 5024 ms (max 5296), zero errors. **Browsers, 5 kiosks + 4 web / 4 min:** every round settled, click-to-verdict p95 5421 ms, flats 1.5%, zero browser errors; 22 runner errors all from one kiosk going broke on cosmetic coins and locking its buttons - the Layer 1.5 kiosk-session gap (C1), not a server defect. Earlier 10-min headed run: seven coupons issued across five kiosks. |

Also merged: the marketing lead's "Play screen polish" commit from the old remote, no conflicts.

## Local production rehearsal: PASS

The full compose stack ran on this machine through Caddy: schema + seed applied once on first boot and skipped on restart; `/health`, the app and `/api/lead` served through Caddy; 30-socket load through Caddy PASS (round_opened p95 10 ms, settle p95 5087 ms); browsers through Caddy settled every round at p95 5442 ms with zero flats. Traps found and fixed before they reached production: compose read the developer's `.env` (now `.env.box`); the env template was gitignored; the client baked a localhost socket URL (now `auto` = same origin); host port 80 taken on dev machines (local override on 8080); two servers on one Finnhub key (429). Details in `box-architecture.md` section 9.

## Next: Layer 1.5 - client experience (see `layers.md`)

Kiosk session on the server (C1) and the kiosk WIN/EXIT screens (C2) first; then web identity, live masked leaderboard, tasks, win/lose feedback, broke path; monitoring (Dozzle + status page) alongside. Layer 2 hardening after.

## Defects found and fixed along the way

- SQL: `create or replace` with a new argument list left the old overload installed. Fixed. Found by the DB worker.
- `feed.js` crashed the process on shutdown if a socket was mid-handshake. Fixed at source.
- `settle_round` did not return `best_streak`. Fixed.
- `verify_otp_code` could not both raise and persist an attempt counter. Returns a status instead. Found by the OTP builder.
- Kiosk verdicts went to whichever socket authenticated last on that kiosk id. Now routed to the socket that opened the round. Found by the client builder.
- pgTAP suites from the Supabase lane used `throws_ok` with the wrong argument order and assumed a seed coupon that no longer existed. Fixed; that is why they never went green before.
- Local server started without `FINNHUB_TOKEN` ran on the PAXG fallback: sluggish, flat chart on first hands-on. Operator error; recipe corrected above.
- Acceptance runner raced the UI between rounds and had no notion of a broke player. Fixed in the runner.

## Known gaps (Layer 1.5 covers them)

- Kiosk coins are cosmetic and can lock the machine when they hit zero (C1/C2).
- A registration/lead modal can appear in kiosk mode (C2).
- No OTP code-entry screen in the UI (C3).
- `claim_task` / `free_refill` frames carry no `reward` field (C5).
- `npm run format:check` is red on ~20 pre-existing files; cosmetic.

## Log

- 2026-09-16 morning: layered spec, Opus review (4 Blockers, 10 Highs) folded into the plan before any code. Feed decision changed to one continuous series. MT5 feed card added.
- 2026-09-16: tickets 1-6 built, verified, merged. Game playable locally on the box stack.
- 2026-09-16: first hands-on: chart sluggish and flat - server had been started without FINNHUB_TOKEN. Restarted with the key: Finnhub connected.
- 2026-09-16: 6b, 7a, 7 done. Layer 1 complete. Box merged into `dev`, pushed; worktrees and branches cleaned; work resumes from `dev`.

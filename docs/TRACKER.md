# xChief Gold Rush - tracker

The one tracker. Updated at every merge. `layers.md` defines the layers and holds the ticket specs; `tasks-marketing-lead.md` is the brief handed to the marketing lead (Part A is theirs, Part B is mirrored here). `PROGRESS.md` is retired into this file.

Status values: `done` (merged into `dev`, verified by the orchestrator's own runs) · `verifying` · `building` · `blocked` · `queued` · `parked`.
Layer: `L1` the game on the box · `L1.5` client experience · `L2` hardening · `MKT` marketing lead's brief · `OPS` deployment and operations · `FEED` price feed.

## Where we are

| Layer | Done | Open | Read |
|---|---|---|---|
| L1 game on the box | 7 / 7 | 0 | complete, load-tested (100 sockets, p95 settle 5024 ms), rehearsed through compose + Caddy |
| L1.5 client experience | 13 / 16 | C9 WIN reveal (proposed), C4b animation, Q1 rest | the booth and the web flows are built and verified end to end |
| OPS | 2 / 2 | 0 | deploy scripts built; first real run happens on the box |
| FEED | 3 / 5 | MetaApi blocked on admin; Docker bridge in review | Finnhub live with PAXG fallbacks, 3-decimal publishing |
| L2 hardening | 5 / 18 | S2 and S18 ready to dispatch; S3, S5, S6, S10, S12 next | audit 2026-09-16: S7, S9, S16 were already done by other tickets |
| MKT Part B | 0 / 13 | B1+B4, B5, B10+B11 ready to dispatch; B2 after B1 | tickets written 2026-09-16 night |

Play it now: compose stack at http://localhost:8080 (kiosk `/?k=dev-kiosk-secret-0001`), operator pages `/ops` and `/logs`.

## Night handover 2026-09-16

Running at shutdown (their files stay in the worktrees; resume each with a RESUME NOTE at the top of its TICKET.md):
- **B15 harden** on cb in Orca terminal "B15 harden", worktree `b15-review` (branch `nightmareinc/b15-review`, review committed, hardening uncommitted). Known blocker and the fix direction are in its TICKET.md.
- **Opus demo + red team**, worktree `demo-redteam`: `demo/showcase.mjs`, `demo/redteam.mjs`, `docs/showcase.md`, `docs/reports/showcase-results.md`, `docs/reports/redteam.md` already on disk, uncommitted; the agent was finishing when the session closed. First thing tomorrow: read `docs/reports/redteam.md`, card every loophole, dispatch fixes to cb Sonnet workers.

Tomorrow's dispatch order (all on cb; switch to this account's Sonnet when cb hits its 5-hour or weekly cap): S2 rate limits, B1+B4 tournaments, B5 device identity, B10+B11, then S18 after S2, B2 after B1, C9 after the owner's yes. Tickets are in `docs/tickets/`.

Awaiting the owner: MetaApi account UUID + broader token + quote interval 0; OpenCode Go top-up (cap is account-wide, every model refused); C9 decision (coupon reserved at win, released if never revealed).

Local stack: compose on http://localhost:8080 comes back by itself after boot (`restart: unless-stopped`); rebuild from `dev` with the compose command in `box-deploy.md` if it looks stale. Kept test DB `goldrush-box-keep` on 55432.

## Tickets

| ID | Layer | Title | Owner | Status | Evidence / notes | Next |
|---|---|---|---|---|---|---|
| 1-7 | L1 | Schema, feed, rounds, ledger, kiosk coupons, OTP, client wiring, acceptance | done | done | 101 pgTAP at the time, 16 integration, E2E 4/4, load PASS, rehearsal PASS | |
| C1 | L1.5 | Kiosk session on the server | Sonnet | done | `kiosk_session` frame, `kiosk_reset`, 60 s sweep; merged `c91d294` | |
| C2 | L1.5 | Kiosk screens: attract, WIN modal + Claim, EXIT modal, reconnect | Sonnet | done | `src/KioskApp.jsx`; `reports/c2/`; merged `b03d468` | |
| C2b | L1.5 | Kiosk idle: 20 s no activity, activity cancels, 20 s countdown, flush | qwen3.8-max + Sonnet | done | kiosk E2E 5/5; merged `727f2de` | |
| C3 | L1.5 | OTP entry screen, masked email in the header, sign out | Sonnet | done | `src/Identity.jsx`; `reports/c3-c4/`; merged `2efe3a6` | |
| C3a | L1.5 | Session policy: 30-day versioned token, 7-day renewal, OTP re-login, revocation | Sonnet | done | merged `abdec28` | |
| C4 | L1.5 | Live masked leaderboard over the socket | Sonnet | done | `mask_email()` in SQL, push after every player settle; merged `2efe3a6` | |
| C4b | L1.5 | Leaderboard row animation, own row cue | | queued | after Part B B2 reshapes the list (paged, own rank) | dispatch with B2 |
| C5 | L1.5 | Tasks and gifts server-owned: `tasks` frame, reward on claim and refill | Sonnet | done | 172 pgTAP, 33 integration, 12 E2E; merged `966068b` | |
| C6 | L1.5 | Web verdict pane driven only by `round_settled` | Sonnet | done | loss line reads the server's delta; merged `a54eeff` | stake in the frame (gap G2) |
| C7 | L1.5 | Broke on the web: refill, tasks, verify email; never a dead end | Sonnet | done | the signup-bonus dead end fixed; broke E2E; merged `a54eeff` | |
| C8 | L1.5 | Kiosk with no prize codes left: server refuses new rounds, full-screen modal asks the visitor to tell the booth staff, recovers when codes are loaded | Sonnet (cb) | done | 176 pgTAP, 36 integration, kiosk + streak E2E 8/8 on my run; `reports/c8/no-codes.png`; merged | |
| C9 | L1.5 | WIN reveal: masked code with a glowing Reveal button and confetti; reveal is a server call that returns the code and starts the 30 s photograph window; an unrevealed coupon returns to the pool after the reveal window | | proposed | two decisions with the owner: coupon reserved at win and released if never revealed; reveal window 10-15 s then the existing 30 s | dispatch on approval |
| Q1 | L1.5 | Blind E2E over every scenario | gpt-5.6-luna (B14) | partly | five-win streak covered by B14; web flows covered by the player-promises and web-identity specs written with the tickets | blind pass for the rest after C4b |
| B14 | L1.5 | Blind five-win streak tests, kiosk and web | gpt-5.6-luna | done | coupon row, session_over, exhausted pool, WIN modal E2E; merged `e4efdd0` | |
| B16 | L1.5 | E2E regression after the profile merge | Sonnet + orchestrator | done | kiosk crashed on the avatar's missing action; 13/13 E2E; merged `92bd000` | |
| D1 | OPS | Monitoring: `/status`, `/ops`, `/logs`, alerts | Sonnet | done | merged `4839072`; `$` doubling trap documented | |
| D2 | OPS | One-command deploy, auto-deploy on push, install, rollback | Sonnet | done | `deploy/*.sh`, `client.Dockerfile` (bundle built in Docker, verified: no dev socket address); box behaviour of install/cron/ufw untestable on Windows, to be rehearsed on the real box | rehearse on the box |
| S17 | FEED | MT5 via MetaApi | orchestrator | blocked | code merged and reaches MetaApi; refused by token scope | admin: account UUID, token with account read, quote interval 0 |
| B15 | FEED | MT5 terminal + tick bridge in Docker | Sonnet | verifying | build committed on `nightmareinc/b15-mt5-docker` (74 unit, 11 Python tests); base image pull truncated in the sandbox; independent review running on cb (`b15-review`), then harden, then blind tests | review, harden, tests, merge |
| F1 | FEED | Finnhub + PAXG continuous series, 3 decimals | | done | measured 9 moves / 5 s vs 1-2 on PAXG | |
| S1 | L2 | Secret rotation procedure | | queued | folded into C3a except the procedure | |
| S2 | L2 | Per-socket AND per-IP rate limits (sockets per IP, connections per minute, anonymous signups, OTP per IP, frame flood, frame size, play cadence), 15-minute IP block | | ready | audit 2026-09-16: only the SQL 400 rounds/hour per identity exists; ticket `docs/tickets/s2-rate-limits.md` | dispatch first tomorrow |
| S3 | L2 | Kiosk secret out of the URL; scrub `k=` from Caddy logs | | queued | audit: not done, secret still in `?k=` | |
| S4 | L2 | OTP on a known email logs into that player | | done | in C3a | |
| S5 | L2 | Postgres least privilege: an `app` role | | queued | audit: the server still connects as `postgres`; the compat roles exist only for pgTAP | |
| S6 | L2 | Nightly `pg_dump` to object storage, one rehearsed restore | | queued | audit: nothing yet | |
| S7 | L2 | Ops runbook for a non-engineer | | done | `docs/box-deploy.md` rewritten by D2 (install, deploy, rollback, daily habits, monitoring) | add "if attacked" with S18 |
| S8 | L2 | Campaign end: freeze the leaderboard, export the top 10 | | queued | audit: only `scripts/export-coupons.mjs` exists; becomes per-tournament with B1 (a tournament's end is its freeze) | with B1 |
| S9 | L2 | Coupon exhaustion wording | | done | C8's modal copy | |
| S10 | L2 | Origin pinning on the socket, security headers, TLS-only cookies | | queued | audit: not done (Caddyfile comment marks the spot; no origin check in `server/index.js`) | with S2 |
| S11 | L2 | Email consent text and code retention | | partly | audit: the lead forms carry "No spam. Unsubscribe anytime."; OTP code retention/cleanup not verified | |
| S12 | L2 | Coupon audit and reconciliation, alert at N codes left | | queued | audit: `codes_left` now on every kiosk frame (C8) and `/status` has the counts; the low-stock alert is missing | small; with S2 |
| S13 | L2 | OTP verify-attempt limiting | | done | in L1 (5 tries per code) | |
| S14 | L2 | Kiosk hygiene: no player token on a kiosk, clean state between visitors | | queued | audit: state clears on every reset (C1/C2); whether `ensureSession` still mints a player token in kiosk mode is unverified | verify in the red-team follow-up |
| S15 | L2 | Least privilege, extended | | queued | with S5 | |
| S16 | L2 | Leaderboard integrity at prize time: one row per verified email | | done | `players.email` is unique and `leaderboard()` ranks verified emails only; the export becomes per-tournament with B1 | |
| S18 | L2 | Safe mode: guarded and locked levels, automatic escalation on connection and signup spikes, operator command, Cloudflare Under Attack runbook | | ready | design in `docs/tickets/s18-safe-mode.md`; depends on S2 | after S2 |
| B1 | MKT | Tournaments as data (dates, prize image and title, broker bonus), adjustable without code | | ready | ticket `docs/tickets/b1-b4-tournaments.md` (with B4) | dispatch tomorrow |
| B2 | MKT | Leaderboard API: 20 per page, own rank and row in every response, live top 20 | | queued | closes gap G3 | |
| B3 | MKT | Badge tiers and the legend endpoint | | queued | | |
| B4 | MKT | Name and phone removed from lead capture | | ready | in the B1 ticket | dispatch tomorrow |
| B5 | MKT | Per-device identity for anonymous players | | ready | ticket `docs/tickets/b5-device-identity.md` | dispatch tomorrow |
| B6 | MKT | Reward: video watched (90 %) once per device | | queued | | |
| B7 | MKT | Reward: redirect and return (Trustpilot, YouTube, Telegram), 5 s window | | queued | lenient by design until B13 | |
| B8 | MKT | Reward: Instagram follow verified through the Instagram API | | queued | needs an Instagram app and token | |
| B9 | MKT | Reward: email verified | | queued | login already works | |
| B10 | MKT | Tour-seen flag per device (web) and per boot (kiosk) | | ready | ticket `docs/tickets/b10-b11-tour-banners.md` (with B11) | dispatch tomorrow |
| B11 | MKT | Ad banner list served to the client | | ready | in the B10 ticket | dispatch tomorrow |
| B12 | MKT | Curate the YouTube list (under one minute each) | | queued | content task | |
| B13 | MKT | Hardening pass on rewards and device identity | | queued | after B5-B9 | |
| A1-A8 | MKT | Screens and copy: ad zone, paged leaderboard, tournaments, profile, tours, rewards rework | marketing lead | queued | brief sent: `tasks-marketing-lead.md` / `.fa.md` | |

## Known gaps (small, carded above where they belong)

| ID | Gap | Covered by |
|---|---|---|
| G1 | The Trader-level signup prompt on the play screen calls `claim_task('signup')` for unverified players and fails with `email_required`; same dead end C7 fixed in the broke overlay | small fix; do with B9 |
| G2 | `round_settled` carries no `stake`; the win pane's stake text is still the client's own number for the lever it sent | add `stake` to the frame; with C4b |
| G3 | Leaderboard own-row match compares masked emails, so colliding masks highlight two rows | B2 |
| G4 | Nothing tests the production bundle; the Connecting trap slipped past every E2E because they run on the Vite dev server | a compose smoke test in the deploy gate; with D2 |
| G5b | The chart is shown only while a round runs (by design); the idle play screen has no chart. Checked 2026-09-16 on the compose build: it draws. | none; say so in the demo doc |
| G5 | `npm run format:check` red on ~20 pre-existing files | cosmetic |

## Defects found and fixed (for the record)

- `create or replace` left old SQL overloads; `feed.js` crashed on shutdown; `settle_round` lacked `best_streak`; `verify_otp_code` could not raise and persist; kiosk verdicts went to the wrong socket; pgTAP `throws_ok` misuse; server without `FINNHUB_TOKEN` looked sluggish; two Finnhub sockets on one key gave 429; compose read the developer `.env`; localhost socket URL baked into the bundle (twice: rehearsal, and again 2026-09-16 evening, now pinned by `.env.production`); kiosk verdict coins computed client-side (C2); the profile avatar crashed the kiosk (B16); the dev hook's last frame was overwritten by ticks (flaky test); the streak spec ran on a session another spec left open; `insufficient_coins` refusal did not push the session state; the signup-bonus CTA was a dead end for unverified players (C7).

## Log

- 2026-09-16 morning: layered spec, Opus review folded in, feed decision changed to one continuous series.
- 2026-09-16 midday: L1 built, verified, merged; box merged into `dev`; local production rehearsal PASS.
- 2026-09-16 afternoon: C1, C2, C3, C3a, C4, D1 merged; 3-decimal publishing; MT5 specced and the MetaApi source built; admin requirements written; handover to the cbx account.
- 2026-09-16 evening: marketing lead's profile screen pulled (pull-only remote); B16 fix; B14, C5, C2b, C6+C7 merged; L1.5 closed except C4b and the rest of Q1. OpenCode Go hit its monthly cap and killed six workers; OpenCode roster raised for when it renews; workers now run as Orca terminals. Play screen stuck on Connecting traced to the bundle carrying the developer socket address; fixed at the root. D2 found never built; being built now.

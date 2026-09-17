# xChief Gold Rush - tracker

The one tracker. Updated at every merge. `layers.md` defines the layers and holds the ticket specs; `tasks-marketing-lead.md` is the brief handed to the marketing lead (Part A is theirs, Part B is mirrored here). `PROGRESS.md` is retired into this file.

Status values, each with its emoji in the table: ✅ `done` (merged into `dev`, verified by the orchestrator's own runs) · 🔍 `verifying` (delivered, the orchestrator is running the gates) · 🔨 `building` (a worker is on it) · 📋 `ready` (ticket written, waiting for a seat) · ⛔ `blocked` (waiting on someone outside the team) · ⏳ `queued` (not ticketed yet) · 🟡 `partly` · 💤 `parked`.
Layer: `L1` the game on the box · `L1.5` client experience · `L2` hardening · `MKT` marketing lead's brief · `OPS` deployment and operations · `FEED` price feed.

## Where we are

| Layer | Progress | Open | Read |
|---|---|---|---|
| L1 game on the box | 🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩 7/7 | 0 | complete, load-tested (100 sockets, p95 settle 5024 ms), rehearsed through compose + Caddy |
| L1.5 client experience | 🟩🟩🟩🟩🟩🟩🟩🟩🟩⬜ 18/19 | C4b animation ⏳, Q1 rest 🟡 | booth and web flows built and verified end to end; red team: every loophole fixed (C10) |
| L2 hardening | 🟩🟩🟩🟩⬜⬜⬜⬜⬜⬜ 7/18 | S1, S3, S5, S6, S8, S10, S11, S12, S14, S15 are M2 scope creep | S2 rate limits and S18 safe mode merged; production numbers under review with the owner |
| MKT Part B | 🟩🟩🟩🟩🟩🟩🟩🟩🟩⬜ 15/16 | B12 ⏳ (content, marketing) | B1, B4, B5, B14, B15 (build), B16 done |
| OPS | 🟩🟩🟩🟩🟩🟩⬜⬜⬜⬜ 3/5 | D3 run on the box, D4 schema apply (M2) | deploy scripts built; first real run happens on the box |
| FEED | 🟩🟩🟩🟩🟩🟩🟩🟩⬜⬜ 4/5 | S17 MetaApi ⛔ admin (may be moot: the Docker bridge is live with the demo account) | Finnhub live with PAXG fallbacks, 3-decimal publishing |

**Demo milestone (M1):** 33 of 33 tickets merged. Gate: showcase run on the compose build, then the `demo-1` tag. MT5 Docker bridge is live on the local stack with the broker demo account. Building now: C9, B6+B7+B9. Verifying: B10+B11, B15 (M3, off the Demo path).

### Landed on dev today (newest first)

Live view: https://github.com/AIT-ERP/xChief-Gold-Rush/commits/dev (every merge below is a push there; `dev` is also pushed to the marketing lead's repo `apsych` since 2026-09-17 evening, never its `main` unless the owner says so). Local stack: http://localhost:8080 rebuilt from dev after every merge; second instance without MT5 at http://localhost:5361 while the demo walk lasts. Each row is added the moment the merge commit is pushed, after the orchestrator's own gate run on the merged tree.

| Time | Ticket | What landed | Gates on the merged tree |
|---|---|---|---|
| 22:35 | K5 | new email mask on the server (`ped*****ncy@gmail.com`, company domains masked to `f***d@a**.co`), leak test proves anonymous sockets and alerts never carry a raw email | 98 server, 35 E2E |
| 22:05 | U2 | one leaderboard header card (cup icon, title, tournament info), switcher toggles it, guest note is the own row, pinned own row fixed | 137 unit, 35 E2E |
| 21:20 | U1 | wipe button gone (code kept), user-icon avatar, themed scrollbars, client keeps one socket to our server only (direct Finnhub/OKX/Binance sources removed from the client) | 137 unit, 33 E2E |
| 19:50 | B13 | rewards hardening: nine attacks held, claim audit, device-bound claims | 137 unit, 287 pgTAP, 97 integration, 31 E2E |
| 19:25 | OD1 | OTP budgets raised to venue-safe values, visible 'too many connections' line, wrong-code regression spec; proven: no verify without the right code, no reward without verify | 137 unit, 87 integration, 31 E2E |
| 18:35 | feed | Finnhub through the gold price relay (`FEED_RELAY_WS`), `/status` shows the publishing source (closes G10) | 137 unit |
| 17:40 | B8 | Instagram reward bound to an OAuth-verified account, live the day the credentials arrive | 135 unit, 285 pgTAP, 85 integration, 30 E2E |
| 17:05 | C11 | real first-visit tour and bilingual kiosk intro on the B10 mount points | 127 unit, 28 E2E |
| 16:30 | T1 | Telegram alerts with an event catalogue and a recommendation per event; first OpenCode Go delivery | 127 unit, 277 pgTAP, 82 integration |
| 16:05 | B6+B7+B9 | rewards released by the server: video progress, redirect-and-return, email and signup on verify; client renders the server task list | 277 pgTAP, 82 integration, 25 E2E |
| 15:20 | B2+B3 | paged leaderboard with the own row pinned, badge tiers and legend | 261 pgTAP, 78 integration, 22 E2E |
| 14:45 | C9 | prize by QR: reserved coupon + one-time claim link, kiosk QR screen with fa+en text and 20 s countdown, /claim page with email and gift card, expired links release the coupon | 114 unit, 236 pgTAP, 74 integration, 21 E2E |
| 14:20 | B10+B11 | tour flag and placeholder tour/intro, ad banner zone on the leaderboard, shared first-visit E2E helper | 114 unit, 211 pgTAP, 68 integration, 19 E2E |
| 14:08 | S18 | safe mode: guarded/locked levels, automatic escalation, operator script, /ops banner, Cloudflare runbook | 108 unit, 211 pgTAP, 68 integration, 17 E2E |
| 13:55 | ops | OpenCode roster back to efficient builders only | |
| 13:45 | B15 | MT5 Docker bridge: build, review, two hardening passes; clean-volume boot 709 s, warm restart ok | lint, 96 unit, 28 Python |
| 12:52 | tracker | emoji states, progress bars, pickup queue | |
| 12:28 | C10 | red-team fixes: kiosk reset voids the round, empty secret fails closed, kiosk cannot read the board, contract-only error codes | 211 pgTAP, 58 integration, 17 E2E |
| 12:05 | B1+B4 | tournaments as data with no-overlap constraint, per-tournament records, client header and switcher; email-only leads | 201 pgTAP, 54 integration, 16 E2E |
| 11:45 | S2 | per-IP and per-socket rate limits, OTP supersession, HTTP body cap, 15-minute IP block | 189 pgTAP, integration green, load 100 sockets p95 5061 ms |
| 11:20 | B5 | device identity: devices table, signed device token, rewards once per device or email | 189 pgTAP, 40 integration |
| 10:30 | red team | showcase 13/13, red team 14 held / 7 partial / 2 loopholes, plan and tickets | |

### Queue, in the exact order it is picked up

1. ✅ B10+B11 merged.
2. ✅ B15 merged (clean boot verified).
3. ✅ C9, B2+B3, B6+B7+B9 merged.
4. ✅ S18 safe mode merged.
5. ✅ B2+B3 merged.
6. ✅ B8 and C11 merged; 🔨 B13 rewards hardening on OpenCode.
9. ⏳ B12 YouTube list curation (content), C4b leaderboard animation (after B2).
10. Demo gate: showcase run on the compose build, all E2E green, then M2 deployment on the box.

Play it now: compose stack at http://localhost:8080 (kiosk `/?k=dev-kiosk-secret-0001`), operator pages `/ops` and `/logs`.

## Operating state 2026-09-17 night (handover for the next context window)

**The one client the owner watches:** http://localhost:5173 (Vite dev server on the main checkout; kiosk `/?k=dev-kiosk-secret-0001`). Its game server is `node server/index.js` on 8787 started from the main checkout with: `DATABASE_URL` = the compose database published on 127.0.0.1:55480 (password = `POSTGRES_PASSWORD` from `.env.box`, exported without printing), `PLAYER_TOKEN_SECRET=dev-secret`, `TRUST_PROXY=0`, `PUBLIC_URL=http://localhost:5173`, `FEED_RELAY_WS=ws://localhost:8788/ws`, `MT5_BRIDGE_WS=ws://localhost:8765`, `MAX_ANON_PLAYERS_PER_IP_PER_10MIN=200`, `MAX_CONNECTIONS_PER_IP_PER_MIN=300`. The relay is `node relay/server.js` with `PORT=8788` and the Finnhub key from `.env.box`. Compose: only `db` and `mt5` run (caddy, server, dozzle stopped); the untracked `docker-compose.override.yml` publishes caddy 8080:80, db 55480 and mt5 8765 on loopback. Restart order after a reboot: compose `db` + `mt5` (profile mt5), relay, game server, Vite. Never `docker compose down -v` on the project (G12): it wipes the MT5 profile; the first login is redone by driving https://127.0.0.1:3001 with Playwright (company search "xChief", pick xChief Ltd, login and password from the container env, server xChief-MT5, Finish, then `pkill -f "opt/mt5-bridge/bridge.p[y]"` so the bridge re-attaches).

**Owner's edits on `dev`:** the owner tweaks UI in the main checkout while walking. Before every merge run `git add -A && git commit -m "Owner UI tweaks"` on `dev`; never overwrite those lines; resolve conflicts the owner's way and say so.

**Workers (OpenCode Go, cheap roster), handles in `D:\tmp\tickets\orca-stage23.txt`, worktrees under `C:\Users\Kayhan Azadi\orca\workspaces\xchief-gold-rush\<name>`, each writes `docs/reports/<name>-report.md` in its worktree:** U1 client polish, U2 leaderboard header, U3 animated banners, U4 share, K1 open kiosk route, K5 email mask. Queued next, in this order because they share files: K4 Missions + YouTube (Tasks.jsx), then K3 Instagram via BoxAPI (Tasks.jsx), K2 kiosk intro with QR (after U1 and K1). Tickets in `docs/tickets/`. OpenCode rules: `kimi-k2.7-code` for server work, `deepseek-v4.1-flash` for client; prompt says explicit `./` paths, never open `.env*` (copies `ENV_PUBLIC.txt`, `ENV_BOX_EXAMPLE.txt`, `ENV_PRODUCTION.txt` are placed in every worktree), never kill foreign processes, own ports only, gates in the foreground, report to a file. When OpenCode is capped (5-hour window), run the same tickets as live Sonnet sessions on cb or cbx (`D:\tmp\tickets\run-<name>-cb-i.ps1` pattern).

**Verification loop per delivery:** in the worktree, `db/run-tests.sh` copied with a free port (5547x) and a `goldrush-verifyN-keep` container, server on 877x, Vite on 536x, `BASE_URL`, `VITE_GAME_WS`, `PUBLIC_URL`, `TRUST_PROXY=0`; lint, unit, build, pgTAP, test:server, full E2E; then commit on the branch, merge into `dev`, resolve, rerun the gates on the merged tree, commit, `git push origin dev` and `git push apsych dev:dev` (both work; pushes to any `main` are blocked by the permission classifier and need the owner), remove the worktree (`orca worktree rm --worktree branch:<b> --force`), add the tracker row and the "Landed on dev today" line. Ports 5178, 5199 and 55479 are in a Windows reserved range; IIS holds port 80.

**Waiting on the owner:** the `main` push and the `demo-1` tag (Demo tickets 33/33 merged; showcase against the compose build was stopped by the owner before the tag), venue numbers for the per-IP limits, credential rotation after the B1 worker read `.env`, `BOXAPI_TOKEN` (placeholder added to `.env.box`), `PASSWORD` for the MT5 VNC page, Telegram bot token and chat id.

## Recalibration 2026-09-17 evening (owner)

Demo tickets are all merged (33/33). The showcase run against the compose build was stopped by the owner before the tag; the `demo-1` tag waits for the owner's word. New requirements, in priority order:

| ID | What | Owner's assumption or change | Status |
|---|---|---|---|
| A1 | MT5 route is secure and looks like an ordinary xChief client; nothing leaks through the server | assumption; needs a written audit: bridge port never published, VNC loopback-only behind `PASSWORD`, investor password only, mt5 container env narrowed (G11), logs never carry credentials | 📋 carded as S19 |
| A2 | The client has one socket, ours; the server ingests every feed and is the relay; ladder MT5, then Finnhub, then others | true on the server (priority 0, 1, 2, 3). False on the client until U1 lands: `src/priceFeed.js` still carries direct Finnhub, OKX and Binance sources from the Supabase era | fixed in U1 |
| U1 | Remove the wipe button (code kept), user icon instead of the "Y" avatar, themed scrollbars everywhere, one socket only | change | ✅ merged (my gates on the merged tree: 137 unit, 295 pgTAP, 97 server, 33 E2E) |
| U2 | Leaderboard: one header card (cup icon, title, tournament info), the switcher toggles it; the guest note readable and placed as the own row (below the list when it fits, pinned when it overflows) | change; the same own-row rule as B2 applied to a logged-out player | ✅ merged (rebased on dev first; my gates: 137 unit, 295 pgTAP, 97 server, 35 E2E); side fix: the pinned own row no longer renders over the topbar (B2 defect) |
| U3 | Ad zone: the two animated xChief banners (`ads/banners/`), rotating when each finishes, zone height at their 1072:310 aspect | change | 🔨 OpenCode |
| U4 | Share: modal with banner preview, copy link and social shortcuts; public `/s/<token>` page with CTAs to play | change | 🔨 OpenCode |
| S19 | MT5 route security audit and hardening (A1) | | 📋 ready to ticket |
| K1 | Open kiosk route `/kiosk`, self-provisioning with a locally persisted identity (accepted leak, decommission after the expo) | change | 🔨 OpenCode |
| K2 | Kiosk intro: three exciting cards, first showing ends on a QR code for the web version; English only (owner 2026-09-17 late: "only 1 locale (eng)"); no coins or missions on the kiosk (owner confirmed the kiosk is already Play only) | change | 📋 ticketed, queued after U1 and K1 |
| K3 | Instagram follow verified through the BoxAPI data API (handle first, then redirect to the Instagram app); `BOXAPI_TOKEN` placeholder for the owner | change | 📋 ticketed, queued after K4 |
| K4 | Coins tab becomes Missions: YouTube missions with a non-seekable watch-progress player; redirect rewards release the moment the timer ends | change | 🔨 OpenCode |
| U5 | English only: the Persian locale is wiped from every page; i18n plumbing stays with one language, the switcher returns in a later version (owner 2026-09-17 late: "a lot of dual locale pages right next to each other") | change | 📋 ticketed; dispatched after the in-flight U2-U4, K1, K5 land (they all touch i18n.js) |
| D5 | Screenshots of every screen (separate PNGs + one high-quality sprite) for a design agent, git-ignored under `design/screens/` (owner 2026-09-17 late) | one-off | 🔨 OpenCode |
| K5 | Nicer server-side email mask that shows more of a long address; masked on the server everywhere | change | ✅ merged (my gates on the merged tree: 137 unit, 295 pgTAP, 98 server, 35 E2E) |

Working mode during the owner's walk: the main checkout runs a Vite dev server on http://localhost:5173 with a game server on 8787 against the compose database, so the owner can tweak the UI on `dev` directly. Workers stay in worktrees. Before every merge the orchestrator commits the owner's working-tree edits on `dev` as "Owner UI tweaks" so nothing is overwritten.

## Plan 2026-09-17: Demo, then the box, then the expansions

Four milestones, in order. Nothing outside the current milestone is picked up unless it blocks it. Anything discovered on the way goes into "Scope creep" below with a priority, and we move on.

**M1 Demo** (today's priority). A simple visitor can play the happy path on the kiosk and on the web, and the operator can run the campaign without code changes.
- Gameplay and visuals: kiosk attract, play, WIN as a QR claim link with the gift card on the visitor's phone (C9), idle reset; web sign in, play, broke path, leaderboard; the first-visit tours (C11). Fix what the red team found (C10).
- Basic security: per-IP and per-socket limits (S2), safe mode with an automatic guarded/locked level and a manual command (S18), Cloudflare rate rule and Under Attack as the last resort. "Am I overwhelmed" is answered in one place: the `/ops` page shows the safe-mode banner, connections per minute and blocked IPs; the same events reach the phone through the alert webhook (Telegram in M4).
- Tournaments as data: add, remove, change dates through documented SQL one-liners, overlap refused by the database (B1), leaderboard per tournament with paging and own row (B2), badge tiers (B3).
- Ads: a banner list plus assets in the repo, rotated on the leaderboard (B11).
- Rewards ("tasks" section): device identity (B5), video watched (B6), redirect and return (B7), Instagram follow with the API adapter built and waiting for credentials (B8), email verified reward (B9), tour flags (B10), hardening (B13). B4 and B12 alongside.
- Definition of done: the showcase script (`demo/showcase.mjs`) runs green on the compose build, all E2E green, tracker rows above marked done.

**M2 Deploy.** The moment M1 lands: execute `docs/box-deploy.md` on the real box (D3): install, DNS, deploy, rollback rehearsal, alerts wired, safe mode tried once. Needs the admin's box and Cloudflare access (`docs/admin-requirements-box.md`).

**M3 Expansion 1, MT5.** Both feed paths in a plug-and-play state: the Docker bridge (B15) merged with its runbook, and MetaApi (S17) with a written "when the credentials arrive" checklist so the swap is a `.env.box` change plus one smoke test. Blocked on the admin for the live test.

**M4 Telegram bot** (T1). Server events to a Telegram group: restart, feed silence and recovery, safe-mode changes, IP blocks, coupon stock low, deploy done, each with a one-line recommendation when it needs a hand.

### The five stages for M1, in dispatch order

1. Land the red-team and showcase work: commit, merge, card the defects (done in this commit).
2. C10 (red-team fixes) and S2 (rate limits, now including OTP code supersession and the HTTP body cap) in parallel on cb Sonnet.
3. B1+B4 (tournaments) and B5 (device identity) in parallel with stage 2; they touch schema and client, not the socket layer.
4. Verify the B15 hardening report; merge or send back. Not on the M1 path, but it is finished work sitting on a branch.
5. Behind those, in order: C9 after C10, B10+B11, S18 after S2, B2 and B3 after B1, B6+B7+B9 after B5, B8 after B6, C11 after B10, B13 last, then the showcase run as the M1 gate.

### Scope creep (found on the way; carded, prioritised, not picked up)

| ID | Found while | What | Priority | Goes to |
|---|---|---|---|---|
| X1 | red team | `/status` and `/health` answer anyone (D6) | low | M2, basic_auth on `/status` in Caddy if the admin wants it |
| X2 | red team | `npm run format:check` red on pre-existing files (G5) | low | any idle worker |
| X3 | tracker audit | S5/S15 Postgres least privilege, S6 nightly dump and restore | medium | M2 |
| X4 | tracker audit | S3 kiosk secret out of the URL | medium | M2 (needs a booth procedure) |
| X5 | tracker audit | S1 secret rotation procedure, S11 code retention | low | M2 |
| X6 | U1 | `README.md`, `CONTRIBUTING.md`, `relay/README.md` still tell developers to set `VITE_RELAY_URL` / `VITE_FINNHUB_TOKEN` for the client, which no longer reads them | low | any idle worker |
| X7 | U1 | `Leaderboard` renders the offline dummy list (`{name, s}`) through the server branch when the fetch is refused, so React keys are `undefined` (console warning, no visible effect) | low | with C4b |
| X8 | U2, U3 | E2E specs write their screenshots into tracked `docs/reports/<ticket>/` folders, so every full-suite run (mine and every worker's) rewrites dozens of PNGs and every merge conflicts on them; move spec output to an ignored `test-results/screens/` and keep curated copies in the reports by hand | medium | before the next batch |

## Tickets

| ID | Layer | Title | Owner | Status | Evidence / notes | Next |
|---|---|---|---|---|---|---|
| 1-7 | L1 | Schema, feed, rounds, ledger, kiosk coupons, OTP, client wiring, acceptance | Sonnet | ✅ done | 101 pgTAP at the time, 16 integration, E2E 4/4, load PASS, rehearsal PASS | |
| C1 | L1.5 | Kiosk session on the server | Sonnet | ✅ done | `kiosk_session` frame, `kiosk_reset`, 60 s sweep; merged `c91d294` | |
| C2 | L1.5 | Kiosk screens: attract, WIN modal + Claim, EXIT modal, reconnect | Sonnet | ✅ done | `src/KioskApp.jsx`; `reports/c2/`; merged `b03d468` | |
| C2b | L1.5 | Kiosk idle: 20 s no activity, activity cancels, 20 s countdown, flush | qwen3.8-max + Sonnet | ✅ done | kiosk E2E 5/5; merged `727f2de` | |
| C3 | L1.5 | OTP entry screen, masked email in the header, sign out | Sonnet | ✅ done | `src/Identity.jsx`; `reports/c3-c4/`; merged `2efe3a6` | |
| C3a | L1.5 | Session policy: 30-day versioned token, 7-day renewal, OTP re-login, revocation | Sonnet | ✅ done | merged `abdec28` | |
| C4 | L1.5 | Live masked leaderboard over the socket | Sonnet | ✅ done | `mask_email()` in SQL, push after every player settle; merged `2efe3a6` | |
| C4b | L1.5 | Leaderboard row animation, own row cue | | ⏳ queued | after Part B B2 reshapes the list (paged, own rank) | dispatch with B2 |
| C5 | L1.5 | Tasks and gifts server-owned: `tasks` frame, reward on claim and refill | Sonnet | ✅ done | 172 pgTAP, 33 integration, 12 E2E; merged `966068b` | |
| C6 | L1.5 | Web verdict pane driven only by `round_settled` | Sonnet | ✅ done | loss line reads the server's delta; merged `a54eeff` | stake in the frame (gap G2) |
| C7 | L1.5 | Broke on the web: refill, tasks, verify email; never a dead end | Sonnet | ✅ done | the signup-bonus dead end fixed; broke E2E; merged `a54eeff` | |
| C8 | L1.5 | Kiosk with no prize codes left: server refuses new rounds, full-screen modal asks the visitor to tell the booth staff, recovers when codes are loaded | Sonnet (cb) | ✅ done | 176 pgTAP, 36 integration, kiosk + streak E2E 8/8 on my run; `reports/c8/no-codes.png`; merged | |
| C9 | L1.5 | Prize by QR: N wins in a row shows a QR with a one-time claim link (fa + en text), 20 s countdown and an "I've scanned it" button that resets the booth; the claim page asks for an email, shows the gift card with the code, emails it; coupon reserved at win, released after 24 h unclaimed | | 🔨 building | approved 2026-09-17, overrides the on-screen code and the reveal idea; ticket `docs/tickets/c9-qr-claim.md`; Sonnet (cbx, live) | verify, merge |
| C10 | L1.5 | Red-team fixes: `kiosk_reset` cancels the round it stands on (D1, high); empty `?k=` refused (D7); `leaderboard` frame kind check (D8); SQLSTATE never escapes as an error code (D9); kiosk secret guessing throttled (D10) | Sonnet (cbx) | ✅ done | red-team reruns A7/A8/A16 HELD; 211 pgTAP, 58 integration, 17 E2E on my merged run; merged | |
| D3 | OPS | Execute the runbook on the real box: install, DNS, deploy, rollback rehearsal, alerts, safe mode tried once | | ⏳ queued | needs the admin's box and Cloudflare access | M2 |
| D4 | OPS | Schema apply on deploy: make `db/schema.sql` re-runnable against a live database (or add migrations) and call it from `deploy/deploy.sh`; smoke-test that `/status` answers after a redeploy | | ⏳ queued | gap G7; without it every schema ticket breaks the next redeploy | M2, before D3 |
| T1 | OPS | Telegram bot: server events to a group (restart, feed silence/recovery, safe-mode change, IP block, coupon stock low, deploy done), one-line recommendation per event | OpenCode kimi-k2.7-code | ✅ done | Telegram transport, event catalogue with recommendations, coupon low/exhausted from the sweep, deploy scripts post done/failed, `alert-test` script and bot docs; 127 unit, 82 integration on my merged run; merged | needs the bot token and chat id from the owner |
| Q1 | L1.5 | Blind E2E over every scenario | gpt-5.6-luna (B14) | 🟡 partly | five-win streak covered by B14; web flows covered by the player-promises and web-identity specs written with the tickets | blind pass for the rest after C4b |
| B14 | L1.5 | Blind five-win streak tests, kiosk and web | gpt-5.6-luna | ✅ done | coupon row, session_over, exhausted pool, WIN modal E2E; merged `e4efdd0` | |
| B16 | L1.5 | E2E regression after the profile merge | Sonnet + orchestrator | ✅ done | kiosk crashed on the avatar's missing action; 13/13 E2E; merged `92bd000` | |
| D1 | OPS | Monitoring: `/status`, `/ops`, `/logs`, alerts | Sonnet | ✅ done | merged `4839072`; `$` doubling trap documented | |
| D2 | OPS | One-command deploy, auto-deploy on push, install, rollback | Sonnet | ✅ done | `deploy/*.sh`, `client.Dockerfile` (bundle built in Docker, verified: no dev socket address); box behaviour of install/cron/ufw untestable on Windows, to be rehearsed on the real box | rehearse on the box |
| S17 | FEED | MT5 via MetaApi, plug-and-play | orchestrator | ⛔ blocked | code merged and reaches MetaApi; refused by token scope | M3: write the "credentials arrived" checklist; admin: account UUID, token with account read, quote interval 0 |
| B15 | FEED | MT5 terminal + tick bridge in Docker, LIVE on the local stack since 2026-09-17 17:58 with the broker demo account (xChief-MT5, symbol `XAUUSD.d`) | Sonnet (cbx) | ✅ done | build, independent review, two hardening passes; my clean-volume cold boot reached healthz in 709 s with zero restarts and a warm restart came back; merged `86141c1` | first login with the broker's investor account (M3) |
| F1 | FEED | Finnhub + PAXG continuous series, 3 decimals | | ✅ done | measured 9 moves / 5 s vs 1-2 on PAXG | |
| S1 | L2 | Secret rotation procedure | | ⏳ queued | folded into C3a except the procedure | |
| S2 | L2 | Per-socket AND per-IP rate limits (sockets per IP, connections per minute, anonymous signups, OTP per IP, frame flood, frame size, play cadence), 15-minute IP block | Sonnet (cbx) | ✅ done | limits.js; load 100 sockets over 10 IPs p95 settle 5061 ms; merged; production numbers under review with the owner (venue NAT) | S18 next |
| S3 | L2 | Kiosk secret out of the URL; scrub `k=` from Caddy logs | | ⏳ queued | audit: not done, secret still in `?k=` | |
| S4 | L2 | OTP on a known email logs into that player | | ✅ done | in C3a | |
| S5 | L2 | Postgres least privilege: an `app` role | | ⏳ queued | audit: the server still connects as `postgres`; the compat roles exist only for pgTAP | |
| S6 | L2 | Nightly `pg_dump` to object storage, one rehearsed restore | | ⏳ queued | audit: nothing yet | |
| S7 | L2 | Ops runbook for a non-engineer | | ✅ done | `docs/box-deploy.md` rewritten by D2 (install, deploy, rollback, daily habits, monitoring) | add "if attacked" with S18 |
| S8 | L2 | Campaign end: freeze the leaderboard, export the top 10 | | ⏳ queued | audit: only `scripts/export-coupons.mjs` exists; becomes per-tournament with B1 (a tournament's end is its freeze) | with B1 |
| S9 | L2 | Coupon exhaustion wording | | ✅ done | C8's modal copy | |
| S10 | L2 | Origin pinning on the socket, security headers, TLS-only cookies | | ⏳ queued | audit: not done (Caddyfile comment marks the spot; no origin check in `server/index.js`) | with S2 |
| S11 | L2 | Email consent text and code retention | | 🟡 partly | audit: the lead forms carry "No spam. Unsubscribe anytime."; OTP code retention/cleanup not verified | |
| S12 | L2 | Coupon audit and reconciliation, alert at N codes left | | ⏳ queued | audit: `codes_left` now on every kiosk frame (C8) and `/status` has the counts; the low-stock alert is missing | with T1 |
| S13 | L2 | OTP verify-attempt limiting | | ✅ done | in L1 (5 tries per code) | |
| S14 | L2 | Kiosk hygiene: no player token on a kiosk, clean state between visitors | | ⏳ queued | red team D7: an empty `?k=` turns a booth into a web player | in C10 |
| S15 | L2 | Least privilege, extended | | ⏳ queued | with S5 | |
| S16 | L2 | Leaderboard integrity at prize time: one row per verified email | | ✅ done | `players.email` is unique and `leaderboard()` ranks verified emails only; the export becomes per-tournament with B1 | |
| S18 | L2 | Safe mode: guarded and locked levels, automatic escalation on connection and signup spikes, operator command, Cloudflare Under Attack runbook | Sonnet (cbx) | ✅ done | `server/safemode.js`, `public.settings`, `scripts/safe-mode.mjs`, /ops banner, Cloudflare runbook; 98 unit, 68 integration, 17 E2E on my merged run; merged | thresholds revisited with the owner's venue numbers |
| B1 | MKT | Tournaments as data (dates, prize image and title, broker bonus), adjustable without code | Sonnet (cbx) | ✅ done | tournaments table, no-overlap constraint, per-tournament records, SQL one-liners in the runbook; merged | B2, B3 |
| B2 | MKT | Leaderboard API: 20 per page, own rank and row in every response, live top 20 | Sonnet (cbx) | ✅ done | 20 per page, `my_rank` by player id (closes G3), per-socket `me` on every push; 261 pgTAP, 78 integration, 22 E2E on my merged run; merged | C4b animation |
| B3 | MKT | Badge tiers and the legend endpoint | Sonnet (cbx) | ✅ done | `badge_tiers` table, `tier_for_rank`, `badge_legend()`, six placeholder SVGs; merged | real badge art from marketing |
| B4 | MKT | Name and phone removed from lead capture | Sonnet (cbx) | ✅ done | email only in forms, storage and /api/lead; merged | |
| B5 | MKT | Per-device identity for anonymous players | Sonnet (cbx) | ✅ done | 189 pgTAP, 40 integration on my run; `clientIp` now owned by S2's limits.js; merged | |
| B6 | MKT | Reward: video watched (90 %) once per device, released by the server from reported progress | Sonnet (cbx) | ✅ done | `video_progress` with the 90 % threshold and fast-forward guard; released by the server; merged | |
| B7 | MKT | Reward: redirect and return (Trustpilot, YouTube, Telegram), 5 s window | Sonnet (cbx) | ✅ done | `task_visits`, 5 s window, once per device or email; merged | B13 hardens |
| B8 | MKT | Reward: Instagram, bound to an OAuth-verified Instagram account once per account, device and email (Instagram exposes no follow check to third parties); env-driven, fake for tests, live the day the app id and secret arrive | OpenCode kimi-k2.7-code | ✅ done | `instagram_accounts`, OAuth start/callback, fake Instagram server for tests, `not_configured` until the app credentials arrive, checklist in the runbook; 135 unit, 285 pgTAP, 85 integration, 30 E2E on my merged run; merged | owner: Instagram app id and secret |
| B9 | MKT | Reward: email verified, released by the server on OTP success | Sonnet (cbx) | ✅ done | email and first-time signup rewards released on OTP verify; closes G1; merged | |
| B10 | MKT | Tour-seen flag per device (web) and per boot (kiosk) | Sonnet (cbx) | ✅ done | tour placeholder (web, localStorage) and kiosk intro (once per boot); shared `dismissFirstVisit` E2E helper; 19 E2E on my merged run; merged | C11 real tour content |
| B11 | MKT | Ad banner list served to the client | Sonnet (cbx) | ✅ done | `ads/banners.json` + `public/ads/`, `<AdZone/>` bottom 40 %% of the leaderboard, Caddy `handle_path /ads*`; merged | marketing drops real banners into `ads/` |
| B12 | MKT | Curate the YouTube list (under one minute each) | | ⏳ queued | content task | |
| B13 | MKT | Hardening pass on rewards and device identity: nine attacks scripted, fixes decided, audit view and export | Sonnet (cb) | ✅ done | nine attacks HELD (`docs/reports/redteam-rewards.md`); claim IP recorded, task frames on the shared budget, claims bound to the device minted at auth, no-device window for legacy clients only, `reward_audit` view and export; 137 unit, 287 pgTAP, 97 integration, 31 E2E on my merged run; merged | |
| A1-A8 | MKT | Screens and copy: ad zone, paged leaderboard, tournaments, profile, tours, rewards rework | us (owner's call 2026-09-17: nothing landed on `apsych/main`) | ⏳ queued | A1 in B11, A2 in B2, A3 in B1+B3, A4 exists (profile screen pulled earlier), A7 in B6-B9; A5+A6 real tour content is the only standalone piece: C11 | in Demo |
| C11 | L1.5 | First-visit tour (web) and kiosk intro with real content on the B10 mount points | OpenCode deepseek-v4.1-flash | ✅ done | three web cards with Next/Skip/Got it, bilingual kiosk intro with the server's streak target; 127 unit, 28 E2E on my merged run; Persian copy written by the worker, one brand-name edit by the orchestrator, still wants a native read; merged | native fa read |

## Open defects (owner-reported, fix later, target the search when picked up)

| ID | Reported | What happened | Keys to reproduce | Related | Status |
|---|---|---|---|---|---|
| OD1 | owner, 2026-09-17 on the local stack (fixed the same evening) | Registering with an email opened the OTP dialog; a few gibberish codes produced a **429** in the browser console; a few attempts later with other emails the owner got in and was credited rewards on the account | email `t1w@f.com`; wrong codes typed several times; then different emails; look for the 429 on the socket upgrade or `/api` (S2's per-IP OTP window is 5 per 10 min, the connection window 30 per min, verify attempts 5 per code); check whether the client reconnects after `too_many_attempts` and burns the connection window; check how the local stack let a later email through (dev OTP peek? code accepted?) and whether the signup/email reward was released on a verified path (B9) | S2, S13, B9, C3 | ✅ done: no security defect (cannot verify without the right code, no reward without a completed verify); the 429 was the per-IP connection window on the socket upgrade, reached through reloads; OTP budgets raised to 30 per IP and 5 per email per 10 min; a visible 'too many connections' line replaces the silent console error; merged; 137 unit, 87 integration, 31 E2E on my merged run |

## Known gaps (small, carded above where they belong)

| ID | Gap | Covered by |
|---|---|---|
| G1 | The Trader-level signup prompt on the play screen calls `claim_task('signup')` for unverified players and fails with `email_required`; same dead end C7 fixed in the broke overlay | closed by B9 (the CTA opens the OTP screen; the reward is released on verify) |
| G2 | `round_settled` carries no `stake`; the win pane's stake text is still the client's own number for the lever it sent | add `stake` to the frame; with C4b |
| G3 | Leaderboard own-row match compares masked emails, so colliding masks highlight two rows | closed by B2 (own row by player id) |
| G4 | Nothing tests the production bundle; the Connecting trap slipped past every E2E because they run on the Vite dev server | a compose smoke test in the deploy gate; with D2 |
| G5b | The chart is shown only while a round runs (by design); the idle play screen has no chart. Checked 2026-09-16 on the compose build: it draws. | none; say so in the demo doc |
| G5 | `npm run format:check` red on ~20 pre-existing files | cosmetic |
| G6 | `get_tasks()` marks `claimed` per player only, so a task blocked by another player on the same device still looks open until the claim is refused | B6-B9 reworks get_tasks; fold in |
| G7 | Schema changes never reach an existing database volume: `db/schema.sql` is applied only when the Postgres container initialises an empty volume, so a redeploy on the box after any schema ticket leaves the old tables in place (seen locally 2026-09-17: `public.settings does not exist` after the S18/C9 merges) | M2 blocker: D2's deploy step needs an idempotent apply (`create ... if not exists` plus `create or replace function`) or a migrations folder; card as D4 |
| G8 | First login on a fresh volume: the terminal starts with no account and the `/login /password /server` switches only work after MT5 has fetched the broker's server list once (the "select a company" dialog). Done today by driving the VNC page with Playwright; the docs still describe a manual VNC session | write the automated first-login into `mt5/` (a script that searches the company, picks the server, fills login and password from the container env) and update `docs/mt5-feed.md`; M3 |
| G9 | The bridge's stdout is block-buffered under Wine, so its log lines only appear when the process dies; `PYTHONUNBUFFERED=1` (or `-u`) in `mt5/entrypoint.sh` | small; M3 |
| G10 | `/status` does not say which feed source is publishing | closed: `feed.source` on `/status` (2026-09-17 evening) |
| G11 | The mt5 container receives the whole box env through `env_file` (database password, Elastic key, token secrets) although it needs five variables | narrow to an `environment:` list; M2 |
| G12 | `docker compose down -v` on the whole project also deletes the `mt5_data` volume, which holds the terminal install and the saved broker login (seen 2026-09-17 20:00: the demo-gate rebuild wiped it, 12-minute reinstall plus a new first login). Reset only the database volume when redeploying; `deploy/deploy.sh` must never use `-v` | D4: reset `db` only; document in the runbook |

## Defects found and fixed (for the record)

- `create or replace` left old SQL overloads; `feed.js` crashed on shutdown; `settle_round` lacked `best_streak`; `verify_otp_code` could not raise and persist; kiosk verdicts went to the wrong socket; pgTAP `throws_ok` misuse; server without `FINNHUB_TOKEN` looked sluggish; two Finnhub sockets on one key gave 429; compose read the developer `.env`; localhost socket URL baked into the bundle (twice: rehearsal, and again 2026-09-16 evening, now pinned by `.env.production`); kiosk verdict coins computed client-side (C2); the profile avatar crashed the kiosk (B16); the dev hook's last frame was overwritten by ticks (flaky test); the streak spec ran on a session another spec left open; `insufficient_coins` refusal did not push the session state; the signup-bonus CTA was a dead end for unverified players (C7).

## Log

- 2026-09-16 morning: layered spec, Opus review folded in, feed decision changed to one continuous series.
- 2026-09-16 midday: L1 built, verified, merged; box merged into `dev`; local production rehearsal PASS.
- 2026-09-16 afternoon: C1, C2, C3, C3a, C4, D1 merged; 3-decimal publishing; MT5 specced and the MetaApi source built; admin requirements written; handover to the cbx account.
- 2026-09-17 morning: red team and showcase landed (2 loopholes, 10 defects, carded as C10 and folded into S2); plan rewritten around four milestones (Demo, Deploy, MT5, Telegram). C10, S2, B1+B4, B5 dispatched on cb; cb hit its 5-hour cap within the hour, all four relaunched on cbx with resume notes. B15 hardening failed verification on a clean volume (second-pass ticket). C9 approved as the QR claim flow; A-screens fall to us (C11 for the tours).
- 2026-09-16 evening: marketing lead's profile screen pulled (pull-only remote); B16 fix; B14, C5, C2b, C6+C7 merged; L1.5 closed except C4b and the rest of Q1. OpenCode Go hit its monthly cap and killed six workers; OpenCode roster raised for when it renews; workers now run as Orca terminals. Play screen stuck on Connecting traced to the bundle carrying the developer socket address; fixed at the root. D2 found never built; being built now.

# Box plan - the two scenarios and the build order

Short version of `box-spec.md` plus the review's fixes, for sign-off. Layer 1 only; security stays in Layer 2.

## Decisions locked

| Topic | Decision |
|---|---|
| Identity in SQL | Keep every migration and all 70 passing tests. Add `0000_compat.sql`: an `auth` schema, `auth.uid()` reading a per-transaction setting the **server** sets after verifying the token, a small `auth.users` the server owns, and the two role names. Identity never comes from a client argument. |
| Development database | Local `postgres:16` in Docker only. Never the Supabase dev database. |
| Price source per round | A round is pinned to the source it opened on; if the source changes before settle, the round is void (`feed_stale`), never settled across XAU and PAXG. Source demotion after 10 s of silence. `rounds` gains a `source` column. |
| Lead capture | The box's server owns `/api/lead` (same JSON, same optional webhook). |
| Rate cap | 400 rounds per player per hour. The 5-second round is the real throttle. |
| Empty coupon pool | The 5th win keeps the streak, returns `coupons_exhausted`, logs loudly. Kiosk shows "tell the staff". |
| Kiosk streak between players | Resets after 60 s with no round on that kiosk. Also resets on a loss or a claim, as today. |
| Kiosks | One `kiosks` row and one launch URL per physical device. Five exist for the demo. |
| Client price feed in server mode | Only ticks from the game socket. The browser's own exchange sockets and the quiet-market animation are off. What the player sees is what the server settles on. |
| Process model | One game server process, forever. Restart voids open rounds (rare, visible, correct). Never run two. |
| Frontend | Served by the box (Caddy). The marketing lead deploys with `npm run build` + one copy command, documented. |

## Scenario A - free play on the web

1. Player opens the site. The browser connects to `/ws`; it has no token, so the first frame is `auth {}`. The server creates an anonymous player, replies `welcome {token, me}`, then streams `hello` and `price` ticks. The browser stores the token; next visit it sends `auth {token}` and gets `welcome {me}` back with the same score.
2. Player picks a lever and presses Up or Down. Client sends `play {dir, lever}`. Server calls `open_round` (start price = latest tick from the current source, pinned), replies `round_opened` in well under 100 ms, and arms a 5-second timer.
3. For 5 seconds the browser runs its countdown on the live ticks it is receiving. Nothing waits on the network.
4. Timer fires: server takes the latest tick from the pinned source, calls `settle_round`, and pushes `round_settled {outcome, delta, coins, streak, record, start_price, end_price}`. The countdown ends and the verdict is on screen. If the player reloaded mid-round, the round still settles; the next `auth` delivers the missed verdict once.
5. Tasks and refill: `claim_task`, `free_refill` over the socket, server-owned coins come back in `me`.
6. Email: at the milestone the player enters an email; `request_otp` stores an 8-digit code and sends it through Elastic's template (dev: stored in `dev_otps`). `verify_otp` marks the same player as verified; the score is kept and the player appears on the top-10 (`leaderboard` frame). Top 3 at campaign end are contacted at that verified email.

## Scenario B - the booth kiosk

1. Staff open the kiosk's own launch URL (`/?k=<secret>`) in Chrome kiosk mode. The browser sends `auth {kiosk}`; the server verifies the hash, replies `welcome {kiosk: true, streak}`, streams prices. No email prompt, no leaderboard, no token stored.
2. A visitor plays: same `play` -> `round_opened` -> local countdown -> `round_settled` at 5 s, with prices and streak from the server. Coins on the kiosk are cosmetic and also come from the server frame, so screen and server never disagree.
3. Fifth consecutive win: `settle_kiosk_round` claims one code atomically and returns it in `round_settled {coupon}`. The kiosk shows it once. Streak resets to 0. If no code is left: `coupons_exhausted`, streak kept, staff told.
4. Visitor walks away: after 60 s without a round the kiosk streak resets, so the next person starts fresh. Any loss also resets it.
5. Venue wifi drops: the socket reconnects with backoff; a round in flight still settles on the server and the verdict arrives on reconnect. If the box is unreachable for longer, the kiosk shows "reconnecting", never a fake verdict.

## Build order (each a ticket, blind tests written from the contract by a different agent)

| # | Ticket | Acceptance |
|---|---|---|
| 1 | `db/`: migrations 0000 (compat) + 0001..0007 copied + `0008_box.sql` (`rounds.source`, 400/hr, exhausted-pool rule, kiosk idle reset) | pgTAP 70/70 plus new cases on local postgres:16 |
| 2 | `server/feed.js`: Finnhub + PAXG fallback, 10 s demotion, per-source ring buffer, fan-out | Unit: source pinning, staleness, buffer |
| 3 | `server/index.js` + `rounds.js` + `ledger.js`: socket protocol, auth frames, rounds with timers, pending verdicts, `/api/lead` | Socket integration: `round_opened` < 100 ms, `round_settled` at 5.0-5.3 s, disconnect settles, two `play` -> one `round_in_flight`, source-switch voids |
| 4 | `server/otp.js` + login frames | Integration: request/verify, dev capture, score kept |
| 5 | Client: `src/api/` on the socket, `priceFeed.js` server mode, kiosk verdict from server | E2E: first assertion is "server mode"; then the four player promises |
| 6 | `docker-compose.yml`, `Caddyfile`, deploy doc for a non-engineer, `gen-kiosk` ported | `docker compose up` on a clean VM serves the game over TLS |
| 7 | Acceptance run: 5 kiosks + 4 web for 10 minutes, then a 100-socket load run | Zero errors, verdicts on the countdown, flats rare |

Tickets 1 and 2 start together; 3 needs 1 and 2; 4 and 5 need 3; 6 needs 5; 7 needs 6. Layer 2 (S1-S16 in `box-spec.md`) starts only after 7 passes.

## Deploy target

One VPS, 4 vCPU / 8 GB, with provider snapshots. Cloudflare free proxy in front for TLS, edge rate limiting, and to hide the IP (DNS-only change, no card). Snapshot after first deploy. Nightly `pg_dump` is Layer 2 (S6) but is switched on before real prizes are live.

## What I need from you to execute

- Say go.
- The VPS: provider account and a root login, when you have one (build and test run locally until then).
- The Finnhub key stays as is (confirmed working over WebSocket).

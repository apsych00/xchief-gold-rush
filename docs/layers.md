# Layers - what gets built, in what order

Layer 1 is functional and smooth (closing now). Layer 1.5 is the client experience: what a visitor at the booth and a player on the web actually go through. Layer 2 is hardening. 1.5 comes before 2 on the lead's instruction: a booth that resets wrong loses more than a booth that is not yet rate-limited.

## Layer 1 - functional and smooth (done)

**Client hosting:** the box serves the client. Caddy serves the static `dist/` build at the campaign domain; Cloudflare caches it at the edge. No Vercel, no extra subscription. Build once locally with `VITE_GAME_WS=auto`, copy `dist/` to the box; the mount is live (`box-architecture.md` 1b).

Tickets 1-7 in `box-plan.md`: database on the box, continuous price feed, game server with in-memory rounds, login codes, client on the socket, compose + Caddy, schema squash, acceptance runner. Proof lives in `PROGRESS.md`.

---

## Layer 1.5 - client experience and functionality

### The two visitors

**Booth visitor (kiosk).** Walks up to an idle screen. Plays with a server-owned pot of coins. Two ways it ends, and both must be unmistakable:
- **Five wins in a row -> the prize.** A full-screen modal: "You won! Get your phone ready - photograph this code." The code, large. A 30-second countdown and a **Claim** button. Claim (or the countdown ending, or walking away) resets the machine for the next person.
- **Coins run out -> the exit.** A full-screen modal: "That was your shot - you have used all your coins. Time to let the next player in." A 20-second countdown and a **Done** button. Either resets the machine. No "try again" loop.
- **Walks away mid-game -> the visible flush.** After a verdict, if nobody plays for 30 s, a countdown appears on screen ("Still there? Resetting in 30..."). At zero the screen flushes with a short animation back to the attract state, ready for the next person. Any tap during the countdown cancels it. The server's own 60 s idle reset stays as the safety net if the browser is gone.
- The kiosk never shows email, tasks, the leaderboard, or any registration/lead modal. (Observed in the ten-minute run: a registration modal appeared on some windows - that is a bug in kiosk mode, ticket C2.)
- Scenarios to design for explicitly: wins the code on the first five tries; plays for half an hour and never strings five; goes broke in a minute; walks away mid-streak.

**Web player.** Plays first, anonymously. At a milestone, enters an email and a code. From then on the interface shows **who they are playing as** - the masked email ("k****i@gmail.com") - with "your score and rank are saved to this email". The leaderboard shows masked emails, never names or raw addresses, and is **live**: it updates over the socket as others play; rows moving is the excitement (animation is the polish step after functionality). Tasks and gifts stay: server-owned claims, rewards shown from the server's numbers. Going broke on the web is not an exit - it is the refill/tasks path.

### Tickets

| # | Ticket | Layer | Notes |
|---|---|---|---|
| C1 | **Kiosk session on the server.** A visitor session per kiosk: coins (start 1000, stake by lever as on web), streak, state. Ends on claim, on broke, on 60 s idle, or on an explicit `kiosk_reset` frame; ending clears coins and streak. `round_settled` for kiosks carries coins and delta; `insufficient_coins` on a kiosk means "session over", not "buy more". Schema: `kiosks.session_coins`, `session_started_at`; `settle_kiosk_round` applies the same economy as `settle_round`. | server + SQL | replaces "kiosk coins are cosmetic" |
| C2 | **Kiosk screens.** Attract/idle state; play; win/lose feedback; the WIN modal (code, 30 s, Claim); the EXIT modal (20 s, Done); the abandon countdown (visible 30 s, then a flush animation to attract, client sends `kiosk_reset`); reconnecting state; and a hard guarantee that no email, task, leaderboard, or lead-capture UI can render in kiosk mode. Frames: `kiosk_reset` on Claim/Done; `kiosk_session` after every change. | client | the booth's money moments |
| C3 | **Web identity.** The OTP entry screen (8 digits) that does not exist yet; after verification, the masked email in the header with "scores saved to this email"; sign-out; what an unverified player sees instead ("play as guest - add your email to be ranked"). | client + small server | uses the frames from ticket 4 |
| C3a | **Session policy.** The player token carries an expiry (30 days) and a version; on `welcome`, a token older than 7 days is replaced with a fresh one (sliding renewal - active players never log out); expired or bad tokens start a new anonymous player. Re-login = OTP: verifying an email that already belongs to a player switches the session to that player (the code proves ownership; the anonymous session is dropped). Revocation = bump the version. Kiosks never store a token. | server + client | replaces S1 and S4 |
| C4 | **Live, masked leaderboard.** `leaderboard()` returns masked emails computed server-side (raw address never leaves the server); the server pushes a `leaderboard` frame to web clients whenever a top-10 record changes (debounced to 1 s); the client re-renders from the frame. | server + client | |
| C4b | Leaderboard motion: rows animate to their new position; the player's own row highlighted; "you moved up" cue. | client polish | after C4 |
| C5 | **Tasks and gifts on the web.** Every reward shown comes from the server (`claim_task` / `free_refill` return the reward and the new balance); the tasks screen reflects claimed/repeatable state from the server, not localStorage. | server + client | closes the "no reward field" gap |
| C6 | **Win and lose feedback on the web.** Verdict pane driven only by `round_settled`; streak and multiplier shown from the frame; the 2 s "settling" state; the "quiet market" flat explained on screen. | client | mostly done; audit and finish |
| C7 | **Broke on the web.** Clear path from 0 coins to refill and tasks; never a dead end. | client | |
| D1 | **Monitoring for the campaign.** Dozzle in compose (live container logs in a browser, behind Cloudflare Access or Caddy basic auth), a `/status` page (feed sources, rounds/min, open sockets, coupons left), and one alert (feed silent > 60 s, or server restart) to a phone. | ops | before launch |
| D2 | **One-command deploy runbook.** `deploy/deploy.sh` on the box: `git pull --ff-only`, build the client inside Docker (a build stage, so Node is not installed on the host), rebuild the server image, `docker compose up -d`, wait for `/health`, print `/status`. `deploy/autodeploy.sh` on a one-minute cron: fetch, and run deploy.sh when the deploy branch has new commits - a push deploys itself. Reboots already recover via `restart: unless-stopped`. Rollback: `git checkout <previous> && deploy/deploy.sh`. Documented for a non-engineer in `box-deploy.md`. | ops | after D1 (same files) |
| Q1 | **Blind E2E for every scenario above**, written from the contract by a different agent: first-five-tries win, half-hour no-streak, broke exit, walk-away reset, web email flow, masked live leaderboard. | tests | |

Order: C1 -> C2 (the booth), then C3 -> C3a -> C4 -> C5 -> C6 -> C7 (the web), D1 alongside, Q1 as each lands, C4b last.

**Design fidelity rule for every client ticket:** new screens and states reuse the existing components, classes, colour tokens and typography only - no new colours, fonts or layout systems; every ticket attaches screenshots of each new screen next to an existing one for review.

Product defaults taken (say if wrong): kiosk starts each visitor at 1000 coins with the same levers as web; WIN modal 30 s; EXIT modal 20 s; abandon countdown shows after 30 s idle and flushes at 60 s (matching the server's reset); masked email keeps the first and last character of the local part and the full domain.

---

## Layer 2 - security and hardening (after 1.5)

| # | Ticket |
|---|---|
| S1 | (folded into C3a) secret rotation procedure only |
| S2 | Per-socket rate limits (play, request_otp per email and per IP, message flood cut-off) |
| S3 | Kiosk secret out of the URL (one-time exchange for a session cookie); scrub `k=` from Caddy logs |
| S4 | (folded into C3a: OTP on a known email logs into that player) |
| S5 | Postgres least privilege: an `app` role that can only execute the game functions |
| S6 | Backups: nightly `pg_dump` to object storage, one rehearsed restore |
| S7 | Ops runbook for a non-engineer; feed-silence and restart alerts (D1 provides the plumbing) |
| S8 | Campaign end: freeze the leaderboard at a timestamp, export the top 10 with verified emails |
| S9 | Coupon exhaustion wording |
| S10 | Origin pinning on the socket, security headers in Caddy, TLS-only cookies |
| S11 | Email consent text and code retention |
| S12 | Coupon audit and reconciliation; alert at N codes remaining |
| S13 | OTP verify-attempt limiting (done in Layer 1: 5 tries per code) |
| S14 | Kiosk hygiene: never persist a player token on a kiosk browser; clear per-player UI state between visitors (partly covered by C1/C2) |
| S15 | Least privilege, extended (with S5) |
| S16 | Leaderboard integrity at prize time: one row per verified email, export proves it |
| S17 | MT5 price feed: the `mt5` source is being built into `server/feed.js` now behind `METAAPI_TOKEN` + `METAAPI_ACCOUNT_ID` (S17-prep, mock-tested); live evaluation with `demo/feed-compare.mjs` the day the investor login exists (`mt5-feed.md`) |

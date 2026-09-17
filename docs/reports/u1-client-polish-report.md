# U1 client polish - delivery report

Branch: `nightmareinc/u1-client-polish` (worktree `u1-client-polish`). Date: 2026-09-17, ~20:22.
Ticket: `TICKET.md` (identical to `docs/tickets/u1-client-polish.md`). Never committed, per the brief.

Dev recipe used exactly as the ticket names it: dev DB copy `db/run-tests-u1.sh` with `PORT=55463`
and container `goldrush-u1-keep`, game server `PORT=8804`, Vite `5366`, `VITE_GAME_WS=ws://localhost:8804/ws`,
`FINNHUB_TOKEN` never set. The copy and the container are deleted (see "Cleanup").

## Bad news first

1. **The one-socket assertion cannot be literal under the Vite dev server.** The brief says "every
   WebSocket the page opened points at the game socket URL and there is exactly one". Vite's own HMR
   client opens a second socket on the page origin, e.g.
   `ws://localhost:5366/?token=-BwUsgWLtHur` (also visible in the existing `od1-otp` spec's own log).
   The test therefore asserts exactly one **app** WebSocket (the dev-server HMR socket is excluded by
   host + path `/`), that it is the game socket, and that zero upstream price sockets
   (`finnhub|okx|binance|kraken|gold-api|gold-relay`) are opened. In a production build / `vite preview`
   there is no HMR socket, so the raw count is exactly one; the dev server is the only reason the filter
   exists.
2. **Pre-existing React key warning in `Leaderboard` (not caused by U1).** In the `od1-otp` run the
   server refuses the leaderboard fetch (`rate_limited`) and `initialGame.others` (the offline dummy
   list, `{name, s}`) is rendered by the server branch, which reads `r.rank` / `r.display` / `r.record`
   - all `undefined`, so `key={r.rank}` is `undefined`. It is a real (minor) bug, in the marketing
   lead's component, and outside this ticket. Left untouched and flagged for a card.
3. **Stale developer docs still advertise the removed client env vars.** `README.md`,
   `CONTRIBUTING.md` and `relay/README.md` still tell developers to set `VITE_RELAY_URL` (and
   `VITE_FINNHUB_TOKEN`) for the client. The client no longer reads either. The ticket named only
   `.env.public` / `.env.production` for removal, so I did not rewrite the docs; they need a follow-up.
4. **`docs/backend-spec.md` and `docs/ways-of-working.md` do not exist in this checkout**, although
   `.claude/agents/builder.md` tells the builder to read them. The brief (builder.md) is wrong about the
   repo here; I read `AGENTS.md`, `docs/TRACKER.md` and the files the ticket names instead of working
   around it silently.
5. **External `ENV_*.txt` files appeared in the worktree mid-run** (`ENV_BOX_EXAMPLE.txt`,
   `ENV_PRODUCTION.txt`, `ENV_PUBLIC.txt`, timestamped 20:20:48). I did not create them, never opened
   them (they read like copies of env files), and left them in place. They are untracked and, unlike
   `.env*`, not covered by `.gitignore`, so a future `git add -A` would pick them up.
6. **Pre-existing Prettier failures remain** in `src/App.jsx` and (before my edit) `tests/e2e/smoke.spec.js`.
   `src/App.jsx`'s residual warnings are all on pre-existing `Leaderboard` lines, not on my change; my
   added lines are Prettier-clean (verified). `tests/e2e/smoke.spec.js` now passes `prettier --check`.
   This is the known `format:check` state (tracker gap G5 / X2); I did not mass-reformat.

## Judgement calls

- **`profile.foot` copy.** Removing the wipe button left the footnote reading "Progress is saved on this
  device. Starting over resets you to {n} coins." - now false. I trimmed it to "Progress is saved on this
  device." (fa: "پیشرفت روی همین دستگاه ذخیره می‌شه."). The `profile.foot` key stays (still rendered);
  `profile.reset` and `profile.resetConfirm` were removed from both `fa` and `en`, as nothing else
  referenced them. If the owner wanted the old sentence verbatim, this is a one-line revert.
- **Dead code removed.** `initialsOf` (now unreferenced), the `.avatar-initials` and `.pf-danger` CSS
  rules, and the unused `font` on `.pf-avatar` are gone. `resetProfile` in `src/useGame.js` and
  `src/profile.js` is untouched, as the ticket requires (the dev hook and tests can still call it).
- **One shared icon, not two copies.** The exact SVG is a single `UserIcon` component exported from
  `src/Profile.jsx` and used in both hosts (`size={24}` in the top bar, `size={48}` in `.pf-avatar`),
  rather than duplicating the markup. `stroke="currentColor"` the ticket asks for; the top-bar
  `.avatar-btn` colour is now `var(--gold)`, so the `.avatar-trader/-pro/-chief` level classes still work.
- **`::-webkit-scrollbar` gets `height: 6px` too.** The ticket says "6 px wide"; I added the matching
  height so horizontal scrollbars are themed as well. Still one global rule set, no new tokens.
- **`VITE_RELAY_URL` removed from `.env.example`.** The ticket named `.env.public` (absent here) and
  `.env.production` (clean: only `VITE_GAME_WS=auto`). `.env.example` is the remaining client-facing
  example listing the dead var, so its relay block is gone.
- **`src/priceFeed.js` is now server-only.** `startLocalPriceFeed` and every source (relay, Finnhub,
  OKX, Binance x2, Kraken, the REST pollers, the quiet/demo simulation) are deleted; `startPriceFeed`
  is the old `startServerPriceFeed`. `useGame.js`'s `!apiEnabled` branches were left intact (out of
  scope) but are now inert: with `VITE_GAME_WS` unset the play screen stays on "Connecting…" until the
  server's hello, exactly as the ticket specifies. Verified there is exactly one `new WebSocket(...)`
  in `src/` (`src/api/socket.js:339`) and no upstream host strings left outside a comment.
- **Removed the stale `TODO` block in `tests/e2e/smoke.spec.js`.** The flows it listed (server verdict,
  OTP, task claim, kiosk streak) now exist and are covered by `player-promises`, `web-identity` and
  `kiosk`/`streak` specs.
- **Never opened `.env`**, and never set `FINNHUB_TOKEN`.

## Files touched

- `src/Profile.jsx` - wipe UI and `confirmReset` removed; `initialsOf` replaced by `UserIcon`;
  `.pf-avatar` renders `UserIcon size={48}`; `pf-actions` now holds only Share.
- `src/App.jsx` - top bar avatar renders `UserIcon size={24}`; unused `signup` local removed; import
  updated.
- `src/i18n.js` - `profile.reset` / `profile.resetConfirm` removed (fa + en); `profile.foot` corrected.
- `src/profile-screen.css` - `.avatar-btn` colour `var(--gold)`; `.avatar-initials` and `.pf-danger`
  removed; unused `font` dropped from `.pf-avatar`.
- `src/styles.css` - global themed scrollbars (`scrollbar-width`/`scrollbar-color` on `*`, plus
  `::-webkit-scrollbar{,-track,-thumb,-thumb:hover}`).
- `src/priceFeed.js` - rewritten to the server socket feed only (478 lines deleted).
- `tests/e2e/smoke.spec.js` - two new tests (one-socket proof; profile/avatar) and their screenshots.
- `.env.example` - dead `VITE_RELAY_URL` block removed.
- `docs/reports/u1/01-topbar-avatar.png`, `docs/reports/u1/02-profile.png` - new screenshots.
- `docs/reports/u1-client-polish-report.md` - this report.

Transient, deleted: `db/run-tests-u1.sh`, container `goldrush-u1-keep`.

## Gates (run unpiped on the final tree, exit codes read)

- `npm run lint` - **exit 0**
- `npm test` (node --test test/economy.test.mjs) - **exit 0** (7/7 pass)
- `npm run build` - **exit 0**
- `npx playwright test` (FULL suite: `BASE_URL=http://localhost:5366 PORT=8804
  DATABASE_URL=postgresql://postgres:test@localhost:55463/postgres
  VITE_GAME_WS=ws://localhost:8804/ws`) - **exit 0, 33 passed (3.7m)**
- `npx prettier --check` on every file I touched except `src/App.jsx` (pre-existing lines only) -
  **exit 0**

The new assertions passed as part of that run:

```
ok 28 smoke.spec.js › after a round the page has exactly one app WebSocket, the game socket
ok 29 smoke.spec.js › the profile has no wipe button and both avatars render the user icon
```

The existing `od1-otp` spec independently logs the captured sockets, matching the claim:

```
[{"id":1,"url":"ws://localhost:5366/?token=-BwUsgWLtHur","closeCode":null},
 {"id":2,"url":"ws://localhost:8804/ws","closeCode":null}]
```

One app socket, pointed at the game server; the other is Vite HMR (bad news 1).

## Screenshots

- `docs/reports/u1/01-topbar-avatar.png` - top bar with the gold user avatar next to the balance chip.
- `docs/reports/u1/02-profile.png` - profile: 48 px user glyph on the gold disc, Share as the only
  action, corrected footnote.

## Cleanup

`db/run-tests-u1.sh` deleted; `docker rm -f goldrush-u1-keep` done (no `u1` container remains).
Processes I did not start were not touched; only ports 55463 / 8804 / 5366 were used.

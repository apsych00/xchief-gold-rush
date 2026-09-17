# U2 report: leaderboard header fused with the tournament card; guest note takes the own-row slot

Branch `nightmareinc/u2-leaderboard-header`. No commit made. All gates green on the final tree.

## Bad news first

1. **The brief's premise about `.lb-row-sticky` was wrong: the "existing treatment" did not work.**
   `.lb-row` is `position: absolute` (it rides `.lb-spacer` with a per-row `--i`), and
   `.lb-row-sticky` never reset that. Rendered as a sibling of `.lb-list`, its `top: 0` resolved
   against `.phone`, so the pinned row sat at the very top of the screen, over the topbar and the
   identity bar. This is visible in the committed B2 evidence
   (`docs/reports/b2-b3/01-sticky-own-row.png`: "57 a***@example... 2,300" over the logo) and in
   my own before shot `docs/reports/u2/before/03-verified-player.png`. The B2 E2E only asserted
   visibility, never position, so it passed. U2's whole placement requirement depends on this
   treatment, so I fixed it: `.lb-row-sticky { position: static }`. It now sits in the flex flow
   directly after `.lb-list`, which is the bottom of the list container. After shot:
   `docs/reports/u2/after/03-verified-player.png`. Flagging it because it is a real B2 defect,
   not just a U2 prerequisite.
2. **The brief pointed at a `docs/TRACKER.md` "Recalibration" section that does not exist.** The
   file has no such section; the recalibration is only commit `c2a2b48`, which added the U1-U4
   tickets. Nothing under `docs/` defines Recalibration. Not blocking, but the read list was
   wrong about the repo.
3. **No past tournament exists in `db/seed.sql`.** As of the run date (2026-09-17) `t1` is
   current (Sep 16-21) and `t2` is upcoming (Sep 21-24), so "past tournament selected" could not
   be captured from the seed. For that one screenshot I inserted a temporary past tournament
   (`t3`, "Gold Rush Pre-Season", Sep 1-10) into the dev DB only, captured
   `docs/reports/u2/after/04-past-tournament.png`, then deleted it. The seed is untouched and the
   committed E2E specs still see exactly two chips.
4. **Pre-existing React warning left in place.** `Warning: Each child in a list should have a
   unique "key" prop` from `Leaderboard`, seen in the OD1 spec output. Cause: before the first
   server frame (OD1 deliberately trips `rate_limited`) `state.others` is still the static demo
   `OTHERS` list, whose rows have no `rank`, so `key={r.rank}` is `undefined`. Pre-existing and
   outside U2; fixing it means either changing what a slow/failed board renders or weakening the
   key, so I only report it.
5. **Two of my own spec edits were needed after a first red E2E run.** `tournament.spec.js`
   initially asserted `.lb-head` visible and read its text immediately; `.lb-head` now renders
   before the first frame, with "No tournament running", so it must wait for the tournament text.
   Fixed (32/33 then; 33/33 after).

## What the ticket asked for, and what shipped

- **One fused card (`.lb-head`).** The cup icon (`TrophyIcon`, 48 px) sits at the left of the
  card, vertically centred. The card then reads "Leaderboard" (`.screen-title`), "by record"
  (`.screen-sub`), then the tournament's `.lb-tournament-title`, `.lb-tournament-dates` (dates
  plus time left) and `.lb-tournament-prize-title`, all in their existing styles. With no
  tournament the card shows "Leaderboard / by record" and the existing `tournament.none` line.
  `prize_image` is no longer rendered anywhere (grep: zero references in `src/`); `.screen-head`,
  `.lb-tournament-head`, `.lb-tournament-prize` and `.lb-tournament-info` are gone.
- **Switcher unchanged, still under the card.** Same `.lb-tournament-switcher` / `.lang-btn`
  chips; switching still changes the described tournament and the listed board.
- **Guest note takes the own-row slot.** It is a `<button className="lb-row lb-row-me lb-row-guest">`
  with an empty `.lb-rank` cell and `.lb-name` in the normal row text colour (`#fff`). Previously
  the button text was browser-default `rgb(0,0,0)` (probed E2E) on the green row. Placement: inline
  at `--i: rows.length` (below the last listed row) while the list fits; otherwise
  `lb-row lb-row-me lb-row-sticky lb-row-guest`, pinned after `.lb-list` (same treatment as the
  verified own row). A verified player never sees it.
- **Design fidelity.** No new colours, fonts or spacing systems. New classes are layout only
  (`.lb-head`, `.lb-head-icon`, `.lb-head-info`, `.lb-row-guest`); everything reuses existing
  tokens (`.screen-title`, `.screen-sub`, `.lb-tournament-*`, `--green`, `--gold`).

## Judgement calls

- **Overflow measured from `.lb-spacer`, not `scrollHeight`.** Rows are absolutely positioned over
  the spacer, and the guest row would otherwise count toward the content height it is deciding on.
  `content = spacer height`, `overflows = content > list.clientHeight + 1`, recomputed with a
  `ResizeObserver` and on `rows.length`.
- **Pinned rows moved before the pager.** The own row and guest row now sit immediately after
  `.lb-list` (above the Prev/Next pager) so they are at the bottom of the list container, as the
  ticket words it. The pager still works identically.
- **`TournamentHeader` renamed `LeaderboardHeader`.** It is no longer only a tournament header.
- **`.lb-tournament-none` restyled to a plain muted line** (no nested card chrome) because it now
  lives inside the fused card; a card inside a card would have looked wrong.
- **Restored collateral screenshot churn.** The full E2E run rewrites every tracked report PNG.
  I reverted the reports unrelated to U2 (`b6-b9`, `b8`, `c11`, `c3-c4`, `c8`, `b10-b11`) and kept
  `b1/` and `b2-b3/` regenerated, since the header card and the own row are exactly what those
  two tickets documented.
- **Ran Vite/server through Playwright's `webServer`** rather than starting them by hand: `PORT=8805`,
  `BASE_URL=http://localhost:5367`, `DATABASE_URL=...:55464`, `VITE_GAME_WS=ws://localhost:8805/ws`
  (passed via the dev server's env, not literally on the command line), `FAKE_INSTAGRAM_PORT=9886`
  to avoid reusing another worktree's fake Instagram. `FINNHUB_TOKEN` was never set.
- **No files starting with `.env` were opened.** I did not need `.env` examples, so
  `ENV_BOX_EXAMPLE.txt` was not modified.

## Files touched

- `src/App.jsx` - `LeaderboardHeader` (fused `.lb-head` card, no prize image); overflow measurement;
  guest row inline/sticky; pinned rows moved before the pager; offline demo branch uses the same
  header.
- `src/styles.css` - `.lb-head`, `.lb-head-icon`, `.lb-head-info`, `.lb-row-guest`; `.lb-tournament-none`
  flattened; `.lb-row-sticky` made `position: static`.
- `tests/e2e/tournament.spec.js` - asserts the fused card: title, `by record`, dates and prize
  inside `.lb-head`, and `.lb-tournament-prize` gone; waits for the frame before reading.
- `tests/e2e/leaderboard-guest-row.spec.js` - new. Fits case (upcoming tournament, empty board:
  inline guest row, no sticky, empty rank cell, text is `rgb(255, 255, 255)`) and overflow case
  (25 scored players via `tests.create_confirmed_player()`: sticky guest row, not a page row).
- `docs/reports/u2/**` - before/after screenshots (see evidence).
- `docs/reports/b1/*.png`, `docs/reports/b2-b3/*.png` - regenerated by the suite and kept.
- Created then deleted: `db/run-tests-u2.sh`, `tests/e2e/zz-u2-capture.spec.js`,
  `tests/e2e/zz-u2-probe.spec.js`.

Untouched: server, DB schema, the API frame shape (`prize_image` is still sent, just not drawn),
i18n (no key changes were needed), and `main`.

## Evidence

`docs/reports/u2/before/` and `docs/reports/u2/after/`, each 01 empty board as guest, 02 full board
as guest (overflowing), 03 verified player, 04 past tournament selected. Plus the committed spec's
own `05-guest-fits.png` and `06-guest-overflow.png`. Web only, phone frame.

## Gates (all run in the foreground, unpiped, exit codes read)

- `npm run lint` - exit 0.
- `npm run test:unit` - 137 pass, 0 fail, exit 0.
- `npm test` - 7 pass, 0 fail, exit 0.
- `npm run build` - built in 1.52 s, exit 0.
- `bash db/run-tests-u2.sh --keep` (pgTAP, dev DB on 55464, container `goldrush-u2-keep`) -
  23 files, 295 tests, all pass, exit 0.
- `npx playwright test` (FULL suite, fresh DB, 5367/8805/55464) - **33 passed, exit 0** (3.6 m),
  including the new `leaderboard-guest-row.spec.js` (2) and the updated `tournament.spec.js`.

## Cleanup

- Removed `db/run-tests-u2.sh`.
- Removed the `goldrush-u2-keep` container (other worktrees' containers left alone).
- No listen sockets left on 5367/8805/55464; no processes I started remain.

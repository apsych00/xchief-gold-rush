# C11 report: real first-visit tour and kiosk intro

Ticket: replace the B10 placeholders with the real tour content on the same mount points.
Status: delivered, untouched tree, never committed. All four gates green on the final tree.

## Bad news first

- I wrote the E2E tests for my own ticket. `.claude/agents/builder.md` says no agent tests its
  own work and a separate ticket does, blind from `docs/test-contract.md`. `TICKET.md` names the
  tests as part of C11 and names `tests/e2e/first-visit.js` as a file to update. I followed the
  ticket. The tests pass, but they are not blind, so they carry less weight than the other
  suites. A review pass on `tests/e2e/c11-tours.spec.js` is the cheap way to close that.
- The Persian copy is mine. The ticket supplied English strings only for the three cards and the
  kiosk line, and asked for both languages. I translated them. `ENABLED_LANGS = ['en']` today, so
  the fa text is not on screen, but it should get a native read before the fa build ships.
- `prettier --check` is red on `src/App.jsx`, `src/KioskApp.jsx` and
  `tests/e2e/b10-b11-tour-ads.spec.js`. That is pre-existing (gap G5/X2); I confirmed the same
  files fail at `HEAD`, and I only formatted my new lines. The new `c11-tours.spec.js` is
  prettier-clean. The unrelated pre-existing violations are still there.
- `docs/reports/b10-b11/01-web-tour-placeholder.png` is now stale. The b10 spec writes
  `01-web-tour-card1.png` instead. I left the old file alone rather than delete another ticket's
  artifact.

## What changed

Web tour, `src/App.jsx` (`TourPlaceholder`):
- Three cards in the existing `.modal-backdrop .modal` shell, one at a time, with three dots.
  Next advances, the last card's button is `Got it`, cards 1 and 2 also offer `Skip`. Both the
  Skip and the Got it paths call `onDone`, which is `markTourSeen` from `src/useGame.js`, so
  `xchief.tour_seen` is written either way and the tour never returns on that device.
- Copy lives in `src/i18n.js` under `tour.card1|card2|card3` plus `tour.next|gotIt|skip`, in fa
  and en.

Kiosk intro, `src/KioskApp.jsx` (`KioskIntroModal`):
- One card, both languages at once, larger type for the booth, one full width `Start` button.
  This mirrors the C9 QR screen's direct-by-key pattern: `kioskIntro.fa` and `kioskIntro.en` hold
  the same literal in `dict.fa` and `dict.en`, read by key rather than through the active lang.
- The streak number comes from `flow.streakTarget` (`useKioskFlow`), which is set from the
  server's `kiosk_session` `streak_target` and falls back to 5 before the first frame. Nothing in
  the copy is hard-coded. The same value feeds the Persian digits through `num(n, 'fa')`.
- Placement is unchanged: the B10 `showIntro` / `dismissIntro` path already counts as activity
  for the idle timer, which the ticket calls out as still true.

Shared helper, `tests/e2e/first-visit.js`:
- `dismissFirstVisit` now waits for the `.modal-backdrop`, then clicks `Next` until the terminal
  button shows. The terminal button is `Got it` on the web tour's last card or `Start` on the
  kiosk intro, matching the ticket's instruction to accept either.

b10-b11 spec, `tests/e2e/b10-b11-tour-ads.spec.js`:
- Its tour assertions now read the real card 1 title and dismiss through the shared helper. Its
  kiosk block asserts the new intro line and clicks `Start`. The B10 flag coverage is unchanged:
  appears once, gone after reload, gone on second tap in the same boot.

## Judgement calls

- Persian copy. Authored from the English the ticket supplied. Flagged above.
- The kiosk button label is the literal English `Start`, not an i18n key. The ticket says one
  button `Start`, and the file already hard-codes the attract copy (`Tap to play`). The web tour
  keeps `Got it` exactly, since the helper and the ticket both name it.
- The web tour's `aria-label` is the current card's title. The old placeholder did the same with
  its single title. The kiosk intro's `aria-label` is the English line with the framed number.
- `Start` is right on the old `.modal-actions` flex end rule; I added one class so the primary
  button also sits right on the last card, where Skip is absent. Without it the lone Got it
  jumped to the left, which looked broken next to cards 1 and 2.
- `.kiosk-intro` and `.tour-dots` are new CSS classes, built only from existing colour tokens and
  type variables. No new colours, fonts, spacing system or library.
- The streak-target kiosk test injects a synthetic `kiosk_session` with `streak_target: 7` after
  the intro is already open, then asserts the text re-renders to 7. It injects after opening so
  the server's own post-auth frame has landed first. The server's sweep only re-pushes on a
  coupon-pool crossing, so nothing overwrites the injected value inside the test window.
- I restored unrelated report screenshots that the full suite rewrote (b1, b2-b3, b6-b9, c3-c4,
  c8) to keep the change set scoped to C11. The b10-b11 `04-kiosk-intro.png` stays updated because
  it now shows the real intro.

## Files touched

- `src/App.jsx` - three-card `TourPlaceholder`.
- `src/KioskApp.jsx` - real `KioskIntroModal`, `streakTarget` prop, `num` import.
- `src/i18n.js` - `tour` and `kioskIntro` keys in fa and en.
- `src/styles.css` - `.tour-dots`/`.tour-dot`, `.tour-actions`, `.kiosk-intro` type sizes.
- `tests/e2e/first-visit.js` - helper walks the cards and accepts `Got it` or `Start`.
- `tests/e2e/b10-b11-tour-ads.spec.js` - new content, uses the helper.
- `tests/e2e/c11-tours.spec.js` - new, four tests.
- `docs/reports/c11/*.png` - new screenshots, every card.
- `docs/reports/b10-b11/01-web-tour-card1.png` - new, `04-kiosk-intro.png` - updated.

Removed before handoff: `db/run-tests-c11.sh` and the `goldrush-c11-keep` container.

## Gates

All run in the foreground, unpiped, exit codes read.

- `npm run lint` -> `EXIT=0`
- `npm test` -> 7 pass, 0 fail, `EXIT=0`
- `npm run test:unit` -> 127 pass, 0 fail, `EXIT=0`
- `npm run build` -> 107 modules, `EXIT=0`
- `npx playwright test` (full suite, 29 tests, 1 worker) -> `29 passed`, `E2E_EXIT=0`

Dev recipe used: a copy of `db/run-tests.sh` with `PORT=55460` and container `goldrush-c11-keep`
(277 pgTAP, PASS, used only to prepare the DB), the game server on `PORT=8801` with
`DATABASE_URL` at 55460, Vite on 5362 started with `VITE_GAME_WS=ws://localhost:8801/ws`.
`FINNHUB_TOKEN` was never set. The copy and the container are deleted.

## Screenshots

- `docs/reports/c11/01-web-card-1.png`
- `docs/reports/c11/02-web-card-2.png`
- `docs/reports/c11/03-web-card-3.png`
- `docs/reports/c11/04-web-no-tour-after-reload.png`
- `docs/reports/c11/05-kiosk-intro.png`
- `docs/reports/c11/06-kiosk-playing.png`
- `docs/reports/c11/07-kiosk-intro-streak-target.png`

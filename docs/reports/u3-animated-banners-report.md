# U3 report: the ad zone shows the two animated xChief banners and shrinks to their aspect ratio

Branch: `nightmareinc/u3-animated-banners` (not committed, not pushed, per the ticket).
Ticket: `TICKET.md` U3. Builder contract: `AGENTS.md`, `.claude/agents/builder.md`.

A previous run died before writing a report (see the RESUME NOTE). I kept every edit it left in the
tree, finished verification, and ran all four gates on the final tree.

## Bad news first

1. **The banner assets clip at the leaderboard's zone width.** The README says the canvas is
   1072x310 (aspect 3.458:1), and the ticket's decision 4 fixes the zone to that ratio. At the
   zone's real width (~404 CSS px on the web layout) the iframe is ~404x117, but the bundled banner
   page reports a `document.documentElement.scrollHeight` of 200 at both 404 and 600 px wide (it only
   matches the ratio from ~800 px wide up). So the bottom of each banner is cut off inside the zone.
   The floor is inside the asset, not the integration: loading `xchief-board-banner.html?embed=1`
   directly at 404x117 shows the same overflow, and the same file at 1072x310 and 800x232 renders
   full. Evidence: `docs/reports/u3/04-banner-asset-clipped-404x117.png` (clipped) beside
   `docs/reports/u3/05-banner-asset-native-1072x310.png` (native, complete). Decision 1 says the two
   files "are the banners" and not to redesign them, and decision 4 fixes the ratio, so I did not
   touch the assets or the ratio. This needs a marketing-lead asset fix (drop the minimum content
   height) or an explicit change to decision 4 (a taller zone). Reporting rather than deciding, per
   `.claude/agents/builder.md`.
2. **An unrelated E2E test failed on rerun, and I fixed it.** `tests/e2e/instagram.spec.js` (ticket
   B8) failed with `?ig=already_claimed`. Root cause: `test/fakes/instagram.mjs` always started user
   ids at `1000000000`, and `instagram_accounts.ig_user_id` is the primary key, so the first run's
   account in the persistent dev DB (created 16:40 by the dead previous run) collided with every
   later run under `db/run-tests.sh --keep`. Real Instagram ids are globally unique, so I gave the
   fake a per-process random base (`test/fakes/instagram.mjs`); `issueCode({ id })` still pins an
   exact id, which is what `test/integration/instagram.test.mjs` uses. This is outside U3; I judged
   it in scope because AGENTS.md says fix test failures and flakiness encountered, and because the
   orchestrator's own full-suite gate would otherwise hit the same red on a kept DB.
3. **The previous run's full-suite run had already overwritten tracked screenshots** under
   `docs/reports/b*/` and `docs/reports/c*/`. My full-suite run regenerated them again, so they show
   as modified test artifacts. They are not hand edits.

## What was built

- `ads/banners.json`: entries now carry `type` (`image` | `iframe`) and, for iframes, `duration_ms`.
  Two iframe entries are seeded first, the board banner (`?embed=1`, 20500 ms) and concept 3 of the
  concepts file (`?concept=3&embed=1`, 11500 ms), followed by the two existing images.
- `src/adsPicker.js`: pure rotation logic. `isIframeAd`, `hasIframeAds`, `adDurationMs` (an iframe
  shows for its own `duration_ms`, anything else falls back to the 8 s `DEFAULT_IMAGE_DURATION_MS`),
  and `nextAd` (list order, wraps). Image-only lists keep the B11 `pickRandomAd`.
- `src/ads.jsx`: an iframe entry renders as `<iframe className="ad-zone-frame" title="xChief"
  loading="lazy" tabIndex={-1}>`, no wrapping anchor, so clicks belong to the banner. A list that
  contains any iframe rotates in list order on a per-entry `setTimeout`; an image-only list keeps the
  random pick. The 400 ms `gr-rise` cross-fade is kept via `key={src}` remounts.
- `src/styles.css`: `.ad-zone` is now `flex: none; width: 100%; aspect-ratio: 1072 / 310;` with a
  black background instead of the fixed 40% height; `.ad-zone-frame` is `display: block; width/height
  100%; border: 0; background: #000`.
- `vite.config.js`: the dev middleware now also serves `ads/banners/*.html` (path-prefix checked,
  query stripped) so the dev server answers the same paths Caddy does. `Caddyfile` needs no change:
  its existing `handle_path /ads*` already serves the whole `./ads:/srv/ads:ro` mount, so
  `/ads/banners/*.html` is reachable in the compose build. `docker-compose.yml` needs no change for
  the same reason.
- `tests/e2e/u3-animated-banners.spec.js` (new): the web zone shows a visible `.ad-zone-frame` whose
  `src` starts with `/ads/banners/`, is served as HTML (200 + `text/html` + `<!doctype html>`), has
  `title="xChief"` and `tabindex="-1"`, and the zone height matches `width / (1072/310)` within 2 px;
  the kiosk renders no `.ad-zone*`.
- `test/unit/ads-rotation.test.mjs` (new): `isIframeAd`, `adDurationMs`, `hasIframeAds`, and the
  ordered/wrapping `nextAd` behavior.
- `src/ads.js` is unchanged: it stays a thin re-export so `App.jsx`'s `./ads.js` import keeps
  resolving.

## Judgement calls

- Kept the mandated 1072:310 aspect and did not redesign or patch the marketing banners; the clip is
  reported as bad news 1.
- Fixed the unrelated Instagram fake (bad news 2) instead of leaving a red gate.
- Ran the full suite against the kept dev DB on 55465 as the ticket dictates, then deleted the
  container and the copied harness script at the end.
- Added two diagnostic screenshots (`04`, `05`) to `docs/reports/u3/` as evidence for bad news 1;
  the ticket's three test screenshots (`01`-`03`) are from the E2E suite.

## Files touched

Modified (U3): `ads/banners.json`, `src/ads.jsx`, `src/adsPicker.js`, `src/styles.css`,
`vite.config.js`, `tests/e2e/b10-b11-tour-ads.spec.js`.

Modified (unrelated fix): `test/fakes/instagram.mjs`.

Modified (regenerated test artifacts): `docs/reports/b1/*`, `docs/reports/b10-b11/*`,
`docs/reports/b2-b3/*`, `docs/reports/b6-b9/*`, `docs/reports/b8/*`, `docs/reports/c11/*`,
`docs/reports/c3-c4/*`, `docs/reports/c8/*`.

New: `tests/e2e/u3-animated-banners.spec.js`, `test/unit/ads-rotation.test.mjs`,
`docs/reports/u3/` (five PNGs).

Created and deleted during the run (per ticket): `db/run-tests-u3.sh`, container
`goldrush-u3-keep`.

Untouched by me (provided by the harness): `TICKET.md`, `ENV_PUBLIC.txt`,
`ENV_BOX_EXAMPLE.txt`, `ENV_PRODUCTION.txt`. No example variables needed adding.

## Gate outputs (all foreground, unpiped, exit code read)

Lint:
```
> xchief-gold-rush@1.1.0 lint
> eslint .
LINT_EXIT=0
```

Unit (`npm run test:unit`, includes `test/unit/ads-rotation.test.mjs`):
```
ℹ tests 145
ℹ pass 145
ℹ fail 0
UNIT_EXIT=0
```
(`npm test`, the economy suite, also green: 7 pass, exit 0.)

Build:
```
✓ 107 modules transformed.
✓ built in 1.68s
BUILD_EXIT=0
```

Full E2E suite (`npx playwright test` on the final tree):
```
33 passed (4.1m)
E2E_EXIT=0
```
The first full run before the Instagram fix was 32 passed / 1 failed (see bad news 2). The U3 specs
were green in both runs:
```
ok u3-animated-banners.spec.js:60 web: the ad zone shows an animated banner (U3)
   the zone shows an iframe from /ads/banners/ and keeps the 1072:310 aspect ratio
ok u3-animated-banners.spec.js:103 kiosk: the ad zone never renders there (U3)
```

## Environment the gates ran on

Ticket recipe, followed as written. Dev DB: `db/run-tests-u3.sh` copy with `PORT=55465` and
container `goldrush-u3-keep` (already up from the previous run, reused). Game server `PORT=8806`,
Vite on `5368`, fake Instagram on `9876`, `BASE_URL=http://localhost:5368`,
`DATABASE_URL=postgresql://postgres:test@localhost:55465/postgres`,
`VITE_GAME_WS=ws://localhost:8806/ws`. `FINNHUB_TOKEN` never set. No process started by another
ticket was killed. `goldrush-u3-keep` and `db/run-tests-u3.sh` were deleted when the gates finished;
ports 8806 and 5368 are closed.

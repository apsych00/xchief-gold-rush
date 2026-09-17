# K5 Email Mask - Delivery Report

## Bad news first

No blocking defects remain. During the run the following stale expectations failed and were corrected:

- `db/tests/70_mask_email.sql` initially used old-rule expected values for `kayani@gmail.com` and the plus-address case.
- `db/tests/71_get_me_identity.sql` expected the old mask for `me-confirmed@example.com`.
- `db/tests/85_leaderboard_paging.sql` expected the old mask for the tie-order players.
- `test/integration-box/claim.test.mjs` asserted the old mask regex for `integration-claim@example.com`.
- `test/integration-box/leaderboard.test.mjs` needed a `connectTo(url)` helper and a test-only `alertsFetch` seam before the new leak test could run cleanly.

All were straightforward updates to the new mask shape.

## Mask table (ticket K5 rule)

| Input | Local length | Domain rule | Output |
|---|---|---|---|
| `pedram.adsency@gmail.com` | 12 (>= 10) | consumer | `ped*****ncy@gmail.com` |
| `ab@x.io` | 2 (<= 2) | non-consumer | `a***@x**.io` |
| `farid@acme-corp.co` | 5 (3..5) | non-consumer | `f***d@a**.co` |
| `a@x.com` | 1 (<= 2) | non-consumer | `a***@x**.com` |
| `abc@x.com` | 3 (3..5) | non-consumer | `a***c@x**.com` |
| `kayani@gmail.com` | 6 (6..9) | consumer | `ka****ni@gmail.com` |
| `k+lb@gmail.com` | 4 (3..5) | consumer | `k***b@gmail.com` |
| `a+very-long-tag@example.com` | 15 (>= 10) | non-consumer | `a+v*****tag@e**.com` |
| `用户名@x.io` | 3 unicode | non-consumer | `用***名@x**.io` |
| `a@sub.example.com` | 1 | non-consumer (subdomain) | `a***@s**.example.com` |
| `KAYANI@GMAIL.COM` | 6 | consumer (case-insensitive match) | `KA****NI@GMAIL.COM` |

## Judgement calls

1. **Unicode-safe split.** The original draft used `reverse()` to find the last `@`, which breaks multi-byte characters. I replaced it with `regexp_match(p_email, '^(.+)@([^@]+)$')` so the split is character-safe.
2. **Test-only seams.** To prove the alerts transport never carries a raw email, I added an `alertsFetch` option to `createApp()` and exposed `alerts` in its return object. These are strictly for the new integration test.
3. **`connectTo(url)` helper.** The leak test runs against a private app instance, so the existing `connect()` helper (hard-wired to the shared `wsUrl`) was generalized to `connectTo(url)`.
4. **No `/api/share` endpoint exists.** The client share path (`Profile.jsx`) uses `navigator.share` with record text only; there is no server endpoint to modify.
5. **`reward_audit` left unmasked.** It is an operator-only view, not a client wire path listed in the ticket. Masking it would make it useless for audits.
6. **E2E assertions were already generic.** `web-identity.spec.js`, `leaderboard-paging.spec.js` and `tournament.spec.js` only assert `not.toContain(email)` and `/\*{3,}/`, which remain valid under the new rule, so no hardcoded strings needed changing.

## Files touched

- `db/schema.sql` - rewritten `public.mask_email()` to the K5 rule; added consumer-domain list and first-label masking.
- `db/tests/70_mask_email.sql` - 14 pgTAP cases covering every length band, unicode, subdomain and case preservation.
- `db/tests/20_leaderboard_view.sql` - updated expected mask for the confirmed player.
- `db/tests/71_get_me_identity.sql` - updated expected display mask.
- `db/tests/85_leaderboard_paging.sql` - updated expected masks for the tie-order test.
- `test/integration-box/claim.test.mjs` - updated the claimed-link mask assertion.
- `test/integration-box/leaderboard.test.mjs` - updated `maskEmail()` helper, added `connectTo(url)`, added raw-email leak test with fake alerts transport.
- `server/index.js` - added `alertsFetch` option and exposed `alerts` in `createApp()` return.

## Gate outputs

All gates ran unpiped in the foreground and exited 0.

### lint
```
> xchief-gold-rush@1.1.0 lint
> eslint .
```
Exit code: 0

### unit
```
> xchief-gold-rush@1.1.0 test
> node --test test/economy.test.mjs

✔ combo table pays 1, 1.5, 2, 3 and caps
✔ a loss costs exactly the stake and resets the combo, record stays
✔ flat keeps coins and combo
✔ coins never go negative and a reckless player is broke within a few rounds
✔ max single win is bounded
✔ levels are monotonic and nextLevel points forward
✔ 50/50 play at ×1 drifts mildly upward, not explosively
ℹ tests 7
ℹ pass 7
ℹ fail 0
```
Exit code: 0

### pgTAP
Dev DB: copied `db/run-tests.sh` to `db/run-tests-k5.sh` with `PORT=55471` and container `goldrush-k5-keep`, ran `--keep`, then deleted both the copy and the container after the gates.
```
Files=23, Tests=300,  2 wallclock secs
All tests successful.
Result: PASS
```
Exit code: 0

### test:server
```
ℹ tests 98
ℹ suites 0
ℹ pass 98
ℹ fail 0
ℹ duration_ms 329374.068
```
Exit code: 0

### build
```
> xchief-gold-rush@1.1.0 build
> vite build

vite v6.4.3 building for production...
transforming...
✓ 107 modules transformed.
rendering chunks...
computing gzip size...
dist/index.html                  1.58 kB │ gzip: 0.66 kB
dist/af/index.html               1.80 kB │ gzip: 0.83 kB
dist/assets/af-DUoEst2U.css     12.20 kB │ gzip: 3.13 kB
dist/assets/main-DXRJZtic.css   42.37 kB │ gzip: 9.32 kB
dist/assets/af-kk5Klwmp.js      12.63 kB │ gzip: 4.25 kB
dist/assets/main-DF-OtZVa.js   123.95 kB │ gzip: 41.73 kB
dist/assets/Logo-CqCd5QZB.js   144.54 kB │ gzip: 46.64 kB
✓ built in 1.12s
```
Exit code: 0

### E2E
Server on `PORT=8812`, Vite on `5374` with `VITE_GAME_WS=ws://localhost:8812/ws`.
```
Running 31 tests using 1 worker
...
31 passed (3.7m)
```
Exit code: 0

## Summary

Ticket K5 is complete. The new `mask_email()` rule is applied server-side, every wire path that carries an email now carries only the masked form, the client has no masking helper of its own, and the new integration test proves that an anonymous socket and the alerts transport never see another player's raw email.

# T1 Telegram alerts - delivery report

## Bad news first

- `docs/backend-spec.md` and `docs/ways-of-working.md` are referenced by `.claude/agents/builder.md` but do not exist in this checkout. I treated `AGENTS.md` as the canonical guide and ignored the missing files.
- The "integration" block-list alert test is written as a unit-level integration of `server/alerts.js` and `server/limits.js`, not as an `integration-box` test against the full server. Reason: changing `BLOCK_TRIP_COUNT` env in an `integration-box` test leaks to the other integration-box files because `node --test` runs them in one process with a shared module cache. Using the public limits API with production defaults keeps the test deterministic and isolated.
- `scripts/alert-test.mjs` bypasses the 5-minute throttle because it creates a fresh `createAlerts()` instance. Running it twice in quick succession will only deliver the first event; this is acceptable for a one-off operator verification tool.

## Judgement calls

- Recommendation line: when a catalogue event has no recommendation, the `<i>Do:</i>` line is omitted entirely rather than rendered empty.
- Coupon thresholds: `coupons_low` uses two distinct throttle keys (`coupons_low:20` and `coupons_low:5`) so crossing 20 and crossing 5 can both alert within the same 5-minute window, matching "again at 5".
- Testability: `createAlerts` now accepts an optional `fetch` dependency so unit tests can fake the Telegram API without overriding `globalThis.fetch`.
- Safe-mode wiring: I kept the existing `fireSafeMode(level, reason)` method on the alerts object and changed only its implementation, so `server/safemode.js` needed no edits.
- Deploy script: `deploy/deploy.sh` duplicates the HTML message format in bash and calls `curl` directly, because the box intentionally has no Node installed.

## Files touched

| File                        | What changed                                                                                        |
| --------------------------- | --------------------------------------------------------------------------------------------------- |
| `server/alerts.js`          | Telegram transport, exported `ALERT_CATALOGUE`, `fireEvent`, injectable `fetch`.                    |
| `server/kiosk.js`           | Tracks previous coupon count and fires `coupons_low`/`coupons_exhausted` through the alerts module. |
| `server/index.js`           | Passes `alerts` into `createKioskIdleSweep`.                                                        |
| `deploy/deploy.sh`          | Sources `.env.box`, posts `deploy_done`/`deploy_failed` to Telegram via `curl`.                     |
| `scripts/alert-test.mjs`    | New operator verification script that fires one catalogue event.                                    |
| `package.json`              | Added `alert-test` and `box:alert-test` scripts.                                                    |
| `.env.box.example`          | Added `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`.                                                  |
| `docs/box-deploy.md`        | Telegram bot setup, chat-id lookup, `.env.box` table, and `box:alert-test` docs.                    |
| `test/unit/alerts.test.mjs` | Catalogue, Telegram payload, webhook+Telegram together, block-list alert integration.               |
| `test/unit/kiosk.test.mjs`  | Coupon threshold crossing tests.                                                                    |

## Event catalogue

| Code                | Severity                           | Message                               | Recommendation                                                                                                                                                            |
| ------------------- | ---------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server_started`    | info                               | Server started                        | (none)                                                                                                                                                                    |
| `feed_silence`      | critical                           | Price feed silent for `{ageSeconds}`s | Check /status feed age; if MetaApi/MT5, check the bridge container; the game refuses rounds while silent                                                                  |
| `feed_recovered`    | info                               | Price feed recovered                  | (none)                                                                                                                                                                    |
| `safe_mode_changed` | warn (guarded) / critical (locked) | Safe mode -> `{level}` (`{reason}`)   | Look at /ops: if kiosk rounds continue and anonymous signups spiked, it is an attack: leave the level or lock; if it is a busy booth, `node scripts/safe-mode.mjs normal` |
| `ip_blocked`        | warn                               | `{count}` IP(s) currently blocked     | No action unless the count keeps rising; then Cloudflare rate rule                                                                                                        |
| `ip_blocks_cleared` | info                               | Block list cleared                    | (none)                                                                                                                                                                    |
| `coupons_low`       | warn                               | `{left}` coupon(s) left               | Load more codes: docs/box-deploy.md 'Prize codes'                                                                                                                         |
| `coupons_exhausted` | critical                           | Coupon pool exhausted                 | Kiosks now show the out-of-codes screen; load codes                                                                                                                       |
| `deploy_done`       | info                               | Deploy complete: `{sha}`              | (none)                                                                                                                                                                    |
| `deploy_failed`     | critical                           | Deploy failed                         | Run deploy/rollback.sh                                                                                                                                                    |

## Gate outputs

### `npm run lint`

```
> xchief-gold-rush@1.1.0 lint
> eslint .

(exit 0)
```

### `npm run test:unit`

```
> xchief-gold-rush@1.1.0 test:unit
> node --test "test/unit/*.test.mjs"

... (full run omitted for brevity)

ℹ tests 127
ℹ suites 0
ℹ pass 127
ℹ fail 0

(exit 0)
```

### `npm run test:server`

Run against the throwaway DB started with `bash db/run-tests.sh --keep` and `DATABASE_URL=postgresql://postgres:test@localhost:55432/postgres`.

```
> xchief-gold-rush@1.1.0 test:server
> node --test --test-concurrency=1 "test/integration-box/*.test.mjs"

... (full run omitted for brevity)

ℹ tests 74
ℹ suites 0
ℹ pass 74
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 272827.4026

(exit 0)
```

### `npm test`

```
> xchief-gold-rush@1.1.0 test
> node --test test/economy.test.mjs

ℹ tests 7
ℹ pass 7
ℹ fail 0

(exit 0)
```

### `bash -n deploy/deploy.sh`

No output, exit 0.

## Notes

- No `.env` file was opened or modified.
- No git commit was made.
- All work stayed inside `C:\Users\Kayhan Azadi\orca\workspaces\xchief-gold-rush\t1-telegram-alerts`.

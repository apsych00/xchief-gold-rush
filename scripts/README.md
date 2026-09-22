# Ops scripts

Small node scripts for running the live campaign: kiosk secrets, coupon stock,
and (dev only) peeking at captured OTP codes. All database access is a direct
Postgres connection through `pg`, configured by one environment variable:
`DATABASE_URL`.

## Credentials

`DATABASE_URL` is read from the environment only, e.g.
`postgresql://postgres:<password>@localhost:5432/postgres`. The scripts never
read or write `.env` and never print the value. A missing variable fails with
a clear message. On a deployed box the database is only reachable from inside
the Docker network, so use the `box:` variants, which run the same script
inside the server container (see `docs/box-deploy.md`):

```
npm run box:kiosk:revoke -- booth-1   # on the box
DATABASE_URL=postgresql://postgres:...@localhost:5432/postgres npm run kiosk:list   # local dev
```

Every script also accepts `--dry-run`, which prints the SQL that would run and
exits 0 without touching the database.

## Commands

| Script                            | npm              | box npm (on the deployed box) | What it does                                                                                                                                                                                                              |
| --------------------------------- | ---------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `revoke-kiosk.mjs <label>`        | `kiosk:revoke`   | `box:kiosk:revoke`            | Sets the kiosk's status to `revoked`; prints rows affected. A booth device provisions its own identity at `/kiosk` - there is no longer a way to mint one from the command line (ticket S3). |
| `list-kiosks.mjs`                 | `kiosk:list`     | `box:kiosk:list`              | Lists label, status, streak, created_at for every kiosk.                                                                                                                                                                  |
| `export-coupons.mjs`              | `coupons:export` | `box:coupons:export`          | Prints all coupons as CSV `code,status,claimed_at`, oldest first. Redirect to a file: `npm run box:coupons:export > coupons.csv`.                                                                                         |
| `load-coupons.mjs <file>`         | `coupons:load`   | `box:coupons:load -- <name>`  | Loads codes from a text file (one per line). Duplicates are skipped, so re-running is safe. Prints the inserted count. The `box:` form sees files in the repo directory as `/work`.                                       |
| `peek-otp.mjs <email>`            | `otp:peek`       | `box:otp:peek`                | Dev only. Prints the newest captured login code for an email, or `none`. Empty in production.                                                                                                                             |
| `safe-mode.mjs <level>`           | `safe-mode`      | `box:safe-mode`               | Sets the server-wide safe mode level (`normal`, `guarded`, `locked`); the server picks it up within 5 s (ticket S18, `docs/box-deploy.md` "If the box is attacked"). Also de-escalates on its own after quiet traffic; re-run to hold a level. |

Add `--dry-run` after the args, e.g.:

```
npm run kiosk:new -- booth-1 https://goldrush.example.com --dry-run
```

Note: everything after the first `--` goes to the script, so for scripts with
no other args (list, export) the flag needs a second `--`:

```
npm run kiosk:list -- --dry-run
```

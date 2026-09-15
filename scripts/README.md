# Ops scripts

Small node scripts for running the live campaign: kiosk secrets, coupon stock,
and (dev only) peeking at captured OTP codes. All database access goes through
the Supabase Management API, so no psql or direct connection string is needed.

## Credentials

`SUPABASE_PROJECT_REF` and `SUPABASE_ACCESS_TOKEN` are read from the
environment only. The scripts never read or write `.env` and never print these
values. A missing variable fails with a clear message. Run form:

```
SUPABASE_PROJECT_REF=... SUPABASE_ACCESS_TOKEN=... npm run kiosk:new -- booth-1
```

Every script also accepts `--dry-run`, which prints the SQL that would run and
exits 0 without touching the network or requiring credentials.

## Commands

| Script                            | npm              | What it does                                                                                                                                                                                                              |
| --------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gen-kiosk.mjs <label> [baseUrl]` | `kiosk:new`      | Generates a 32-char URL-safe secret, stores only its bcrypt hash, prints the launch URL `<baseUrl>/?k=<secret>` once (default base `http://localhost:5173`). The secret is not recoverable; lose it, revoke and re-issue. |
| `revoke-kiosk.mjs <label>`        | `kiosk:revoke`   | Sets the kiosk's status to `revoked`; prints rows affected.                                                                                                                                                               |
| `list-kiosks.mjs`                 | `kiosk:list`     | Lists label, status, streak, created_at for every kiosk.                                                                                                                                                                  |
| `export-coupons.mjs`              | `coupons:export` | Prints all coupons as CSV `code,status,claimed_at`, oldest first. Redirect to a file: `npm run coupons:export > coupons.csv`.                                                                                             |
| `load-coupons.mjs <file>`         | `coupons:load`   | Loads codes from a text file (one per line). Duplicates are skipped, so re-running is safe. Prints the inserted count.                                                                                                    |
| `peek-otp.mjs <email>`            | `otp:peek`       | Dev only. Prints the newest captured login code for an email, or `none`. Empty in production.                                                                                                                             |

Add `--dry-run` after the args, e.g.:

```
npm run kiosk:new -- booth-1 https://xchief-gold-rush.vercel.app --dry-run
```

Note: everything after the first `--` goes to the script, so for scripts with
no other args (list, export) the flag needs a second `--`:

```
npm run kiosk:list -- --dry-run
```

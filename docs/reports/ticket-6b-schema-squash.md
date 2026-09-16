# Ticket 6b report: squashed schema

Date: 2026-09-16. Branch: nightmareinc/box-squash. Worker: qwen3.8-flash (Orca dispatch).

## Bad news first

- `npm run format:check` fails on this branch, and it failed before this ticket. 22 files warn: `docs/*.md`, `src/useGame.js`, the legacy `supabase/functions/*`, `tests/e2e/player-promises.spec.js`, `CLAUDE.md`. None of them is a file this ticket touched; every file I changed passes prettier. I left them alone because the marketing lead edits docs and client files daily, and reformatting 22 of their files here would guarantee merge conflicts. CI runs `format:check`, so the pipeline is red on this branch regardless. Worth a separate, owned cleanup.
- `bash db/run-tests.sh` first failed on port 55432 because a leftover `goldrush-box-keep` container (from someone's earlier `--keep` run) held it. I stopped that container for the run and started it again afterward. It is running now, untouched.

No other problems. Everything else passed.

## What changed

- Added `db/schema.sql`: the full database that migrations 0000..0011 added up to, written as one from-scratch file. Order: auth compatibility layer (roles, `auth.uid()`, `auth.users`, pgcrypto in `extensions`, the default-privilege mirror, kept exactly as 0000 defined them), tables with final columns, indexes, RLS + policies, functions with final bodies and signatures, then every grant/revoke stated once at the end. No create-or-replace of earlier versions, no drop-function lines, no revoke-then-grant churn. Rule-explaining comments from the migrations are kept.
- Deleted `db/migrations/` (0000..0011; there was no 0009).
- `db/run-tests.sh`: applies `db/schema.sql` then `db/seed.sql` instead of looping over the migrations directory. Header and the PGOPTIONS comment updated.
- `server/migrate.mjs`: `steps()` returns the two fixed files. It keeps the `schema_migrations` bookkeeping table, so a fresh database applies `db/schema.sql` and `db/seed.sql` once, and re-runs skip both. Verified on a live database: first run `apply db/schema.sql / apply db/seed.sql / done: 2 step(s) applied`, second run all skips.
- Stale path references in comments, in `docker-compose.yml`, `server/Dockerfile`, `server/migrate.mjs`, `db/run-tests.sh`, and one header comment in `test/integration-box/otp.test.mjs`. No test assertion changed, no `server/*.js` file touched except `migrate.mjs`. No `.env` opened, nothing committed.

## Proof of equivalence

### pgTAP: 101/101 against the squashed schema

`bash db/run-tests.sh` on a fresh postgres:16 container, all suites unchanged:

```
/box-tests/00_helpers.sql ............. ok
/box-tests/10_rls_writes_denied.sql ... ok
/box-tests/15_rls_select_denied.sql ... ok
/box-tests/20_leaderboard_view.sql .... ok
/box-tests/25_combo_mult.sql .......... ok
/box-tests/30_settle_round.sql ........ ok
/box-tests/35_round_in_flight.sql ..... ok
/box-tests/40_settle_kiosk_round.sql .. ok
/box-tests/45_function_grants.sql ..... ok
/box-tests/50_box_rules.sql ........... ok
/box-tests/60_otp.sql ................. ok
Files=11, Tests=101
Result: PASS   (exit code 0)
```

(The two `coupons_exhausted` WARNING lines during the run are the empty-pool tests behaving as designed.)

### Catalog diff: identical

Built two throwaway containers from the same image. One got `db/migrations/0000..0011` + `db/seed.sql` in order (captured before deleting the directory), the other got `db/schema.sql` + `db/seed.sql`. Dumped a canonical, sorted, OID-free catalog from each (`psql -tA`, query over `pg_proc`, `pg_class`, `pg_constraint`, `pg_indexes`, `pg_policies`, `pg_default_acl`, `pg_namespace`, `pg_roles`, `pg_extension`, `information_schema.columns/sequences`), covering for every function: schema, name, full argument list with defaults, result type, kind, volatility, security-definer flag, `search_path` config, `prosrc` body, argument names, ACL, owner; for every table: columns in ordinal order with types, nullability and defaults, constraints with definitions, indexes with definitions, policies with quals, row-security flag, ACLs.

```
dump exit codes: old=0 new=0
line counts: old=487 new=487
diff -u cat-old.txt cat-new.txt  ->  CATALOG DIFF: IDENTICAL
```

Zero differences, OIDs not even included. Raw evidence: `D:\dev-storage\temp\opencode\cat-old.txt`, `cat-new.txt`, `cat-diff.txt` (empty diff), `catdump.sql` (the query).

The first pass found two real deviations, both comment text inside function bodies that I had reworded. A squashed file may not quietly rewrite a body, so I restored the exact final bodies from 0007 (`claim_task`) and 0008 (`open_round`) before the run above.

### Lint

`npm run lint` exits 0. `npm test` (economy unit suite) exits 0, 7/7.

## What's left for the coordinator

- The `format:check` decision above.
- Merge whenever ticket 6b fits the queue; nothing blocks on it.

# Ops scripts report - kiosks, coupons, dev OTPs

Branch: `nightmareinc/ops`. Not committed (per instructions).

## Files created

- `scripts/_db.mjs` - shared module: Management API request
  (`POST https://api.supabase.com/v1/projects/{ref}/database/query`,
  `Authorization: Bearer {token}`, body `{"query": sql}`), env-var handling,
  `--dry-run`, single-quote escaping (`sqlStr`), `randomUrlSafe`, row/CSV
  helpers.
- `scripts/gen-kiosk.mjs` - 32-char base64url secret (`crypto.randomBytes`),
  stores only `extensions.crypt(secret, extensions.gen_salt('bf'))`, prints
  label + launch URL + non-recoverability warning once.
- `scripts/revoke-kiosk.mjs` - `update ... set status='revoked' where label=...
  and status='active' returning id`, prints rows affected. (Restricting to
  `status='active'` makes the count meaningful on re-runs.)
- `scripts/list-kiosks.mjs` - label, status, streak, created_at aligned table.
- `scripts/export-coupons.mjs` - CSV `code,status,claimed_at` ordered by
  created_at, RFC-4180 quoting.
- `scripts/load-coupons.mjs` - one code per line, `on conflict (code) do
  nothing returning id`, prints inserted count. Idempotent.
- `scripts/peek-otp.mjs` - newest `public.dev_otps` token for an email, else
  `none`.
- `scripts/README.md` - usage incl. run form and the npm `--` caveat.
- `package.json` - added `kiosk:new`, `kiosk:revoke`, `kiosk:list`,
  `coupons:export`, `coupons:load`, `otp:peek`.

## Secrets rule compliance

- `.env` was never opened; only the pre-existing `.env.example` was listed in
  a directory listing, not read for values.
- `SUPABASE_PROJECT_REF` / `SUPABASE_ACCESS_TOKEN` are read from
  `process.env` only; a missing one exits 1 with a clear message and is never
  printed (verified below).
- No network request happens in `--dry-run`; dry-run also bypasses the env
  requirement so the scripts can be validated without a token.
- Nothing committed.

## Dry-run validation outputs

Note: args after the first `--` in `npm run <script> -- ...` go to the node
process. For scripts with no positional args, `--dry-run` needs a second
`--` (`npm run kiosk:list -- --dry-run`), because npm consumes a bare
trailing `--dry-run`. Documented in scripts/README.md.

### 1. gen-kiosk

```
$ npm run kiosk:new -- booth-1 --dry-run
> node scripts/gen-kiosk.mjs booth-1 --dry-run
-- dry run: the following SQL would run --
insert into public.kiosks (label, secret_hash) values ('booth-1', extensions.crypt('soAJJ6Sm6Te7Wp0yxnXjRBUkz0YyO0T8', extensions.gen_salt('bf')));
(dry run: no secret would be created or printed)
```

### 2. gen-kiosk with baseUrl, apostrophe-heavy label (escaping check)

```
$ npm run kiosk:new -- "O''Brien's booth" "https://xchief-gold-rush.vercel.app" --dry-run
> node scripts/gen-kiosk.mjs O''Brien's booth https://xchief-gold-rush.vercel.app --dry-run
-- dry run: the following SQL would run --
insert into public.kiosks (label, secret_hash) values ('O''''Brien''s booth', extensions.crypt('H114nK_mxR9X1ZmS9UwrOdQ2HyNFzunQ', extensions.gen_salt('bf')));
(dry run: no secret would be created or printed)
```

Every single quote in the value is doubled in the emitted SQL.

### 3. revoke-kiosk

```
$ npm run kiosk:revoke -- "booth'1" --dry-run
> node scripts/revoke-kiosk.mjs booth'1 --dry-run
-- dry run: the following SQL would run --
update public.kiosks set status = 'revoked' where label = 'booth''1' and status = 'active' returning id;
rows affected: 0
```

### 4. list-kiosks

```
$ npm run kiosk:list -- --dry-run
> node scripts/list-kiosks.mjs --dry-run
-- dry run: the following SQL would run --
select label, status, streak, created_at from public.kiosks order by created_at;
(no rows)
```

### 5. export-coupons

```
$ npm run coupons:export -- --dry-run
> node scripts/export-coupons.mjs --dry-run
-- dry run: the following SQL would run --
select code, status, claimed_at from public.coupons order by created_at;
code,status,claimed_at
```

### 6. load-coupons (sample file: 2 codes, blank line, code with apostrophe)

```
$ npm run coupons:load -- "D:\dev-storage\temp\opencode\coupons-sample.txt" --dry-run
> node scripts/load-coupons.mjs D:\dev-storage\temp\opencode\coupons-sample.txt --dry-run
-- dry run: the following SQL would run --
insert into public.coupons (code) values ('GOLD-TEST-0001'), ('GOLD-TEST-0002'), ('GOLD O''HARA 9') on conflict (code) do nothing returning id;
codes in file: 3, inserted: 0
```

### 7. peek-otp

```
$ npm run otp:peek -- "dev@example.com" --dry-run
> node scripts/peek-otp.mjs dev@example.com --dry-run
-- dry run: the following SQL would run --
select token from public.dev_otps where email = 'dev@example.com' order by created_at desc limit 1;
none
```

### Missing-env guard (non-dry-run, no token present)

```
$ npm run kiosk:list
> node scripts/list-kiosks.mjs
Missing required environment variable SUPABASE_PROJECT_REF. Set it alongside the command, e.g. SUPABASE_PROJECT_REF=... SUPABASE_ACCESS_TOKEN=... npm run kiosk:list
exit code: 1
```

Only the variable name is echoed, never a value.

## Checks

- `npm run lint` - passes (exit 0). Note: `node_modules` was empty in this
  fresh worktree, ran `npm ci` to make eslint available.
- `npm test` - 7/7 pass.
- `npx prettier --check scripts package.json` - clean (ran `--write` first).

## Left to do / handoff notes

- Live run against the real project needs the orchestrator to supply
  `SUPABASE_PROJECT_REF` + `SUPABASE_ACCESS_TOKEN`.
- Dry-run assumes the Management API response shape: rows as a JSON array or
  `{result: [...]}`; parse is tolerant of both. First live `kiosk:list` will
  confirm.
- `gen-kiosk` relies on `extensions.crypt`/`extensions.gen_salt` (pgcrypto in
  the `extensions` schema, as Supabase provisions it); 0001_schema.sql
  installs `pgcrypto`, so both spellings exist on a managed project.

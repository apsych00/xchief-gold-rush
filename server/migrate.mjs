/**
 * Schema bootstrap and migrations for the box (docs/box-spec.md 1.7, tickets 6, 6b and
 * db-migrations).
 *
 * Applies db/schema.sql (the whole schema as one file) and then db/seed.sql, each exactly
 * once, then every file in db/migrations/ that has not run yet, in lexical filename order. A
 * schema_migrations table (name primary key) records every one of these by name, so re-running
 * is a no-op and the server container can call this on every boot without ever double-applying
 * (seed.sql generates fresh random coupon codes each time it runs, so it must not re-run
 * freely). A fresh database gets everything; a database that already has schema.sql and
 * seed.sql recorded only picks up the pending migrations - both end up in the same state.
 *
 *   node server/migrate.mjs        # needs DATABASE_URL in the environment
 *
 * Each step (bootstrap or migration) runs in its own transaction together with its bookkeeping
 * insert: it either fully applies or not at all. A failure stops the run immediately and exits
 * non-zero - server/Dockerfile's boot command is `node server/migrate.mjs && exec node
 * server/index.js`, so a failed migration never starts a server against a half-migrated
 * database.
 *
 * Concurrency: the server container can boot more than one replica at once, and each one calls
 * this on start. Without serializing, two connections could both read the same "pending"
 * migration, both apply it, and race on the bookkeeping insert (or, worse, on a migration that
 * is not itself idempotent). A Postgres advisory lock (pg_advisory_lock) held for the whole run
 * - not pg_advisory_xact_lock, since each step commits its own transaction rather than the run
 * being one big transaction - makes every concurrent boot queue up and run this file one at a
 * time; whichever runs first does the work, the rest then find nothing pending and exit
 * immediately. The lock is session-scoped, so it releases on its own if the connection drops
 * for any reason, including a crash mid-run - it can never be left held forever.
 *
 * Going forward: db/schema.sql stays the from-scratch definition of the whole schema, for a
 * database that has never run anything. It is not what an existing database re-reads. Editing
 * it alone changes nothing anywhere a database has already booted once - see the top of this
 * file's own history, ticket db-migrations. Any change to schema.sql (a function body, a
 * column, a default) needs a matching file added under db/migrations/ that brings an already-
 * running database to the same state, or it will only ever exist on a database that has not
 * been created yet. See db/migrations/README.md.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import pg from 'pg';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_MIGRATIONS_DIR = path.join(ROOT, 'db', 'migrations');

// Arbitrary fixed key for the whole-run advisory lock (see the module comment above). Must
// never collide with another advisory lock key in this codebase - there are none today.
const MIGRATE_LOCK_KEY = 724601190;

function databaseUrl() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required, e.g. postgresql://postgres:<password>@localhost:5432/postgres');
    process.exit(1);
  }
  return url;
}

/** The schema and seed, applied once each, ahead of every migration. */
function bootstrapSteps() {
  return [
    { name: 'db/schema.sql', file: path.join(ROOT, 'db', 'schema.sql') },
    { name: 'db/seed.sql', file: path.join(ROOT, 'db', 'seed.sql') },
  ];
}

/** Every db/migrations/*.sql file, sorted lexically - numbered filenames make that order. */
export function migrationSteps(migrationsDir = DEFAULT_MIGRATIONS_DIR) {
  if (!fs.existsSync(migrationsDir)) return [];
  return fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => ({ name: `db/migrations/${f}`, file: path.join(migrationsDir, f) }));
}

/**
 * Runs the full bootstrap-then-migrations sequence against one database and returns the number
 * of steps actually applied (0 means everything was already up to date). Throws on the first
 * failing step, having already rolled that step back; nothing after it runs.
 */
export async function runMigrations({
  databaseUrl: url,
  migrationsDir = DEFAULT_MIGRATIONS_DIR,
  log = console.log,
} = {}) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    // pgcrypto was installed into the `extensions` schema by the compat layer in db/schema.sql
    // and seed.sql calls crypt()/gen_salt() unqualified, so the session needs extensions on
    // the path (same as db/run-tests.sh).
    await client.query('set search_path to public, extensions');

    await client.query('select pg_advisory_lock($1)', [MIGRATE_LOCK_KEY]);
    try {
      await client.query(`
        create table if not exists public.schema_migrations (
          name text primary key,
          applied_at timestamptz not null default now()
        )`);
      const { rows } = await client.query('select name from public.schema_migrations');
      const applied = new Set(rows.map((r) => r.name));

      let count = 0;
      for (const step of [...bootstrapSteps(), ...migrationSteps(migrationsDir)]) {
        if (applied.has(step.name)) {
          log(`skip  ${step.name} (already applied)`);
          continue;
        }
        const sql = fs.readFileSync(step.file, 'utf8');
        await client.query('begin');
        try {
          await client.query(sql);
          await client.query('insert into public.schema_migrations (name) values ($1)', [step.name]);
          await client.query('commit');
          log(`apply ${step.name}`);
          count += 1;
        } catch (err) {
          await client.query('rollback').catch(() => {});
          throw err;
        }
      }
      log(count ? `done: ${count} step(s) applied` : 'done: nothing to apply');
      return count;
    } finally {
      await client.query('select pg_advisory_unlock($1)', [MIGRATE_LOCK_KEY]).catch(() => {});
    }
  } finally {
    await client.end().catch(() => {});
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    await runMigrations({ databaseUrl: databaseUrl() });
  } catch (err) {
    console.error(`migrate failed: ${err.message}`);
    process.exit(1);
  }
}

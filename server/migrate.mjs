/**
 * Schema bootstrap for the box (docs/box-spec.md 1.7, tickets 6 and 6b).
 *
 * Applies db/schema.sql (the whole schema as one file, written from scratch;
 * there is no migration history to preserve) and then db/seed.sql, each exactly
 * once. A schema_migrations table records what has been applied, so re-running
 * is a no-op and the server container can call this on every boot without ever
 * double-applying (seed.sql generates fresh random coupon codes each time it
 * runs, so it must not re-run freely). A fresh database gets both steps; a
 * database that has already run shows schema.sql and seed.sql as applied.
 *
 *   node server/migrate.mjs        # needs DATABASE_URL in the environment
 *
 * Each step runs in its own transaction: it either fully applies or not at
 * all, and the bookkeeping insert commits with it.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function databaseUrl() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required, e.g. postgresql://postgres:<password>@localhost:5432/postgres');
    process.exit(1);
  }
  return url;
}

/** Everything to apply, in order: the schema, then the seed. */
function steps() {
  return [
    { name: 'db/schema.sql', file: path.join(ROOT, 'db', 'schema.sql') },
    { name: 'db/seed.sql', file: path.join(ROOT, 'db', 'seed.sql') },
  ];
}

const client = new pg.Client({ connectionString: databaseUrl() });
try {
  await client.connect();
  // pgcrypto was installed into the `extensions` schema by the compat layer in
  // db/schema.sql and seed.sql calls crypt()/gen_salt() unqualified, so the
  // session needs extensions on the path (same as db/run-tests.sh).
  await client.query('set search_path to public, extensions');
  await client.query(`
    create table if not exists public.schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )`);
  const { rows } = await client.query('select name from public.schema_migrations');
  const applied = new Set(rows.map((r) => r.name));

  let count = 0;
  for (const step of steps()) {
    if (applied.has(step.name)) {
      console.log(`skip  ${step.name} (already applied)`);
      continue;
    }
    const sql = fs.readFileSync(step.file, 'utf8');
    await client.query('begin');
    try {
      await client.query(sql);
      await client.query('insert into public.schema_migrations (name) values ($1)', [step.name]);
      await client.query('commit');
      console.log(`apply ${step.name}`);
      count += 1;
    } catch (err) {
      await client.query('rollback').catch(() => {});
      throw err;
    }
  }
  console.log(count ? `done: ${count} step(s) applied` : 'done: nothing to apply');
} catch (err) {
  console.error(`migrate failed: ${err.message}`);
  process.exit(1);
} finally {
  await client.end().catch(() => {});
}

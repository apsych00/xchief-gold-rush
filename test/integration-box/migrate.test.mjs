// Coverage for server/migrate.mjs: ordering, idempotence, the adopted-database path, and that
// a failing migration aborts and rolls back (ticket db-migrations).
//
// Needs a live database server: run
//   bash db/run-tests.sh --keep
// and export the DATABASE_URL it prints before running this suite.
//
//   DATABASE_URL=postgresql://postgres:test@localhost:55432/postgres npm run test:migrate
//
// Every test creates its own throwaway database on that same server (CREATE DATABASE) rather
// than reusing the one db/run-tests.sh pointed at, so tests can start from empty, or from a
// hand-built "adopted" state, without disturbing each other or anything already running there.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import { runMigrations, migrationSteps } from '../../server/migrate.mjs';

if (!process.env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL is not set. Start a throwaway database server first:\n' +
      '  bash db/run-tests.sh --keep\n' +
      'then export the DATABASE_URL it prints and re-run npm run test:migrate.',
  );
}

const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const createdDatabases = [];

function urlForDatabase(name) {
  const idx = process.env.DATABASE_URL.lastIndexOf('/');
  return `${process.env.DATABASE_URL.slice(0, idx + 1)}${name}`;
}

async function freshDatabase(label) {
  const name = `migrate_test_${label}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await admin.query(`create database ${name}`);
  createdDatabases.push(name);
  return urlForDatabase(name);
}

after(async () => {
  for (const name of createdDatabases) {
    await admin.query(`drop database if exists ${name} with (force)`).catch(() => {});
  }
  await admin.end();
});

/** A comparable snapshot of everything migrations touch: function bodies, column shapes, and
 * settings values - deliberately not row data that varies run to run (coupon codes, ids). Two
 * databases that produce the same fingerprint are schema-identical where it matters. */
async function schemaFingerprint(databaseUrl) {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const { rows: funcs } = await client.query(`
      select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as sig,
             pg_get_functiondef(p.oid) as def
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
      order by 1
    `);
    const { rows: cols } = await client.query(`
      select table_name, column_name, data_type, is_nullable, column_default
      from information_schema.columns
      where table_schema = 'public'
      order by table_name, ordinal_position
    `);
    const { rows: settings } = await client.query('select key, value from public.settings order by key');
    return JSON.stringify({ funcs, cols, settings });
  } finally {
    await client.end();
  }
}

// --- ordering --------------------------------------------------------------------------------

test('applies bootstrap then migrations in lexical order, recording every step by name', async () => {
  const databaseUrl = await freshDatabase('order');
  const log = [];
  const count = await runMigrations({ databaseUrl, log: (line) => log.push(line) });

  const expectedNames = ['db/schema.sql', 'db/seed.sql', ...migrationSteps().map((s) => s.name)];
  assert.equal(count, expectedNames.length, 'every bootstrap step and every migration applied once');
  assert.deepEqual(
    log.filter((l) => l.startsWith('apply')).map((l) => l.slice('apply '.length)),
    expectedNames,
    'applied in exactly this order: schema, seed, then migrations 0001, 0002, 0003 in lexical order',
  );

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const { rows } = await client.query('select name from public.schema_migrations order by name');
    assert.deepEqual(
      rows.map((r) => r.name).sort(),
      [...expectedNames].sort(),
      'schema_migrations records every step by its own name',
    );
  } finally {
    await client.end();
  }
});

test('a fresh database ends up with the fixed values: 25/page, 4-digit OTP, streak target 3', async () => {
  const databaseUrl = await freshDatabase('fresh_values');
  await runMigrations({ databaseUrl, log: () => {} });

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const { rows: def } = await client.query(
      "select pg_get_functiondef('public.leaderboard(text, int)'::regprocedure) as def",
    );
    assert.match(def[0].def, /limit 25 offset/, 'leaderboard() pages at 25');

    const { rows: setting } = await client.query("select value from public.settings where key = 'kiosk_streak_target'");
    assert.equal(setting[0].value, '3');

    const { rows: otpDef } = await client.query(
      "select pg_get_functiondef('public.request_otp_code(uuid, text)'::regprocedure) as def",
    );
    assert.match(otpDef[0].def, /'FM0000'/, 'request_otp_code generates a 4-digit zero-padded code');
  } finally {
    await client.end();
  }
});

// --- idempotence -----------------------------------------------------------------------------

test('running twice applies nothing the second time and changes nothing', async () => {
  const databaseUrl = await freshDatabase('idempotent');
  await runMigrations({ databaseUrl, log: () => {} });
  const before = await schemaFingerprint(databaseUrl);

  const log = [];
  const secondCount = await runMigrations({ databaseUrl, log: (line) => log.push(line) });
  const after1 = await schemaFingerprint(databaseUrl);

  assert.equal(secondCount, 0, 'the second run applies nothing');
  assert.ok(
    log.every((l) => l.startsWith('skip') || l.startsWith('done')),
    'every step is reported as already applied',
  );
  assert.equal(after1, before, 'the second run changes nothing');
});

// --- adoption ----------------------------------------------------------------------------

test('an adopted database (schema.sql + seed.sql applied the old way, none of the migrations run) ends up identical to a fresh one', async () => {
  const freshUrl = await freshDatabase('adopt_fresh');
  await runMigrations({ databaseUrl: freshUrl, log: () => {} });
  const freshFingerprint = await schemaFingerprint(freshUrl);

  // Reconstruct what db/schema.sql and db/seed.sql looked like before the three drifts this
  // ticket fixes, by reverting exactly the lines those commits changed (b19436c, 1b71586,
  // 54b8033) in a copy of the current files - the same text an old, already-seeded database
  // has sitting in its catalog right now.
  const schemaRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const oldSchemaSql = fs
    .readFileSync(path.join(schemaRoot, 'db', 'schema.sql'), 'utf8')
    .replace(
      'limit 25 offset (greatest(coalesce(p_page, 1), 1) - 1) * 25;',
      'limit 20 offset (greatest(coalesce(p_page, 1), 1) - 1) * 20;',
    )
    .replace(
      "v_code := to_char(floor(random() * 10000)::int, 'FM0000');",
      "v_code := to_char(floor(random() * 100000000)::int, 'FM00000000');",
    )
    .replace(
      "v_target := public.get_setting_int('kiosk_streak_target', 3);",
      "v_target := public.get_setting_int('kiosk_streak_target', 5);",
    );
  const oldSeedSql = fs
    .readFileSync(path.join(schemaRoot, 'db', 'seed.sql'), 'utf8')
    .replace(
      "insert into public.settings (key, value) values ('kiosk_streak_target', '3')",
      "insert into public.settings (key, value) values ('kiosk_streak_target', '5')",
    );
  assert.notEqual(
    oldSchemaSql,
    fs.readFileSync(path.join(schemaRoot, 'db', 'schema.sql'), 'utf8'),
    'sanity: a revert actually changed something',
  );
  assert.notEqual(
    oldSeedSql,
    fs.readFileSync(path.join(schemaRoot, 'db', 'seed.sql'), 'utf8'),
    'sanity: a revert actually changed something',
  );

  const adoptedUrl = await freshDatabase('adopt_old');
  const adopted = new pg.Client({ connectionString: adoptedUrl });
  await adopted.connect();
  try {
    await adopted.query('set search_path to public, extensions');
    await adopted.query(oldSchemaSql);
    await adopted.query(oldSeedSql);
    await adopted.query(`create table public.schema_migrations (
      name text primary key, applied_at timestamptz not null default now())`);
    await adopted.query("insert into public.schema_migrations (name) values ('db/schema.sql'), ('db/seed.sql')");
  } finally {
    await adopted.end();
  }

  // Confirm the drift is really there before migrating, otherwise this test would pass for the
  // wrong reason.
  const preMigrate = await schemaFingerprint(adoptedUrl);
  assert.notEqual(preMigrate, freshFingerprint, 'the adopted database starts out different from a fresh one');

  const count = await runMigrations({ databaseUrl: adoptedUrl, log: () => {} });
  assert.equal(
    count,
    migrationSteps().length,
    'only the pending migrations apply - schema.sql and seed.sql are skipped',
  );

  const adoptedFingerprint = await schemaFingerprint(adoptedUrl);
  assert.equal(
    adoptedFingerprint,
    freshFingerprint,
    'the adopted database converges to exactly the fresh one, mechanically compared',
  );
});

// --- failure -------------------------------------------------------------------------------

test('a failing migration aborts the run, rolls back its own statements, and is not recorded as applied', async () => {
  const databaseUrl = await freshDatabase('failure');
  const migrationsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'goldrush-migrate-test-'));
  fs.writeFileSync(
    path.join(migrationsDir, '0001_broken.sql'),
    'create table public.migrate_rollback_marker (id int);\nselect 1/0;\n',
  );

  await assert.rejects(runMigrations({ databaseUrl, migrationsDir, log: () => {} }));

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const { rows: markerTable } = await client.query("select to_regclass('public.migrate_rollback_marker') as reg");
    assert.equal(markerTable[0].reg, null, 'the DDL that ran before the failing statement was rolled back too');

    const { rows: recorded } = await client.query(
      "select name from public.schema_migrations where name = 'db/migrations/0001_broken.sql'",
    );
    assert.equal(recorded.length, 0, 'the failed migration is not recorded as applied');

    const { rows: bootstrap } = await client.query(
      "select name from public.schema_migrations where name in ('db/schema.sql', 'db/seed.sql') order by name",
    );
    assert.deepEqual(
      bootstrap.map((r) => r.name),
      ['db/schema.sql', 'db/seed.sql'],
      'the bootstrap steps that succeeded before the broken migration are unaffected',
    );
  } finally {
    await client.end();
  }
});

// --- concurrency -----------------------------------------------------------------------------

test('two runs racing on an empty database do not conflict: exactly one does the work', async () => {
  const databaseUrl = await freshDatabase('concurrent');
  const counts = await Promise.all([
    runMigrations({ databaseUrl, log: () => {} }),
    runMigrations({ databaseUrl, log: () => {} }),
  ]);

  const totalSteps = 2 + migrationSteps().length; // db/schema.sql + db/seed.sql + every migration
  assert.equal(
    counts[0] + counts[1],
    totalSteps,
    'the total work done across both racing runs is exactly one full run - the advisory lock serialized them rather than double-applying or erroring',
  );

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const { rows } = await client.query('select count(*)::int as n from public.schema_migrations');
    assert.equal(rows[0].n, totalSteps, 'no duplicate or missing bookkeeping rows');
  } finally {
    await client.end();
  }
});

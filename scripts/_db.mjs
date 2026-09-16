/**
 * Shared helper for the ops scripts. All database access is a direct Postgres
 * connection through `pg`, configured by one environment variable:
 *   DATABASE_URL=postgresql://user:password@host:5432/dbname
 *
 * On the deployed box the database is not reachable from outside the Docker
 * network, so run these through the server container (npm run box:kiosk:new,
 * ... see docs/box-deploy.md). Against a local dev database set DATABASE_URL
 * yourself (db/run-tests.sh starts a throwaway postgres:16).
 * Credentials come from process.env only. They are never read from a .env
 * file and never printed. With --dry-run no connection is made: the SQL is
 * printed and the command exits 0, which is how these scripts are validated
 * without a database.
 */

import crypto from 'node:crypto';
import pg from 'pg';

const { Pool } = pg;

let dryRun = false;

/** Pick --dry-run out of an argv list; every script calls this once at startup. */
export function init(args) {
  dryRun = args.includes('--dry-run');
  return args.filter((a) => a !== '--dry-run');
}

export function isDryRun() {
  return dryRun;
}

/** SQL string literal with single quotes doubled. */
export function sqlStr(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

/** URL-safe random string of exactly n chars (24 bytes -> 32 base64url chars). */
export function randomUrlSafe(n = 32) {
  const raw = crypto.randomBytes(Math.ceil((n * 3) / 4)).toString('base64url');
  return raw.slice(0, n);
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(
      `Missing required environment variable ${name}. ` +
        `Set it alongside the command, e.g. ${name}='postgresql://postgres:<password>@localhost:5432/postgres' ${invocation}`,
    );
    process.exit(1);
  }
  return value;
}

let invocation = 'npm run <script> -- <args>';

/** Set the "npm run ..." form echoed by the missing-env message. */
export function setInvocation(form) {
  invocation = form;
}

/**
 * Run SQL against the database. Returns the result rows (an empty array for
 * statements that return nothing). In dry-run mode prints the SQL and returns
 * [] without touching the network or the environment.
 */
export async function runQuery(sql) {
  if (dryRun) {
    console.log('-- dry run: the following SQL would run --');
    console.log(sql);
    return [];
  }
  const connectionString = requireEnv('DATABASE_URL');
  const pool = new Pool({ connectionString, max: 1 });
  let res;
  try {
    res = await pool.query(sql);
  } catch (err) {
    console.error(`Query failed: ${err.message}`);
    process.exit(1);
  } finally {
    await pool.end();
  }
  return res.rows ?? [];
}

/** Print rows as a simple aligned text table. */
export function printTable(rows, columns) {
  if (!rows.length) {
    console.log('(no rows)');
    return;
  }
  const cells = rows.map((r) => columns.map((c) => (r[c.key] === null ? '' : String(r[c.key]))));
  const widths = columns.map((c, i) => Math.max(c.label.length, ...cells.map((row) => row[i].length)));
  const line = (vals) =>
    console.log(
      vals
        .map((v, i) => v.padEnd(widths[i]))
        .join('  ')
        .trimEnd(),
    );
  line(columns.map((c) => c.label));
  line(widths.map((w) => '-'.repeat(w)));
  cells.forEach(line);
}

/** Minimal CSV field quoting (RFC 4180). */
export function csvField(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

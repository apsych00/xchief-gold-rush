/**
 * Shared helper for the ops scripts. All database access goes through the
 * Supabase Management API:
 *   POST https://api.supabase.com/v1/projects/{ref}/database/query
 *   Authorization: Bearer {token}   body: {"query": "<sql>"}
 *
 * Credentials come from process.env only (SUPABASE_PROJECT_REF,
 * SUPABASE_ACCESS_TOKEN). They are never read from a .env file and never
 * printed. With --dry-run no request is made: the SQL is printed and the
 * command exits 0, which is how these scripts are validated without a token.
 */

import crypto from 'node:crypto';

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
        `Set it alongside the command, e.g. SUPABASE_PROJECT_REF=... SUPABASE_ACCESS_TOKEN=... ${invocation}`,
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
 * Run SQL against the project. Returns the result rows (an empty array for
 * statements that return nothing). In dry-run mode prints the SQL and returns
 * [] without touching the network or the environment.
 */
export async function runQuery(sql) {
  if (dryRun) {
    console.log('-- dry run: the following SQL would run --');
    console.log(sql);
    return [];
  }
  const ref = requireEnv('SUPABASE_PROJECT_REF');
  const token = requireEnv('SUPABASE_ACCESS_TOKEN');
  const url = `https://api.supabase.com/v1/projects/${encodeURIComponent(ref)}/database/query`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: sql }),
    });
  } catch (err) {
    console.error(`Management API request failed: ${err.message}`);
    process.exit(1);
  }
  const text = await res.text();
  if (!res.ok) {
    console.error(`Management API error (HTTP ${res.status}): ${text || res.statusText}`);
    process.exit(1);
  }
  if (!text) return [];
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    console.error(`Management API returned a non-JSON response: ${text.slice(0, 500)}`);
    process.exit(1);
  }
  if (Array.isArray(data)) return data;
  if (typeof data.error === 'string' && data.error) {
    console.error(`Query failed: ${data.error}`);
    process.exit(1);
  }
  return Array.isArray(data?.result) ? data.result : [];
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

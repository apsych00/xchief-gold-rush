/**
 * Cheap CI guard for the rule in db/migrations/README.md: a change to db/schema.sql needs a
 * matching new file added under db/migrations/, because a running database never re-reads
 * schema.sql - server/migrate.mjs records it as applied once, on that database's first boot,
 * and skips it forever after.
 *
 * Diffs against the PR's base branch (GITHUB_BASE_REF, falling back to origin/main, then
 * main). If none of those can be resolved - a shallow local checkout, for instance - this
 * prints a warning and exits 0 rather than block on a state it cannot actually check.
 *
 *   node scripts/check-schema-migration-guard.mjs
 */

import { execFileSync } from 'node:child_process';

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function resolveBase() {
  const candidates = [];
  if (process.env.GITHUB_BASE_REF) candidates.push(`origin/${process.env.GITHUB_BASE_REF}`);
  candidates.push('origin/main', 'main');
  for (const ref of candidates) {
    try {
      git(['rev-parse', '--verify', ref]);
      return ref;
    } catch {
      // not resolvable here - try the next candidate
    }
  }
  return null;
}

const base = resolveBase();
if (!base) {
  console.warn('check-schema-migration-guard: no base ref to diff against, skipping');
  process.exit(0);
}

let mergeBase;
try {
  mergeBase = git(['merge-base', base, 'HEAD']);
} catch {
  console.warn(`check-schema-migration-guard: could not find a merge base with ${base}, skipping`);
  process.exit(0);
}

const changed = git(['diff', '--name-status', `${mergeBase}..HEAD`])
  .split('\n')
  .filter(Boolean);

const schemaChanged = changed.some((line) => line.endsWith('\tdb/schema.sql'));
if (!schemaChanged) process.exit(0);

const newMigration = changed.some(
  (line) => line.startsWith('A\t') && line.includes('db/migrations/') && line.endsWith('.sql'),
);
if (!newMigration) {
  console.error(
    'check-schema-migration-guard: db/schema.sql changed with no new file under db/migrations/.\n' +
      'Editing schema.sql alone only changes what a brand-new database gets - see db/migrations/README.md.',
  );
  process.exit(1);
}

console.log('check-schema-migration-guard: schema.sql change has a matching new migration');

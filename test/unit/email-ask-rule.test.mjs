// The email-ask rule as a testable contract (never ask a user for an email we already have).
// Two layers:
//   1. mayAskEmail's own truth table - the server's answer is the only authority, and "unknown"
//      behaves like "do not ask", never like "ask" (src/leads.js).
//   2. A source scan: a negated flag read (`!profile.emailVerified`) is the shape every
//      wrong-person ask is built from, so it may exist in exactly one place - inside the helper
//      itself. A sixth entry point added next month that reads the flag directly, instead of
//      going through mayAskEmail, fails here and gets pointed at the helper. The screen-level
//      behaviour itself is covered end to end in tests/e2e/email-ask-once.spec.js.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { mayAskEmail } from '../../src/leads.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SRC_DIR = path.join(REPO_ROOT, 'src');

test('mayAskEmail asks only when the server has said this player has no verified email', () => {
  assert.equal(mayAskEmail(true, { emailVerified: false }), true, 'known unverified: ask');
  assert.equal(mayAskEmail(true, { emailVerified: true }), false, 'known verified: never ask');
  assert.equal(mayAskEmail(false, { emailVerified: false }), false, 'unknown: do not ask');
  assert.equal(mayAskEmail(false, { emailVerified: true }), false, 'unknown: do not ask');
});

test('mayAskEmail treats a missing/unknown flag the same as unverified once known', () => {
  // The server row is the only writer of emailVerified (useGame.js's applyMe coerces with !!),
  // but a hand-built or partially migrated profile must still fail safe in both directions.
  assert.equal(mayAskEmail(true, {}), true);
  assert.equal(mayAskEmail(false, {}), false);
});

/** Every .js/.jsx file under src/, recursively. */
function srcFiles(dir = SRC_DIR) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...srcFiles(full));
    else if (full.endsWith('.js') || full.endsWith('.jsx')) out.push(full);
  }
  return out;
}

test('no src file negates the verified flag directly - every ask guard goes through mayAskEmail', () => {
  const pattern = /!\s*(?:profile\s*\.\s*)?emailVerified\b/g;
  const helper = path.join(SRC_DIR, 'leads.js');
  const offenders = [];
  for (const file of srcFiles()) {
    const text = readFileSync(file, 'utf8');
    // Comments count too: a commented-out guard is one uncomment away from being a live one,
    // and prose about the rule belongs in leads.js next to the helper itself.
    const matches = text.match(pattern);
    if (matches && file !== helper) {
      offenders.push(`${path.relative(REPO_ROOT, file)} (${matches.length}x)`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `email-ask guards must call mayAskEmail(identityKnown, profile) from src/leads.js, never read
     the negated flag themselves - unknown is not the same as unverified. Offenders: ${offenders.join(', ')}`,
  );

  // And the helper itself still exists in the one allowed place, with the right shape.
  const helperText = readFileSync(helper, 'utf8');
  assert.match(helperText, /export const mayAskEmail = \(identityKnown, profile\) => identityKnown && !profile\.emailVerified;/);
});

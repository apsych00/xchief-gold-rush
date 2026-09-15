/**
 * Register a kiosk: generate a secret, store only its bcrypt hash, print the
 * launch URL once. The raw secret is never stored and cannot be recovered.
 *
 *   npm run kiosk:new -- booth-1 [baseUrl] [--dry-run]
 */

import { init, isDryRun, runQuery, randomUrlSafe, setInvocation, sqlStr } from './_db.mjs';

setInvocation('npm run kiosk:new -- <label> [baseUrl]');

const args = init(process.argv.slice(2));
const [label, baseUrl] = args;
if (!label) {
  console.error('usage: npm run kiosk:new -- <label> [baseUrl]');
  process.exit(1);
}

const secret = randomUrlSafe(32);
const sql =
  `insert into public.kiosks (label, secret_hash) ` +
  `values (${sqlStr(label)}, extensions.crypt(${sqlStr(secret)}, extensions.gen_salt('bf')));`;

await runQuery(sql);

if (isDryRun()) {
  console.log('(dry run: no secret would be created or printed)');
  process.exit(0);
}

const url = `${baseUrl || 'http://localhost:5173'}/?k=${secret}`;
console.log(`label:  ${label}`);
console.log(`url:    ${url}`);
console.log('WARNING: the secret is shown once and is not recoverable. Store it securely now.');

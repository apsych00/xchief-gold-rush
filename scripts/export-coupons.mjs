/**
 * Export all coupons as CSV to stdout: code,status,claimed_at, oldest first.
 *
 *   npm run coupons:export [--dry-run]
 *   npm run coupons:export > coupons.csv
 */

import { csvField, init, runQuery, setInvocation } from './_db.mjs';

setInvocation('npm run coupons:export');

init(process.argv.slice(2));

const sql = `select code, status, claimed_at from public.coupons order by created_at;`;

const rows = await runQuery(sql);
console.log('code,status,claimed_at');
for (const r of rows) {
  console.log([csvField(r.code), csvField(r.status), csvField(r.claimed_at)].join(','));
}

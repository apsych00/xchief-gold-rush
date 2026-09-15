/**
 * Dev only: show the newest login code captured for an email address, so the
 * OTP flow can be tested without an email provider. Prints "none" when the
 * address has no stored codes. Does nothing in production, where dev_otps
 * stays empty.
 *
 *   npm run otp:peek -- <email> [--dry-run]
 */

import { init, runQuery, setInvocation, sqlStr } from './_db.mjs';

setInvocation('npm run otp:peek -- <email>');

const args = init(process.argv.slice(2));
const [email] = args;
if (!email) {
  console.error('usage: npm run otp:peek -- <email>');
  process.exit(1);
}

const sql =
  `select token from public.dev_otps ` + `where email = ${sqlStr(email)} ` + `order by created_at desc limit 1;`;

const rows = await runQuery(sql);
console.log(rows.length ? rows[0].token : 'none');

/**
 * Export all coupons as CSV to stdout: code,status,claimed_at,claim_email,claim_time, oldest
 * first. claim_email/claim_time (ticket C9) come from the coupon's own claim_links row - null
 * for a coupon nobody has reserved or claimed through a QR link yet.
 *
 *   npm run coupons:export [--dry-run]
 *   npm run coupons:export > coupons.csv
 */

import { csvField, init, runQuery, setInvocation } from './_db.mjs';

setInvocation('npm run coupons:export');

init(process.argv.slice(2));

const sql = `
  select c.code, c.status, c.claimed_at, cl.email as claim_email, cl.claimed_at as claim_time
  from public.coupons c
  left join public.claim_links cl on cl.coupon_id = c.id
  order by c.created_at;
`;

const rows = await runQuery(sql);
console.log('code,status,claimed_at,claim_email,claim_time');
for (const r of rows) {
  console.log(
    [csvField(r.code), csvField(r.status), csvField(r.claimed_at), csvField(r.claim_email), csvField(r.claim_time)].join(
      ',',
    ),
  );
}

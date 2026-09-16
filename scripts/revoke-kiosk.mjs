/**
 * Revoke a kiosk by label: flips its status to 'revoked' so the game server
 * rejects it. Reports how many rows were affected.
 *
 *   npm run kiosk:revoke -- <label> [--dry-run]
 */

import { init, runQuery, setInvocation, sqlStr } from './_db.mjs';

setInvocation('npm run kiosk:revoke -- <label>');

const args = init(process.argv.slice(2));
const [label] = args;
if (!label) {
  console.error('usage: npm run kiosk:revoke -- <label>');
  process.exit(1);
}

const sql =
  `update public.kiosks set status = 'revoked' ` +
  `where label = ${sqlStr(label)} and status = 'active' ` +
  `returning id;`;

const rows = await runQuery(sql);
console.log(`rows affected: ${rows.length}`);

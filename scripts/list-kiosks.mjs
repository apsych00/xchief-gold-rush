/**
 * List all kiosks: label, status, current win streak, created_at.
 *
 *   npm run kiosk:list [--dry-run]
 */

import { init, printTable, runQuery, setInvocation } from './_db.mjs';

setInvocation('npm run kiosk:list');

init(process.argv.slice(2));

const sql = `select label, status, streak, created_at from public.kiosks order by created_at;`;

const rows = await runQuery(sql);
printTable(rows, [
  { key: 'label', label: 'label' },
  { key: 'status', label: 'status' },
  { key: 'streak', label: 'streak' },
  { key: 'created_at', label: 'created_at' },
]);

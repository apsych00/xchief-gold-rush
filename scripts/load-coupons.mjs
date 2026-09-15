/**
 * Load coupon codes from a text file (one code per line, blank lines and
 * surrounding whitespace ignored). Existing codes are skipped, so the script
 * is safe to re-run. Prints the number of newly inserted codes.
 *
 *   npm run coupons:load -- <file> [--dry-run]
 */

import fs from 'node:fs';

import { init, runQuery, setInvocation, sqlStr } from './_db.mjs';

setInvocation('npm run coupons:load -- <file>');

const args = init(process.argv.slice(2));
const [file] = args;
if (!file) {
  console.error('usage: npm run coupons:load -- <file>');
  process.exit(1);
}

let codes;
try {
  codes = fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
} catch (err) {
  console.error(`Cannot read ${file}: ${err.message}`);
  process.exit(1);
}
if (!codes.length) {
  console.error(`${file} contains no codes.`);
  process.exit(1);
}

const values = codes.map((c) => `(${sqlStr(c)})`).join(', ');
const sql = `insert into public.coupons (code) values ${values} ` + `on conflict (code) do nothing ` + `returning id;`;

const rows = await runQuery(sql);
console.log(`codes in file: ${codes.length}, inserted: ${rows.length}`);

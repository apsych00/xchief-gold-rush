/**
 * The one operator command for safe mode (ticket S18): writes the `safe_mode` row in
 * public.settings directly. server/safemode.js polls that row every 5 s and adopts whatever it
 * finds, tagging the change 'manual' - this is the one command to lock the box under attack and
 * the one to bring it back (docs/box-deploy.md "If the box is attacked").
 *
 *   npm run safe-mode -- <normal|guarded|locked>
 */

import { init, isDryRun, runQuery, setInvocation, sqlStr } from './_db.mjs';

setInvocation('npm run safe-mode -- <level>');

const LEVELS = ['normal', 'guarded', 'locked'];

const args = init(process.argv.slice(2));
const [level] = args;
if (!LEVELS.includes(level)) {
  console.error(`usage: npm run safe-mode -- <${LEVELS.join('|')}>`);
  process.exit(1);
}

const value = JSON.stringify({ level, reason: 'manual', at: new Date().toISOString() });
const sql =
  `insert into public.settings (key, value, updated_at) ` +
  `values ('safe_mode', ${sqlStr(value)}, now()) ` +
  `on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at;`;

await runQuery(sql);

if (isDryRun()) {
  console.log('(dry run: no level would be changed)');
  process.exit(0);
}

console.log(`safe mode -> ${level} (the server picks this up within 5 s)`);

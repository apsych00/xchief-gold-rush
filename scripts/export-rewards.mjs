/**
 * Export every task reward the server released as CSV to stdout (ticket B13): player uuid,
 * device uuid, email, task, reward amount, claim time and the IP the server saw at claim time.
 *
 *   npm run rewards:export [--dry-run]
 *   npm run rewards:export > rewards.csv
 */

import { csvField, init, runQuery, setInvocation } from './_db.mjs';

setInvocation('npm run rewards:export');

init(process.argv.slice(2));

const sql = `
  select player, device, email, task, reward, claimed_at, ip
  from public.reward_audit
  order by claimed_at;
`;

const rows = await runQuery(sql);
console.log('player,device,email,task,reward,claimed_at,ip');
for (const r of rows) {
  console.log(
    [
      csvField(r.player),
      csvField(r.device),
      csvField(r.email),
      csvField(r.task),
      csvField(r.reward),
      csvField(r.claimed_at),
      csvField(r.ip),
    ].join(','),
  );
}

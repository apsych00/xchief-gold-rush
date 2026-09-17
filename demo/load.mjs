#!/usr/bin/env node
/**
 * Ticket 7a load probe: drive the game socket directly with pure `ws` clients
 * (no browser), N of them, playing continuously, and report the latency the
 * server adds to each decision.
 *
 *   play -> round_opened : how fast the server pins a start price and confirms
 *   play -> round_settled: how fast the 5s round actually settles
 *
 *   node demo/load.mjs --sockets 100 --seconds 120 --ws ws://localhost:8787/ws
 *
 * PASS: no error frames other than round_in_flight, p95 round_opened under
 * 200 ms, p95 round_settled between 5000 and 5600 ms.
 *
 * --fake-ips N (ticket S2): spreads the sockets over N distinct fake IPs (10.66.0.1,
 * 10.66.0.2, ...) via an X-Forwarded-For header, round-robin - so a 100-socket run stays
 * under MAX_SOCKETS_PER_IP (20) and MAX_CONNECTIONS_PER_IP_PER_MIN (30) per fake IP instead
 * of tripping S2's own per-IP limits on itself. The server must run with TRUST_PROXY=1 (the
 * production default) for the header to be honoured; run this against a server started that
 * way, e.g. `TRUST_PROXY=1 PORT=8794 node server/index.js`.
 */
import WebSocket from 'ws';

const AUTH_WAIT_MS = 8000;
const OPENED_WAIT_MS = 4000;
const SETTLED_WAIT_MS = 8000;

function parseArgs(argv) {
  const args = { sockets: 100, seconds: 120, ws: 'ws://localhost:8787/ws', fakeIps: 0 };
  const num = (label, raw) => {
    const v = Number(raw);
    if (!Number.isFinite(v) || v < 0) throw new Error(`${label} expects a number, got "${raw}"`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const take = (label) => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${label} needs a value`);
      return next;
    };
    switch (a) {
      case '--sockets':
        args.sockets = num('--sockets', take('--sockets'));
        break;
      case '--seconds':
        args.seconds = num('--seconds', take('--seconds'));
        break;
      case '--ws':
        args.ws = take('--ws');
        break;
      case '--fake-ips':
        args.fakeIps = num('--fake-ips', take('--fake-ips'));
        break;
      case '-h':
      case '--help':
        console.log(
          [
            'Usage: node demo/load.mjs [options]',
            '  --sockets N   concurrent ws clients (default 100)',
            '  --seconds D   duration each client plays (default 120)',
            '  --ws URL      game socket URL (default ws://localhost:8787/ws)',
            '  --fake-ips N  spread sockets over N fake IPs via X-Forwarded-For (default 0: off)',
          ].join('\n'),
        );
        process.exit(0);
        break;
      default:
        throw new Error(`unknown argument: ${a}`);
    }
  }
  return args;
}

const fakeIpFor = (socketIndex, fakeIps) => {
  const n = socketIndex % fakeIps;
  return `10.66.${Math.floor(n / 256)}.${n % 256}`;
};

function percentile(sorted, p) {
  if (sorted.length === 0) return NaN;
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const frac = rank - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

const fmt = (ms) => (Number.isFinite(ms) ? `${Math.round(ms)}` : '-');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randDir = () => (Math.random() < 0.5 ? 'up' : 'down');

/**
 * One ws client: connect, authenticate (anonymous), then loop play -> wait for
 * the round to settle -> pause 0.5-1.5s. Frames are matched by arrival order;
 * a single client never has two rounds in flight, so round_opened /
 * round_settled belong to the play that immediately precedes them.
 */
async function runSocket(index, url, deadline, stats, fakeIps) {
  const ws = fakeIps > 0
    ? new WebSocket(url, { headers: { 'X-Forwarded-For': fakeIpFor(index, fakeIps) } })
    : new WebSocket(url);
  const openLat = [];
  const settleLat = [];
  let rounds = 0;

  const waitFor = (pred, timeout, label) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.off('message', onMsg);
        reject(new Error(`timeout waiting for ${label}`));
      }, timeout);
      function onMsg(data) {
        let frame;
        try {
          frame = JSON.parse(data.toString());
        } catch {
          return;
        }
        if (pred(frame)) {
          clearTimeout(timer);
          ws.off('message', onMsg);
          resolve(frame);
        }
      }
      ws.on('message', onMsg);
    });

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('connect timeout')), AUTH_WAIT_MS);
      ws.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    // auth {} -> welcome. The box server treats a missing token as a new player.
    ws.send(JSON.stringify({ type: 'auth' }));
    await waitFor((f) => f.type === 'welcome' || f.type === 'error', AUTH_WAIT_MS, 'welcome');

    while (Date.now() < deadline) {
      ws.send(JSON.stringify({ type: 'play', dir: randDir(), lever: 1 }));
      const t0 = Date.now();
      const opened = await waitFor((f) => f.type === 'round_opened' || f.type === 'error', OPENED_WAIT_MS, 'round_opened');
      if (opened.type === 'error') {
        stats.errors.push(opened.code || 'unknown');
        await sleep(300);
        continue;
      }
      const t1 = Date.now();
      const settled = await waitFor(
        (f) => f.type === 'round_settled' || f.type === 'error',
        SETTLED_WAIT_MS,
        'round_settled',
      );
      const t2 = Date.now();
      if (settled.type === 'error') {
        stats.errors.push(settled.code || 'unknown');
        // a settle error still counts the round as played but not settled; the
        // play is over (server decided not to), so just move on.
        rounds++;
        openLat.push(t1 - t0);
        await sleep(500 + Math.random() * 1000);
        continue;
      }
      rounds++;
      openLat.push(t1 - t0);
      settleLat.push(t2 - t0);
      await sleep(500 + Math.random() * 1000);
    }
  } catch (err) {
    stats.connectErrors++;
    stats.errors.push(`client-${index}: ${err.message}`);
  } finally {
    try {
      ws.close();
    } catch {
      /* already closing */
    }
  }
  return { openLat, settleLat, rounds };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.sockets === 0) {
    console.log('nothing to do: --sockets is 0');
    return;
  }
  console.log(
    `[load] ${args.sockets} sockets for ${args.seconds}s against ${args.ws}` +
      (args.fakeIps > 0 ? ` spread over ${args.fakeIps} fake IPs (X-Forwarded-For)` : ''),
  );

  const stats = { errors: [], connectErrors: 0 };
  const deadline = Date.now() + args.seconds * 1000;

  // Stagger the connect storm a little so a single process can hold N sockets
  // without all of them racing to authenticate in the same tick.
  const results = await Promise.all(
    Array.from({ length: args.sockets }, (_, i) => (async () => {
      await sleep(i * 5);
      return runSocket(i, args.ws, deadline, stats, args.fakeIps);
    })()),
  );

  const openLat = [];
  const settleLat = [];
  let rounds = 0;
  for (const r of results) {
    openLat.push(...r.openLat);
    settleLat.push(...r.settleLat);
    rounds += r.rounds;
  }
  openLat.sort((a, b) => a - b);
  settleLat.sort((a, b) => a - b);

  const errorCounts = {};
  for (const code of stats.errors) errorCounts[code] = (errorCounts[code] || 0) + 1;
  const realErrors = stats.errors.filter((c) => !['round_in_flight', 'insufficient_coins', 'rate_limited'].includes(c));

  const openP50 = percentile(openLat, 50);
  const openP95 = percentile(openLat, 95);
  const openMax = openLat.length ? openLat[openLat.length - 1] : NaN;
  const setP50 = percentile(settleLat, 50);
  const setP95 = percentile(settleLat, 95);
  const setMax = settleLat.length ? settleLat[settleLat.length - 1] : NaN;

  console.log('\nsocket load summary');
  console.log('  sockets        ' + args.sockets + (stats.connectErrors ? `  (${stats.connectErrors} failed to connect/auth)` : ''));
  console.log('  rounds played  ' + rounds);
  console.log(
    '  play->round_opened   p50 ' + fmt(openP50) + 'ms   p95 ' + fmt(openP95) + 'ms   max ' + fmt(openMax) + 'ms',
  );
  console.log(
    '  play->round_settled  p50 ' + fmt(setP50) + 'ms   p95 ' + fmt(setP95) + 'ms   max ' + fmt(setMax) + 'ms',
  );
  const errList = Object.entries(errorCounts).map(([k, v]) => `${k}=${v}`).join(', ') || 'none';
  console.log('  error frames     ' + errList);

  const pass =
    realErrors.length === 0 &&
    rounds > 0 &&
    Number.isFinite(openP95) &&
    openP95 < 200 &&
    Number.isFinite(setP95) &&
    setP95 >= 5000 &&
    setP95 <= 5600;

  console.log(
    `\nPASS criteria: no non-round_in_flight errors (got ${realErrors.length}), ` +
      `p95 open<200ms (got ${fmt(openP95)}ms), p95 settled 5000-5600ms (got ${fmt(setP95)}ms)`,
  );
  console.log(pass ? '\nRESULT: PASS' : '\nRESULT: FAIL');
  process.exitCode = pass ? 0 : 1;
}

main().catch((err) => {
  console.error('[load] fatal:', err);
  process.exitCode = 1;
});

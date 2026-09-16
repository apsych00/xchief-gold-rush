#!/usr/bin/env node
/**
 * Ticket 7a acceptance runner: open many browsers at once (kiosk + web side by
 * side), play the 5-second gold prediction game in each for a fixed duration,
 * capture every console error and failed request, time each round from click to
 * verdict, then print a per-window summary and a PASS/FAIL verdict.
 *
 * This drives the real client UI (see src/App.jsx selectors: .btn-start,
 * .btn-up, .btn-down, .countdown, .pane-result, .balance-text). It never
 * reports its own result to the server: the outcome is whatever the client
 * renders, which in server mode comes from the server's round_settled frame.
 *
 *   node demo/run-demo.mjs --kiosks 5 --web 4 --seconds 600 --base http://localhost:5173 --headless
 */
import { chromium } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// A round is 5s of countdown then a verdict; the ceiling is a safety margin
// for cold start / server tail, not the target (PASS still checks p95 < 5600).
const ROUND_SECONDS = 5;
const RESULT_TIMEOUT_MS = 12000;
const CLICK_TIMEOUT_MS = 4000;
// How long to wait for the price feed to go live before timing any round, and
// how long to let it settle after that so the first round is a real round.
const WARMUP_MS = 20000;
const FEED_SETTLE_MS = 1200;
// Only start a round when at least this much budget remains (click -> verdict ->
// the 1-2s pause between rounds).
const MIN_BUDGET_MS = (ROUND_SECONDS + 2.5) * 1000;
const VIEWPORT = { width: 480, height: 800 };
const GAP_X = 480;
const GAP_Y = 800;
const COLS = 4;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const args = {
    kiosks: 5,
    web: 4,
    seconds: 600,
    base: 'http://localhost:5173',
    headless: false,
    kiosksFile: path.join(HERE, 'kiosks.json'),
  };
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
      case '--kiosks':
        args.kiosks = num('--kiosks', take('--kiosks'));
        break;
      case '--web':
        args.web = num('--web', take('--web'));
        break;
      case '--seconds':
        args.seconds = num('--seconds', take('--seconds'));
        break;
      case '--base':
        args.base = take('--base').replace(/\/$/, '');
        break;
      case '--kiosks-file':
        args.kiosksFile = path.resolve(take('--kiosks-file'));
        break;
      case '--headless':
        args.headless = true;
        break;
      case '-h':
      case '--help':
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`unknown argument: ${a}`);
    }
  }
  return args;
}

function printHelp() {
  console.log(
    [
      'Usage: node demo/run-demo.mjs [options]',
      '  --kiosks N        number of kiosk windows (default 5)',
      '  --web M           number of web windows (default 4)',
      '  --seconds D       duration each window plays (default 600)',
      '  --base URL        app base URL (default http://localhost:5173)',
      '  --kiosks-file P   JSON array of {label,url} for kiosks (default demo/kiosks.json)',
      '  --headless        run without visible windows',
    ].join('\n'),
  );
}

function buildWindows(args) {
  let kioskEntries = [];
  if (existsSync(args.kiosksFile)) {
    try {
      const parsed = JSON.parse(readFileSync(args.kiosksFile, 'utf8'));
      if (Array.isArray(parsed)) kioskEntries = parsed;
    } catch (err) {
      console.warn(`[demo] could not read kiosks file ${args.kiosksFile}: ${err.message}`);
    }
  }
  const defaultKioskUrl = `${args.base}/?k=dev-kiosk-secret-0001`;
  const windows = [];
  for (let i = 0; i < args.kiosks; i++) {
    const entry = kioskEntries[i];
    windows.push({
      kind: 'kiosk',
      label: entry?.label || `kiosk-${i + 1}`,
      url: entry?.url || defaultKioskUrl,
      index: i,
    });
  }
  for (let i = 0; i < args.web; i++) {
    windows.push({ kind: 'web', label: `web-${i + 1}`, url: args.base, index: i });
  }
  return windows;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return NaN;
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const frac = rank - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

function parseBalance(text) {
  const digits = String(text).replace(/[^\d-]/g, '');
  if (!digits || digits === '-') return NaN;
  return parseInt(digits, 10);
}

function tileFor(index) {
  const col = index % COLS;
  const row = Math.floor(index / COLS);
  return { left: 40 + col * GAP_X, top: 40 + row * GAP_Y };
}

async function setWindowBounds(context, page, index) {
  const cdp = await context.newCDPSession(page);
  const { windowId } = await cdp.send('Browser.getWindowForTarget');
  const pos = tileFor(index);
  await cdp.send('Browser.setWindowBounds', {
    windowId,
    bounds: { left: pos.left, top: pos.top, width: VIEWPORT.width, height: VIEWPORT.height },
  });
}

async function isVisible(page, selector) {
  try {
    return await page.locator(selector).first().isVisible({ timeout: 250 });
  } catch {
    return false;
  }
}

/** Bring the console back to an idle state where the dir buttons are live. */
async function ensureIdle(page) {
  if (await isVisible(page, '.btn-start')) {
    await page.locator('.btn-start').first().click({ timeout: CLICK_TIMEOUT_MS });
  }
  if (await isVisible(page, '.btn-again')) {
    await page.locator('.btn-again').first().click({ timeout: CLICK_TIMEOUT_MS });
  }
}

/**
 * Enter the game and wait until the price feed is live (a dir button becomes
 * enabled only when idle, a price exists and the player can afford the stake),
 * then let it settle. Without this the very first round measures browser and
 * feed boot time and can blow the verdict ceiling.
 */
async function warmUp(page, errors) {
  try {
    if (await isVisible(page, '.btn-start')) {
      await page.locator('.btn-start').first().click({ timeout: CLICK_TIMEOUT_MS });
    }
    await page.waitForFunction(
      () => {
        const up = document.querySelector('.btn-up');
        const down = document.querySelector('.btn-down');
        const btn = up || down;
        return !!btn && !btn.disabled;
      },
      null,
      { timeout: WARMUP_MS },
    );
    await sleep(FEED_SETTLE_MS);
  } catch (err) {
    errors.push(`warm-up (feed not ready): ${err.message.split('\n')[0]}`);
  }
}

async function readOutcome(page) {
  const result = page.locator('.pane-result').first();
  if (await result.locator('.win-word').count()) return 'win';
  if (await result.locator('.tie-word').count()) return 'flat';
  return 'lose';
}

async function readCoupon(page) {
  try {
    const text = await page.locator('.pane-result').first().innerText({ timeout: 1000 });
    const m = /Code:\s*([A-Za-z0-9][A-Za-z0-9-]*)/.exec(text);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

async function readBalance(page) {
  try {
    const text = await page.locator('.balance-text').first().innerText({ timeout: 1000 });
    return parseBalance(text);
  } catch {
    return NaN;
  }
}

async function driveWindow(browser, win, deadline) {
  const errors = [];
  const samples = [];
  const rec = {
    ...win,
    attempts: 0,
    wins: 0,
    losses: 0,
    flats: 0,
    coupons: 0,
    errors,
    samples,
    settled: 0,
  };
  // Each window is its own browser context: isolated storage, so every web
  // window is a distinct anonymous player and every kiosk keeps its own state.
  // In headed Chromium a context opens in its own top-level window; Playwright
  // 1.63 removed browser.newWindow(), so we place the window via CDP instead.
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  if (!win.headless) {
    try {
      await setWindowBounds(context, page, win.slotIndex);
    } catch (err) {
      console.warn(`[${win.label}] window tiling failed: ${err.message}`);
    }
  }

  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console: ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('requestfailed', (req) => {
    errors.push(`requestfailed: ${req.method()} ${req.url()} (${req.failure()?.errorText || 'failed'})`);
  });
  page.on('response', (res) => {
    if (res.status() >= 400) errors.push(`http ${res.status()}: ${res.url()}`);
  });

  try {
    await page.goto(win.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
  } catch (err) {
    errors.push(`goto: ${err.message}`);
    await context.close();
    return rec;
  }
  await warmUp(page, errors);

  let streak = 0;
  let roundNum = 0;
  while (Date.now() < deadline) {
    if (Date.now() + MIN_BUDGET_MS > deadline) break;
    roundNum++;
    let dir;
    try {
      await ensureIdle(page);
      dir = Math.random() < 0.5 ? 'up' : 'down';
      await page.locator(dir === 'up' ? '.btn-up' : '.btn-down').first().click({ timeout: CLICK_TIMEOUT_MS });
      // The countdown starts the moment the click is dispatched, so stamp t0
      // after click() resolves - the actionability/stability wait before
      // dispatch is not part of the round and would skew the timing.
      const t0 = Date.now();
      rec.attempts++;
      await page.locator('.pane-result').first().waitFor({ state: 'visible', timeout: RESULT_TIMEOUT_MS });
      const latency = Date.now() - t0;
      samples.push(latency);
      rec.settled++;

      const outcome = await readOutcome(page);
      const balance = await readBalance(page);
      const coupon = await readCoupon(page);
      if (outcome === 'win') {
        rec.wins++;
        streak += 1;
      } else if (outcome === 'lose') {
        rec.losses++;
        streak = 0;
      } else {
        rec.flats++;
      }
      if (coupon) {
        rec.coupons++;
        console.log(`[${win.label}] round ${roundNum}: COUPON ${coupon}`);
      }
      const verdict = outcome === 'win' ? 'win' : outcome === 'lose' ? 'lose' : 'flat';
      const tail = win.kind === 'kiosk' ? `streak=${streak}` : `coins=${Number.isNaN(balance) ? '?' : balance}`;
      console.log(`[${win.label}] round ${roundNum}: ${verdict} ${tail}`);
    } catch (err) {
      const started = dir ? 'after open' : 'before open';
      errors.push(`round ${roundNum} (${started}): ${err.message.split('\n')[0]}`);
      console.log(`[${win.label}] round ${roundNum}: no verdict (${dir || '?'}, ${started})`);
      // The console may be stuck mid-round; go home and retry next tick.
      try {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
        await warmUp(page, errors);
      } catch {
        /* ignore a failed reload; the next iteration's ensureIdle recovers */
      }
    }
    await sleep(1000 + Math.random() * 1000);
  }

  await context.close();
  return rec;
}

function fmt(ms) {
  return Number.isFinite(ms) ? `${Math.round(ms)}` : '-';
}

function row(cols, widths) {
  return cols.map((c, i) => String(c).padEnd(widths[i])).join(' ');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const windows = buildWindows(args);
  if (windows.length === 0) {
    console.log('nothing to do: --kiosks and --web are both 0');
    return;
  }
  windows.forEach((w, i) => {
    w.slotIndex = i;
    w.headless = args.headless;
  });

  console.log(
    `[demo] ${windows.length} windows (${args.kiosks} kiosk + ${args.web} web) for ${args.seconds}s ` +
      `against ${args.base} [${args.headless ? 'headless' : 'headed'}]`,
  );

  const browser = await chromium.launch({
    headless: args.headless,
    // With nine windows only one is focused. Without these flags Chrome throttles
    // the 60 ms countdown interval in every background window, so their rounds
    // settle late or miss the verdict window. Keep all windows on real time.
    args: [
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
    ],
  });
  const deadline = Date.now() + args.seconds * 1000;
  let records;
  try {
    records = await Promise.all(windows.map((w) => driveWindow(browser, w, deadline)));
  } finally {
    await browser.close();
  }

  records.sort((a, b) => (a.kind === b.kind ? a.label.localeCompare(b.label) : a.kind === 'kiosk' ? -1 : 1));

  const widths = [8, 6, 7, 5, 6, 5, 7, 6, 8, 8, 7];
  const header = row(
    ['window', 'kind', 'rounds', 'win', 'loss', 'flat', 'coupon', 'err', 'p50ms', 'p95ms', 'unsett'],
    widths,
  );
  console.log('\n' + header);
  console.log('-'.repeat(header.length));

  const totals = { rounds: 0, wins: 0, losses: 0, flats: 0, coupons: 0, errors: 0, allSamples: [], unsettled: 0 };
  for (const rec of records) {
    const sorted = [...rec.samples].sort((a, b) => a - b);
    const p50 = percentile(sorted, 50);
    const p95 = percentile(sorted, 95);
    const unsettled = rec.attempts - rec.settled;
    console.log(
      row(
        [
          rec.label,
          rec.kind,
          rec.attempts,
          rec.wins,
          rec.losses,
          rec.flats,
          rec.coupons,
          rec.errors.length,
          fmt(p50),
          fmt(p95),
          unsettled,
        ],
        widths,
      ),
    );
    totals.rounds += rec.attempts;
    totals.wins += rec.wins;
    totals.losses += rec.losses;
    totals.flats += rec.flats;
    totals.coupons += rec.coupons;
    totals.errors += rec.errors.length;
    totals.unsettled += unsettled;
    totals.allSamples.push(...sorted);
  }

  const allSorted = totals.allSamples.sort((a, b) => a - b);
  const p50 = percentile(allSorted, 50);
  const p95 = percentile(allSorted, 95);
  console.log('-'.repeat(header.length));
  console.log(
    row(
      ['TOTAL', '', totals.rounds, totals.wins, totals.losses, totals.flats, totals.coupons, totals.errors, fmt(p50), fmt(p95), totals.unsettled],
      widths,
    ),
  );

  let errorTotal = 0;
  for (const rec of records) {
    for (const e of rec.errors) {
      errorTotal++;
      if (errorTotal <= 40) console.log(`  [${rec.label}] ${e}`);
    }
  }
  if (errorTotal > 40) console.log(`  ... ${errorTotal - 40} more errors`);

  // PASS: zero errors, every round settled, p95 click-to-verdict under 5600 ms,
  // and flats under 10% of rounds.
  const pass =
    totals.errors === 0 &&
    totals.unsettled === 0 &&
    Number.isFinite(p95) &&
    p95 < 5600 &&
    totals.flats < 0.1 * totals.rounds;

  console.log(
    `\nPASS criteria: errors=0 (got ${totals.errors}), settled=rounds (unsettled ${totals.unsettled}), ` +
      `p95<5600ms (got ${fmt(p95)}ms), flats<10% (got ${
        totals.rounds ? ((100 * totals.flats) / totals.rounds).toFixed(1) : '0.0'
      }%)`,
  );
  console.log(pass ? '\nRESULT: PASS' : '\nRESULT: FAIL');
  process.exitCode = pass ? 0 : 1;
}

main().catch((err) => {
  console.error('[demo] fatal:', err);
  process.exitCode = 1;
});

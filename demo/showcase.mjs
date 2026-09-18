#!/usr/bin/env node
/**
 * The showcase: one headed Chromium, three tiled windows (Kiosk A, Kiosk B, Web), walked
 * through every scenario the product promises - at the speed a person can actually follow.
 *
 * Each scenario opens with a full-screen caption card in its own window (scenario number, one
 * line of title, two lines of what to watch), then acts at human pace: ~600-900 ms between
 * actions, ~1.5 s wherever a person would stop and read. Nothing is sped up.
 *
 * What is real and what is staged is stated on the caption itself, every time. Two scenarios
 * are staged: the five-win streak (frames injected through the DEV-only window.__xchief.inject
 * hook, because five real wins in a row is luck) and the balances that have to be a specific
 * number (set straight in the database, because the server owns every coin and there is no
 * client path to one). Everything else is the real client talking to the real server.
 *
 * Run: see docs/showcase.md. In short -
 *   bash db/run-tests-demo.sh --keep
 *   DATABASE_URL=postgresql://postgres:test@localhost:55447/postgres \
 *     PLAYER_TOKEN_SECRET=dev-secret PORT=8787 KIOSK_OPEN_PROVISION=1 npm run server
 *   npx vite --port 5347 --strictPort
 *   DATABASE_URL=postgresql://postgres:test@localhost:55447/postgres node demo/showcase.mjs
 *
 * The two kiosk windows open the OPEN route (${BASE}/kiosk): each self-provisions its own kiosk
 * (POST /api/kiosk/provision) and stores {id, secret, label} in localStorage under 'xchief.kiosk'.
 * There is no seeded secret in the URL anymore, so the server MUST run with KIOSK_OPEN_PROVISION=1
 * or /kiosk cannot provision. Where a scenario has to touch a kiosk's row in the database, it reads
 * that window's own provisioned identity off the page (see provisionedKiosk()).
 *
 * Options:
 *   --only 1,4,8     run a subset (every scenario sets up its own world, so any subset works)
 *   --base URL       app base URL (default http://localhost:5347)
 *   --ws URL         game socket (default ws://localhost:8787/ws)
 *   --fast           halve the pacing; for a dry run, not for showing anybody
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import pg from 'pg';
import { WebSocket } from 'ws';
import { dismissFirstVisit } from '../tests/e2e/first-visit.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPORT = path.join(REPO, 'docs', 'reports', 'showcase-results.md');

const VIEWPORT = { width: 420, height: 900 };

const args = parseArgs(process.argv.slice(2));
const BASE = args.base;
const WS_URL = args.ws;
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:test@localhost:55447/postgres';

const pool = new pg.Pool({ connectionString: DATABASE_URL });
const q = async (sql, params = []) => (await pool.query(sql, params)).rows;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* --------------------------------------------------------------------- pacing ----- */

const PACE = args.fast ? 0.5 : 1;
/** One deliberate action: the gap a person leaves between two taps. */
const beat = () => sleep((600 + Math.random() * 300) * PACE);
/** A pause where a person would stop and read what just appeared. */
const read = (n = 1) => sleep(1500 * n * PACE);
const CAPTION_MS = 4000 * PACE;

/* -------------------------------------------------------------------- captions ---- */

const CAPTION_CSS = `
#__showcase_caption{position:fixed;inset:0;z-index:2147483647;background:#0B0B0C;
  display:flex;flex-direction:column;justify-content:center;gap:18px;padding:34px 30px;
  font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#fff;
  animation:__cap_in .35s ease-out}
#__showcase_caption .cap-n{font-size:13px;letter-spacing:.22em;text-transform:uppercase;color:#E9B62A}
#__showcase_caption .cap-t{font-size:27px;line-height:1.22;font-weight:600}
#__showcase_caption .cap-w{margin-top:8px;display:flex;flex-direction:column;gap:11px}
#__showcase_caption .cap-w div{font-size:15px;line-height:1.45;color:rgba(255,255,255,.72);
  padding-left:15px;border-left:2px solid rgba(233,182,42,.55)}
#__showcase_caption .cap-f{position:absolute;left:30px;right:30px;bottom:26px;font-size:12px;
  color:rgba(255,255,255,.34);letter-spacing:.04em}
@keyframes __cap_in{from{opacity:0}to{opacity:1}}`;

/** Full-screen caption card, injected into the page itself so it shows in that window. */
async function caption(page, n, title, watch, footer) {
  await page.evaluate(
    ({ css, n: num, title: ttl, watch: lines, win }) => {
      document.getElementById('__showcase_caption')?.remove();
      if (!document.getElementById('__showcase_caption_css')) {
        const style = document.createElement('style');
        style.id = '__showcase_caption_css';
        style.textContent = css;
        document.head.appendChild(style);
      }
      const el = document.createElement('div');
      el.id = '__showcase_caption';
      el.innerHTML =
        `<div class="cap-n">Scenario ${num}</div><div class="cap-t"></div>` +
        `<div class="cap-w">${lines.map(() => '<div></div>').join('')}</div>` +
        `<div class="cap-f"></div>`;
      el.querySelector('.cap-t').textContent = ttl;
      el.querySelectorAll('.cap-w div').forEach((d, i) => {
        d.textContent = lines[i];
      });
      el.querySelector('.cap-f').textContent = win;
      document.body.appendChild(el);
    },
    { css: CAPTION_CSS, n, title, watch, win: footer },
  );
  await sleep(CAPTION_MS);
  await page.evaluate(() => document.getElementById('__showcase_caption')?.remove());
  await beat();
}

/* -------------------------------------------------------- server, read directly --- */

/**
 * Ask the server the same question the app asks itself, over an independent socket - so an
 * assertion can never be fooled by anything the page happens to be rendering.
 * `accept` is the predicate for the frame that ends the exchange.
 */
function askServer(authFrame, requestFrame, accept, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('timed out waiting for the server reply'));
    }, timeoutMs);
    let authed = false;
    ws.on('open', () => ws.send(JSON.stringify(authFrame)));
    ws.on('message', (data) => {
      let frame;
      try {
        frame = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (frame.type === 'welcome') {
        authed = true;
        ws.send(JSON.stringify(requestFrame));
        return;
      }
      if (authed && accept(frame)) {
        clearTimeout(timer);
        ws.close();
        resolve(frame);
      } else if (frame.type === 'error') {
        clearTimeout(timer);
        ws.close();
        reject(Object.assign(new Error(frame.code), { code: frame.code }));
      }
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

const serverMe = (token) => askServer({ type: 'auth', token }, { type: 'get_me' }, (f) => f.type === 'me');
// A kiosk welcome is followed by its own bootstrap kiosk_session, so wait for the one that is
// actually the reset's answer: state 'idle'.
const kioskResetViaSocket = (secret) =>
  askServer(
    { type: 'auth', kiosk: secret },
    { type: 'kiosk_reset' },
    (f) => f.type === 'kiosk_session' && f.state === 'idle',
  );

/** The dev-captured login code, read exactly as a human tester would in dev. */
async function peekOtp(email) {
  for (let i = 0; i < 20; i++) {
    const out = execFileSync('node', ['scripts/peek-otp.mjs', email], {
      cwd: REPO,
      env: { ...process.env, DATABASE_URL },
      encoding: 'utf8',
    }).trim();
    if (out && out !== 'none') return out;
    await sleep(250);
  }
  throw new Error(`no dev-captured OTP code for ${email}`);
}

/* ------------------------------------------------------------------ page helpers -- */

const coinsOnScreen = async (page) => Number((await page.locator('.balance-text').innerText()).replace(/[^\d]/g, ''));

const tokenOf = async (page) => {
  for (let i = 0; i < 40; i++) {
    const t = await page.evaluate(() => window.__xchief && window.__xchief.token);
    if (t) return t;
    await sleep(250);
  }
  throw new Error('no window.__xchief.token: the client is not wired to the game socket');
};

const modeOf = (page) => page.evaluate(() => window.__xchief && window.__xchief.mode);

/** Direction buttons go live only once a price is in and the balance can cover a stake. */
async function waitPlayable(page, ms = 25000) {
  await page.waitForFunction(
    () => {
      const up = document.querySelector('.btn-up');
      return !!up && !up.disabled;
    },
    null,
    { timeout: ms },
  );
}

/** Everything the kiosk must never render (docs/layers.md C2). */
const forbiddenUi = (page) => page.locator('.lead, .signup, .lb, .tasks, .nav, input[type="email"]');

/** The player's own leaderboard row, with a legible message if the board highlights two. */
async function ownLeaderboardRow(page) {
  const rows = page.locator('.lb-row-me');
  await rows.first().waitFor({ timeout: 15000 });
  const n = await rows.count();
  if (n > 1) {
    throw new Error(
      `the leaderboard highlights ${n} rows as "you" - two masked addresses collided ` +
        '(docs/TRACKER.md gap G3: the own-row match compares masked emails)',
    );
  }
  return (await rows.innerText()).replace(/\s+/g, ' ').trim();
}

async function enterKiosk(page) {
  await page.goto(`${BASE}/kiosk`, { waitUntil: 'domcontentloaded' });
  await page.getByText('Tap to play').waitFor({ timeout: 20000 });
  await read();
  await page.locator('.btn-start').click();
  await dismissFirstVisit(page).catch(() => {});
  await waitPlayable(page);
}

/**
 * The open-route kiosk identity this window self-provisioned into localStorage. Waits for the
 * client to reach its play state first (window.__xchief.mode === 'server'), because the identity
 * is only stored once /kiosk has provisioned and connected - reading it any earlier gets nothing.
 * Returns {id, secret, label}; the id names the kiosk's row, the secret authenticates a socket
 * reset. The server must run with KIOSK_OPEN_PROVISION=1 or /kiosk never provisions (see the
 * header). Read per window, so Kiosk A and Kiosk B each drive their own provisioned kiosk.
 */
async function provisionedKiosk(page) {
  await page.waitForFunction(() => window.__xchief && window.__xchief.mode === 'server', null, { timeout: 25000 });
  const identity = await page.evaluate(() => JSON.parse(localStorage.getItem('xchief.kiosk') || 'null'));
  if (!identity || !identity.id || !identity.secret) {
    throw new Error(
      'the kiosk window never self-provisioned an identity - is KIOSK_OPEN_PROVISION=1 set on the server?',
    );
  }
  return identity;
}

/* --------------------------------------------------------------------- fixtures --- */

/** Make sure the prize pool is not empty, so a real five-win streak could be honoured. */
async function ensureCoupons() {
  const [{ n }] = await q("select count(*)::int as n from public.coupons where status = 'available'");
  if (n === 0) {
    await q(
      // pgcrypto lives in the `extensions` schema on this database (db/schema.sql's compat
      // layer mirrors Supabase), and this pool has the default search_path - so qualify it.
      `insert into public.coupons (code)
         select 'XG-' || upper(encode(extensions.gen_random_bytes(5), 'hex')) from generate_series(1, 20)`,
    );
  }
}

/* ----------------------------------------------------------- web identity helper -- */

/**
 * Addresses whose masked forms are unlikely to collide. mask_email() keeps only the first and
 * last character of the local part, and the leaderboard decides "is this my row" by comparing
 * those masks (docs/TRACKER.md gap G3) - so two demo identities with the same first and last
 * letter get highlighted as the same row. Randomising both ends, plus retireOldDemoPlayers()
 * below, keeps a carded product gap from derailing scenarios that are about something else.
 */
const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
const letter = () => LETTERS[Math.floor(Math.random() * LETTERS.length)];
const showcaseEmail = (role) => `${letter()}${role}-${Date.now()}-${letter()}@example.com`;

/** Drop earlier runs' demo identities off the leaderboard (their rounds and rows are left
 * alone; only the confirmed email that puts them on the board is cleared). */
async function retireOldDemoPlayers() {
  const rows = await q(
    `update public.players set email = null
       where email like '%player-%@example.com' or email like '%rival-%@example.com'
       returning id`,
  );
  return rows.length;
}

/** Runs the OTP flow on the web page with no captions - used when a scenario needs a verified
 * player but is not itself the scenario about verifying one. */
async function verifyWebPlayer(page) {
  const email = showcaseEmail('player');
  await page.getByRole('button', { name: 'Board' }).click();
  await page.locator('.lb-row-me').click();
  await page.locator('.modal input[type="email"]').fill(email);
  await page
    .locator('.modal')
    .getByRole('button', { name: /send code/i })
    .click();
  await page.locator('.modal .pin-input').waitFor({ timeout: 15000 });
  const code = await peekOtp(email);
  await page.locator('.modal .pin-input').fill(code);
  await page
    .locator('.modal')
    .getByRole('button', { name: /verify/i })
    .click();
  await page.locator('.modal .signup-done-title').waitFor({ timeout: 15000 });
  await page.locator('.modal').getByRole('button', { name: /done/i }).click();
  await page.locator('.identity-bar').waitFor({ timeout: 10000 });
  return email;
}

async function ensureVerifiedWeb(page) {
  if (await page.locator('.identity-bar').count()) return null;
  return verifyWebPlayer(page);
}

/* =================================================================== scenarios ===== */

const SCENARIOS = [
  {
    n: 1,
    window: 'Web',
    title: 'A first round, decided by the server',
    watch: [
      'The countdown runs a full 5 s before any verdict appears.',
      'The balance after the verdict is read back off the server, not off the screen.',
    ],
    covered: 'tests/e2e/player-promises.spec.js #1',
    async run({ web }) {
      await web.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
      // C11: the first-visit tour sits in front of Play on a fresh context; walk it like a visitor.
      await dismissFirstVisit(web).catch(() => {});
      if ((await modeOf(web)) !== 'server') {
        for (let i = 0; i < 40 && (await modeOf(web)) !== 'server'; i++) await sleep(250);
      }
      await read();
      await web.locator('.btn-start').click();
      await waitPlayable(web);
      await read();

      const before = await web.evaluate(() => (window.__xchief && window.__xchief.settledCount) || 0);
      const t0 = Date.now();
      await web.locator('.btn-up').click();
      await web.locator('.countdown').waitFor({ timeout: 5000 });
      await web.waitForFunction((b) => window.__xchief && (window.__xchief.settledCount || 0) > b, before, {
        timeout: 25000,
      });
      const elapsed = Date.now() - t0;
      await web.locator('.pane-result').waitFor({ timeout: 8000 });
      const verdict = (await web.locator('.pane-result').innerText()).replace(/\s+/g, ' ').trim();
      await read(2);

      const me = await serverMe(await tokenOf(web));
      const screen = await coinsOnScreen(web);
      if (elapsed < 4500) throw new Error(`the verdict appeared after ${elapsed} ms, before the 5 s round was over`);
      if (screen !== me.coins) throw new Error(`screen shows ${screen} coins, the server says ${me.coins}`);
      return `verdict after ${elapsed} ms ("${verdict.slice(0, 40)}"); screen ${screen} = server ${me.coins}`;
    },
  },

  {
    n: 2,
    window: 'Web',
    title: 'Reload in the middle of a round',
    watch: [
      'The page is reloaded 1 s into a live round - the browser loses everything.',
      'The server still settles it: exactly one round is recorded, never two and never zero.',
    ],
    covered: 'tests/e2e/player-promises.spec.js #2',
    async run({ web }) {
      await web.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
      // C11: the first-visit tour sits in front of Play on a fresh context; walk it like a visitor.
      await dismissFirstVisit(web).catch(() => {});
      const token = await tokenOf(web);
      const before = await serverMe(token);
      await web.locator('.btn-start').click();
      await waitPlayable(web);
      await beat();

      await web.locator('.btn-up').click();
      await web.locator('.countdown').waitFor({ timeout: 5000 });
      await sleep(1000);
      await web.reload({ waitUntil: 'domcontentloaded' });
      await read(2);

      let after = await serverMe(token);
      const deadline = Date.now() + 20000;
      while (after.rounds < before.rounds + 1 && Date.now() < deadline) {
        await sleep(1000);
        after = await serverMe(token);
      }
      if (after.id !== before.id) throw new Error('the reload started a new player instead of resuming the old one');
      if (after.rounds !== before.rounds + 1) {
        throw new Error(`rounds went ${before.rounds} -> ${after.rounds}; exactly one settled round was expected`);
      }
      return `same player ${String(after.id).slice(0, 8)}; rounds ${before.rounds} -> ${after.rounds} (exactly one)`;
    },
  },

  {
    n: 3,
    window: 'Web',
    title: 'Signing in with an emailed code',
    watch: [
      'A wrong code is refused with an error, in the modal, with no page change.',
      'The real code comes from scripts/peek-otp.mjs - the dev capture, never a guess.',
    ],
    covered: 'tests/e2e/web-identity.spec.js',
    async run({ web }) {
      await web.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
      // C11: the first-visit tour sits in front of Play on a fresh context; walk it like a visitor.
      await dismissFirstVisit(web).catch(() => {});
      // Always start this one as a guest so the whole flow is on screen.
      if (await web.locator('.identity-bar').count()) {
        await web
          .locator('.identity-bar')
          .getByRole('button', { name: /sign out/i })
          .click();
        await web.locator('.identity-bar').waitFor({ state: 'detached', timeout: 15000 });
        await sleep(1500);
      }
      await tokenOf(web);
      await beat();
      await web.getByRole('button', { name: 'Board' }).click();
      await web.locator('.lb').waitFor({ timeout: 10000 });
      await read();

      await web.locator('.lb-row-me').click();
      await web.locator('.modal-backdrop .modal').waitFor({ timeout: 10000 });
      await read();

      const email = showcaseEmail('player');
      await web.locator('.modal input[type="email"]').fill(email);
      await beat();
      await web
        .locator('.modal')
        .getByRole('button', { name: /send code/i })
        .click();
      await web.locator('.modal .pin-input').waitFor({ timeout: 15000 });
      await read();

      await web.locator('.modal .pin-input').fill('00000000');
      await beat();
      await web
        .locator('.modal')
        .getByRole('button', { name: /verify/i })
        .click();
      await web.locator('.modal .lead-error').waitFor({ timeout: 10000 });
      const errorText = (await web.locator('.modal .lead-error').innerText()).trim();
      await read(2);

      const code = await peekOtp(email);
      await web.locator('.modal .pin-input').fill(code);
      await beat();
      await web
        .locator('.modal')
        .getByRole('button', { name: /verify/i })
        .click();
      await web.locator('.modal .signup-done-title').waitFor({ timeout: 15000 });
      await read();
      await web.locator('.modal').getByRole('button', { name: /done/i }).click();

      await web.locator('.identity-bar').waitFor({ timeout: 15000 });
      const header = await web.locator('.identity-bar').innerText();
      await read(2);
      if (header.includes(email)) throw new Error(`the header shows the raw address: ${header}`);
      if (!/\*{3,}/.test(header)) throw new Error(`the header shows no masked address: ${header}`);
      return `wrong code -> "${errorText}"; code ${code} accepted; header shows ${header.replace(/\s+/g, ' ').trim().slice(0, 60)}`;
    },
  },

  {
    n: 4,
    window: 'Web',
    title: 'The leaderboard, masked and live',
    watch: [
      'Your own row is highlighted and shows a masked address, never the raw one.',
      'A rival settles a round and the board re-orders itself - no reload, no navigation.',
    ],
    covered: 'tests/e2e/web-identity.spec.js; test/integration-box/leaderboard.test.mjs',
    async run({ web }) {
      await web.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
      // C11: the first-visit tour sits in front of Play on a fresh context; walk it like a visitor.
      await dismissFirstVisit(web).catch(() => {});
      await ensureVerifiedWeb(web);
      await beat();
      await web.getByRole('button', { name: 'Board' }).click();
      await web.locator('.lb').waitFor({ timeout: 10000 });
      const ownRow = await ownLeaderboardRow(web);
      if (!/\*{3,}/.test(ownRow)) throw new Error(`own row is not masked: ${ownRow}`);
      await read(2);

      // A rival: a second verified player whose record is seeded in the database (the server
      // owns `record`, so there is no honest client path to a specific number), then made to
      // play one real round. It is that round SETTLING on the server that recomputes the top 10
      // and pushes the `leaderboard` frame this window is about to redraw from.
      const rivalEmail = showcaseEmail('rival');
      const rival = await createVerifiedPlayerOverSocket(rivalEmail);
      const [{ top }] = await q(
        'select coalesce(max(record), 1000) as top from public.players where email is not null',
      );
      const target = Number(top) + 777;
      // Keep the rival's coins well under its seeded record: settle_round raises record with
      // greatest(record, coins), so a fat balance would let a winning round overwrite the number
      // this scenario is watching for.
      await q('update public.players set record = $2, coins = 400 where id = $1', [rival.id, target]);
      await playOneRoundOverSocket(rival.token);

      // Read the scores the way the screen shows them, digits only, so locale grouping does
      // not matter: the rival's row has to turn up without the page being touched.
      const scores = () =>
        web
          .locator('.lb-score')
          .allInnerTexts()
          .then((t) => t.map((s) => Number(s.replace(/[^\d]/g, ''))));
      const deadline = Date.now() + 20000;
      let seen = false;
      while (Date.now() < deadline && !seen) {
        seen = (await scores()).some((s) => s >= target);
        if (!seen) await sleep(500);
      }
      await read(2);
      if (!seen) throw new Error('the rival never appeared: no live leaderboard push arrived');
      const stillMine = await ownLeaderboardRow(web);
      if (!/\*{3,}/.test(stillMine)) throw new Error('own row lost its mask after the push');
      return `own row masked and highlighted (${ownRow.slice(0, 40)}); rival at ${target} arrived live over the socket`;
    },
  },

  {
    n: 5,
    window: 'Web',
    title: 'Claiming a task reward',
    watch: [
      'The "+N" toast is the reward the server granted, echoed back on its own reply.',
      "The balance chip afterwards equals the server's coins, checked over a second socket.",
    ],
    covered: 'tests/e2e/player-promises.spec.js #4; test/integration-box/tasks.test.mjs',
    async run({ web }) {
      // A task is one-time per player: give this scenario a player who has not claimed it.
      await web.evaluate(() => {
        try {
          localStorage.clear();
        } catch {
          /* nothing stored */
        }
      });
      await web.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
      // C11: the first-visit tour sits in front of Play on a fresh context; walk it like a visitor.
      await dismissFirstVisit(web).catch(() => {});
      const token = await tokenOf(web);
      const before = await serverMe(token);
      await beat();

      await web.locator('.nav-btn').nth(2).click();
      await web.locator('.tasks').waitFor({ timeout: 10000 });
      await read();

      const task = web.locator('.task').nth(3); // 'instagram' - a plain link task, no modal
      await task.locator('.task-btn').click();
      const claim = task.locator('.task-btn-ready');
      await claim.waitFor({ timeout: 30000 });
      await read();
      await claim.click();

      await web.locator('.toast').waitFor({ timeout: 10000 });
      const toast = (await web.locator('.toast').innerText()).trim();
      await task.locator('.task-state').waitFor({ timeout: 10000 });
      await read(2);

      const after = await serverMe(token);
      const granted = after.coins - before.coins;
      const screen = await coinsOnScreen(web);
      if (granted <= 0) throw new Error('the server granted nothing');
      if (screen !== after.coins) throw new Error(`screen shows ${screen}, the server says ${after.coins}`);
      if (!toast.includes(String(granted))) throw new Error(`toast "${toast}" does not show the granted ${granted}`);
      return `server granted ${granted}; toast "${toast}"; screen ${screen} = server ${after.coins}`;
    },
  },

  {
    n: 6,
    window: 'Web',
    title: 'Broke on the web is never a dead end',
    watch: [
      'The balance is forced to 50 in the database - the server owns coins, so there is no client path to a number.',
      'The overlay offers a refill; taking it re-enables play with no reload.',
    ],
    covered: 'tests/e2e/player-promises.spec.js #5',
    async run({ web }) {
      await web.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
      // C11: the first-visit tour sits in front of Play on a fresh context; walk it like a visitor.
      await dismissFirstVisit(web).catch(() => {});
      const token = await tokenOf(web);
      const me = await serverMe(token);
      await q('update public.players set coins = 50, free_refill_used = false where id = $1', [me.id]);
      await web.reload({ waitUntil: 'domcontentloaded' });
      await beat();
      await web.locator('.btn-start').click();

      const overlay = web.locator('.broke');
      await overlay.waitFor({ timeout: 25000 });
      const shown = await coinsOnScreen(web);
      if (shown !== 50) throw new Error(`the chip shows ${shown}, the server says 50`);
      await read(2);

      await overlay.locator('.btn-primary').click();
      await web.locator('.broke').waitFor({ state: 'detached', timeout: 20000 });
      await waitPlayable(web);
      await read();

      const after = await serverMe(token);
      const screen = await coinsOnScreen(web);
      if (!after.free_refill_used) throw new Error('the server did not record the refill as used');
      if (screen !== after.coins) throw new Error(`screen shows ${screen}, the server says ${after.coins}`);
      return `50 -> ${after.coins} after the refill (free_refill_used=${after.free_refill_used}); play enabled again with no reload`;
    },
  },

  {
    n: 7,
    window: 'Kiosk A',
    title: 'The booth: attract, tap, play, verdict',
    watch: [
      "A real round against the live gold price: countdown, then the server's verdict.",
      'No email field, no tasks, no leaderboard, no nav - none of it exists in the DOM.',
    ],
    covered: 'tests/e2e/kiosk.spec.js #1; tests/e2e/player-promises.spec.js #3',
    async run({ kioskA }) {
      const { id, secret } = await provisionedKiosk(kioskA);
      await kioskResetViaSocket(secret);
      await kioskA.goto(`${BASE}/kiosk`, { waitUntil: 'domcontentloaded' });
      await kioskA.getByText('Tap to play').waitFor({ timeout: 20000 });
      const atAttract = await forbiddenUi(kioskA).count();
      await read(2);

      await kioskA.locator('.btn-start').click();
      await waitPlayable(kioskA);
      await read();
      await kioskA.locator('.btn-up').click();
      await kioskA.locator('.countdown').waitFor({ timeout: 5000 });
      await kioskA.locator('.pane-result').waitFor({ timeout: 25000 });
      const verdict = (await kioskA.locator('.pane-result').innerText()).replace(/\s+/g, ' ').trim();
      await read(2);
      const atResult = await forbiddenUi(kioskA).count();

      if (!/WIN|MISS|FLAT/.test(verdict)) throw new Error(`no server verdict on screen: ${verdict}`);
      if (atAttract + atResult > 0) throw new Error(`web-only UI rendered on a kiosk (${atAttract}/${atResult} nodes)`);
      const session = await q('select session_coins, streak, session_state from public.kiosks where id = $1', [id]);
      return `verdict "${verdict.slice(0, 32)}"; session now ${session[0].session_coins} coins / streak ${session[0].streak}; forbidden UI nodes: 0`;
    },
  },

  {
    n: 8,
    window: 'Kiosk A',
    title: 'Five wins in a row wins the code',
    watch: [
      'STAGED: the five wins are frames injected through the DEV-only window.__xchief.inject hook.',
      'The client path is the real one - same frame shape, same handler; only the input is synthetic.',
    ],
    covered: 'tests/e2e/kiosk.spec.js #4; tests/e2e/streak.spec.js',
    async run({ kioskA }) {
      const CODE = 'XG-SHOWCASE-DEMO';
      const { id, secret } = await provisionedKiosk(kioskA);
      await kioskResetViaSocket(secret);
      await enterKiosk(kioskA);
      await read();

      for (const streak of [1, 2, 3, 4]) {
        await kioskA.evaluate((s) => {
          window.__xchief.inject({
            type: 'round_settled',
            round_id: `showcase-${s}`,
            outcome: 'win',
            delta: 100,
            mult: s >= 3 ? 3 : s === 2 ? 2 : 1.5,
            coins: 1000 + s * 100,
            streak: s,
            coupon: null,
            coupons_exhausted: false,
            state: 'playing',
            start_price: 2000,
            end_price: 2001,
          });
          window.__xchief.inject({ type: 'kiosk_session', coins: 1000 + s * 100, streak: s, state: 'playing' });
        }, streak);
        const shown = await coinsOnScreen(kioskA);
        if (shown !== 1000 + streak * 100) throw new Error(`win ${streak}: chip shows ${shown}`);
        await beat();
      }
      await read();

      await kioskA.evaluate((code) => {
        window.__xchief.inject({
          type: 'round_settled',
          round_id: 'showcase-5',
          outcome: 'win',
          delta: 300,
          mult: 3,
          coins: 1500,
          streak: 5,
          coupon: code,
          coupons_exhausted: false,
          state: 'won',
          start_price: 2000,
          end_price: 2001,
        });
        window.__xchief.inject({ type: 'kiosk_session', coins: 1500, streak: 5, state: 'won' });
      }, CODE);

      await kioskA.getByText('You won!').waitFor({ timeout: 10000 });
      const code = kioskA.getByText(CODE, { exact: true });
      await code.waitFor({ timeout: 5000 });
      const lines = await code.evaluate((el) => el.getClientRects().length);
      const forbidden = await forbiddenUi(kioskA).count();
      await read(3);

      await kioskA.getByRole('button', { name: 'Claim' }).click();
      await kioskA.getByText('Tap to play').waitFor({ timeout: 15000 });
      await read();

      if (lines !== 1) throw new Error(`the code wrapped onto ${lines} lines`);
      if (forbidden > 0) throw new Error(`web-only UI rendered behind the win modal (${forbidden} nodes)`);
      const state = (await q('select session_state from public.kiosks where id = $1', [id]))[0];
      return `win modal showed ${CODE} on ${lines} line; Claim returned the booth to attract (server session '${state.session_state}')`;
    },
  },

  {
    n: 9,
    window: 'Kiosk B',
    title: 'Out of coins: the exit modal',
    watch: [
      'The pot is set to 50 in the database - below the smallest stake, so the next play is refused.',
      'The server marks the session broke and pushes it; the modal is driven by that frame.',
    ],
    covered: 'tests/e2e/kiosk.spec.js #2; test/integration-box/server.test.mjs',
    async run({ kioskB }) {
      const { id, secret } = await provisionedKiosk(kioskB);
      await kioskResetViaSocket(secret);
      await enterKiosk(kioskB);
      await q(
        "update public.kiosks set session_coins = 50, session_state = 'playing', last_round_at = now() where id = $1",
        [id],
      );
      await read();

      await kioskB.locator('.tick-1').click();
      await beat();
      await kioskB.locator('.btn-up').click();
      await kioskB.getByText('That was your shot').waitFor({ timeout: 20000 });
      await kioskB.getByText(/You have used all your coins/).waitFor({ timeout: 5000 });
      const forbidden = await forbiddenUi(kioskB).count();
      await read(3);

      await kioskB.getByRole('button', { name: 'Done' }).click();
      await kioskB.getByText('Tap to play').waitFor({ timeout: 15000 });
      await read();

      if (forbidden > 0) throw new Error(`web-only UI rendered behind the exit modal (${forbidden} nodes)`);
      const state = (await q('select session_state, session_coins from public.kiosks where id = $1', [id]))[0];
      return `exit modal shown from the server's broke state; Done reset the booth (server session '${state.session_state}', ${state.session_coins} coins)`;
    },
  },

  {
    n: 10,
    window: 'Kiosk B',
    title: 'Walked away: the idle countdown',
    watch: [
      'STAGED TIMING: window.__xchief.kioskTiming shrinks the 20 s + 20 s product rule to 4 s + 6 s.',
      'A mouse move cancels the countdown; left alone the second time, it flushes to attract.',
    ],
    covered: 'tests/e2e/kiosk.spec.js #5',
    async run({ kioskB }) {
      const { secret } = await provisionedKiosk(kioskB);
      await kioskResetViaSocket(secret);
      await enterKiosk(kioskB);
      await kioskB.evaluate(() => window.__xchief.kioskTiming({ idleMs: 4000, countdownMs: 6000 }));

      const overlay = kioskB.getByText('Still there?');
      await overlay.waitFor({ timeout: 20000 });
      await read(2);

      await kioskB.mouse.move(80, 300);
      await kioskB.mouse.move(220, 520);
      await overlay.waitFor({ state: 'hidden', timeout: 10000 });
      await read(2);

      await overlay.waitFor({ timeout: 20000 }); // idle again, counting from the top
      await kioskB.getByText('Tap to play').waitFor({ timeout: 25000 });
      await read();

      const forbidden = await forbiddenUi(kioskB).count();
      if (forbidden > 0) throw new Error(`web-only UI rendered on the flushed kiosk (${forbidden} nodes)`);
      return 'overlay appeared, a mouse move cancelled it, it returned, and the flush took the booth back to attract';
    },
  },

  {
    n: 11,
    window: 'Kiosk B',
    title: "The server's own idle sweep, with no client help",
    watch: [
      'The client countdown is disabled here, so only the server can end this session.',
      'last_round_at is pushed 90 s into the past; the sweep resets the booth within 10 s.',
    ],
    covered: 'test/integration-box/server.test.mjs (idle sweep); tests/e2e/kiosk.spec.js #3',
    async run({ kioskB }) {
      const { id, secret } = await provisionedKiosk(kioskB);
      await kioskResetViaSocket(secret);
      await enterKiosk(kioskB);
      // Take the client's own flush out of the picture entirely, so what happens next can only
      // be the server's doing.
      await kioskB.evaluate(() => window.__xchief.kioskTiming({ idleMs: 3600000, countdownMs: 3600000 }));
      const kioskId = id;
      await read(2);

      // Prove the starting point, then make the row stale - in that order, so the sweep has no
      // window to fire before the assertion and make a pass look like a failure.
      if (!(await kioskB.locator('.btn-up').count())) throw new Error('the booth is not on the play screen');
      const before = await q(
        `update public.kiosks set session_state = 'playing', session_coins = 700,
           last_round_at = now() - interval '90 seconds' where id = $1 returning session_state`,
        [kioskId],
      );
      if (before[0].session_state !== 'playing') throw new Error(`session was '${before[0].session_state}'`);

      const t0 = Date.now();
      await kioskB.getByText('Tap to play').waitFor({ timeout: 30000 });
      const took = Date.now() - t0;
      await read();
      const state = (
        await q('select session_state, session_coins, streak from public.kiosks where id = $1', [kioskId])
      )[0];
      if (state.session_state !== 'idle') throw new Error(`the server session is still '${state.session_state}'`);
      return `playing -> attract ${(took / 1000).toFixed(1)} s after the row went stale, with no client action (the sweep runs every 10 s); server session '${state.session_state}', ${state.session_coins} coins, streak ${state.streak}`;
    },
  },

  {
    n: 12,
    window: 'Kiosk A',
    title: 'The winning code stays on screen long enough to photograph',
    watch: [
      'The contract is 25 s minimum before the modal may close (the product rule is a 30 s timer).',
      'Nothing is touched for 25 s: the code must still be there at the end.',
    ],
    covered: 'tests/e2e/streak.spec.js #2',
    async run({ kioskA }) {
      const CODE = 'XG-SHOWCASE-HOLD';
      const { secret } = await provisionedKiosk(kioskA);
      await kioskResetViaSocket(secret);
      await enterKiosk(kioskA);
      await kioskA.evaluate((code) => {
        window.__xchief.inject({
          type: 'round_settled',
          round_id: 'showcase-hold',
          outcome: 'win',
          delta: 300,
          mult: 3,
          coins: 1500,
          streak: 5,
          coupon: code,
          coupons_exhausted: false,
          state: 'won',
          start_price: 2000,
          end_price: 2001,
        });
      }, CODE);
      const code = kioskA.getByText(CODE, { exact: true });
      await code.waitFor({ timeout: 10000 });
      const t0 = Date.now();
      for (let s = 25; s > 0; s -= 5) {
        await sleep(5000);
        if (!(await code.isVisible())) {
          throw new Error(`the code disappeared after ${((Date.now() - t0) / 1000).toFixed(0)} s`);
        }
      }
      const held = ((Date.now() - t0) / 1000).toFixed(0);
      await kioskA.getByRole('button', { name: 'Claim' }).click();
      await kioskA.getByText('Tap to play').waitFor({ timeout: 15000 });
      return `the code stayed on screen untouched for ${held} s, then Claim cleared the booth`;
    },
  },

  {
    n: 13,
    window: 'Web',
    title: 'Cold start: what a first-time visitor lands on',
    watch: [
      'A fresh browser, nothing stored: title, hero art and the one call to action.',
      'This is the shallow guard that catches a broken build before anything else runs.',
    ],
    covered: 'tests/e2e/smoke.spec.js',
    async run({ web }) {
      await web.context().clearCookies();
      await web.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
      // C11: the first-visit tour sits in front of Play on a fresh context; walk it like a visitor.
      await dismissFirstVisit(web).catch(() => {});
      await web.evaluate(() => {
        try {
          localStorage.clear();
        } catch {
          /* nothing stored */
        }
      });
      await web.reload({ waitUntil: 'domcontentloaded' });
      const title = await web.title();
      await web.locator('.hero-art').waitFor({ timeout: 15000 });
      const cta = web.getByRole('button', { name: /start the challenge/i });
      await cta.waitFor({ timeout: 10000 });
      await read(2);
      if (!/xChief Gold Rush/.test(title)) throw new Error(`unexpected title: ${title}`);
      return `title "${title}"; hero art and the start button both render on a clean first load`;
    },
  },
];

/* ------------------------------------------------------- rival player over sockets - */

/** A second verified player, built entirely over the socket the way a real one would be. */
function createVerifiedPlayerOverSocket(email) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('timed out creating the rival player'));
    }, 25000);
    let token = null;
    let stage = 'auth';
    ws.on('open', () => ws.send(JSON.stringify({ type: 'auth' })));
    ws.on('message', async (data) => {
      let frame;
      try {
        frame = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (frame.type === 'welcome') {
        token = frame.token;
        ws.send(JSON.stringify({ type: 'request_otp', email }));
      } else if (frame.type === 'otp_sent' && stage === 'auth') {
        stage = 'verify';
        let code;
        try {
          code = await peekOtp(email);
        } catch (err) {
          clearTimeout(timer);
          ws.close();
          reject(err);
          return;
        }
        ws.send(JSON.stringify({ type: 'verify_otp', email, code }));
      } else if (frame.type === 'me' && stage === 'verify') {
        clearTimeout(timer);
        ws.close();
        resolve({ id: frame.id, token: frame.token || token });
      } else if (frame.type === 'error') {
        clearTimeout(timer);
        ws.close();
        reject(Object.assign(new Error(frame.code), { code: frame.code }));
      }
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** One real round, played and settled by the server, for a token we hold. */
function playOneRoundOverSocket(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('timed out playing the rival round'));
    }, 25000);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token })));
    ws.on('message', (data) => {
      let frame;
      try {
        frame = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (frame.type === 'welcome') ws.send(JSON.stringify({ type: 'play', dir: 'up', lever: 1 }));
      else if (frame.type === 'round_settled') {
        clearTimeout(timer);
        ws.close();
        resolve(frame);
      } else if (frame.type === 'error') {
        clearTimeout(timer);
        ws.close();
        reject(Object.assign(new Error(frame.code), { code: frame.code }));
      }
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/* ------------------------------------------------------------------- windowing ---- */

async function tile(context, page, index, total) {
  const screen = await page.evaluate(() => ({
    w: window.screen.availWidth,
    h: window.screen.availHeight,
  }));
  const chromeH = 120; // browser frame + tab strip + address bar
  const height = Math.min(VIEWPORT.height + chromeH, screen.h - 20);
  const gap = Math.max(8, Math.floor((screen.w - total * VIEWPORT.width) / (total + 1)));
  const left = gap + index * (VIEWPORT.width + gap);
  const cdp = await context.newCDPSession(page);
  const { windowId } = await cdp.send('Browser.getWindowForTarget');
  await cdp.send('Browser.setWindowBounds', {
    windowId,
    bounds: { left, top: 10, width: VIEWPORT.width, height },
  });
}

/* ---------------------------------------------------------------------- runner ---- */

function parseArgs(argv) {
  const out = { only: null, base: 'http://localhost:5347', ws: 'ws://localhost:8787/ws', fast: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--only':
        out.only = new Set(argv[++i].split(',').map((s) => Number(s.trim())));
        break;
      case '--base':
        out.base = argv[++i].replace(/\/$/, '');
        break;
      case '--ws':
        out.ws = argv[++i];
        break;
      case '--fast':
        out.fast = true;
        break;
      default:
        throw new Error(`unknown argument: ${argv[i]}`);
    }
  }
  return out;
}

function writeReport(rows, startedAt, finishedAt) {
  const pad = (s, n) => String(s).padEnd(n);
  const w = {
    n: 3,
    win: Math.max(8, ...rows.map((r) => r.window.length)),
    title: Math.max(9, ...rows.map((r) => r.title.length)),
  };
  const lines = [
    '# Showcase results',
    '',
    `Run started ${startedAt.toISOString()}, finished ${finishedAt.toISOString()} ` +
      `(${Math.round((finishedAt - startedAt) / 1000)} s total).`,
    '',
    `App ${BASE} · game socket ${WS_URL} · database ${DATABASE_URL.replace(/:[^:@/]*@/, ':***@')}`,
    '',
    'Generated by `node demo/showcase.mjs`. Do not edit by hand - re-run the script.',
    '',
    '| # | Window | Scenario | Result | Seconds | Finished at | Observation |',
    '|---|---|---|---|---|---|---|',
    ...rows.map(
      (r) =>
        `| ${r.n} | ${r.window} | ${r.title} | **${r.result}** | ${r.seconds} | ${r.at} | ${r.note.replace(/\|/g, '/')} |`,
    ),
    '',
    `Passed ${rows.filter((r) => r.result === 'PASS').length} of ${rows.length}.`,
    '',
  ];
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  fs.writeFileSync(REPORT, lines.join('\n'), 'utf8');

  console.log(`\n${'='.repeat(110)}`);
  console.log('SHOWCASE RESULTS');
  console.log('='.repeat(110));
  console.log(`${pad('#', w.n)} ${pad('WINDOW', w.win)} ${pad('SCENARIO', w.title)} RESULT  SECONDS  OBSERVATION`);
  for (const r of rows) {
    console.log(
      `${pad(r.n, w.n)} ${pad(r.window, w.win)} ${pad(r.title, w.title)} ${pad(r.result, 7)} ${pad(r.seconds, 8)} ${r.note}`,
    );
  }
  console.log(`\nPassed ${rows.filter((r) => r.result === 'PASS').length} of ${rows.length}.`);
  console.log(`Written to ${path.relative(REPO, REPORT)}`);
}

async function main() {
  const startedAt = new Date();
  console.log('xChief Gold Rush - showcase');
  console.log(`app       ${BASE}`);
  console.log(`socket    ${WS_URL}`);
  console.log(`database  ${DATABASE_URL.replace(/:[^:@/]*@/, ':***@')}`);
  console.log(`started   ${startedAt.toISOString()}\n`);

  const healthUrl = WS_URL.replace(/^ws/, 'http').replace(/\/ws$/, '/health');
  const health = await fetch(healthUrl)
    .then((r) => r.json())
    .catch(() => null);
  if (!health || !health.ok) {
    throw new Error(`the game server is not answering ${healthUrl} - start it first, see docs/showcase.md`);
  }
  const app = await fetch(`${BASE}/`).catch(() => null);
  if (!app || !app.ok) throw new Error(`the app is not being served at ${BASE} - see docs/showcase.md`);

  await ensureCoupons();
  const retired = await retireOldDemoPlayers();
  if (retired) console.log(`retired ${retired} demo identities from earlier runs off the leaderboard\n`);
  // Both kiosk windows open the open route (${BASE}/kiosk) and self-provision on load, so there
  // is no kiosk to pre-reset here - each kiosk scenario reads its own window's provisioned
  // identity (provisionedKiosk) and resets that kiosk first thing.

  const browser = await chromium.launch({ headless: false, args: ['--disable-features=TranslateUI'] });
  const windows = {};
  const order = [
    ['kioskA', 'Kiosk A', `${BASE}/kiosk`],
    ['kioskB', 'Kiosk B', `${BASE}/kiosk`],
    ['web', 'Web', `${BASE}/`],
  ];
  for (const [i, [key, , url]] of order.entries()) {
    const context = await browser.newContext({ viewport: VIEWPORT });
    const page = await context.newPage();
    page.on('pageerror', (err) => console.error(`[${key}] page error: ${err.message}`));
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await tile(context, page, i, order.length).catch((err) => console.warn(`[${key}] tiling failed: ${err.message}`));
    windows[key] = page;
  }
  await sleep(2500);

  const rows = [];
  for (const s of SCENARIOS) {
    if (args.only && !args.only.has(s.n)) continue;
    const page = { 'Kiosk A': windows.kioskA, 'Kiosk B': windows.kioskB, Web: windows.web }[s.window];
    console.log(`\n--- ${s.n}. ${s.title}  [${s.window}]`);
    const t0 = Date.now();
    let result = 'PASS';
    let note = '';
    try {
      await caption(page, s.n, s.title, s.watch, `${s.window} window · covered by ${s.covered}`);
      note = await s.run(windows);
    } catch (err) {
      result = 'FAIL';
      note = `${err.message}`.split('\n')[0].slice(0, 200);
      console.error(`    FAILED: ${note}`);
      await page.evaluate(() => document.getElementById('__showcase_caption')?.remove()).catch(() => {});
    }
    const seconds = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`    ${result} in ${seconds}s - ${note}`);
    rows.push({ n: s.n, window: s.window, title: s.title, result, seconds, note, at: new Date().toISOString() });
  }

  await sleep(1500);
  await browser.close();
  writeReport(rows, startedAt, new Date());
  await pool.end();
  process.exit(rows.some((r) => r.result === 'FAIL') ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => {});
  process.exit(1);
});

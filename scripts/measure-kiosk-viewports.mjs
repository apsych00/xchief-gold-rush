/**
 * Measure the rendered .phone width at common iPad viewports (kiosk mode).
 *
 * Run against the already-running Docker stack on localhost:8080 only.
 *   http://localhost:8080/?k=Z6gP-WEm4S3IsAA53CjCmE-4JaiA3InC
 *
 * Writes one screenshot per viewport to docs/reports/ipad/ as evidence and
 * prints a markdown table of widths, scroll and clipping results.
 */
import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'docs', 'reports', 'ipad');

const KIOSK_SECRET = 'Z6gP-WEm4S3IsAA53CjCmE-4JaiA3InC';
const KIOSK_URL = `http://localhost:8080/?k=${KIOSK_SECRET}`;

const VIEWPORTS = [
  { device: 'iPad Air 11', orientation: 'portrait', width: 820, height: 1180 },
  { device: 'iPad Air 11', orientation: 'landscape', width: 1180, height: 820 },
  { device: 'iPad Pro 13', orientation: 'portrait', width: 1024, height: 1366 },
  { device: 'iPad Pro 13', orientation: 'landscape', width: 1366, height: 1024 },
  { device: 'iPad Pro 11', orientation: 'portrait', width: 834, height: 1194 },
  { device: 'iPad Pro 11', orientation: 'landscape', width: 1194, height: 834 },
  { device: 'iPad mini', orientation: 'portrait', width: 744, height: 1133 },
  { device: 'iPad mini', orientation: 'landscape', width: 1133, height: 744 },
  { device: 'iPhone 15 Pro Max', orientation: 'portrait', width: 430, height: 932, phone: true },
];

function fileName(vp) {
  const slug = `${vp.device} ${vp.orientation}`.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return `${slug}.png`;
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function measureViewport(browser, vp) {
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 2,
    hasTouch: true,
    isMobile: true,
    userAgent:
      'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  });
  const page = await context.newPage();
  const result = {
    device: vp.device,
    orientation: vp.orientation,
    viewport: `${vp.width} x ${vp.height}`,
    phoneWidth: null,
    phoneHeight: null,
    scrollOk: false,
    clipOk: false,
    screenshot: null,
    clips: [],
    error: null,
  };

  try {
    await page.goto(KIOSK_URL, { waitUntil: 'networkidle' });
    await page.locator('.phone').waitFor({ state: 'visible', timeout: 15000 });
    // Let any entrance animation settle.
    await page.waitForTimeout(500);

    const measures = await page.evaluate((viewport) => {
      const doc = document.documentElement;
      const phone = document.querySelector('.phone');
      const phoneRect = phone ? phone.getBoundingClientRect() : null;

      const scrollY = doc.scrollHeight - viewport.height;
      const scrollX = doc.scrollWidth - viewport.width;
      const scrollOk = scrollY <= 0 && scrollX <= 0;

      const clips = [];
      const all = document.querySelectorAll('*');
      for (const el of all) {
        const rect = el.getBoundingClientRect();
        if (!rect.width || !rect.height) continue;
        const leftOver = Math.max(0, -rect.left);
        const rightOver = Math.max(0, rect.right - viewport.width);
        const topOver = Math.max(0, -rect.top);
        const bottomOver = Math.max(0, rect.bottom - viewport.height);
        if (leftOver > 1 || rightOver > 1 || topOver > 1 || bottomOver > 1) {
          let selector = '';
          if (el.id) selector = `#${el.id}`;
          else if (el.className && typeof el.className === 'string') {
            selector = `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}`;
          } else {
            selector = el.tagName.toLowerCase();
          }
          clips.push({
            selector,
            tag: el.tagName.toLowerCase(),
            leftOver,
            rightOver,
            topOver,
            bottomOver,
          });
        }
      }

      return {
        phoneWidth: phoneRect ? phoneRect.width : null,
        phoneHeight: phoneRect ? phoneRect.height : null,
        scrollY,
        scrollX,
        scrollOk,
        clipOk: clips.length === 0,
        clips: clips.slice(0, 5),
      };
    }, { width: vp.width, height: vp.height });

    Object.assign(result, measures);

    const shotPath = path.join(OUT_DIR, fileName(vp));
    await page.screenshot({ path: shotPath, fullPage: false });
    result.screenshot = shotPath;
  } catch (err) {
    result.error = err.message;
  } finally {
    await context.close();
  }

  return result;
}

function passFail(ok) {
  return ok ? 'pass' : 'FAIL';
}

function printTable(results) {
  console.log('\n| device | orientation | viewport | .phone width | scroll | clip |');
  console.log('|---|---|---|---|---|---|');
  for (const r of results) {
    const width = r.error ? `error: ${r.error}` : `${Math.round(r.phoneWidth)}px`;
    const scroll = r.error ? '-' : passFail(r.scrollOk);
    const clip = r.error ? '-' : passFail(r.clipOk);
    console.log(`| ${r.device} | ${r.orientation} | ${r.viewport} | ${width} | ${scroll} | ${clip} |`);
  }
}

async function main() {
  await ensureDir(OUT_DIR);
  const browser = await chromium.launch({ headless: true });
  const results = [];

  try {
    for (const vp of VIEWPORTS) {
      console.log(`Measuring ${vp.device} ${vp.orientation} (${vp.width}x${vp.height})...`);
      const result = await measureViewport(browser, vp);
      results.push(result);
      if (result.error) {
        console.error(`  error: ${result.error}`);
      } else if (!result.scrollOk || !result.clipOk) {
        console.error(`  scroll=${result.scrollOk} clip=${result.clipOk}`);
        for (const c of result.clips) {
          console.error(`    clip ${c.selector}: L=${c.leftOver.toFixed(1)} R=${c.rightOver.toFixed(1)} T=${c.topOver.toFixed(1)} B=${c.bottomOver.toFixed(1)}`);
        }
      }
    }
  } finally {
    await browser.close();
  }

  printTable(results);

  const failed = results.filter((r) => r.error || !r.scrollOk || !r.clipOk);
  if (failed.length) {
    console.error(`\n${failed.length} viewport(s) failed layout checks.`);
    process.exit(1);
  }
  console.log('\nAll viewports passed layout checks.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

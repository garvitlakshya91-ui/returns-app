// Capture App Store screenshots + a walkthrough video of the customer
// returns portal using the ?demo=1 seed mode. Assumes the vite dev server
// is already running on BASE (default http://localhost:5173).
//
// Usage: node scripts/shots.mjs
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '../../../brand/screenshots');
const VIDEO_DIR = resolve(OUT, 'video');
const BASE = process.env.BASE || 'http://localhost:5173';
const SLUG = 'demoshop';

mkdirSync(OUT, { recursive: true });
mkdirSync(VIDEO_DIR, { recursive: true });

// App Store standard: 1600x900 landscape, exact pixels (scale factor 1).
const VIEWPORT = { width: 1600, height: 900 };

const STEPS = [
  { name: '1-lookup',        path: `/portal/${SLUG}?demo=1` },
  { name: '2-select-items',  path: `/portal/${SLUG}/select-items?demo=1` },
  { name: '3-reason',        path: `/portal/${SLUG}/reason?demo=1` },
  { name: '4-resolution',    path: `/portal/${SLUG}/resolution?demo=1` },
  { name: '5-dropoff',       path: `/portal/${SLUG}/dropoff?demo=1` },
  { name: '6-confirmation',  path: `/portal/${SLUG}/confirmation?demo=1` },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: VIEWPORT,
  deviceScaleFactor: 1, // exact 1600x900 output
});
const page = await context.newPage();

for (const step of STEPS) {
  await page.goto(`${BASE}${step.path}`, { waitUntil: 'networkidle' });
  await sleep(900); // let fonts + images settle

  // On the dropoff step, run a search so the location cards show.
  if (step.name === '5-dropoff') {
    const input = page.locator('input[placeholder*="postcode"]');
    if (await input.count()) {
      await input.fill('GL1 1DQ');
      await page.getByRole('button', { name: /search/i }).click().catch(() => {});
      await sleep(1200);
    }
  }

  await page.screenshot({ path: resolve(OUT, `${step.name}.png`) });
  console.log(`captured ${step.name}`);
}

await context.close(); // flushes the video
await browser.close();
console.log(`\nDone. Screenshots + video in ${OUT}`);

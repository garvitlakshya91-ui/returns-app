// Record a landscape (16:9) walkthrough video of the customer returns portal
// using the ?demo=1 seed mode. 1920x1080 so YouTube treats it as a normal
// video (not a Short). Requires the vite dev server running on BASE.
//
// Usage: node scripts/video-landscape.mjs
import { chromium } from 'playwright';
import { mkdirSync, renameSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '../../../brand/screenshots/video');
const BASE = process.env.BASE || 'http://localhost:5173';
const SLUG = 'demoshop';

mkdirSync(OUT, { recursive: true });

const VIEWPORT = { width: 1920, height: 1080 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: VIEWPORT,
  recordVideo: { dir: OUT, size: VIEWPORT },
});
const page = await context.newPage();

// 1. Lookup — type into the fields for a lifelike intro, then advance.
await page.goto(`${BASE}/portal/${SLUG}?demo=1`, { waitUntil: 'networkidle' });
await sleep(1200);
await page.fill('input#email', 'jamie@example.com');
await sleep(500);
await page.fill('input#order', '#1042');
await sleep(1400);

// Walk the remaining steps (state is seeded by ?demo=1 on each load).
const steps = [
  { path: `/portal/${SLUG}/select-items?demo=1`, hold: 3000 },
  { path: `/portal/${SLUG}/reason?demo=1`, hold: 3200 },
  { path: `/portal/${SLUG}/resolution?demo=1`, hold: 3200 },
  { path: `/portal/${SLUG}/dropoff?demo=1`, hold: 800, dropoff: true },
  { path: `/portal/${SLUG}/confirmation?demo=1`, hold: 3500 },
];

for (const s of steps) {
  await page.goto(`${BASE}${s.path}`, { waitUntil: 'networkidle' });
  await sleep(900);
  if (s.dropoff) {
    const input = page.locator('input[placeholder*="postcode"]');
    if (await input.count()) {
      await input.fill('GL1 1DQ');
      await sleep(400);
      await page.getByRole('button', { name: /search/i }).click().catch(() => {});
      await sleep(1600);
    }
  }
  await sleep(s.hold);
}

await context.close(); // flush video
await browser.close();

// Rename the hashed webm to a friendly name.
const files = readdirSync(OUT).filter((f) => f.endsWith('.webm') && f.startsWith('page'));
if (files.length) {
  renameSync(resolve(OUT, files[0]), resolve(OUT, 'portal-walkthrough-landscape.webm'));
  console.log('Saved brand/screenshots/video/portal-walkthrough-landscape.webm');
}

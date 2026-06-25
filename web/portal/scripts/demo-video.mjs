// Records ONE polished landscape (1600x900) walkthrough video covering BOTH
// the customer portal flow (via ?demo=1) and the merchant dashboard (via
// mocked /api/admin/*). Includes branded title/section/end cards and slower,
// watchable pacing — ready to upload to YouTube.
//
// Prereqs: portal dev server + merchant dev server (5180) both running.
// Usage: PORTAL=http://localhost:5173 node scripts/demo-video.mjs
import { chromium } from 'playwright';
import { mkdirSync, renameSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '../../../brand/screenshots/video');
const PORTAL = process.env.PORTAL || 'http://localhost:5173';
const MERCHANT = process.env.MERCHANT || 'http://localhost:5180';
const SLUG = 'demoshop';
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const VIEWPORT = { width: 1600, height: 900 };

// ── Mock data for the merchant API ───────────────────────────────────────
const RETURNS = [
  { id: 'ret_1', shopifyOrderName: '#1042', customerName: 'Jamie Rivera', customerEmail: 'jamie@example.com', status: 'REQUESTED', totalValue: '68.00', createdAt: '2026-06-22T10:15:00Z', items: [{ id: 'i1' }] },
  { id: 'ret_2', shopifyOrderName: '#1039', customerName: 'Priya Shah', customerEmail: 'priya@example.com', status: 'LABEL_SENT', totalValue: '124.00', createdAt: '2026-06-21T16:40:00Z', items: [{ id: 'i2' }, { id: 'i3' }] },
  { id: 'ret_3', shopifyOrderName: '#1031', customerName: 'Tom Okafor', customerEmail: 'tom@example.com', status: 'PROCESSED', totalValue: '42.50', createdAt: '2026-06-20T09:05:00Z', items: [{ id: 'i4' }] },
];
const DETAIL = { id: 'ret_1', shopifyOrderName: '#1042', customerName: 'Jamie Rivera', customerEmail: 'jamie@example.com', status: 'LABEL_SENT', resolution: 'STORE_CREDIT', totalValue: '68.00', refundAmount: null, currency: 'GBP', createdAt: '2026-06-22T10:15:00Z', items: [{ id: 'i1', productTitle: 'Merino Wool Jumper', variantTitle: 'Medium / Forest Green', reason: 'doesnt_fit', reasonDetail: 'Slightly too tight on the shoulders.', quantity: 1, unitPrice: '68.00' }], label: { carrier: 'evri', trackingCode: 'EVR44D42F330135', status: 'created', qrCodeUrl: 'https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=EVR44D42F330135', labelUrl: null }, events: [{ id: 'e1', type: 'return.created', createdAt: '2026-06-22T10:15:00Z' }, { id: 'e2', type: 'return.approved', createdAt: '2026-06-22T10:16:00Z' }, { id: 'e3', type: 'label.generated', createdAt: '2026-06-22T10:16:05Z' }] };
const SUMMARY = { periodDays: 30, totalReturns: 48, processedReturns: 31, rejectedReturns: 3, pendingReturns: 14, totalValue: 3120, refundedValue: 1840, revenueRetained: 1280 };
const TREND = Array.from({ length: 14 }, (_, i) => ({ date: `2026-06-${String(9 + i).padStart(2, '0')}`, count: [1,2,1,3,2,4,3,2,5,3,4,2,3,4][i], value: [40,70,35,110,80,150,120,75,190,110,160,80,120,160][i] }));
const SKUS = [{ sku: 'MWJ-M-GRN', productTitle: 'Merino Wool Jumper', totalReturns: 9, totalQuantity: 10, reasonBreakdown: { doesnt_fit: 6, damaged: 3 } }, { sku: 'CTB-NAT', productTitle: 'Canvas Tote Bag', totalReturns: 5, totalQuantity: 5, reasonBreakdown: { changed_mind: 3, not_as_described: 2 } }, { sku: 'DNM-32-IND', productTitle: 'Selvedge Denim', totalReturns: 4, totalQuantity: 4, reasonBreakdown: { doesnt_fit: 4 } }];
const POLICIES = [{ id: 'pol_1', name: 'Standard Returns', windowDays: 30, isDefault: true, isActive: true, conditions: {}, resolutions: { allowRefund: true, allowStoreCredit: true, allowExchange: true }, fees: null, createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z' }];
const SETTINGS = { name: 'Wildgrove & Co.', email: 'hello@wildgrove.co', plan: 'GROWTH', currency: 'GBP', settings: { warehouseLine1: '1 Returns Centre', warehouseCity: 'London', warehousePostcode: 'EC1A 1BB' } };

function mockAdmin(url) {
  const p = new URL(url).pathname.replace(/^\/api\/admin/, '');
  if (p === '/returns') return { returns: RETURNS, total: RETURNS.length, page: 1, limit: 20 };
  if (/^\/returns\/[^/]+$/.test(p)) return DETAIL;
  if (p === '/analytics/summary') return SUMMARY;
  if (p === '/analytics/trend') return TREND;
  if (p === '/analytics/skus') return SKUS;
  if (p === '/policies') return POLICIES;
  if (p === '/settings') return SETTINGS;
  if (p === '/billing/plans') return { currentPlan: 'GROWTH', plans: [] };
  return {};
}

// ── Branded title / section / end card ───────────────────────────────────
const PKG = '<path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="M3.3 7 12 12l8.7-5"/><path d="M12 22V12"/>';
async function card(page, { title, subtitle, kicker, url }, holdMs) {
  await page.setContent(`<!doctype html><meta charset="utf-8">
    <style>
      html,body{margin:0;height:100%}
      .w{height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;
        background:radial-gradient(1200px 700px at 50% 0%, #6366F1 0%, #4338CA 70%);
        color:#fff;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;text-align:center}
      .logo{width:104px;height:104px;border-radius:26px;background:rgba(255,255,255,.16);
        display:flex;align-items:center;justify-content:center;margin-bottom:30px;box-shadow:0 10px 40px rgba(0,0,0,.2)}
      .kicker{text-transform:uppercase;letter-spacing:3px;font-size:15px;opacity:.75;margin-bottom:14px}
      h1{font-size:56px;margin:0;font-weight:800;letter-spacing:-1.5px}
      p{font-size:25px;margin:16px 0 0;opacity:.92;font-weight:400;max-width:900px}
      .url{margin-top:40px;font-size:21px;opacity:.85}
    </style>
    <div class="w">
      <div class="logo"><svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${PKG}</svg></div>
      ${kicker ? `<div class="kicker">${kicker}</div>` : ''}
      <h1>${title}</h1>
      ${subtitle ? `<p>${subtitle}</p>` : ''}
      ${url ? `<div class="url">${url}</div>` : ''}
    </div>`, { waitUntil: 'load' });
  await sleep(holdMs);
}

// ── Record ───────────────────────────────────────────────────────────────
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: VIEWPORT, recordVideo: { dir: OUT, size: VIEWPORT } });
await context.route('**/api/admin/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(mockAdmin(route.request().url())) }));
const page = await context.newPage();

// Intro
await card(page, { title: 'ReturnFlow', subtitle: 'Self-serve returns, carrier labels & exchanges', kicker: 'Returns made simple' }, 3800);

// Customer section
await card(page, { title: 'For your customers', subtitle: 'A branded, self-serve returns portal', kicker: 'Part 1' }, 2600);

await page.goto(`${PORTAL}/portal/${SLUG}?demo=1`, { waitUntil: 'networkidle' });
await sleep(1600);
await page.fill('input#email', 'jamie@example.com'); await sleep(650);
await page.fill('input#order', '#1042'); await sleep(1800);

for (const [path, dropoff, hold] of [
  [`/portal/${SLUG}/select-items?demo=1`, false, 3800],
  [`/portal/${SLUG}/reason?demo=1`, false, 4200],
  [`/portal/${SLUG}/resolution?demo=1`, false, 4000],
  [`/portal/${SLUG}/dropoff?demo=1`, true, 800],
  [`/portal/${SLUG}/confirmation?demo=1`, false, 4200],
]) {
  await page.goto(`${PORTAL}${path}`, { waitUntil: 'networkidle' });
  await sleep(1100);
  if (dropoff) {
    const input = page.locator('input[placeholder*="postcode"]');
    if (await input.count()) { await input.fill('GL1 1DQ'); await sleep(500);
      await page.getByRole('button', { name: /search/i }).click().catch(() => {}); await sleep(1800); }
  }
  await sleep(hold);
}

// Merchant section
await card(page, { title: 'For you, the merchant', subtitle: 'Manage every return inside Shopify Admin', kicker: 'Part 2' }, 2600);

await page.goto(`${MERCHANT}/admin/`, { waitUntil: 'networkidle' }); await sleep(4200); // dashboard
await page.getByRole('button', { name: '#1042' }).click().catch(() => {}); await sleep(5000); // detail + QR
await page.getByRole('link', { name: 'Returns' }).click().catch(async () => { await page.getByText('Returns', { exact: true }).first().click().catch(() => {}); }); await sleep(3800);
await page.getByRole('link', { name: 'Analytics' }).click().catch(async () => { await page.getByText('Analytics', { exact: true }).first().click().catch(() => {}); }); await sleep(5200);

// End
await card(page, { title: 'ReturnFlow', subtitle: 'Returns, refunds & exchanges — automated', url: 'app.returnsflow.uk' }, 4000);

await context.close();
await browser.close();

const f = readdirSync(OUT).filter((x) => x.endsWith('.webm') && x.startsWith('page'));
if (f.length) { renameSync(resolve(OUT, f[0]), resolve(OUT, 'returnflow-demo.webm'));
  console.log('Saved brand/screenshots/video/returnflow-demo.webm'); }

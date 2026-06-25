// Records ONE landscape walkthrough video covering BOTH the customer portal
// flow (via ?demo=1) and the merchant dashboard (via mocked /api/admin/*).
// No Shopify session needed — the merchant API is intercepted with mock data.
//
// Prereqs: portal dev server + merchant dev server (port 5180) both running.
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
  { id: 'ret_1', shopifyOrderName: '#1042', customerName: 'Jamie Rivera', customerEmail: 'jamie@example.com',
    status: 'REQUESTED', totalValue: '68.00', createdAt: '2026-06-22T10:15:00Z', items: [{ id: 'i1' }] },
  { id: 'ret_2', shopifyOrderName: '#1039', customerName: 'Priya Shah', customerEmail: 'priya@example.com',
    status: 'LABEL_SENT', totalValue: '124.00', createdAt: '2026-06-21T16:40:00Z', items: [{ id: 'i2' }, { id: 'i3' }] },
  { id: 'ret_3', shopifyOrderName: '#1031', customerName: 'Tom Okafor', customerEmail: 'tom@example.com',
    status: 'PROCESSED', totalValue: '42.50', createdAt: '2026-06-20T09:05:00Z', items: [{ id: 'i4' }] },
  { id: 'ret_4', shopifyOrderName: '#1025', customerName: 'Mia Conti', customerEmail: 'mia@example.com',
    status: 'IN_TRANSIT', totalValue: '89.00', createdAt: '2026-06-19T12:20:00Z', items: [{ id: 'i5' }] },
];

const DETAIL = {
  id: 'ret_1', shopifyOrderName: '#1042', customerName: 'Jamie Rivera', customerEmail: 'jamie@example.com',
  status: 'LABEL_SENT', resolution: 'STORE_CREDIT', totalValue: '68.00', refundAmount: null,
  currency: 'GBP', createdAt: '2026-06-22T10:15:00Z',
  items: [{ id: 'i1', productTitle: 'Merino Wool Jumper', variantTitle: 'Medium / Forest Green',
    reason: 'doesnt_fit', reasonDetail: 'Slightly too tight on the shoulders.', quantity: 1, unitPrice: '68.00' }],
  label: { carrier: 'evri', trackingCode: 'EVR44D42F330135', status: 'created',
    qrCodeUrl: 'https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=EVR44D42F330135',
    labelUrl: null },
  events: [
    { id: 'e1', type: 'return.created', createdAt: '2026-06-22T10:15:00Z' },
    { id: 'e2', type: 'return.approved', createdAt: '2026-06-22T10:16:00Z' },
    { id: 'e3', type: 'label.generated', createdAt: '2026-06-22T10:16:05Z' },
  ],
};

const SUMMARY = { periodDays: 30, totalReturns: 48, processedReturns: 31, rejectedReturns: 3,
  pendingReturns: 14, totalValue: 3120, refundedValue: 1840, revenueRetained: 1280 };
const TREND = Array.from({ length: 14 }, (_, i) => ({
  date: `2026-06-${String(9 + i).padStart(2, '0')}`,
  count: [1,2,1,3,2,4,3,2,5,3,4,2,3,4][i], value: [40,70,35,110,80,150,120,75,190,110,160,80,120,160][i] }));
const SKUS = [
  { sku: 'MWJ-M-GRN', productTitle: 'Merino Wool Jumper', totalReturns: 9, totalQuantity: 10, reasonBreakdown: { doesnt_fit: 6, damaged: 3 } },
  { sku: 'CTB-NAT', productTitle: 'Canvas Tote Bag', totalReturns: 5, totalQuantity: 5, reasonBreakdown: { changed_mind: 3, not_as_described: 2 } },
  { sku: 'DNM-32-IND', productTitle: 'Selvedge Denim', totalReturns: 4, totalQuantity: 4, reasonBreakdown: { doesnt_fit: 4 } },
];
const POLICIES = [{ id: 'pol_1', name: 'Standard Returns', windowDays: 30, isDefault: true, isActive: true,
  conditions: {}, resolutions: { allowRefund: true, allowStoreCredit: true, allowExchange: true }, fees: null,
  createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z' }];
const SETTINGS = { name: 'Wildgrove & Co.', email: 'hello@wildgrove.co', plan: 'GROWTH', currency: 'GBP',
  settings: { warehouseLine1: '1 Returns Centre', warehouseCity: 'London', warehousePostcode: 'EC1A 1BB', portalHeading: 'Start a Return' } };

function mockAdmin(url) {
  const u = new URL(url);
  const p = u.pathname.replace(/^\/api\/admin/, '');
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

// ── Record ───────────────────────────────────────────────────────────────
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: VIEWPORT, recordVideo: { dir: OUT, size: VIEWPORT } });
await context.route('**/api/admin/**', (route) => {
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(mockAdmin(route.request().url())) });
});
const page = await context.newPage();

// ===== CUSTOMER FLOW =====
await page.goto(`${PORTAL}/portal/${SLUG}?demo=1`, { waitUntil: 'networkidle' });
await sleep(1300);
await page.fill('input#email', 'jamie@example.com'); await sleep(450);
await page.fill('input#order', '#1042'); await sleep(1300);

for (const [path, dropoff, hold] of [
  [`/portal/${SLUG}/select-items?demo=1`, false, 2800],
  [`/portal/${SLUG}/reason?demo=1`, false, 3000],
  [`/portal/${SLUG}/resolution?demo=1`, false, 3000],
  [`/portal/${SLUG}/dropoff?demo=1`, true, 800],
  [`/portal/${SLUG}/confirmation?demo=1`, false, 3200],
]) {
  await page.goto(`${PORTAL}${path}`, { waitUntil: 'networkidle' });
  await sleep(900);
  if (dropoff) {
    const input = page.locator('input[placeholder*="postcode"]');
    if (await input.count()) { await input.fill('GL1 1DQ'); await sleep(400);
      await page.getByRole('button', { name: /search/i }).click().catch(() => {}); await sleep(1500); }
  }
  await sleep(hold);
}

// ===== MERCHANT FLOW (navigate via in-app clicks; deep /admin links bounce
// to the dashboard because BrowserRouter has no basename in dev) =====
await page.goto(`${MERCHANT}/admin/`, { waitUntil: 'networkidle' });
await sleep(3200); // dashboard

// Open a return from the Recent Returns table.
await page.getByRole('button', { name: '#1042' }).click().catch(() => {});
await sleep(4000); // detail + QR label

// Nav to the returns list.
await page.getByRole('link', { name: 'Returns' }).click()
  .catch(async () => { await page.getByText('Returns', { exact: true }).first().click().catch(() => {}); });
await sleep(3000);

// Nav to analytics.
await page.getByRole('link', { name: 'Analytics' }).click()
  .catch(async () => { await page.getByText('Analytics', { exact: true }).first().click().catch(() => {}); });
await sleep(4200);

await context.close();
await browser.close();

const f = readdirSync(OUT).filter((x) => x.endsWith('.webm') && x.startsWith('page'));
if (f.length) { renameSync(resolve(OUT, f[0]), resolve(OUT, 'returnflow-demo.webm'));
  console.log('Saved brand/screenshots/video/returnflow-demo.webm'); }

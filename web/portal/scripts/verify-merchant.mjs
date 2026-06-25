import { chromium } from 'playwright';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const SHOTS = resolve(__dirname, '../../../brand/screenshots');

const RETURNS = [
  { id: 'ret_1', shopifyOrderName: '#1042', customerName: 'Jamie Rivera', customerEmail: 'jamie@example.com', status: 'REQUESTED', totalValue: '68.00', createdAt: '2026-06-22T10:15:00Z', items: [{ id: 'i1' }] },
  { id: 'ret_2', shopifyOrderName: '#1039', customerName: 'Priya Shah', customerEmail: 'priya@example.com', status: 'LABEL_SENT', totalValue: '124.00', createdAt: '2026-06-21T16:40:00Z', items: [{ id: 'i2' }, { id: 'i3' }] },
  { id: 'ret_3', shopifyOrderName: '#1031', customerName: 'Tom Okafor', customerEmail: 'tom@example.com', status: 'PROCESSED', totalValue: '42.50', createdAt: '2026-06-20T09:05:00Z', items: [{ id: 'i4' }] },
];
const DETAIL = { id: 'ret_1', shopifyOrderName: '#1042', customerName: 'Jamie Rivera', customerEmail: 'jamie@example.com', status: 'LABEL_SENT', resolution: 'STORE_CREDIT', totalValue: '68.00', refundAmount: null, currency: 'GBP', createdAt: '2026-06-22T10:15:00Z', items: [{ id: 'i1', productTitle: 'Merino Wool Jumper', variantTitle: 'Medium / Forest Green', reason: 'doesnt_fit', reasonDetail: 'Slightly too tight on the shoulders.', quantity: 1, unitPrice: '68.00' }], label: { carrier: 'evri', trackingCode: 'EVR44D42F330135', status: 'created', qrCodeUrl: 'https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=EVR44D42F330135', labelUrl: null }, events: [{ id: 'e1', type: 'return.created', createdAt: '2026-06-22T10:15:00Z' }, { id: 'e2', type: 'return.approved', createdAt: '2026-06-22T10:16:00Z' }] };
const SUMMARY = { periodDays: 30, totalReturns: 48, processedReturns: 31, rejectedReturns: 3, pendingReturns: 14, totalValue: 3120, refundedValue: 1840, revenueRetained: 1280 };
const TREND = Array.from({ length: 14 }, (_, i) => ({ date: `2026-06-${String(9 + i).padStart(2, '0')}`, count: [1,2,1,3,2,4,3,2,5,3,4,2,3,4][i], value: [40,70,35,110,80,150,120,75,190,110,160,80,120,160][i] }));
const SKUS = [{ sku: 'MWJ-M-GRN', productTitle: 'Merino Wool Jumper', totalReturns: 9, totalQuantity: 10, reasonBreakdown: { doesnt_fit: 6, damaged: 3 } }, { sku: 'CTB-NAT', productTitle: 'Canvas Tote Bag', totalReturns: 5, totalQuantity: 5, reasonBreakdown: { changed_mind: 3, not_as_described: 2 } }];

function mock(url) {
  const p = new URL(url).pathname.replace(/^\/api\/admin/, '');
  if (p === '/returns') return { returns: RETURNS, total: RETURNS.length, page: 1, limit: 20 };
  if (/^\/returns\/[^/]+$/.test(p)) return DETAIL;
  if (p === '/analytics/summary') return SUMMARY;
  if (p === '/analytics/trend') return TREND;
  if (p === '/analytics/skus') return SKUS;
  return {};
}

const b = await chromium.launch();
const c = await b.newContext({ viewport: { width: 1600, height: 900 } });
await c.route('**/api/admin/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(mock(r.request().url())) }));
const pg = await c.newPage();
const shot = async (f) => { await pg.waitForTimeout(2400); await pg.screenshot({ path: resolve(SHOTS, `${f}.png`) }); console.log('captured', f); };

// Load the app (redirects to dashboard) then navigate via in-app clicks so
// react-router matches the prefix-less routes.
await pg.goto('http://localhost:5180/admin/', { waitUntil: 'networkidle' });
await shot('m-dashboard');

// Click the order link in Recent Returns → detail page.
await pg.getByRole('button', { name: '#1042' }).click().catch(() => {});
await shot('m-detail');

// Nav → Returns list.
await pg.getByRole('link', { name: 'Returns' }).click().catch(async () => {
  await pg.getByText('Returns', { exact: true }).first().click().catch(() => {});
});
await shot('m-returns');

// Nav → Analytics.
await pg.getByRole('link', { name: 'Analytics' }).click().catch(async () => {
  await pg.getByText('Analytics', { exact: true }).first().click().catch(() => {});
});
await shot('m-analytics');

await b.close();

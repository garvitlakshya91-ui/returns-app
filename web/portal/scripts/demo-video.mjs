// Records ONE landscape (1600x900) walkthrough of ReturnFlow for the App
// Store listing: the customer portal (via ?demo=1) and the merchant app (with
// /api/admin/* mocked, so no Shopify session is needed). Each screen carries
// a caption saying what is happening, and the merchant part runs the real
// buttons: Approve → label booked and emailed → Process Refund.
//
// Shows only what the app actually does: refund or store credit (no
// exchanges), a carrier PDF label (no home-made QR code), links to the
// carriers' own drop-off finders.
//
// Prereqs: portal dev server (5173) + merchant dev server (5180) running.
// Usage: node scripts/demo-video.mjs
import { chromium } from 'playwright';
import { mkdirSync, renameSync, readdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '../../../brand/screenshots/video');
const PORTAL = process.env.PORTAL || 'http://localhost:5173';
const MERCHANT = process.env.MERCHANT || 'http://localhost:5180';
const SLUG = 'demoshop';
mkdirSync(OUT, { recursive: true });
for (const f of readdirSync(OUT)) if (f.startsWith('page') && f.endsWith('.webm')) rmSync(resolve(OUT, f));

// PACE < 1 records a shorter cut (e.g. PACE=0.55 for the under-3-minute
// listing feature video); OUT_NAME names the file.
const PACE = Number(process.env.PACE || 1);
const OUT_NAME = process.env.OUT_NAME || 'returnflow-demo.webm';
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.round(ms * PACE)));
const VIEWPORT = { width: 1600, height: 900 };

// ── Mock merchant API, with the return moving through its states ──────────
const state = { status: 'REQUESTED', label: null, refundAmount: null, events: [] };
const at = (m) => `2026-10-22T10:${String(m).padStart(2, '0')}:00Z`;
state.events.push({ id: 'e1', type: 'return.created', actor: 'customer', createdAt: at(15) });

const LABEL = {
  id: 'lbl_1', carrier: 'evri', trackingCode: 'H01M8A0097391890', status: 'created', cost: '2.75',
  labelUrl: 'https://example.com/label.pdf', qrCodeUrl: null, createdAt: at(17),
};
const ITEM = { id: 'i1', productTitle: 'Merino Wool Jumper', variantTitle: 'Medium / Forest Green', reason: 'doesnt_fit', reasonDetail: 'Slightly too tight on the shoulders.', quantity: 1, unitPrice: '68.00', photoUrls: [] };
const detail = () => ({
  id: 'ret_1', shopifyOrderName: '#1042', customerName: 'Jamie Rivera', customerEmail: 'jamie@example.com',
  status: state.status, resolution: 'REFUND', totalValue: '68.00', refundAmount: state.refundAmount, currency: 'GBP',
  createdAt: at(15), items: [ITEM], label: state.label, events: [...state.events].reverse(),
});
const RETURNS = () => [
  { id: 'ret_1', shopifyOrderName: '#1042', customerName: 'Jamie Rivera', customerEmail: 'jamie@example.com', status: state.status, totalValue: '68.00', currency: 'GBP', createdAt: at(15), items: [{ id: 'i1' }] },
  { id: 'ret_2', shopifyOrderName: '#1039', customerName: 'Priya Shah', customerEmail: 'priya@example.com', status: 'LABEL_SENT', totalValue: '124.00', currency: 'GBP', createdAt: '2026-10-21T16:40:00Z', items: [{ id: 'i2' }, { id: 'i3' }] },
  { id: 'ret_3', shopifyOrderName: '#1031', customerName: 'Tom Okafor', customerEmail: 'tom@example.com', status: 'PROCESSED', totalValue: '42.50', currency: 'GBP', createdAt: '2026-10-20T09:05:00Z', items: [{ id: 'i4' }] },
];
const SUMMARY = { periodDays: 30, totalReturns: 48, processedReturns: 31, rejectedReturns: 3, pendingReturns: 14, totalValue: 3120, refundedValue: 1840, revenueRetained: 1280, currency: 'GBP' };
const TREND = Array.from({ length: 14 }, (_, i) => ({ date: `2026-10-${String(9 + i).padStart(2, '0')}`, count: [1,2,1,3,2,4,3,2,5,3,4,2,3,4][i], value: [40,70,35,110,80,150,120,75,190,110,160,80,120,160][i] }));
const SKUS = [
  { sku: 'MWJ-M-GRN', productTitle: 'Merino Wool Jumper', totalReturns: 9, totalQuantity: 10, reasonBreakdown: { doesnt_fit: 6, damaged: 3 } },
  { sku: 'CTB-NAT', productTitle: 'Canvas Tote Bag', totalReturns: 5, totalQuantity: 5, reasonBreakdown: { changed_mind: 3, not_as_described: 2 } },
  { sku: 'DNM-32-IND', productTitle: 'Selvedge Denim', totalReturns: 4, totalQuantity: 4, reasonBreakdown: { doesnt_fit: 4 } },
];
const POLICIES = [{ id: 'pol_1', name: 'Standard Returns', windowDays: 30, isDefault: true, isActive: true, conditions: {}, resolutions: { allowRefund: true, allowStoreCredit: true, allowExchange: false }, fees: { changed_mind: 2.5 }, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' }];
const SETTINGS = {
  name: 'Wildgrove & Co.', email: 'hello@wildgrove.co', plan: 'GROWTH', currency: 'GBP', shopifyDomain: 'wildgrove.myshopify.com',
  portalUrl: 'https://app.returnsflow.uk/portal/wildgrove',
  settings: {
    warehouseLine1: '188 Chester Road North', warehouseCity: 'Sutton Coldfield', warehousePostcode: 'B73 6SH',
    setupGuideDismissed: true, welcomeDismissed: true, reviewPromptDismissed: true,
  },
};
const CARRIERS = [{ id: 'c1', carrier: 'shippo', isActive: true, hasCredentials: false, settings: {} }];

function mockAdmin(method, url) {
  const p = new URL(url).pathname.replace(/^\/api\/admin/, '');
  if (method === 'PUT' && p === '/returns/ret_1/approve') {
    state.status = 'LABEL_SENT';
    state.label = LABEL;
    state.events.push({ id: 'e2', type: 'return.approved', actor: 'merchant', createdAt: at(16) });
    state.events.push({ id: 'e3', type: 'label.emailed', actor: 'system', createdAt: at(17), data: {} });
    state.events.push({ id: 'e4', type: 'label.generated', actor: 'system', createdAt: at(17), data: {} });
    return { ok: true };
  }
  if (method === 'PUT' && p === '/returns/ret_1/process') {
    state.status = 'PROCESSED';
    state.refundAmount = '68.00';
    state.events.push({ id: 'e5', type: 'refund.recorded', actor: 'system', createdAt: at(24), data: { amount: 68, method: 'original_payment' } });
    return { success: true, type: 'REFUND', amount: 68, requestedAmount: 68, reconciled: false };
  }
  if (p === '/returns/stats') return { total: 48, pending: 14, inProgress: 3, processed: 31, rejected: 3, totalValue: 3120, refundedValue: 1840, currency: 'GBP' };
  if (p === '/returns') return { returns: RETURNS(), total: 3, page: 1, limit: 20 };
  if (/^\/returns\/[^/]+$/.test(p)) return detail();
  if (p === '/analytics/summary') return SUMMARY;
  if (p === '/analytics/trend') return TREND;
  if (p === '/analytics/skus') return SKUS;
  if (p === '/policies') return POLICIES;
  if (p === '/settings') return SETTINGS;
  if (p === '/carriers') return CARRIERS;
  if (p.startsWith('/billing')) return { currentPlan: 'GROWTH', plans: [] };
  return {};
}

// ── Caption bar, drawn over whatever page is showing ──────────────────────
async function caption(page, text) {
  await page.evaluate((t) => {
    let el = document.getElementById('__rf_caption');
    if (!el) {
      el = document.createElement('div');
      el.id = '__rf_caption';
      Object.assign(el.style, {
        position: 'fixed', left: '50%', bottom: '28px', transform: 'translateX(-50%)', zIndex: '2147483647',
        maxWidth: '1100px', padding: '14px 26px', borderRadius: '14px', background: 'rgba(17,24,39,.88)',
        color: '#fff', font: "500 22px/1.35 'Segoe UI',Roboto,Helvetica,Arial,sans-serif", textAlign: 'center',
        boxShadow: '0 10px 30px rgba(0,0,0,.25)', pointerEvents: 'none',
      });
      document.body.appendChild(el);
    }
    el.textContent = t;
  }, text);
}

// ── Title / section / end cards ──────────────────────────────────────────
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
      p{font-size:25px;margin:16px 0 0;opacity:.92;font-weight:400;max-width:960px;line-height:1.4}
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

// Short timeouts: a missed lookup must not leave 30 idle seconds in the video.
async function clickByText(page, role, name) {
  const t0 = Date.now();
  const first = role === 'text'
    ? page.getByText(name, { exact: true }).first()
    : page.getByRole(role, { name }).first();
  await first.click({ timeout: 2500 }).catch(async () => {
    await page.getByText(name, { exact: true }).first().click({ timeout: 2500 }).catch(() => {});
  });
  console.log(`click ${role} "${name}" took ${Date.now() - t0}ms`);
}

// ── Record ───────────────────────────────────────────────────────────────
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: VIEWPORT, recordVideo: { dir: OUT, size: VIEWPORT } });
await context.route('**/api/admin/**', (route) => route.fulfill({
  status: 200, contentType: 'application/json',
  body: JSON.stringify(mockAdmin(route.request().method(), route.request().url())),
}));
const page = await context.newPage();
// A page that crashes would record as a blank screen: report it loudly.
const crashes = [];
page.on('pageerror', (e) => { if (!/missing required configuration fields: shop/.test(e.message)) crashes.push(e.message); });

await card(page, { title: 'ReturnFlow', subtitle: 'Self-serve returns for UK Shopify stores, with real carrier labels and refunds issued through Shopify', kicker: 'Returns made simple' }, 5000);

// Part 1: the customer
await card(page, { title: 'For your customers', subtitle: 'A branded returns portal: no emails, no support tickets', kicker: 'Part 1' }, 3500);

await page.goto(`${PORTAL}/portal/${SLUG}?demo=1`, { waitUntil: 'load' });
await caption(page, 'The customer opens your returns portal and finds their order with their email and order number.');
await sleep(2500);
await page.fill('input#email', 'jamie@example.com'); await sleep(700);
await page.fill('input#order', '#1042'); await sleep(3500);

const portalSteps = [
  ['select-items', 'They choose which items to send back. Only items still eligible under your return policy are offered.', 6500],
  ['reason', 'They give a reason for each item, and can add details and photos.', 6500],
  ['resolution', 'They pick a refund to the original payment, or store credit. You decide which options each policy allows.', 7000],
  ['dropoff', 'Their label works at any of the carrier’s drop-off points. These links open the carriers’ own finders.', 7000],
  ['confirmation', 'They check the summary and submit. The return now appears in your dashboard.', 6500],
];
for (const [step, text, hold] of portalSteps) {
  await page.goto(`${PORTAL}/portal/${SLUG}/${step}?demo=1`, { waitUntil: 'load' });
  await caption(page, text);
  await sleep(hold);
}

// Part 2: the merchant
await card(page, { title: 'For you, the merchant', subtitle: 'Approve, label and refund every return from one place', kicker: 'Part 2' }, 3500);

await page.goto(`${MERCHANT}/admin/`, { waitUntil: 'load' });
await caption(page, 'Your dashboard shows new returns waiting for review, returns in progress and their value.');
await sleep(6500);

await clickByText(page, 'button', '#1042');
await sleep(1200);
await caption(page, 'Open a return to see the items, the reason and any photos the customer added.');
await sleep(6000);

await clickByText(page, 'button', 'Approve');
await sleep(1500);
await caption(page, 'Approve it: ReturnFlow books a real Evri label to your returns address and emails it to the customer.');
await sleep(8000);

await caption(page, 'The label PDF, tracking number and every step are on the return’s timeline.');
await sleep(6000);

await clickByText(page, 'button', 'Process Refund');
await sleep(1500);
await caption(page, 'When the parcel is back, process the refund. Shopify issues it to the original payment method, or as store credit.');
await sleep(8500);

await clickByText(page, 'text', 'Returns');
await sleep(1200);
await caption(page, 'All returns in one list. Search, filter, and approve or reject several at once.');
await sleep(6500);

await clickByText(page, 'text', 'Policies');
await sleep(1200);
await caption(page, 'Return policies set the return window, the refund options, and optional fees by reason.');
await sleep(6500);

await clickByText(page, 'text', 'Settings');
await sleep(1200);
await caption(page, 'Settings: turn on managed labels, brand your portal, and set the returns address your labels go to.');
await sleep(4000);
// Bring the returns (warehouse) address into view: reviewers must set it first.
await page.getByText(/warehouse address/i).first().scrollIntoViewIfNeeded({ timeout: 2500 }).catch(() => {});
await sleep(4500);

await clickByText(page, 'text', 'Analytics');
await sleep(1200);
await caption(page, 'Analytics show return volume, value, top reasons and your most-returned products, with CSV export.');
await sleep(8000);

await card(page, { title: 'ReturnFlow', subtitle: 'Returns portal · real UK carrier labels · refunds through Shopify', url: 'app.returnsflow.uk' }, 5000);

await context.close();
await browser.close();
if (crashes.length) { console.error(`PAGE CRASHES:\n${crashes.join('\n')}`); process.exitCode = 1; }

const f = readdirSync(OUT).filter((x) => x.endsWith('.webm') && x.startsWith('page'));
if (f.length) {
  renameSync(resolve(OUT, f[0]), resolve(OUT, OUT_NAME));
  console.log(`Saved brand/screenshots/video/${OUT_NAME}`);
}

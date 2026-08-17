import { chromium } from 'playwright';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '../../../brand/screenshots/onboarding');

// --- Mock data for the new onboarding + carrier UI -------------------------
const SETTINGS = {
  name: 'Thread & Bramble',
  email: 'hello@threadandbramble.co.uk',
  plan: 'STARTER',
  currency: 'GBP',
  portalUrl: 'https://portal.returnsflow.uk/portal/thread-bramble',
  settings: {
    portalHeading: 'Start a return',
    primaryColor: '#4F46E5',
    supportEmail: 'returns@threadandbramble.co.uk',
    // Warehouse deliberately left blank so the Setup Guide shows a pending step.
    warehouseLine1: '',
    warehousePostcode: '',
    setupGuideDismissed: false,
  },
};

// Evri connected+active; Royal Mail / InPost not connected.
const CARRIERS = [
  { id: 'cc_evri', carrier: 'evri', isActive: true, hasCredentials: true, settings: {} },
];

const RETURNS = [
  { id: 'ret_1', shopifyOrderName: '#1042', customerName: 'Jamie Rivera', status: 'REQUESTED', totalValue: '68.00', createdAt: '2026-06-22T10:15:00Z', items: [{ id: 'i1' }] },
  { id: 'ret_2', shopifyOrderName: '#1039', customerName: 'Priya Shah', status: 'LABEL_SENT', totalValue: '124.00', createdAt: '2026-06-21T16:40:00Z', items: [{ id: 'i2' }] },
  { id: 'ret_3', shopifyOrderName: '#1031', customerName: 'Tom Okafor', status: 'PROCESSED', totalValue: '42.50', createdAt: '2026-06-20T09:05:00Z', items: [{ id: 'i3' }] },
];

function mock(url, method) {
  const p = new URL(url).pathname.replace(/^\/api\/admin/, '');
  if (p === '/settings') return SETTINGS;
  if (p === '/carriers') return method === 'GET' ? CARRIERS : { id: 'cc_new', carrier: 'royalmail', isActive: true, hasCredentials: true };
  if (p === '/returns') return { returns: RETURNS, total: RETURNS.length, page: 1, limit: 20 };
  return {};
}

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const c = await b.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
await c.route('**/api/admin/**', (r) =>
  r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(mock(r.request().url(), r.request().method())) }),
);
const pg = await c.newPage();
const shot = async (f) => { await pg.waitForTimeout(1800); await pg.screenshot({ path: resolve(OUT, `${f}.png`) }); console.log('captured', f); };

// Dashboard — now leads with the Setup Guide onboarding checklist.
await pg.goto('http://localhost:5180/admin/', { waitUntil: 'networkidle' });
await shot('dashboard-setup-guide');

// Settings — scroll to the new Carriers card.
await pg.getByRole('link', { name: 'Settings' }).click().catch(async () => {
  await pg.getByText('Settings', { exact: true }).first().click().catch(() => {});
});
await pg.waitForTimeout(1200);
await pg.getByText('Carriers', { exact: true }).first().scrollIntoViewIfNeeded().catch(() => {});
await shot('settings-carriers');

// Open the "Connect" modal for Royal Mail (not yet connected). Exact match so
// we don't accidentally hit Evri's "Disconnect" (substring "connect").
await pg.getByRole('button', { name: 'Connect', exact: true }).first().click().catch(() => {});
await pg.waitForTimeout(800);
await shot('carrier-connect-modal');

await b.close();
console.log('done →', OUT);

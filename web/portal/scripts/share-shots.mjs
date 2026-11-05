// Crisp screenshots of the two places a merchant learns how to share the
// returns portal with customers: the Dashboard setup guide and the Settings
// "Let customers find your portal" card. Merchant API is mocked (fresh store
// on the Free plan with managed labels on). Needs the merchant dev server:
//   cd web/merchant && npx vite --port 5180
// Then: node web/portal/scripts/share-shots.mjs
import { chromium } from 'playwright';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '../../../brand/screenshots');

const SLUG = 'address-quality';
const SETTINGS = {
  name: 'Address_quality', email: 'owner@example.com', plan: 'FREE', currency: 'USD', shopifyDomain: `${SLUG}.myshopify.com`,
  settings: { warehouseLine1: '188 Chester Road North', warehouseCity: 'Sutton Coldfield', warehousePostcode: 'B73 6SH' },
  portalUrl: `https://app.returnsflow.uk/portal/${SLUG}`, shopHandle: SLUG,
  themeEditorUrl: `https://admin.shopify.com/store/${SLUG}/themes/current/editor?template=index&addAppBlockId=545b64c0-bd29-453c-de0b-a51dd63563ca0e1176e8/start-return&target=newAppsSection`,
};

function mock(url) {
  const p = new URL(url).pathname.replace(/^\/api\/admin/, '');
  if (p === '/settings') return SETTINGS;
  if (p === '/carriers') return [{ id: 'c1', carrier: 'shippo', isActive: true, hasCredentials: false, settings: {} }];
  if (p === '/policies') return [{ id: 'p1', name: 'Standard returns', windowDays: 30, isActive: true, isDefault: true }];
  if (p === '/billing/labels') return { allowed: true, devStore: false, reason: null, plan: 'Free', planUrl: `https://admin.shopify.com/store/${SLUG}/charges/returns-app-garvit-20260613/pricing_plans`, message: null };
  if (p === '/billing/plans') return { currentPlan: 'FREE', trialDays: 14, plans: [] };
  if (p === '/returns/stats') return { total: 0, pending: 0, processed: 0, totalValue: 0 };
  if (p === '/returns') return { returns: [], total: 0, page: 1, limit: 20 };
  return {};
}

const b = await chromium.launch();
const c = await b.newContext({ viewport: { width: 1280, height: 1100 }, deviceScaleFactor: 2 });
await c.route('**/api/admin/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(mock(r.request().url())) }));
const pg = await c.newPage();

await pg.goto('http://localhost:5180/admin/', { waitUntil: 'networkidle' });
await pg.waitForTimeout(2500);
// Polaris 13 renders Card as ShadowBevel > Box; climb to the bevel.
const CARD = 'xpath=ancestor::div[contains(@class,"Polaris-ShadowBevel")][1]';
const guide = pg.getByText('Set up ReturnFlow', { exact: true }).locator(CARD);
await guide.screenshot({ path: resolve(OUT, 'share-1-setup-guide.png') });
console.log('captured share-1-setup-guide');

await pg.getByRole('link', { name: 'Settings' }).click().catch(async () => {
  await pg.getByText('Settings', { exact: true }).first().click();
});
await pg.waitForTimeout(2500);
const card = pg.getByText('Let customers find your portal', { exact: true }).locator(CARD);
await card.screenshot({ path: resolve(OUT, 'share-2-settings-card.png') });
console.log('captured share-2-settings-card');

await b.close();

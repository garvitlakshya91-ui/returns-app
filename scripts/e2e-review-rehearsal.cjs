// End-to-end rehearsal of the Shopify App Store reviewer's script, run
// against PRODUCTION (or whatever E2E_APP_URL points at):
//
//   1. Create a real PAID order on the dev store (Admin API orderCreate with a
//      SALE transaction + a real UK shipping address)
//   2. Customer: portal lookup -> create return        (public portal API)
//   3. Merchant: approve -> wait for label -> process  (admin API, using a
//      session token signed with SHOPIFY_API_SECRET — what App Bridge mints)
//   4. Verify the refund landed on the Shopify order
//
// Usage (from the repo root; needs .env with DATABASE_URL / SHOPIFY_API_KEY /
// SHOPIFY_API_SECRET / ENCRYPTION_KEY):
//   node scripts/e2e-review-rehearsal.cjs                 # fresh order
//   node scripts/e2e-review-rehearsal.cjs "#1008" <gid>   # reuse an order
//
// Env overrides: E2E_SHOP_DOMAIN (default returns-hjpu8csz.myshopify.com),
//                E2E_APP_URL    (default https://app.returnsflow.uk)
//
// This is the check that caught both 2026-08 review gaps (simulated label,
// unpublished plans). Run it before EVERY resubmission.
require('dotenv').config();
const crypto = require('crypto');
const prisma = require('../app/config/database');
const ShopToken = require('../app/services/ShopToken');

const SHOP_DOMAIN = process.env.E2E_SHOP_DOMAIN || 'returns-hjpu8csz.myshopify.com';
const SHOP_SLUG = SHOP_DOMAIN.replace('.myshopify.com', '');
const APP_URL = (process.env.E2E_APP_URL || 'https://app.returnsflow.uk').replace(/\/$/, '');
const API_VERSION = '2026-04';
const CUSTOMER = {
  email: 'jane.e2e@example.com',
  firstName: 'Jane',
  lastName: 'Reviewer',
  address: { address1: "1 St Peter's Square", city: 'Manchester', zip: 'M2 3AE', countryCode: 'GB' },
};

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sessionToken() {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({
    iss: `https://${SHOP_DOMAIN}/admin`,
    dest: `https://${SHOP_DOMAIN}`,
    aud: process.env.SHOPIFY_API_KEY,
    sub: '1',
    exp: now + 60,
    nbf: now - 5,
    iat: now,
    jti: crypto.randomUUID(),
    sid: crypto.randomUUID(),
  }));
  const sig = b64url(crypto.createHmac('sha256', process.env.SHOPIFY_API_SECRET).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${sig}`;
}

async function adminGql(accessToken, query, variables = {}) {
  const res = await fetch(`https://${SHOP_DOMAIN}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(`Shopify GraphQL: ${JSON.stringify(json.errors).slice(0, 400)}`);
  return json.data;
}

async function appApi(path, { method = 'GET', body, admin = false } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (admin) headers.Authorization = `Bearer ${sessionToken()}`;
  const res = await fetch(`${APP_URL}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(json).slice(0, 400)}`);
  return json;
}

(async () => {
  const shop = await prisma.shop.findUnique({ where: { shopifyDomain: SHOP_DOMAIN } });
  if (!shop?.shopifyToken) throw new Error(`No token stored for ${SHOP_DOMAIN} — open the app in Shopify admin first`);
  const accessToken = await ShopToken.getAccessToken(shop);
  console.log('[1] Access token OK');

  const prod = await adminGql(accessToken, `
    { shop { currencyCode }
      products(first: 20, query: "status:active") { edges { node {
        title isGiftCard variants(first: 1) { edges { node { id title price } } }
    } } } }`);
  const currency = prod.shop.currencyCode;
  const pEdge = prod.products.edges.find((e) => !e.node.isGiftCard
    && e.node.variants.edges.length && Number(e.node.variants.edges[0].node.price) > 0);
  if (!pEdge) throw new Error('No active non-gift-card product with a priced variant on the store');
  const variant = pEdge.node.variants.edges[0].node;
  console.log(`[2] Using product "${pEdge.node.title}" @ ${variant.price} ${currency}`);

  let order;
  if (process.argv[2] && process.argv[3]) {
    order = { name: process.argv[2], id: process.argv[3] };
    console.log(`[3] Reusing order ${order.name} (${order.id})`);
  } else {
    const created = await adminGql(accessToken, `
      mutation($order: OrderCreateOrderInput!) {
        orderCreate(order: $order) {
          order { id name displayFinancialStatus }
          userErrors { field message }
        }
      }`, {
      order: {
        email: CUSTOMER.email,
        lineItems: [{ variantId: variant.id, quantity: 1 }],
        shippingAddress: { firstName: CUSTOMER.firstName, lastName: CUSTOMER.lastName, ...CUSTOMER.address },
        transactions: [{
          kind: 'SALE', status: 'SUCCESS',
          amountSet: { shopMoney: { amount: variant.price, currencyCode: currency } },
        }],
      },
    });
    if (created.orderCreate.userErrors.length) throw new Error(JSON.stringify(created.orderCreate.userErrors));
    order = created.orderCreate.order;
    console.log(`[3] Order ${order.name} created (${order.id}) — ${order.displayFinancialStatus}`);
  }

  // Shopify's order search index is eventually consistent — retry for ~90s.
  let lookup = null;
  for (let i = 0; i < 18; i++) {
    try {
      lookup = await appApi('/api/portal/lookup', {
        method: 'POST',
        body: { email: CUSTOMER.email, orderNumber: order.name.replace('#', ''), shopSlug: SHOP_SLUG },
      });
      break;
    } catch (err) {
      if (!/404/.test(err.message)) throw err;
      console.log(`    lookup not indexed yet (attempt ${i + 1}) — waiting 5s`);
      await sleep(5000);
    }
  }
  if (!lookup) throw new Error('Order never appeared in Shopify order search');
  if (!lookup.eligibleItems?.length) throw new Error(`Lookup returned no eligible items: ${JSON.stringify(lookup).slice(0, 300)}`);
  console.log(`[4] Portal lookup OK — ${lookup.eligibleItems.length} eligible item(s) on ${lookup.orderName}`);

  const li = lookup.eligibleItems[0];
  const ret = await appApi('/api/portal/returns', {
    method: 'POST',
    body: {
      shopId: lookup.shopId,
      orderId: lookup.orderId,
      orderName: lookup.orderName,
      customerEmail: CUSTOMER.email,
      customerName: `${CUSTOMER.firstName} ${CUSTOMER.lastName}`,
      resolution: 'REFUND',
      items: [{
        lineItemId: li.lineItemId,
        productId: li.productId,
        variantId: li.variantId,
        productTitle: li.title,
        variantTitle: li.variantTitle,
        sku: li.sku,
        quantity: 1,
        unitPrice: li.price,
        reason: 'doesnt_fit',
        reasonDetail: 'E2E review rehearsal',
      }],
    },
  });
  console.log(`[5] Return created: ${ret.id} (status ${ret.status})`);

  await appApi(`/api/admin/returns/${ret.id}/approve`, { method: 'PUT', admin: true });
  console.log('[6] Approved — waiting for label job...');
  let detail = null;
  for (let i = 0; i < 20; i++) {
    await sleep(3000);
    detail = await appApi(`/api/admin/returns/${ret.id}`, { admin: true });
    if (detail.label) break;
  }
  if (!detail?.label) throw new Error(`No label after 60s (status ${detail?.status})`);
  const simulated = !detail.label.labelUrl;
  console.log(`[7] Label: carrier=${detail.label.carrier} tracking=${detail.label.trackingCode} cost=${detail.label.cost}`);
  console.log(`    labelUrl=${detail.label.labelUrl || '(none — SIMULATED: no carrier key on the server)'}`);
  console.log(`    qrCodeUrl=${(detail.label.qrCodeUrl || '').slice(0, 90)}`);

  await appApi(`/api/admin/returns/${ret.id}/process`, { method: 'PUT', admin: true });
  console.log('[8] Refund processed via app');

  await sleep(3000);
  const check = await adminGql(accessToken, `
    query($id: ID!) { node(id: $id) { ... on Order { name displayFinancialStatus } } }`, { id: order.id });
  console.log(`[9] Shopify says ${check.node.name} is now: ${check.node.displayFinancialStatus}`);

  const ok = check.node.displayFinancialStatus === 'REFUNDED' && !simulated;
  console.log(`\n${ok ? 'E2E PASS' : 'E2E COMPLETE WITH WARNINGS'}`, JSON.stringify({
    order: order.name,
    returnId: ret.id,
    financialStatus: check.node.displayFinancialStatus,
    label: { carrier: detail.label.carrier, tracking: detail.label.trackingCode, url: detail.label.labelUrl, simulated },
  }, null, 2));
  if (simulated) console.log('WARNING: label was simulated — set SHIPPO_API_KEY on the server before resubmitting.');
  if (/^0+$/.test(detail.label.trackingCode || '')) console.log('WARNING: all-zero tracking = Shippo TEST key -> generic SAMPLE LABEL PDF. Use a shippo_live_ key for review.');
  process.exit(ok ? 0 : 2);
})().catch((err) => { console.error('E2E FAILED:', err.message); process.exit(1); });

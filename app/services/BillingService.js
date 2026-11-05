const prisma = require('../config/database');
const ShopToken = require('./ShopToken');
const logger = require('../utils/logger');

// Single source of truth for plan definitions. Mirrors the pricing table in
// CLAUDE.md. `returnsPerMonth: null` means unlimited.
//
// Pro is intentionally NOT sold yet: its intended differentiators (fraud
// detection, AI prediction, API access) aren't built, so it would charge more
// than Growth for nothing. The PRO enum + PLAN_LIMITS stay in place so it can
// be re-introduced the moment those features ship.
const PLANS = {
  // Shopify App Pricing invoices the free plan under its (unchangeable) plan
  // name "Preview", so that is what app_subscriptions/update webhooks carry.
  FREE:    { amount: 0,  name: 'Free',    returnsPerMonth: 30, aliases: ['preview'] },
  STARTER: { amount: 9,  name: 'Starter', returnsPerMonth: 150 },
  GROWTH:  { amount: 29, name: 'Growth',  returnsPerMonth: null },
};

const SUBSCRIPTION_PREFIX = 'ReturnFlow';

// Paid plans get a free trial; annual billing is ~2 months free (×10/yr).
const TRIAL_DAYS = 14;
function annualAmount(planKey) {
  return Math.round((PLANS[planKey]?.amount || 0) * 10 * 100) / 100;
}

// ─── Managed-label usage billing ───
// Paid subscriptions carry a usage-pricing line item so we can bill managed
// return labels per-label (postage + a flat service fee) on the merchant's
// Shopify invoice. The capped amount is the monthly usage ceiling the merchant
// approves; charges above it are rejected until they raise the cap.
const USAGE_CAP_GBP = Number(process.env.LABEL_USAGE_CAP_GBP || 200);
const LABEL_FEE_GBP = Number(process.env.LABEL_FEE_GBP || 0.5);

/** The usage-pricing line item attached to every paid subscription. */
function usagePricingLineItem() {
  return {
    plan: {
      appUsagePricingDetails: {
        terms: `Managed return labels: postage + £${LABEL_FEE_GBP.toFixed(2)} service fee, charged per label`,
        cappedAmount: { amount: USAGE_CAP_GBP, currencyCode: 'GBP' },
      },
    },
  };
}

/** Subscription name we register on Shopify for a given plan + interval. */
function subscriptionName(planKey, interval = 'monthly') {
  return `${SUBSCRIPTION_PREFIX} ${PLANS[planKey].name}${interval === 'annual' ? ' (Annual)' : ''}`;
}

/**
 * Map a Shopify subscription name back to a plan key. Tolerant of casing, a
 * missing "ReturnFlow" prefix, an "(Annual)" suffix, and trailing text after
 * the plan word (managed-pricing plan names like "Starter — £9/month").
 */
function planKeyFromName(name) {
  if (!name) return null;
  const cleaned = String(name)
    .replace(new RegExp(`^${SUBSCRIPTION_PREFIX}\\s*`, 'i'), '')
    .replace(/\s*\(annual\)\s*$/i, '')
    .trim()
    .toLowerCase();
  const names = (p) => [p.name, ...(p.aliases || [])];
  const entry = Object.entries(PLANS).find(([, p]) => names(p).some((n) => n.toLowerCase() === cleaned))
    || Object.entries(PLANS).find(([, p]) => names(p).some((n) => new RegExp(`^${n}([^a-z]|$)`, 'i').test(cleaned)));
  return entry ? entry[0] : null;
}

// Async: expiring offline tokens may need a refresh before use.
function graphqlClient(shop) {
  return ShopToken.graphqlClient(shop);
}

/**
 * Development stores can only approve TEST charges — creating a real charge
 * there fails, which is exactly what the App Store reviewer hits when they
 * try to upgrade on their review store. Detect them so subscribe can flip the
 * `test` flag. Fails safe: if the store type can't be determined, treat it as
 * a regular store (real charge in production).
 */
async function isDevelopmentStore(client) {
  try {
    const resp = await client.request('{ shop { plan { partnerDevelopment } } }');
    return Boolean(resp.data?.shop?.plan?.partnerDevelopment);
  } catch (err) {
    logger.warn({ err: err.message }, 'Could not determine store type for billing; assuming regular store');
    return false;
  }
}

/**
 * Query Shopify for the merchant's current ACTIVE app subscription.
 * Returns { id, name, status } or null. This is the source of truth — never
 * trust a client-supplied plan when deciding what the merchant actually pays.
 */
async function getActiveSubscription(client) {
  const resp = await client.request(`
    {
      currentAppInstallation {
        activeSubscriptions { id name status }
      }
    }
  `);
  const subs = resp.data?.currentAppInstallation?.activeSubscriptions || [];
  return subs.find((s) => s.status === 'ACTIVE') || null;
}

/** Cancel a subscription by id. Throws on userErrors. */
async function cancelSubscription(client, id) {
  const resp = await client.request(`
    mutation AppSubscriptionCancel($id: ID!) {
      appSubscriptionCancel(id: $id) {
        appSubscription { id status }
        userErrors { field message }
      }
    }
  `, { variables: { id } });

  const errors = resp.data?.appSubscriptionCancel?.userErrors || [];
  if (errors.length > 0) {
    throw new Error(errors.map((e) => e.message).join(', '));
  }
  return resp.data?.appSubscriptionCancel?.appSubscription;
}

/**
 * Reconcile the local plan with a subscription status from Shopify (used by
 * both the confirm redirect and the app_subscriptions/update webhook).
 *  - ACTIVE   → upgrade to the matching plan, reset the billing cycle.
 *  - anything else (CANCELLED/EXPIRED/DECLINED/FROZEN/PENDING) → drop to FREE.
 */
async function applySubscriptionStatus(shopDomain, { name, status }) {
  const shop = await prisma.shop.findUnique({ where: { shopifyDomain: shopDomain } });
  if (!shop) return null;

  const isActive = status === 'ACTIVE';
  const planKey = isActive ? (planKeyFromName(name) || shop.plan) : 'FREE';

  await prisma.shop.update({
    where: { id: shop.id },
    data: {
      plan: planKey,
      // Only reset the usage counter when a paid plan activates — a downgrade
      // shouldn't wipe the merchant's current-cycle return count.
      ...(isActive ? { billingCycleStart: new Date(), returnCount: 0 } : {}),
    },
  });

  logger.info({ shop: shopDomain, status, plan: planKey }, 'Billing subscription reconciled');
  return planKey;
}

// ─── Managed-label billing under Shopify App Pricing ───
// Plans live in the Partner Dashboard (priced in USD) and each one carries a
// usage meter for return labels (handle LABEL_METER_HANDLE). Every label
// bought on ReturnFlow's carrier account is reported as one billable event
// through Shopify's App Events API; Shopify multiplies by the meter's price
// and adds it to the merchant's monthly Shopify bill. There is no cap to
// check and nothing to charge directly. Development stores get every plan at
// $0, so reporting there costs the merchant nothing.
const LABEL_METER_HANDLE = process.env.LABEL_METER_HANDLE || 'return_label';
const APP_EVENTS_VERSION = process.env.SHOPIFY_APP_EVENTS_VERSION || '2026-10';
const APP_EVENTS_BASE = (process.env.SHOPIFY_APP_EVENTS_BASE || 'https://api.shopify.com').replace(/\/$/, '');
const APP_HANDLE = process.env.SHOPIFY_APP_HANDLE || 'returns-app-garvit-20260613';

/** Shopify's hosted plan-selection page for this app (Shopify App Pricing). */
function pricingPlansUrl(shopDomain) {
  const storeHandle = String(shopDomain || '').replace('.myshopify.com', '');
  return `https://admin.shopify.com/store/${storeHandle}/charges/${APP_HANDLE}/pricing_plans`;
}

/** The one idempotency key a label's usage event ever uses, retries included (≤ 64 chars). */
function labelChargeKey(returnId) {
  return `returnflow:label-charge:${returnId}`;
}

// The App Events API authenticates the app itself (client credentials), not
// a shop. Tokens last an hour; keep one and renew a minute early.
let appEventsToken = null;
async function appEventsAccessToken() {
  if (appEventsToken && appEventsToken.expiresAt > Date.now() + 60 * 1000) return appEventsToken.token;
  const res = await fetch(`${APP_EVENTS_BASE}/auth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.SHOPIFY_API_KEY,
      client_secret: process.env.SHOPIFY_API_SECRET,
      grant_type: 'client_credentials',
    }),
  });
  if (!res.ok) throw new Error(`App Events auth failed (${res.status})`);
  const body = await res.json();
  if (!body?.access_token) throw new Error('App Events auth returned no token');
  appEventsToken = { token: body.access_token, expiresAt: Date.now() + Number(body.expires_in || 3600) * 1000 };
  return appEventsToken.token;
}

/** The shop's Shopify id (a gid), read once and kept in Shop.settings. */
async function shopGid(shop) {
  const cached = shop.settings?.shopifyShopId;
  if (cached) return cached;
  const client = await graphqlClient(shop);
  const resp = await client.request('{ shop { id } }');
  const id = resp.data?.shop?.id;
  if (!id) throw new Error('Could not read the shop id from Shopify');
  await prisma.shop.update({
    where: { id: shop.id },
    data: { settings: { ...(shop.settings || {}), shopifyShopId: id } },
  }).catch((err) => logger.warn({ shop: shop.shopifyDomain, err: err.message }, 'Could not cache the shop id'));
  return id;
}

/**
 * Report one bought label to the merchant's plan meter. Idempotent per
 * return: Shopify keeps the key for good, so a retry can never bill twice.
 * Shopify answers 202 as soon as it has the event; whether it billed shows
 * up in the Dev Dashboard's "App Billing Event" logs (e.g. NO_MATCHING_METER
 * when the plan has no meter yet).
 */
async function reportLabelUsage(shop, { returnId, quantity = 1, at = new Date() }) {
  const token = await appEventsAccessToken();
  const shopId = await shopGid(shop);
  const idempotencyKey = labelChargeKey(returnId);
  const res = await fetch(`${APP_EVENTS_BASE}/app/${APP_EVENTS_VERSION}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      shop_id: shopId,
      event_handle: LABEL_METER_HANDLE,
      timestamp: at.toISOString(),
      idempotency_key: idempotencyKey,
      attributes: { value: quantity },
    }),
  });
  if (res.status === 401) appEventsToken = null; // stale token: the retry gets a fresh one
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`App Events rejected the label usage event (${res.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`);
  }
  logger.info({ shop: shop.shopifyDomain, returnId, meter: LABEL_METER_HANDLE }, 'Label usage reported to Shopify');
  return { reported: true, meter: LABEL_METER_HANDLE, idempotencyKey, quantity };
}

/**
 * May a managed label be bought for this shop? Under Shopify App Pricing the
 * merchant agreed to the per-label price when they picked their plan, so
 * the only requirement is an active plan (Free included). Development
 * stores are always allowed and are never charged.
 *  - { allowed: true, devStore: true }         development store
 *  - { allowed: true, plan }                   a plan is active
 *  - { allowed: false, reason: 'no_active_plan' }        no plan chosen yet
 *  - { allowed: false, reason: 'billing_check_failed' }  Shopify could not be asked
 */
async function managedLabelBilling(shop) {
  try {
    const client = await graphqlClient(shop);
    // settings.treatAsRealStoreForBilling: a development store we use to
    // rehearse the path real merchants take (plan check + usage event).
    const rehearsingRealStore = shop.settings?.treatAsRealStoreForBilling === true;
    if (!rehearsingRealStore && await isDevelopmentStore(client)) {
      return { allowed: true, devStore: true, reason: null, plan: null };
    }
    const resp = await client.request('{ currentAppInstallation { activeSubscriptions { name status } } }');
    const active = (resp.data?.currentAppInstallation?.activeSubscriptions || []).find((s) => s.status === 'ACTIVE');
    if (!active) {
      return { allowed: false, devStore: false, reason: 'no_active_plan', plan: null };
    }
    return { allowed: true, devStore: false, reason: null, plan: active.name };
  } catch (err) {
    // Unsure means no: never spend on our own account when we can't confirm
    // the merchant has agreed to pay for labels.
    logger.warn({ shop: shop.shopifyDomain, err: err.message }, 'Managed-label billing check failed');
    return { allowed: false, devStore: false, reason: 'billing_check_failed', plan: null };
  }
}

/** Why a managed label cannot be bought, in words the merchant can act on. */
function labelBillingMessage(reason) {
  switch (reason) {
    case 'no_active_plan':
      return 'choose a plan on Shopify\'s plan page first (the Free plan is fine). Return labels are billed per label on your Shopify invoice.';
    case 'billing_check_failed':
      return 'we could not confirm your plan with Shopify just now. Try again in a minute.';
    default:
      return 'managed labels are not available for this store right now. Connect your own carrier in Settings, or try again later.';
  }
}

module.exports = {
  PLANS,
  TRIAL_DAYS,
  LABEL_FEE_GBP,
  USAGE_CAP_GBP,
  annualAmount,
  subscriptionName,
  planKeyFromName,
  usagePricingLineItem,
  graphqlClient,
  isDevelopmentStore,
  getActiveSubscription,
  cancelSubscription,
  applySubscriptionStatus,
  labelChargeKey,
  reportLabelUsage,
  managedLabelBilling,
  labelBillingMessage,
  pricingPlansUrl,
  shopGid,
  LABEL_METER_HANDLE,
};

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
  FREE:    { amount: 0,  name: 'Free',    returnsPerMonth: 30 },
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
  const entry = Object.entries(PLANS).find(([, p]) => p.name.toLowerCase() === cleaned)
    || Object.entries(PLANS).find(([, p]) => new RegExp(`^${p.name}([^a-z]|$)`, 'i').test(cleaned));
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

/**
 * Find the usage-pricing line-item id on the merchant's active subscription
 * (needed to attach per-label usage charges). Returns null if they're on a plan
 * without a usage component (e.g. FREE), so callers can skip silently.
 */
async function getUsageLineItemId(client) {
  const resp = await client.request(`
    {
      currentAppInstallation {
        activeSubscriptions {
          id status
          lineItems { id plan { pricingDetails { __typename } } }
        }
      }
    }
  `);
  const active = (resp.data?.currentAppInstallation?.activeSubscriptions || []).find((s) => s.status === 'ACTIVE');
  if (!active) return null;
  const usage = (active.lineItems || []).find((li) => li.plan?.pricingDetails?.__typename === 'AppUsagePricing');
  return usage?.id || null;
}

/**
 * Charge the merchant for one managed label via a Shopify usage record
 * (postage + service fee). Non-fatal: a billing hiccup must never fail label
 * generation, so this swallows errors and returns null.
 */
async function recordLabelCharge(shop, { amount, description }) {
  try {
    const client = await graphqlClient(shop);
    const lineItemId = await getUsageLineItemId(client);
    if (!lineItemId) {
      logger.info({ shop: shop.shopifyDomain }, 'No usage line item — skipping managed-label charge');
      return null;
    }
    const resp = await client.request(`
      mutation AppUsageRecordCreate($subscriptionLineItemId: ID!, $price: MoneyInput!, $description: String!) {
        appUsageRecordCreate(subscriptionLineItemId: $subscriptionLineItemId, price: $price, description: $description) {
          appUsageRecord { id }
          userErrors { field message }
        }
      }
    `, {
      variables: {
        subscriptionLineItemId: lineItemId,
        // The usage line item is GBP (managedLabelBilling refuses any other),
        // so charge in GBP, not the shop's store currency.
        price: { amount, currencyCode: 'GBP' },
        description: String(description).slice(0, 255),
      },
    });
    const errs = resp.data?.appUsageRecordCreate?.userErrors || [];
    if (errs.length > 0) {
      logger.warn({ shop: shop.shopifyDomain, errs }, 'Managed-label usage charge userErrors');
      return null;
    }
    return resp.data?.appUsageRecordCreate?.appUsageRecord?.id || null;
  } catch (err) {
    logger.warn({ shop: shop.shopifyDomain, err: err.message }, 'Managed-label usage charge failed (non-fatal)');
    return null;
  }
}

// Postage from the managed carrier account is priced in GBP (UK domestic
// returns), so a usage charge can only recover it on a GBP usage line item.
const LABEL_POSTAGE_CURRENCY = 'GBP';
// Headroom a merchant's usage cap must still have before a label is bought:
// the real postage is only known after purchase, so check for a typical label
// plus the service fee.
const LABEL_CHARGE_HEADROOM_GBP = Number(process.env.LABEL_CHARGE_HEADROOM_GBP || 5);

/**
 * Can a managed label be bought for this shop without ReturnFlow paying for it?
 *
 * A managed label is bought on ReturnFlow's own carrier account, so it may
 * only be bought when the cost can be charged back to the merchant: an active
 * subscription with a GBP usage line item that still has headroom under its
 * cap. Development stores (Shopify's reviewers, our own test store) can't be
 * charged real money, so they are allowed and never charged.
 *
 * Returns { allowed, devStore, reason, lineItemId }. reason is one of
 * 'no_usage_billing' | 'currency_mismatch' | 'usage_cap_reached' |
 * 'billing_check_failed' when allowed is false.
 */
async function managedLabelBilling(shop) {
  try {
    const client = await graphqlClient(shop);
    if (await isDevelopmentStore(client)) {
      return { allowed: true, devStore: true, reason: null, lineItemId: null };
    }

    const resp = await client.request(`
      {
        currentAppInstallation {
          activeSubscriptions {
            status
            lineItems {
              id
              plan {
                pricingDetails {
                  __typename
                  ... on AppUsagePricing {
                    cappedAmount { amount currencyCode }
                    balanceUsed { amount currencyCode }
                  }
                }
              }
            }
          }
        }
      }
    `);
    const active = (resp.data?.currentAppInstallation?.activeSubscriptions || []).find((s) => s.status === 'ACTIVE');
    const usage = (active?.lineItems || []).find((li) => li.plan?.pricingDetails?.__typename === 'AppUsagePricing');
    if (!usage) {
      return { allowed: false, devStore: false, reason: 'no_usage_billing', lineItemId: null };
    }

    const { cappedAmount, balanceUsed } = usage.plan.pricingDetails;
    if (cappedAmount?.currencyCode !== LABEL_POSTAGE_CURRENCY) {
      return { allowed: false, devStore: false, reason: 'currency_mismatch', lineItemId: usage.id };
    }
    const headroom = Number(cappedAmount.amount || 0) - Number(balanceUsed?.amount || 0);
    if (headroom < LABEL_CHARGE_HEADROOM_GBP) {
      return { allowed: false, devStore: false, reason: 'usage_cap_reached', lineItemId: usage.id };
    }
    return { allowed: true, devStore: false, reason: null, lineItemId: usage.id };
  } catch (err) {
    // Unsure means no: never spend on our own account when we can't confirm
    // the merchant can be charged.
    logger.warn({ shop: shop.shopifyDomain, err: err.message }, 'Managed-label billing check failed');
    return { allowed: false, devStore: false, reason: 'billing_check_failed', lineItemId: null };
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
  getUsageLineItemId,
  recordLabelCharge,
  managedLabelBilling,
};

const shopify = require('../config/shopify');
const prisma = require('../config/database');
const { decrypt } = require('../utils/encryption');
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

/** Subscription name we register on Shopify for a given plan + interval. */
function subscriptionName(planKey, interval = 'monthly') {
  return `${SUBSCRIPTION_PREFIX} ${PLANS[planKey].name}${interval === 'annual' ? ' (Annual)' : ''}`;
}

/**
 * Map a Shopify subscription name back to a plan key. Tolerant of casing, a
 * missing "ReturnFlow" prefix, and an "(Annual)" suffix.
 */
function planKeyFromName(name) {
  if (!name) return null;
  const cleaned = String(name)
    .replace(new RegExp(`^${SUBSCRIPTION_PREFIX}\\s*`, 'i'), '')
    .replace(/\s*\(annual\)\s*$/i, '')
    .trim()
    .toLowerCase();
  const entry = Object.entries(PLANS).find(([, p]) => p.name.toLowerCase() === cleaned);
  return entry ? entry[0] : null;
}

function graphqlClient(shop) {
  const accessToken = decrypt(shop.shopifyToken);
  return new shopify.clients.Graphql({ session: { shop: shop.shopifyDomain, accessToken } });
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

module.exports = {
  PLANS,
  TRIAL_DAYS,
  annualAmount,
  subscriptionName,
  planKeyFromName,
  graphqlClient,
  getActiveSubscription,
  cancelSubscription,
  applySubscriptionStatus,
};

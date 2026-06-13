const { Router } = require('express');
const { verifyShopifySession } = require('../../middleware/auth');
const shopify = require('../../config/shopify');
const prisma = require('../../config/database');
const { decrypt } = require('../../utils/encryption');
const logger = require('../../utils/logger');

const PLANS = {
  FREE:    { amount: 0,  name: 'Free',    returnsPerMonth: 30 },
  STARTER: { amount: 9,  name: 'Starter', returnsPerMonth: 150 },
  GROWTH:  { amount: 29, name: 'Growth',  returnsPerMonth: null },
  PRO:     { amount: 49, name: 'Pro',     returnsPerMonth: null },
};

const router = Router();
router.use(verifyShopifySession);

/**
 * GET /api/admin/billing/plans
 */
router.get('/plans', (req, res) => {
  res.json({
    currentPlan: req.shop.plan,
    plans: Object.entries(PLANS).map(([key, p]) => ({
      id: key,
      ...p,
    })),
  });
});

/**
 * POST /api/admin/billing/subscribe
 * Create an app subscription via Shopify Billing API. Returns confirmation URL.
 */
router.post('/subscribe', async (req, res) => {
  try {
    const { plan } = req.body;
    const planConfig = PLANS[plan];
    if (!planConfig || plan === 'FREE') {
      return res.status(400).json({ error: 'Invalid plan' });
    }

    const accessToken = decrypt(req.shop.shopifyToken);
    const session = { shop: req.shopDomain, accessToken };
    const client = new shopify.clients.Graphql({ session });

    const response = await client.request(`
      mutation AppSubscriptionCreate(
        $name: String!,
        $returnUrl: URL!,
        $lineItems: [AppSubscriptionLineItemInput!]!,
        $test: Boolean
      ) {
        appSubscriptionCreate(
          name: $name,
          returnUrl: $returnUrl,
          lineItems: $lineItems,
          test: $test
        ) {
          confirmationUrl
          appSubscription { id status }
          userErrors { field message }
        }
      }
    `, {
      variables: {
        name: `ReturnFlow ${planConfig.name}`,
        returnUrl: `${process.env.HOST}/?shop=${req.shopDomain}&billing=confirmed`,
        lineItems: [{
          plan: {
            appRecurringPricingDetails: {
              price: { amount: planConfig.amount, currencyCode: 'GBP' },
              interval: 'EVERY_30_DAYS',
            },
          },
        }],
        test: process.env.NODE_ENV !== 'production',
      },
    });

    const errors = response.data?.appSubscriptionCreate?.userErrors || [];
    if (errors.length > 0) {
      return res.status(400).json({ error: errors.map((e) => e.message).join(', ') });
    }

    res.json({
      confirmationUrl: response.data.appSubscriptionCreate.confirmationUrl,
      subscriptionId: response.data.appSubscriptionCreate.appSubscription?.id,
    });
  } catch (err) {
    logger.error({ err }, 'Billing subscribe error');
    res.status(500).json({ error: err.message || 'Failed to create subscription' });
  }
});

/**
 * POST /api/admin/billing/confirm
 * Called after Shopify billing confirmation redirect. Updates plan locally.
 */
router.post('/confirm', async (req, res) => {
  try {
    const { plan } = req.body;
    if (!PLANS[plan]) return res.status(400).json({ error: 'Invalid plan' });

    await prisma.shop.update({
      where: { id: req.shopId },
      data: {
        plan,
        billingCycleStart: new Date(),
        returnCount: 0,
      },
    });

    res.json({ ok: true, plan });
  } catch (err) {
    logger.error({ err }, 'Billing confirm error');
    res.status(500).json({ error: 'Failed to confirm plan' });
  }
});

module.exports = router;

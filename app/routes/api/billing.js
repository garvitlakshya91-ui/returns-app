const { Router } = require('express');
const { verifyShopifySession } = require('../../middleware/auth');
const BillingService = require('../../services/BillingService');
const prisma = require('../../config/database');
const logger = require('../../utils/logger');

const { PLANS } = BillingService;

const router = Router();
router.use(verifyShopifySession);

/**
 * GET /api/admin/billing/plans
 */
router.get('/plans', (req, res) => {
  res.json({
    currentPlan: req.shop.plan,
    trialDays: BillingService.TRIAL_DAYS,
    plans: Object.entries(PLANS).map(([key, p]) => ({
      id: key,
      ...p,
      annualAmount: BillingService.annualAmount(key),
    })),
  });
});

/**
 * POST /api/admin/billing/subscribe
 * For a paid plan: create an app subscription and return the confirmation URL.
 * For FREE: cancel any active subscription (self-serve downgrade) and drop the
 * merchant to the Free plan immediately — no support contact, no reinstall.
 */
router.post('/subscribe', async (req, res) => {
  try {
    const { plan, interval = 'monthly' } = req.body;
    if (!PLANS[plan]) {
      return res.status(400).json({ error: 'Invalid plan' });
    }
    const isAnnual = interval === 'annual';

    const client = BillingService.graphqlClient(req.shop);

    // ── Downgrade / cancel ──
    if (plan === 'FREE') {
      const active = await BillingService.getActiveSubscription(client);
      if (active) {
        await BillingService.cancelSubscription(client, active.id);
      }
      await prisma.shop.update({
        where: { id: req.shopId },
        data: { plan: 'FREE' },
      });
      return res.json({ ok: true, plan: 'FREE', cancelled: Boolean(active) });
    }

    // ── Upgrade / change paid plan ──
    const planConfig = PLANS[plan];
    const price = isAnnual ? BillingService.annualAmount(plan) : planConfig.amount;
    const billingInterval = isAnnual ? 'ANNUAL' : 'EVERY_30_DAYS';

    const response = await client.request(`
      mutation AppSubscriptionCreate(
        $name: String!,
        $returnUrl: URL!,
        $lineItems: [AppSubscriptionLineItemInput!]!,
        $trialDays: Int,
        $test: Boolean
      ) {
        appSubscriptionCreate(
          name: $name,
          returnUrl: $returnUrl,
          lineItems: $lineItems,
          trialDays: $trialDays,
          test: $test
        ) {
          confirmationUrl
          appSubscription { id status }
          userErrors { field message }
        }
      }
    `, {
      variables: {
        name: BillingService.subscriptionName(plan, interval),
        returnUrl: `${process.env.HOST}/?shop=${req.shopDomain}&billing=confirmed&plan=${plan}`,
        lineItems: [
          {
            plan: {
              appRecurringPricingDetails: {
                price: { amount: price, currencyCode: 'GBP' },
                interval: billingInterval,
              },
            },
          },
          // Usage component so managed return labels can be billed per-label.
          BillingService.usagePricingLineItem(),
        ],
        trialDays: BillingService.TRIAL_DAYS,
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
 * Called after the Shopify billing confirmation redirect. We DO NOT trust the
 * client-supplied plan — we re-query the Billing API and set the local plan to
 * whatever subscription Shopify reports as ACTIVE. If the merchant declined the
 * charge, there's no active subscription and they stay on FREE.
 */
router.post('/confirm', async (req, res) => {
  try {
    const client = BillingService.graphqlClient(req.shop);
    const active = await BillingService.getActiveSubscription(client);

    if (!active) {
      // Declined or not yet active — ensure we're on FREE and report it.
      await prisma.shop.update({ where: { id: req.shopId }, data: { plan: 'FREE' } });
      return res.json({ ok: true, plan: 'FREE', active: false });
    }

    const planKey = BillingService.planKeyFromName(active.name) || 'FREE';
    await prisma.shop.update({
      where: { id: req.shopId },
      data: { plan: planKey, billingCycleStart: new Date(), returnCount: 0 },
    });

    res.json({ ok: true, plan: planKey, active: true });
  } catch (err) {
    logger.error({ err }, 'Billing confirm error');
    res.status(500).json({ error: 'Failed to confirm plan' });
  }
});

module.exports = router;

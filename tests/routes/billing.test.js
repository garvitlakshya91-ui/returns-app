const request = require('supertest');
const express = require('express');
const { installPrismaMock, installShopifyMock, fakeShop } = require('../helpers');
const { encrypt } = require('../../app/utils/encryption');

let app;
let prisma;
let shopifyClient;

beforeEach(() => {
  jest.resetModules();
  prisma = installPrismaMock();
  shopifyClient = installShopifyMock();

  jest.doMock('../../app/middleware/auth', () => ({
    verifyShopifySession: (req, res, next) => {
      req.shopId = 'shop_test_1';
      req.shopDomain = 'test-shop.myshopify.com';
      req.shop = fakeShop({ id: 'shop_test_1', plan: 'GROWTH', shopifyToken: encrypt('shpat_x') });
      next();
    },
  }));

  app = express();
  app.use(express.json());
  app.use('/api/admin/billing', require('../../app/routes/api/billing'));
});

describe('GET /api/admin/billing/plans', () => {
  it('returns the current plan and the plan catalogue', async () => {
    const res = await request(app).get('/api/admin/billing/plans');
    expect(res.status).toBe(200);
    expect(res.body.currentPlan).toBe('GROWTH');
    expect(res.body.plans.map((p) => p.id)).toEqual(['FREE', 'STARTER', 'GROWTH']);
  });
});

describe('POST /api/admin/billing/subscribe — paid plan', () => {
  it('400 on an unknown plan', async () => {
    const res = await request(app).post('/api/admin/billing/subscribe').send({ plan: 'WAT' });
    expect(res.status).toBe(400);
  });

  it('returns the Shopify confirmation URL', async () => {
    shopifyClient.request.mockResolvedValue({
      data: {
        appSubscriptionCreate: {
          confirmationUrl: 'https://shop/confirm/123',
          appSubscription: { id: 'gid://shopify/AppSubscription/1', status: 'PENDING' },
          userErrors: [],
        },
      },
    });

    const res = await request(app).post('/api/admin/billing/subscribe').send({ plan: 'STARTER' });
    expect(res.status).toBe(200);
    expect(res.body.confirmationUrl).toBe('https://shop/confirm/123');

    // Monthly by default, with a free trial.
    const vars = shopifyClient.request.mock.calls[0][1].variables;
    expect(vars.trialDays).toBe(14);
    expect(vars.name).toBe('ReturnFlow Starter');
    expect(vars.lineItems[0].plan.appRecurringPricingDetails.interval).toBe('EVERY_30_DAYS');
    // Paid subs also carry a usage line item for managed-label billing.
    expect(vars.lineItems).toHaveLength(2);
    expect(vars.lineItems[1].plan.appUsagePricingDetails).toBeDefined();
  });

  it('supports annual billing (2 months free) with a trial', async () => {
    shopifyClient.request.mockResolvedValue({
      data: { appSubscriptionCreate: { confirmationUrl: 'https://shop/confirm/a', appSubscription: { id: '1', status: 'PENDING' }, userErrors: [] } },
    });

    await request(app).post('/api/admin/billing/subscribe').send({ plan: 'GROWTH', interval: 'annual' });

    const vars = shopifyClient.request.mock.calls[0][1].variables;
    expect(vars.name).toBe('ReturnFlow Growth (Annual)');
    expect(vars.trialDays).toBe(14);
    const pricing = vars.lineItems[0].plan.appRecurringPricingDetails;
    expect(pricing.interval).toBe('ANNUAL');
    expect(pricing.price.amount).toBe(290); // £29 × 10
  });
});

describe('POST /api/admin/billing/subscribe — downgrade to FREE', () => {
  it('cancels the active subscription and drops to FREE', async () => {
    shopifyClient.request
      .mockResolvedValueOnce({
        data: { currentAppInstallation: { activeSubscriptions: [{ id: 'sub_1', name: 'ReturnFlow Growth', status: 'ACTIVE' }] } },
      })
      .mockResolvedValueOnce({
        data: { appSubscriptionCancel: { appSubscription: { id: 'sub_1', status: 'CANCELLED' }, userErrors: [] } },
      });
    prisma.shop.update.mockResolvedValue({});

    const res = await request(app).post('/api/admin/billing/subscribe').send({ plan: 'FREE' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, plan: 'FREE', cancelled: true });
    expect(prisma.shop.update).toHaveBeenCalledWith({
      where: { id: 'shop_test_1' },
      data: { plan: 'FREE' },
    });
  });

  it('drops to FREE without an active subscription to cancel', async () => {
    shopifyClient.request.mockResolvedValueOnce({
      data: { currentAppInstallation: { activeSubscriptions: [] } },
    });
    prisma.shop.update.mockResolvedValue({});

    const res = await request(app).post('/api/admin/billing/subscribe').send({ plan: 'FREE' });
    expect(res.status).toBe(200);
    expect(res.body.cancelled).toBe(false);
  });
});

describe('POST /api/admin/billing/confirm', () => {
  it('upgrades to the plan Shopify reports as ACTIVE (ignores client-supplied plan)', async () => {
    shopifyClient.request.mockResolvedValue({
      data: { currentAppInstallation: { activeSubscriptions: [{ id: 'sub_1', name: 'ReturnFlow Starter', status: 'ACTIVE' }] } },
    });
    prisma.shop.update.mockResolvedValue({});

    // Client claims PRO, but Shopify says Starter — Starter must win.
    const res = await request(app).post('/api/admin/billing/confirm').send({ plan: 'PRO' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, plan: 'STARTER', active: true });
    expect(prisma.shop.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ plan: 'STARTER', returnCount: 0 }),
    }));
  });

  it('stays on FREE when the merchant declined the charge (no active subscription)', async () => {
    shopifyClient.request.mockResolvedValue({
      data: { currentAppInstallation: { activeSubscriptions: [] } },
    });
    prisma.shop.update.mockResolvedValue({});

    const res = await request(app).post('/api/admin/billing/confirm').send({ plan: 'GROWTH' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, plan: 'FREE', active: false });
  });
});

describe('BillingService.planKeyFromName', () => {
  it('maps subscription names back to plan keys', () => {
    // Required after beforeEach so config/shopify + config/database are mocked.
    const BillingService = require('../../app/services/BillingService');
    expect(BillingService.planKeyFromName('ReturnFlow Growth')).toBe('GROWTH');
    expect(BillingService.planKeyFromName('returnflow starter')).toBe('STARTER');
    expect(BillingService.planKeyFromName('Unknown thing')).toBeNull();
    expect(BillingService.planKeyFromName(null)).toBeNull();
  });
});

describe('BillingService.recordLabelCharge', () => {
  function shopObj() {
    return fakeShop({ shopifyToken: encrypt('shpat_x'), currency: 'GBP' });
  }

  it('records a usage charge against the subscription usage line item', async () => {
    const BillingService = require('../../app/services/BillingService');
    shopifyClient.request
      .mockResolvedValueOnce({
        data: { currentAppInstallation: { activeSubscriptions: [{
          id: 'sub_1', status: 'ACTIVE',
          lineItems: [
            { id: 'li_rec', plan: { pricingDetails: { __typename: 'AppRecurringPricing' } } },
            { id: 'li_usage', plan: { pricingDetails: { __typename: 'AppUsagePricing' } } },
          ],
        }] } },
      })
      .mockResolvedValueOnce({ data: { appUsageRecordCreate: { appUsageRecord: { id: 'usage_1' }, userErrors: [] } } });

    const id = await BillingService.recordLabelCharge(shopObj(), { amount: 4.7, description: 'Return label #1042' });
    expect(id).toBe('usage_1');
    const mutation = shopifyClient.request.mock.calls[1][1].variables;
    expect(mutation.subscriptionLineItemId).toBe('li_usage');
    expect(mutation.price).toEqual({ amount: 4.7, currencyCode: 'GBP' });
  });

  it('skips silently (null) when the plan has no usage line item', async () => {
    const BillingService = require('../../app/services/BillingService');
    shopifyClient.request.mockResolvedValueOnce({
      data: { currentAppInstallation: { activeSubscriptions: [{
        id: 'sub', status: 'ACTIVE',
        lineItems: [{ id: 'li_rec', plan: { pricingDetails: { __typename: 'AppRecurringPricing' } } }],
      }] } },
    });
    const id = await BillingService.recordLabelCharge(shopObj(), { amount: 4.7, description: 'x' });
    expect(id).toBeNull();
    expect(shopifyClient.request).toHaveBeenCalledTimes(1); // no mutation attempted
  });
});

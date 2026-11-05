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

describe('POST /api/admin/billing/subscribe — test vs real charges', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  afterEach(() => { process.env.NODE_ENV = originalNodeEnv; });

  const subscriptionOk = {
    data: {
      appSubscriptionCreate: {
        confirmationUrl: 'https://shop/confirm/t',
        appSubscription: { id: 'gid://shopify/AppSubscription/9', status: 'PENDING' },
        userErrors: [],
      },
    },
  };

  it('creates a TEST charge for development stores even in production (review store fix)', async () => {
    process.env.NODE_ENV = 'production';
    shopifyClient.request
      .mockResolvedValueOnce({ data: { shop: { plan: { partnerDevelopment: true } } } })
      .mockResolvedValueOnce(subscriptionOk);

    const res = await request(app).post('/api/admin/billing/subscribe').send({ plan: 'STARTER' });
    expect(res.status).toBe(200);
    const vars = shopifyClient.request.mock.calls[1][1].variables;
    expect(vars.test).toBe(true);
  });

  it('creates a REAL charge for regular stores in production', async () => {
    process.env.NODE_ENV = 'production';
    shopifyClient.request
      .mockResolvedValueOnce({ data: { shop: { plan: { partnerDevelopment: false } } } })
      .mockResolvedValueOnce(subscriptionOk);

    const res = await request(app).post('/api/admin/billing/subscribe').send({ plan: 'STARTER' });
    expect(res.status).toBe(200);
    const vars = shopifyClient.request.mock.calls[1][1].variables;
    expect(vars.test).toBe(false);
  });

  it('falls back to a real charge when the store-type lookup fails', async () => {
    process.env.NODE_ENV = 'production';
    shopifyClient.request
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(subscriptionOk);

    const res = await request(app).post('/api/admin/billing/subscribe').send({ plan: 'STARTER' });
    expect(res.status).toBe(200);
    const vars = shopifyClient.request.mock.calls[1][1].variables;
    expect(vars.test).toBe(false);
  });

  it('stays a test charge outside production without querying the store type', async () => {
    shopifyClient.request.mockResolvedValueOnce(subscriptionOk);

    const res = await request(app).post('/api/admin/billing/subscribe').send({ plan: 'STARTER' });
    expect(res.status).toBe(200);
    expect(shopifyClient.request).toHaveBeenCalledTimes(1);
    expect(shopifyClient.request.mock.calls[0][1].variables.test).toBe(true);
  });
});

describe('POST /api/admin/billing/subscribe — Shopify App Pricing (managed pricing)', () => {
  const managedPricingError = 'Managed Pricing Apps cannot use the Billing API (to create charges).';
  const hostedPlansUrl = 'https://admin.shopify.com/store/test-shop/charges/returns-app-garvit-20260613/pricing_plans';

  it('returns the hosted plans page when Shopify refuses via userErrors', async () => {
    shopifyClient.request.mockResolvedValueOnce({
      data: {
        appSubscriptionCreate: {
          confirmationUrl: null,
          appSubscription: null,
          userErrors: [{ field: null, message: managedPricingError }],
        },
      },
    });

    const res = await request(app).post('/api/admin/billing/subscribe').send({ plan: 'GROWTH' });
    expect(res.status).toBe(200);
    expect(res.body.redirectUrl).toBe(hostedPlansUrl);
  });

  it('returns the hosted plans page when Shopify refuses with a thrown error', async () => {
    shopifyClient.request.mockRejectedValueOnce(new Error(managedPricingError));

    const res = await request(app).post('/api/admin/billing/subscribe').send({ plan: 'GROWTH' });
    expect(res.status).toBe(200);
    expect(res.body.redirectUrl).toBe(hostedPlansUrl);
  });

  it('still 400s on unrelated userErrors', async () => {
    shopifyClient.request.mockResolvedValueOnce({
      data: {
        appSubscriptionCreate: {
          confirmationUrl: null,
          appSubscription: null,
          userErrors: [{ field: 'price', message: 'Price must be positive' }],
        },
      },
    });

    const res = await request(app).post('/api/admin/billing/subscribe').send({ plan: 'GROWTH' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Price must be positive');
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
    // Managed-pricing plan names may carry trailing text after the plan word.
    expect(BillingService.planKeyFromName('Starter — £9/month')).toBe('STARTER');
    expect(BillingService.planKeyFromName('Growth ($29/mo)')).toBe('GROWTH');
    // The App Pricing free plan is invoiced as "Preview" (its fixed plan name),
    // so a downgrade webhook must land on FREE rather than keep the old plan.
    expect(BillingService.planKeyFromName('Preview')).toBe('FREE');
    expect(BillingService.planKeyFromName('ReturnFlow Preview')).toBe('FREE');
    expect(BillingService.planKeyFromName('Unknown thing')).toBeNull();
    expect(BillingService.planKeyFromName(null)).toBeNull();
  });
});

describe('BillingService.reportLabelUsage — one billable event per label (App Events API)', () => {
  const shopObj = (settings = { shopifyShopId: 'gid://shopify/Shop/42' }) => fakeShop({ shopifyToken: encrypt('shpat_x'), settings });
  const authOk = { ok: true, status: 200, json: async () => ({ access_token: 'tok_1', expires_in: 3600 }) };
  const accepted = { ok: true, status: 202, json: async () => ({ success: true }), text: async () => '' };
  beforeEach(() => {
    process.env.SHOPIFY_API_KEY = 'key_1';
    process.env.SHOPIFY_API_SECRET = 'secret_1';
    global.fetch = jest.fn();
  });
  afterEach(() => { delete global.fetch; });

  it('gets a client-credentials token, then posts the event with the stable idempotency key', async () => {
    const BillingService = require('../../app/services/BillingService');
    global.fetch.mockResolvedValueOnce(authOk).mockResolvedValueOnce(accepted);

    const out = await BillingService.reportLabelUsage(shopObj(), { returnId: 'ret_1', at: new Date('2026-11-04T16:42:00Z') });

    expect(global.fetch.mock.calls[0][0]).toBe('https://api.shopify.com/auth/access_token');
    expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toEqual({ client_id: 'key_1', client_secret: 'secret_1', grant_type: 'client_credentials' });
    expect(global.fetch.mock.calls[1][0]).toBe('https://api.shopify.com/app/2026-10/events');
    expect(global.fetch.mock.calls[1][1].headers.Authorization).toBe('Bearer tok_1');
    expect(JSON.parse(global.fetch.mock.calls[1][1].body)).toEqual({
      shop_id: 'gid://shopify/Shop/42',
      event_handle: 'return_label',
      timestamp: '2026-11-04T16:42:00.000Z',
      idempotency_key: 'returnflow:label-charge:ret_1',
      attributes: { value: 1 },
    });
    expect(out).toEqual({ reported: true, meter: 'return_label', idempotencyKey: 'returnflow:label-charge:ret_1', quantity: 1 });
    expect(shopifyClient.request).not.toHaveBeenCalled(); // shop id was cached
  });

  it('looks the shop id up once and keeps it in the shop settings', async () => {
    const BillingService = require('../../app/services/BillingService');
    shopifyClient.request.mockResolvedValueOnce({ data: { shop: { id: 'gid://shopify/Shop/7' } } });
    prisma.shop.update.mockResolvedValue({});
    global.fetch.mockResolvedValueOnce(authOk).mockResolvedValueOnce(accepted);

    await BillingService.reportLabelUsage(shopObj({ warehouseLine1: 'x' }), { returnId: 'ret_2' });

    expect(JSON.parse(global.fetch.mock.calls[1][1].body).shop_id).toBe('gid://shopify/Shop/7');
    expect(prisma.shop.update).toHaveBeenCalledWith({ where: { id: 'shop_test_1' }, data: { settings: { warehouseLine1: 'x', shopifyShopId: 'gid://shopify/Shop/7' } } });
  });

  it('reuses the token for later events', async () => {
    const BillingService = require('../../app/services/BillingService');
    global.fetch.mockResolvedValueOnce(authOk).mockResolvedValueOnce(accepted).mockResolvedValueOnce(accepted);
    await BillingService.reportLabelUsage(shopObj(), { returnId: 'ret_a' });
    await BillingService.reportLabelUsage(shopObj(), { returnId: 'ret_b' });
    expect(global.fetch).toHaveBeenCalledTimes(3);
    expect(JSON.parse(global.fetch.mock.calls[2][1].body).idempotency_key).toBe('returnflow:label-charge:ret_b');
  });

  it('throws when Shopify does not accept the event, so the ledger records it and the retry job tries again', async () => {
    const BillingService = require('../../app/services/BillingService');
    global.fetch.mockResolvedValueOnce(authOk).mockResolvedValueOnce({ ok: false, status: 422, text: async () => 'bad request' });
    await expect(BillingService.reportLabelUsage(shopObj(), { returnId: 'ret_1' })).rejects.toThrow(/422.*bad request/);
  });

  it('the idempotency key fits Shopify\'s 64-character limit for any return id', () => {
    const BillingService = require('../../app/services/BillingService');
    expect(BillingService.labelChargeKey('cmvdx312b0001mn01url2zu29').length).toBeLessThanOrEqual(64);
  });
});

describe('BillingService.managedLabelBilling — under Shopify App Pricing', () => {
  const shop = () => fakeShop({ shopifyToken: encrypt('shpat_x') });
  const devStore = (dev) => ({ data: { shop: { plan: { partnerDevelopment: dev } } } });
  const subs = (list) => ({ data: { currentAppInstallation: { activeSubscriptions: list } } });

  it('allows a development store (its plan is $0, so labels cost it nothing)', async () => {
    const BillingService = require('../../app/services/BillingService');
    shopifyClient.request.mockResolvedValueOnce(devStore(true));
    expect(await BillingService.managedLabelBilling(shop())).toEqual({ allowed: true, devStore: true, reason: null, plan: null });
    expect(shopifyClient.request).toHaveBeenCalledTimes(1);
  });

  it('allows a real store with any active plan, Free included: the per-label price is on the plan', async () => {
    const BillingService = require('../../app/services/BillingService');
    shopifyClient.request.mockResolvedValueOnce(devStore(false)).mockResolvedValueOnce(subs([{ name: 'Free', status: 'ACTIVE' }]));
    expect(await BillingService.managedLabelBilling(shop())).toEqual({ allowed: true, devStore: false, reason: null, plan: 'Free' });
  });

  it('refuses a real store that has not chosen a plan yet, and says how to fix it', async () => {
    const BillingService = require('../../app/services/BillingService');
    shopifyClient.request.mockResolvedValueOnce(devStore(false)).mockResolvedValueOnce(subs([{ name: 'Growth', status: 'CANCELLED' }]));
    expect(await BillingService.managedLabelBilling(shop())).toMatchObject({ allowed: false, reason: 'no_active_plan' });
    expect(BillingService.labelBillingMessage('no_active_plan')).toMatch(/choose a plan/i);
    expect(BillingService.pricingPlansUrl('acme.myshopify.com')).toBe('https://admin.shopify.com/store/acme/charges/returns-app-garvit-20260613/pricing_plans');
  });

  it('a development store marked treatAsRealStoreForBilling takes the real-merchant path (for rehearsals)', async () => {
    const BillingService = require('../../app/services/BillingService');
    shopifyClient.request.mockResolvedValueOnce(subs([{ name: 'Growth', status: 'ACTIVE' }]));
    const rehearsal = fakeShop({ shopifyToken: encrypt('shpat_x'), settings: { treatAsRealStoreForBilling: true } });
    expect(await BillingService.managedLabelBilling(rehearsal)).toEqual({ allowed: true, devStore: false, reason: null, plan: 'Growth' });
    expect(shopifyClient.request).toHaveBeenCalledTimes(1); // the dev-store question is skipped
  });

  it('refuses when the check itself fails (never spend when unsure)', async () => {
    const BillingService = require('../../app/services/BillingService');
    shopifyClient.request.mockResolvedValueOnce(devStore(false)).mockRejectedValueOnce(new Error('Shopify down'));
    expect(await BillingService.managedLabelBilling(shop())).toMatchObject({ allowed: false, reason: 'billing_check_failed' });
    expect(BillingService.labelBillingMessage('billing_check_failed')).toMatch(/try again/i);
  });
});
describe("POST /api/admin/billing/subscribe — App Pricing refusal wordings", () => {
  it.each([
    'Managed Pricing Apps cannot use the Billing API (to create charges).',
    'Cannot use the Billing API (to create charges) when on Shopify App Pricing.',
  ])('hands back the hosted plans page when Shopify says "%s"', async (message) => {
    shopifyClient.request.mockResolvedValueOnce({
      data: { appSubscriptionCreate: { confirmationUrl: null, appSubscription: null, userErrors: [{ field: null, message }] } },
    });

    const res = await request(app).post('/api/admin/billing/subscribe').send({ plan: 'GROWTH' });
    expect(res.status).toBe(200);
    expect(res.body.redirectUrl).toBe(
      'https://admin.shopify.com/store/test-shop/charges/returns-app-garvit-20260613/pricing_plans',
    );
  });

  it('also catches the refusal when it surfaces as a thrown error', async () => {
    shopifyClient.request.mockRejectedValueOnce(new Error('GraphQL: Cannot use the Billing API when on Shopify App Pricing'));
    const res = await request(app).post('/api/admin/billing/subscribe').send({ plan: 'STARTER' });
    expect(res.status).toBe(200);
    expect(res.body.redirectUrl).toContain('/pricing_plans');
  });
});

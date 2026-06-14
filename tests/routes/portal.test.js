const request = require('supertest');
const express = require('express');
const { installPrismaMock, installShopifyMock, installStripeMock, fakeShop } = require('../helpers');
const { encrypt } = require('../../app/utils/encryption');

let app;
let prisma;
let shopifyClient;
let stripe;

beforeEach(() => {
  jest.resetModules();

  // Rate limiters must no-op in tests
  jest.doMock('../../app/middleware/rateLimiter', () => ({
    portalLimiter: (req, res, next) => next(),
    lookupLimiter: (req, res, next) => next(),
    createReturnLimiter: (req, res, next) => next(),
    adminLimiter: (req, res, next) => next(),
  }));

  prisma = installPrismaMock();
  shopifyClient = installShopifyMock();
  stripe = installStripeMock();

  // Stub PolicyEngine.evaluateEligibility to always allow — focuses these
  // tests on the route layer, not policy logic (covered separately).
  jest.doMock('../../app/services/PolicyEngine', () => ({
    evaluateEligibility: jest.fn().mockResolvedValue({ eligible: true, policy: {}, resolutions: {}, fees: null }),
  }));

  // Stub ReturnService.createReturn so tests don't have to mock the
  // shop.update / event emit chain that's already covered in unit tests.
  jest.doMock('../../app/services/ReturnService', () => ({
    createReturn: jest.fn().mockImplementation(async (args) => ({
      id: 'ret_new', returnFee: 0, ...args,
    })),
  }));

  app = express();
  app.use(express.json());
  app.use('/api/portal', require('../../app/routes/api/portal'));
});

describe('POST /api/portal/lookup', () => {
  it('400 when required fields are missing', async () => {
    const res = await request(app).post('/api/portal/lookup').send({ email: 'x@y.com' });
    expect(res.status).toBe(400);
  });

  it('404 when shop not found by slug', async () => {
    prisma.shop.findFirst.mockResolvedValue(null);
    const res = await request(app)
      .post('/api/portal/lookup')
      .send({ email: 'x@y.com', orderNumber: '#1', shopSlug: 'unknown' });
    expect(res.status).toBe(404);
  });

  it('404 when GraphQL returns no order', async () => {
    prisma.shop.findFirst.mockResolvedValue(fakeShop({
      shopifyToken: encrypt('shpat_x'),
      policies: [],
    }));
    shopifyClient.request.mockResolvedValue({ data: { orders: { edges: [] } } });
    const res = await request(app)
      .post('/api/portal/lookup')
      .send({ email: 'x@y.com', orderNumber: '#1', shopSlug: 'shop1' });
    expect(res.status).toBe(404);
  });

  it('404 when order email does not match request email', async () => {
    prisma.shop.findFirst.mockResolvedValue(fakeShop({
      shopifyToken: encrypt('shpat_x'),
      policies: [],
    }));
    shopifyClient.request.mockResolvedValue({
      data: { orders: { edges: [{ node: { id: 'o1', name: '#1', email: 'other@x.com', createdAt: '2026-01-01', displayFulfillmentStatus: 'FULFILLED', fulfillments: [{ createdAt: '2026-01-02' }], lineItems: { edges: [] } } }] } },
    });
    const res = await request(app)
      .post('/api/portal/lookup')
      .send({ email: 'jane@x.com', orderNumber: '#1', shopSlug: 'shop1' });
    expect(res.status).toBe(404);
  });

  it('200 returns eligible items when policy allows', async () => {
    prisma.shop.findFirst.mockResolvedValue(fakeShop({
      shopifyToken: encrypt('shpat_x'),
      policies: [{ isActive: true }],
    }));
    shopifyClient.request.mockResolvedValue({
      data: {
        orders: {
          edges: [{
            node: {
              id: 'o1', name: '#1001', email: 'jane@x.com',
              createdAt: '2026-01-01', displayFulfillmentStatus: 'FULFILLED',
              fulfillments: [{ createdAt: '2026-01-02' }],
              lineItems: {
                edges: [{
                  node: {
                    id: 'li1', title: 'Tee', variantTitle: 'M / Navy',
                    quantity: 1, sku: 'TEE-M-NAV',
                    originalUnitPriceSet: { shopMoney: { amount: '20.00' } },
                    image: { url: 'https://cdn/x.jpg' },
                    product: { id: 'p1' }, variant: { id: 'v1' },
                  },
                }],
              },
            },
          }],
        },
      },
    });

    const res = await request(app)
      .post('/api/portal/lookup')
      .send({ email: 'jane@x.com', orderNumber: '#1001', shopSlug: 'shop1' });

    expect(res.status).toBe(200);
    expect(res.body.eligibleItems).toHaveLength(1);
    expect(res.body.eligibleItems[0]).toMatchObject({ title: 'Tee', price: 20, sku: 'TEE-M-NAV' });
  });
});

describe('POST /api/portal/returns', () => {
  it('400 when shopId is missing (loadShopFromBody)', async () => {
    const res = await request(app).post('/api/portal/returns').send({ items: [{}], resolution: 'REFUND' });
    expect(res.status).toBe(400);
  });

  it('404 when shop not found', async () => {
    prisma.shop.findUnique.mockResolvedValue(null);
    const res = await request(app)
      .post('/api/portal/returns')
      .send({ shopId: 'missing', items: [{}], resolution: 'REFUND' });
    expect(res.status).toBe(404);
  });

  it('403 when shop has hit the monthly limit', async () => {
    prisma.shop.findUnique.mockResolvedValue(fakeShop({ plan: 'FREE', returnCount: 30 }));
    const res = await request(app)
      .post('/api/portal/returns')
      .send({ shopId: 'shop_test_1', items: [{ quantity: 1, unitPrice: 10 }], resolution: 'REFUND' });
    expect(res.status).toBe(403);
    expect(res.body.upgradeRequired).toBe(true);
  });

  it('403 when plan disallows exchanges', async () => {
    prisma.shop.findUnique.mockResolvedValue(fakeShop({ plan: 'FREE', returnCount: 0 }));
    const res = await request(app)
      .post('/api/portal/returns')
      .send({ shopId: 'shop_test_1', items: [{ quantity: 1 }], resolution: 'EXCHANGE' });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Starter/);
  });

  it('400 when items or resolution missing', async () => {
    prisma.shop.findUnique.mockResolvedValue(fakeShop({ plan: 'GROWTH' }));
    const res = await request(app)
      .post('/api/portal/returns')
      .send({ shopId: 'shop_test_1' });
    expect(res.status).toBe(400);
  });

  it('201 creates return on the happy path', async () => {
    prisma.shop.findUnique.mockResolvedValue(fakeShop({ plan: 'GROWTH' }));
    const res = await request(app)
      .post('/api/portal/returns')
      .send({
        shopId: 'shop_test_1',
        items: [{ lineItemId: 'li1', productTitle: 'Tee', quantity: 1, unitPrice: 20, reason: 'doesnt_fit' }],
        resolution: 'REFUND',
        customerEmail: 'jane@x.com',
      });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe('ret_new');
  });
});

describe('POST /api/portal/returns/:id/pay', () => {
  it('404 when return not found', async () => {
    prisma.return.findUnique.mockResolvedValue(null);
    const res = await request(app).post('/api/portal/returns/x/pay');
    expect(res.status).toBe(404);
  });

  it('409 when return not in REQUESTED status', async () => {
    prisma.return.findUnique.mockResolvedValue({ id: 'r', status: 'APPROVED', returnFee: 5 });
    const res = await request(app).post('/api/portal/returns/r/pay');
    expect(res.status).toBe(409);
  });

  it('400 when return has no fee', async () => {
    prisma.return.findUnique.mockResolvedValue({ id: 'r', status: 'REQUESTED', returnFee: 0 });
    const res = await request(app).post('/api/portal/returns/r/pay');
    expect(res.status).toBe(400);
  });

  it('200 returns Stripe Checkout URL and logs an event', async () => {
    prisma.return.findUnique.mockResolvedValue({
      id: 'r', shopId: 's', status: 'REQUESTED',
      returnFee: 2.5, shopifyOrderName: '#1001', customerEmail: 'j@x.com', currency: 'GBP',
    });
    prisma.returnEvent.create.mockResolvedValue({});
    stripe.checkout.sessions.create.mockResolvedValue({
      id: 'cs_test', url: 'https://stripe/checkout/cs_test',
    });

    const res = await request(app).post('/api/portal/returns/r/pay');
    expect(res.status).toBe(200);
    expect(res.body.url).toBe('https://stripe/checkout/cs_test');
    expect(prisma.returnEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ type: 'stripe.checkout_created' }),
    }));
  });
});

describe('GET /api/portal/returns/:id', () => {
  it('404 when return not found', async () => {
    prisma.return.findUnique.mockResolvedValue(null);
    const res = await request(app).get('/api/portal/returns/missing');
    expect(res.status).toBe(404);
  });

  it('404 when email query does not match the return', async () => {
    prisma.return.findUnique.mockResolvedValue({
      id: 'r', customerEmail: 'a@x.com', items: [], events: [],
    });
    const res = await request(app).get('/api/portal/returns/r?email=b@x.com');
    expect(res.status).toBe(404);
  });

  it('200 when email matches (case-insensitive)', async () => {
    prisma.return.findUnique.mockResolvedValue({
      id: 'r', status: 'REQUESTED', resolution: 'REFUND',
      totalValue: 20, refundAmount: null,
      customerEmail: 'Jane@X.Com',
      items: [], events: [], label: null, createdAt: new Date(),
    });
    const res = await request(app).get('/api/portal/returns/r?email=jane@x.com');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('r');
  });
});

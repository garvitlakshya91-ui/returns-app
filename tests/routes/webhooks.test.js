const request = require('supertest');
const express = require('express');
const crypto = require('crypto');
const { installPrismaMock, fakeShop } = require('../helpers');

let app;
let prisma;

function rawBodyMiddleware(req, res, next) {
  let data = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => { data += chunk; });
  req.on('end', () => {
    req.rawBody = data;
    try { req.body = JSON.parse(data); } catch { req.body = {}; }
    next();
  });
}

function shopifyHmac(body) {
  return crypto.createHmac('sha256', process.env.SHOPIFY_API_SECRET).update(body, 'utf8').digest('base64');
}

beforeEach(() => {
  jest.resetModules();
  prisma = installPrismaMock();

  jest.doMock('../../app/services/StorageService', () => ({
    deleteAllForShop: jest.fn().mockResolvedValue(0),
  }));

  app = express();
  app.use('/webhooks', rawBodyMiddleware);
  app.use('/webhooks', require('../../app/routes/webhooks'));
});

describe('Shopify webhook HMAC verification', () => {
  it('401 when x-shopify-hmac-sha256 header is missing', async () => {
    const body = JSON.stringify({ id: 1 });
    const res = await request(app)
      .post('/webhooks/orders/create')
      .set('content-type', 'application/json')
      .send(body);
    expect(res.status).toBe(401);
  });

  it('401 when HMAC is incorrect', async () => {
    const body = JSON.stringify({ id: 1 });
    const wrong = crypto.createHmac('sha256', 'wrong_secret').update(body, 'utf8').digest('base64');
    const res = await request(app)
      .post('/webhooks/orders/create')
      .set('content-type', 'application/json')
      .set('x-shopify-hmac-sha256', wrong)
      .send(body);
    expect(res.status).toBe(401);
  });

  it('200 with valid HMAC for orders/create', async () => {
    const body = JSON.stringify({ id: 1042, name: '#1042' });
    const res = await request(app)
      .post('/webhooks/orders/create')
      .set('content-type', 'application/json')
      .set('x-shopify-hmac-sha256', shopifyHmac(body))
      .set('x-shopify-shop-domain', 'test-shop.myshopify.com')
      .send(body);
    expect(res.status).toBe(200);
  });
});

describe('orders/fulfilled stores fulfillment date in shop settings', () => {
  it('updates shop settings with fulfillment timestamp', async () => {
    prisma.shop.findUnique.mockResolvedValue(fakeShop({ settings: {} }));
    prisma.shop.update.mockResolvedValue({});

    const body = JSON.stringify({
      id: 1042, name: '#1042',
      fulfillments: [{ created_at: '2026-01-15T10:00:00Z' }],
    });
    await request(app)
      .post('/webhooks/orders/fulfilled')
      .set('x-shopify-hmac-sha256', shopifyHmac(body))
      .set('x-shopify-shop-domain', 'test-shop.myshopify.com')
      .set('content-type', 'application/json')
      .send(body);

    // Webhook is fire-and-forget; give the async path a tick
    await new Promise((r) => setImmediate(r));

    expect(prisma.shop.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        settings: expect.objectContaining({
          fulfillments: expect.objectContaining({ 1042: '2026-01-15T10:00:00Z' }),
        }),
      }),
    }));
  });
});

describe('app/uninstalled wipes the token', () => {
  it('clears the encrypted token and stamps uninstalledAt', async () => {
    prisma.shop.findUnique.mockResolvedValue(fakeShop({ id: 'shop_1' }));
    prisma.shop.update.mockResolvedValue({});

    const body = JSON.stringify({});
    await request(app)
      .post('/webhooks/app/uninstalled')
      .set('x-shopify-hmac-sha256', shopifyHmac(body))
      .set('x-shopify-shop-domain', 'test-shop.myshopify.com')
      .set('content-type', 'application/json')
      .send(body);

    await new Promise((r) => setImmediate(r));
    expect(prisma.shop.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'shop_1' },
      data: expect.objectContaining({ shopifyToken: '' }),
    }));
  });
});

describe('app_subscriptions/update syncs the plan', () => {
  it('downgrades to FREE when a subscription is cancelled', async () => {
    prisma.shop.findUnique.mockResolvedValue(fakeShop({ id: 'shop_1', plan: 'GROWTH' }));
    prisma.shop.update.mockResolvedValue({});

    const body = JSON.stringify({ app_subscription: { name: 'ReturnFlow Growth', status: 'CANCELLED' } });
    await request(app)
      .post('/webhooks/app_subscriptions/update')
      .set('x-shopify-hmac-sha256', shopifyHmac(body))
      .set('x-shopify-shop-domain', 'test-shop.myshopify.com')
      .set('content-type', 'application/json')
      .send(body);

    await new Promise((r) => setImmediate(r));
    expect(prisma.shop.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ plan: 'FREE' }),
    }));
  });

  it('upgrades to the active plan and resets the cycle', async () => {
    prisma.shop.findUnique.mockResolvedValue(fakeShop({ id: 'shop_1', plan: 'FREE' }));
    prisma.shop.update.mockResolvedValue({});

    const body = JSON.stringify({ app_subscription: { name: 'ReturnFlow Starter', status: 'ACTIVE' } });
    await request(app)
      .post('/webhooks/app_subscriptions/update')
      .set('x-shopify-hmac-sha256', shopifyHmac(body))
      .set('x-shopify-shop-domain', 'test-shop.myshopify.com')
      .set('content-type', 'application/json')
      .send(body);

    await new Promise((r) => setImmediate(r));
    expect(prisma.shop.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ plan: 'STARTER', returnCount: 0 }),
    }));
  });
});

describe('GDPR webhooks', () => {
  it('customers/redact anonymizes returns and clears photos', async () => {
    prisma.shop.findUnique.mockResolvedValue(fakeShop({ id: 'shop_1' }));
    prisma.return.findMany.mockResolvedValue([{ id: 'r1' }, { id: 'r2' }]);
    prisma.return.updateMany.mockResolvedValue({ count: 2 });
    const Storage = require('../../app/services/StorageService');

    const body = JSON.stringify({
      shop_domain: 'test-shop.myshopify.com',
      customer: { email: 'jane@x.com' },
    });
    await request(app)
      .post('/webhooks/customers/redact')
      .set('x-shopify-hmac-sha256', shopifyHmac(body))
      .set('content-type', 'application/json')
      .send(body);

    await new Promise((r) => setImmediate(r));
    expect(Storage.deleteAllForShop).toHaveBeenCalledWith(['r1', 'r2']);
    expect(prisma.return.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ customerName: 'Redacted' }),
    }));
  });

  it('shop/redact deletes the shop (cascading)', async () => {
    prisma.shop.findUnique.mockResolvedValue({ id: 'shop_1', returns: [{ id: 'r1' }] });
    prisma.shop.delete.mockResolvedValue({});

    const body = JSON.stringify({ shop_domain: 'test-shop.myshopify.com' });
    await request(app)
      .post('/webhooks/shop/redact')
      .set('x-shopify-hmac-sha256', shopifyHmac(body))
      .set('content-type', 'application/json')
      .send(body);

    await new Promise((r) => setImmediate(r));
    expect(prisma.shop.delete).toHaveBeenCalledWith({ where: { id: 'shop_1' } });
  });
});

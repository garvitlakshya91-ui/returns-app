// Additional coverage for app/routes/webhooks.js — HMAC edge cases, malformed
// bodies, shop/update sync, order handlers, subscription plan reconciliation,
// idempotency via Redis, and the GDPR compliance topics.
const request = require('supertest');
const express = require('express');
const crypto = require('crypto');
const { installPrismaMock, fakeShop } = require('../helpers');

let app;
let prisma;
let logger;
let Storage;
let fakeRedis;
let eventBus;

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

const tick = () => new Promise((r) => setImmediate(r));

/** Minimal in-memory Redis double implementing SET key value EX ttl NX. */
function makeFakeRedis() {
  const store = new Map();
  return {
    store,
    set: jest.fn(async (key, value, ...args) => {
      const nx = args.includes('NX');
      if (nx && store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    }),
  };
}

function post(path, body, { hmac = shopifyHmac(body), shop = 'test-shop.myshopify.com', webhookId } = {}) {
  let req = request(app)
    .post(`/webhooks${path}`)
    .set('content-type', 'application/json')
    .set('x-shopify-shop-domain', shop);
  if (hmac !== null) req = req.set('x-shopify-hmac-sha256', hmac);
  if (webhookId) req = req.set('x-shopify-webhook-id', webhookId);
  return req.send(body);
}

beforeEach(() => {
  jest.resetModules();
  prisma = installPrismaMock();

  fakeRedis = null;
  jest.doMock('../../app/config/redis', () => ({
    getRedis: () => fakeRedis, // null by default → no dedup (dev fallback)
  }));

  jest.doMock('../../app/utils/logger', () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
  }));
  logger = require('../../app/utils/logger');

  jest.doMock('../../app/services/StorageService', () => ({
    deleteAllForShop: jest.fn().mockResolvedValue(0),
  }));
  Storage = require('../../app/services/StorageService');
  eventBus = require('../../app/events/eventBus');

  app = express();
  app.use('/webhooks', rawBodyMiddleware);
  app.use('/webhooks', require('../../app/routes/webhooks'));
});

afterEach(() => {
  eventBus.removeAllListeners();
});

describe('HMAC verification (applies to every topic)', () => {
  const topics = [
    '/orders/create', '/orders/fulfilled', '/app/uninstalled', '/shop/update',
    '/app_subscriptions/update', '/customers/data_request', '/customers/redact', '/shop/redact',
  ];

  it.each(topics)('%s → 401 when the HMAC header is missing and nothing is processed', async (topic) => {
    prisma.shop.findUnique.mockResolvedValue(fakeShop());
    const body = JSON.stringify({ shop_domain: 'test-shop.myshopify.com', customer: { email: 'a@b.c' } });
    const res = await post(topic, body, { hmac: null });
    await tick();
    expect(res.status).toBe(401);
    expect(res.text).toMatch(/Missing HMAC/);
    expect(prisma.shop.findUnique).not.toHaveBeenCalled();
    expect(prisma.shop.update).not.toHaveBeenCalled();
    expect(prisma.shop.updateMany).not.toHaveBeenCalled();
    expect(prisma.shop.delete).not.toHaveBeenCalled();
    expect(prisma.return.updateMany).not.toHaveBeenCalled();
  });

  it.each(topics)('%s → 401 when the HMAC is signed with the wrong secret', async (topic) => {
    prisma.shop.findUnique.mockResolvedValue(fakeShop());
    const body = JSON.stringify({ shop_domain: 'test-shop.myshopify.com' });
    const wrong = crypto.createHmac('sha256', 'not_the_secret').update(body, 'utf8').digest('base64');
    const res = await post(topic, body, { hmac: wrong });
    await tick();
    expect(res.status).toBe(401);
    expect(res.text).toMatch(/Invalid HMAC/);
    expect(prisma.shop.findUnique).not.toHaveBeenCalled();
    expect(prisma.shop.updateMany).not.toHaveBeenCalled();
    expect(prisma.shop.delete).not.toHaveBeenCalled();
  });

  it('401 "HMAC verification failed" when the header is not a valid digest length (timingSafeEqual throws)', async () => {
    const body = JSON.stringify({ id: 1 });
    const res = await post('/orders/create', body, { hmac: 'short' });
    expect(res.status).toBe(401);
    expect(res.text).toMatch(/HMAC verification failed/);
    // crypto's RangeError comes from Node's realm, so match on message rather than instanceof
    expect(logger.error).toHaveBeenCalledWith(
      { err: expect.objectContaining({ message: expect.stringMatching(/same byte length/) }) },
      'HMAC verification error',
    );
  });

  it('401 when the body was tampered with after signing', async () => {
    const signed = JSON.stringify({ app_subscription: { name: 'Growth', status: 'ACTIVE' } });
    const tampered = JSON.stringify({ app_subscription: { name: 'Growth', status: 'CANCELLED' } });
    prisma.shop.findUnique.mockResolvedValue(fakeShop());
    const res = await post('/app_subscriptions/update', tampered, { hmac: shopifyHmac(signed) });
    await tick();
    expect(res.status).toBe(401);
    expect(prisma.shop.update).not.toHaveBeenCalled();
  });

  it('a bad HMAC is rejected before the idempotency claim is attempted', async () => {
    fakeRedis = makeFakeRedis();
    const body = JSON.stringify({ id: 1 });
    const res = await post('/orders/create', body, { hmac: 'short', webhookId: 'wh-1' });
    expect(res.status).toBe(401);
    expect(fakeRedis.set).not.toHaveBeenCalled();
  });
});

describe('Idempotency via X-Shopify-Webhook-Id', () => {
  it('processes the first delivery and skips an identical redelivery with 200', async () => {
    fakeRedis = makeFakeRedis();
    prisma.shop.findUnique.mockResolvedValue(fakeShop({ id: 'shop_1' }));
    prisma.shop.update.mockResolvedValue({});

    const body = JSON.stringify({ id: 77, name: '#77', fulfillments: [{ created_at: '2026-02-01T00:00:00Z' }] });
    const first = await post('/orders/fulfilled', body, { webhookId: 'wh-abc' });
    await tick();
    expect(first.status).toBe(200);
    expect(first.text).toBe('OK');
    expect(prisma.shop.update).toHaveBeenCalledTimes(1);

    const second = await post('/orders/fulfilled', body, { webhookId: 'wh-abc' });
    await tick();
    expect(second.status).toBe(200);
    expect(second.text).toMatch(/duplicate/);
    expect(prisma.shop.update).toHaveBeenCalledTimes(1); // not re-processed
    expect(fakeRedis.set).toHaveBeenCalledWith('idem:shopify:wh-abc', expect.any(String), 'EX', 60 * 60 * 24, 'NX');
  });

  it('different webhook ids are both processed', async () => {
    fakeRedis = makeFakeRedis();
    prisma.shop.findUnique.mockResolvedValue(fakeShop({ id: 'shop_1' }));
    prisma.shop.update.mockResolvedValue({});
    const body = JSON.stringify({ id: 77, name: '#77' });
    await post('/orders/fulfilled', body, { webhookId: 'wh-1' });
    await post('/orders/fulfilled', body, { webhookId: 'wh-2' });
    await tick();
    expect(prisma.shop.update).toHaveBeenCalledTimes(2);
  });

  it('without Redis every delivery is processed (dev fallback)', async () => {
    fakeRedis = null;
    prisma.shop.findUnique.mockResolvedValue(fakeShop({ id: 'shop_1' }));
    prisma.shop.update.mockResolvedValue({});
    const body = JSON.stringify({ id: 77, name: '#77' });
    await post('/orders/fulfilled', body, { webhookId: 'wh-same' });
    await post('/orders/fulfilled', body, { webhookId: 'wh-same' });
    await tick();
    expect(prisma.shop.update).toHaveBeenCalledTimes(2);
  });
});

describe('Malformed JSON bodies', () => {
  it.each([
    '/orders/create', '/orders/fulfilled', '/shop/update', '/app_subscriptions/update',
    '/customers/data_request', '/customers/redact', '/shop/redact',
  ])('%s still answers 200 and logs the parse error (no DB writes)', async (topic) => {
    const body = '{ this is not json';
    const res = await post(topic, body);
    await tick();
    expect(res.status).toBe(200);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(SyntaxError) }),
      expect.stringMatching(/error$/),
    );
    expect(prisma.shop.update).not.toHaveBeenCalled();
    expect(prisma.shop.updateMany).not.toHaveBeenCalled();
    expect(prisma.shop.delete).not.toHaveBeenCalled();
    expect(prisma.return.updateMany).not.toHaveBeenCalled();
  });
});

describe('orders/create', () => {
  it('acknowledges with 200 and logs the order name without touching the DB', async () => {
    const body = JSON.stringify({ id: 5001, name: '#5001' });
    const res = await post('/orders/create', body);
    await tick();
    expect(res.status).toBe(200);
    expect(logger.info).toHaveBeenCalledWith(
      { shop: 'test-shop.myshopify.com', order: '#5001' },
      'Order created webhook',
    );
    expect(prisma.shop.findUnique).not.toHaveBeenCalled();
    expect(prisma.shop.update).not.toHaveBeenCalled();
  });
});

describe('orders/fulfilled', () => {
  it('no-ops (but still 200) for an unknown shop', async () => {
    prisma.shop.findUnique.mockResolvedValue(null);
    const body = JSON.stringify({ id: 9, name: '#9', fulfillments: [{ created_at: '2026-03-01T00:00:00Z' }] });
    const res = await post('/orders/fulfilled', body, { shop: 'nobody.myshopify.com' });
    await tick();
    expect(res.status).toBe(200);
    expect(prisma.shop.findUnique).toHaveBeenCalledWith({ where: { shopifyDomain: 'nobody.myshopify.com' } });
    expect(prisma.shop.update).not.toHaveBeenCalled();
  });

  it('merges into existing settings and keeps earlier fulfillments', async () => {
    prisma.shop.findUnique.mockResolvedValue(fakeShop({
      id: 'shop_1',
      settings: { branding: { color: '#000' }, fulfillments: { 1: '2026-01-01T00:00:00Z' } },
    }));
    prisma.shop.update.mockResolvedValue({});
    const body = JSON.stringify({ id: 2, name: '#2', fulfillments: [{ created_at: '2026-02-02T00:00:00Z' }] });
    await post('/orders/fulfilled', body);
    await tick();
    expect(prisma.shop.update).toHaveBeenCalledWith({
      where: { id: 'shop_1' },
      data: {
        settings: {
          branding: { color: '#000' },
          fulfillments: { 1: '2026-01-01T00:00:00Z', 2: '2026-02-02T00:00:00Z' },
        },
      },
    });
    expect(logger.info).toHaveBeenCalledWith(
      { shop: 'test-shop.myshopify.com', order: '#2' },
      'Order fulfilled — return window started',
    );
  });

  it('falls back to "now" when the payload has no fulfillments array', async () => {
    prisma.shop.findUnique.mockResolvedValue(fakeShop({ id: 'shop_1', settings: null }));
    prisma.shop.update.mockResolvedValue({});
    const before = Date.now();
    const body = JSON.stringify({ id: 3, name: '#3' });
    await post('/orders/fulfilled', body);
    await tick();
    const saved = prisma.shop.update.mock.calls[0][0].data.settings.fulfillments[3];
    const ts = new Date(saved).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(Date.now());
  });

  it('swallows a DB failure and still returns 200 (Shopify must not retry forever)', async () => {
    prisma.shop.findUnique.mockRejectedValue(new Error('db down'));
    const body = JSON.stringify({ id: 4, name: '#4' });
    const res = await post('/orders/fulfilled', body);
    await tick();
    expect(res.status).toBe(200);
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), 'orders/fulfilled error');
  });
});

describe('app/uninstalled', () => {
  it('emits SHOP_UNINSTALLED with the shop id and domain', async () => {
    prisma.shop.findUnique.mockResolvedValue(fakeShop({ id: 'shop_9' }));
    prisma.shop.update.mockResolvedValue({});
    const { SHOP_UNINSTALLED } = require('../../app/events/emitters');
    const listener = jest.fn();
    eventBus.on(SHOP_UNINSTALLED, listener);

    await post('/app/uninstalled', JSON.stringify({}));
    await tick();
    expect(listener).toHaveBeenCalledWith({ shopId: 'shop_9', shopDomain: 'test-shop.myshopify.com' });
    const data = prisma.shop.update.mock.calls[0][0].data;
    expect(data.settings).toEqual({ uninstalledAt: expect.any(String) });
  });

  it('no-ops for an unknown shop and emits nothing', async () => {
    prisma.shop.findUnique.mockResolvedValue(null);
    const { SHOP_UNINSTALLED } = require('../../app/events/emitters');
    const listener = jest.fn();
    eventBus.on(SHOP_UNINSTALLED, listener);
    const res = await post('/app/uninstalled', JSON.stringify({}), { shop: 'ghost.myshopify.com' });
    await tick();
    expect(res.status).toBe(200);
    expect(prisma.shop.update).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('shop/update', () => {
  it('syncs name + email onto the matching shop row only', async () => {
    prisma.shop.updateMany.mockResolvedValue({ count: 1 });
    const body = JSON.stringify({ name: 'Renamed Shop', email: 'new@shop.com', domain: 'custom.example' });
    const res = await post('/shop/update', body);
    await tick();
    expect(res.status).toBe(200);
    expect(prisma.shop.updateMany).toHaveBeenCalledWith({
      where: { shopifyDomain: 'test-shop.myshopify.com' },
      data: { name: 'Renamed Shop', email: 'new@shop.com' },
    });
    // Only the two synced fields are written — nothing else leaks from the payload
    expect(Object.keys(prisma.shop.updateMany.mock.calls[0][0].data).sort()).toEqual(['email', 'name']);
  });

  it('an unknown shop is a harmless no-op (updateMany scoped by domain, nothing created)', async () => {
    prisma.shop.updateMany.mockResolvedValue({ count: 0 });
    const body = JSON.stringify({ name: 'X', email: 'x@x.com' });
    const res = await post('/shop/update', body, { shop: 'unknown.myshopify.com' });
    await tick();
    expect(res.status).toBe(200);
    expect(prisma.shop.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { shopifyDomain: 'unknown.myshopify.com' },
    }));
    expect(prisma.shop.upsert).not.toHaveBeenCalled();
    expect(prisma.shop.update).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('swallows a DB failure and still returns 200', async () => {
    prisma.shop.updateMany.mockRejectedValue(new Error('db down'));
    const res = await post('/shop/update', JSON.stringify({ name: 'X', email: 'x@x.com' }));
    await tick();
    expect(res.status).toBe(200);
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), 'shop/update error');
  });
});

describe('app_subscriptions/update → plan reconciliation', () => {
  function subBody(name, status) {
    return JSON.stringify({ app_subscription: { name, status, admin_graphql_api_id: 'gid://shopify/AppSubscription/1' } });
  }

  it('ACTIVE "Growth" (managed-pricing plain name) → GROWTH, cycle reset, returnCount 0', async () => {
    prisma.shop.findUnique.mockResolvedValue(fakeShop({ id: 'shop_1', plan: 'FREE', returnCount: 17 }));
    prisma.shop.update.mockResolvedValue({});
    const before = Date.now();
    await post('/app_subscriptions/update', subBody('Growth', 'ACTIVE'));
    await tick();
    expect(prisma.shop.update).toHaveBeenCalledTimes(1);
    const call = prisma.shop.update.mock.calls[0][0];
    expect(call.where).toEqual({ id: 'shop_1' });
    expect(call.data.plan).toBe('GROWTH');
    expect(call.data.returnCount).toBe(0);
    expect(call.data.billingCycleStart).toBeInstanceOf(Date);
    expect(call.data.billingCycleStart.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('ACTIVE "Starter — £9/month" (trailing managed-pricing text) → STARTER', async () => {
    prisma.shop.findUnique.mockResolvedValue(fakeShop({ id: 'shop_1', plan: 'FREE' }));
    prisma.shop.update.mockResolvedValue({});
    await post('/app_subscriptions/update', subBody('Starter — £9/month', 'ACTIVE'));
    await tick();
    expect(prisma.shop.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ plan: 'STARTER', returnCount: 0 }),
    }));
  });

  it('ACTIVE "ReturnFlow Growth (Annual)" → GROWTH', async () => {
    prisma.shop.findUnique.mockResolvedValue(fakeShop({ id: 'shop_1', plan: 'FREE' }));
    prisma.shop.update.mockResolvedValue({});
    await post('/app_subscriptions/update', subBody('ReturnFlow Growth (Annual)', 'ACTIVE'));
    await tick();
    expect(prisma.shop.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ plan: 'GROWTH' }),
    }));
  });

  it('ACTIVE with an unrecognised name keeps the current plan (never silently downgrades)', async () => {
    prisma.shop.findUnique.mockResolvedValue(fakeShop({ id: 'shop_1', plan: 'STARTER' }));
    prisma.shop.update.mockResolvedValue({});
    await post('/app_subscriptions/update', subBody('Mystery Plan', 'ACTIVE'));
    await tick();
    expect(prisma.shop.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ plan: 'STARTER' }),
    }));
  });

  it.each(['CANCELLED', 'EXPIRED', 'DECLINED', 'FROZEN'])('%s → FREE without wiping returnCount or cycle start', async (status) => {
    prisma.shop.findUnique.mockResolvedValue(fakeShop({ id: 'shop_1', plan: 'GROWTH', returnCount: 42 }));
    prisma.shop.update.mockResolvedValue({});
    await post('/app_subscriptions/update', subBody('Growth', status));
    await tick();
    expect(prisma.shop.update).toHaveBeenCalledTimes(1);
    const data = prisma.shop.update.mock.calls[0][0].data;
    expect(data).toEqual({ plan: 'FREE' });
    expect(data).not.toHaveProperty('returnCount');
    expect(data).not.toHaveProperty('billingCycleStart');
  });

  it('unknown shop → no update, still 200', async () => {
    prisma.shop.findUnique.mockResolvedValue(null);
    const res = await post('/app_subscriptions/update', subBody('Growth', 'ACTIVE'), { shop: 'ghost.myshopify.com' });
    await tick();
    expect(res.status).toBe(200);
    expect(prisma.shop.update).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('missing app_subscription object does not crash — treated as non-active (FREE)', async () => {
    prisma.shop.findUnique.mockResolvedValue(fakeShop({ id: 'shop_1', plan: 'GROWTH', returnCount: 3 }));
    prisma.shop.update.mockResolvedValue({});
    const res = await post('/app_subscriptions/update', JSON.stringify({ something_else: true }));
    await tick();
    expect(res.status).toBe(200);
    expect(logger.error).not.toHaveBeenCalled();
    expect(prisma.shop.update).toHaveBeenCalledWith(expect.objectContaining({ data: { plan: 'FREE' } }));
  });

  it('swallows a billing-service failure and still returns 200', async () => {
    prisma.shop.findUnique.mockRejectedValue(new Error('db down'));
    const res = await post('/app_subscriptions/update', subBody('Growth', 'ACTIVE'));
    await tick();
    expect(res.status).toBe(200);
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), 'app_subscriptions/update error');
  });
});

describe('GDPR compliance webhooks', () => {
  it('customers/data_request: verifies HMAC, returns 200, logs the request, mutates nothing', async () => {
    prisma.returnEvent.createMany.mockResolvedValue({ count: 0 });
    const body = JSON.stringify({
      shop_domain: 'test-shop.myshopify.com',
      customer: { email: 'jane@example.com' },
      orders_requested: [1, 2],
    });
    const res = await post('/customers/data_request', body);
    await tick();
    expect(res.status).toBe(200);
    expect(logger.info).toHaveBeenCalledWith(
      { email: 'jane@example.com', shop: 'test-shop.myshopify.com' },
      'GDPR data request received',
    );
    // The event write is deliberately a no-op today (no FK target)
    if (prisma.returnEvent.createMany.mock.calls.length) {
      expect(prisma.returnEvent.createMany.mock.calls[0][0].data).toEqual([]);
    }
    expect(prisma.return.updateMany).not.toHaveBeenCalled();
    expect(prisma.shop.delete).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('customers/data_request: 401 on bad HMAC', async () => {
    const body = JSON.stringify({ shop_domain: 'test-shop.myshopify.com', customer: { email: 'j@x.com' } });
    const res = await post('/customers/data_request', body, { hmac: shopifyHmac('other') });
    expect(res.status).toBe(401);
  });

  it('customers/redact: no customer email → nothing happens', async () => {
    const body = JSON.stringify({ shop_domain: 'test-shop.myshopify.com', customer: { id: 1 } });
    const res = await post('/customers/redact', body);
    await tick();
    expect(res.status).toBe(200);
    expect(prisma.shop.findUnique).not.toHaveBeenCalled();
    expect(prisma.return.updateMany).not.toHaveBeenCalled();
  });

  it('customers/redact: unknown shop → nothing anonymised', async () => {
    prisma.shop.findUnique.mockResolvedValue(null);
    const body = JSON.stringify({ shop_domain: 'ghost.myshopify.com', customer: { email: 'j@x.com' } });
    const res = await post('/customers/redact', body);
    await tick();
    expect(res.status).toBe(200);
    expect(prisma.return.findMany).not.toHaveBeenCalled();
    expect(prisma.return.updateMany).not.toHaveBeenCalled();
    expect(Storage.deleteAllForShop).not.toHaveBeenCalled();
  });

  it('customers/redact: scopes anonymisation to the shop AND email, with a unique redacted address', async () => {
    prisma.shop.findUnique.mockResolvedValue(fakeShop({ id: 'shop_1' }));
    prisma.return.findMany.mockResolvedValue([{ id: 'r1' }]);
    prisma.return.updateMany.mockResolvedValue({ count: 1 });
    const body = JSON.stringify({ shop_domain: 'test-shop.myshopify.com', customer: { email: 'jane@x.com' } });
    await post('/customers/redact', body);
    await tick();
    expect(prisma.return.findMany).toHaveBeenCalledWith({
      where: { shopId: 'shop_1', customerEmail: 'jane@x.com' },
      select: { id: true },
    });
    const call = prisma.return.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ shopId: 'shop_1', customerEmail: 'jane@x.com' });
    expect(call.data.customerEmail).toMatch(/^redacted\+\d+@redacted\.local$/);
    expect(call.data.notes).toBeNull();
  });

  it('customers/redact: a photo-storage failure does not block the DB anonymisation', async () => {
    prisma.shop.findUnique.mockResolvedValue(fakeShop({ id: 'shop_1' }));
    prisma.return.findMany.mockResolvedValue([{ id: 'r1' }]);
    prisma.return.updateMany.mockResolvedValue({ count: 1 });
    Storage.deleteAllForShop.mockRejectedValue(new Error('R2 down'));
    const body = JSON.stringify({ shop_domain: 'test-shop.myshopify.com', customer: { email: 'jane@x.com' } });
    const res = await post('/customers/redact', body);
    await tick();
    expect(res.status).toBe(200);
    expect(prisma.return.updateMany).toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('shop/redact: unknown shop → no delete', async () => {
    prisma.shop.findUnique.mockResolvedValue(null);
    const res = await post('/shop/redact', JSON.stringify({ shop_domain: 'ghost.myshopify.com' }));
    await tick();
    expect(res.status).toBe(200);
    expect(prisma.shop.delete).not.toHaveBeenCalled();
    expect(Storage.deleteAllForShop).not.toHaveBeenCalled();
  });

  it('shop/redact: cleans up photos for every return before deleting the shop', async () => {
    prisma.shop.findUnique.mockResolvedValue({ id: 'shop_1', returns: [{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }] });
    prisma.shop.delete.mockResolvedValue({});
    await post('/shop/redact', JSON.stringify({ shop_domain: 'test-shop.myshopify.com' }));
    await tick();
    expect(Storage.deleteAllForShop).toHaveBeenCalledWith(['r1', 'r2', 'r3']);
    expect(prisma.shop.delete).toHaveBeenCalledWith({ where: { id: 'shop_1' } });
    expect(logger.info).toHaveBeenCalledWith({ shop: 'test-shop.myshopify.com' }, 'Shop data redacted');
  });

  it('shop/redact: a DB failure is logged and still answers 200', async () => {
    prisma.shop.findUnique.mockResolvedValue({ id: 'shop_1', returns: [] });
    prisma.shop.delete.mockRejectedValue(new Error('fk violation'));
    const res = await post('/shop/redact', JSON.stringify({ shop_domain: 'test-shop.myshopify.com' }));
    await tick();
    expect(res.status).toBe(200);
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), 'shop/redact error');
  });
});

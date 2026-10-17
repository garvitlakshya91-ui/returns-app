// Compliance webhooks: shopify.app.toml points all three topics at /webhooks
// (topic in the header), and a data request produces a real export.

const request = require('supertest');
const express = require('express');
const crypto = require('crypto');
const { installPrismaMock, fakeShop } = require('../helpers');

let app;
let prisma;
let storage;
let notifications;
let analytics;

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

const hmac = (body) => crypto.createHmac('sha256', process.env.SHOPIFY_API_SECRET).update(body, 'utf8').digest('base64');
const flush = () => new Promise((r) => setImmediate(r));

function post(path, topic, payload) {
  const body = JSON.stringify(payload);
  return request(app)
    .post(path)
    .set('x-shopify-hmac-sha256', hmac(body))
    .set('x-shopify-topic', topic)
    .set('content-type', 'application/json')
    .send(body);
}

beforeEach(() => {
  jest.resetModules();
  prisma = installPrismaMock();
  storage = { deleteAllForShop: jest.fn().mockResolvedValue(0) };
  jest.doMock('../../app/services/StorageService', () => storage);
  notifications = { sendEmail: jest.fn().mockResolvedValue({ sent: true }) };
  jest.doMock('../../app/services/NotificationService', () => notifications);
  analytics = { exportCsv: jest.fn().mockResolvedValue('Return ID,Order\nret_1,#1001') };
  jest.doMock('../../app/services/AnalyticsService', () => analytics);
  jest.doMock('../../app/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

  app = express();
  app.use('/webhooks', rawBodyMiddleware);
  app.use('/webhooks', require('../../app/routes/webhooks'));
});

describe('POST /webhooks — the configured compliance destination', () => {
  it('routes customers/redact by topic header to the redaction handler', async () => {
    prisma.shop.findUnique.mockResolvedValue(fakeShop({ id: 'shop_1' }));
    prisma.return.findMany.mockResolvedValue([{ id: 'r1' }]);
    prisma.return.updateMany.mockResolvedValue({ count: 1 });

    const res = await post('/webhooks', 'customers/redact', { shop_domain: 'test-shop.myshopify.com', customer: { email: 'jane@x.com' } });
    await flush();

    expect(res.status).toBe(200);
    expect(storage.deleteAllForShop).toHaveBeenCalledWith(['r1']);
    expect(prisma.return.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { shopId: 'shop_1', customerEmail: 'jane@x.com' },
      data: expect.objectContaining({ customerName: 'Redacted' }),
    }));
    // What the customer wrote, their photos and anything logged about them go too.
    expect(prisma.returnItem.updateMany).toHaveBeenCalledWith({
      where: { returnId: { in: ['r1'] } }, data: { reasonDetail: null, photoUrls: [] },
    });
    expect(prisma.returnEvent.updateMany).toHaveBeenCalledWith({
      where: { returnId: { in: ['r1'] } }, data: { data: { redacted: true } },
    });
  });

  it('answers 500 (not 200) when the work fails, so the retry is processed rather than dropped as a duplicate', async () => {
    prisma.shop.findUnique.mockRejectedValue(new Error('db outage'));
    const res = await post('/webhooks', 'customers/data_request', { shop_domain: 'test-shop.myshopify.com', customer: { email: 'jane@x.com' } });
    expect(res.status).toBe(500);
    expect(notifications.sendEmail).not.toHaveBeenCalled();
  });

  it('routes shop/redact by topic header to the shop deletion handler', async () => {
    prisma.shop.findUnique.mockResolvedValue({ id: 'shop_1', returns: [{ id: 'r1' }] });
    prisma.shop.delete.mockResolvedValue({});

    const res = await post('/webhooks', 'shop/redact', { shop_domain: 'test-shop.myshopify.com' });
    await flush();

    expect(res.status).toBe(200);
    expect(prisma.shop.delete).toHaveBeenCalledWith({ where: { id: 'shop_1' } });
  });

  it('404s an unknown topic so Shopify shows the misconfiguration, and does nothing', async () => {
    const res = await post('/webhooks', 'orders/create', { id: 1 });
    expect(res.status).toBe(404);
    expect(prisma.shop.findUnique).not.toHaveBeenCalled();
  });

  it('still requires a valid HMAC', async () => {
    const body = JSON.stringify({ shop_domain: 'test-shop.myshopify.com' });
    const res = await request(app).post('/webhooks').set('x-shopify-hmac-sha256', 'bad').set('x-shopify-topic', 'shop/redact').send(body);
    expect(res.status).toBe(401);
  });
});

describe('customers/data_request', () => {
  const payload = {
    shop_domain: 'test-shop.myshopify.com',
    customer: { email: 'Jane@X.com' },
    data_request: { id: 9999 },
  };

  it('exports the customer\'s returns as CSV, emails the merchant, and notes the request on each return', async () => {
    prisma.shop.findUnique.mockResolvedValue(fakeShop({ id: 'shop_1', name: 'Test Shop', email: 'owner@test-shop.com' }));
    prisma.return.findMany.mockResolvedValue([{ id: 'r1' }, { id: 'r2' }]);
    prisma.returnEvent.createMany.mockResolvedValue({ count: 2 });

    const res = await post('/webhooks', 'customers/data_request', payload);
    await flush();

    expect(res.status).toBe(200);
    expect(prisma.return.findMany).toHaveBeenCalledWith({
      where: { shopId: 'shop_1', customerEmail: { equals: 'Jane@X.com', mode: 'insensitive' } },
      select: { id: true },
    });
    expect(prisma.returnEvent.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({ returnId: 'r1', type: 'gdpr.data_request', data: expect.objectContaining({ shopifyRequestId: 9999 }) }),
        expect.objectContaining({ returnId: 'r2', type: 'gdpr.data_request' }),
      ],
    });
    expect(analytics.exportCsv).toHaveBeenCalledWith('shop_1', { customerEmail: 'Jane@X.com' });
    expect(notifications.sendEmail).toHaveBeenCalledWith({
      to: 'owner@test-shop.com',
      subject: 'Customer data request: Jane@X.com',
      template: 'DataRequest',
      data: { shopName: 'Test Shop', customerEmail: 'Jane@X.com', returnCount: 2, csv: 'Return ID,Order\nret_1,#1001', requestId: 9999 },
    });
  });

  it('also works on the per-topic path', async () => {
    prisma.shop.findUnique.mockResolvedValue(fakeShop({ id: 'shop_1' }));
    prisma.return.findMany.mockResolvedValue([]);

    await post('/webhooks/customers/data_request', 'customers/data_request', payload);
    await flush();

    expect(prisma.returnEvent.createMany).not.toHaveBeenCalled();
    expect(notifications.sendEmail).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ returnCount: 0 }) }));
  });

  it('does nothing for an unknown shop or a payload without an email', async () => {
    prisma.shop.findUnique.mockResolvedValue(null);
    await post('/webhooks', 'customers/data_request', payload);
    await flush();
    expect(notifications.sendEmail).not.toHaveBeenCalled();

    await post('/webhooks', 'customers/data_request', { shop_domain: 'test-shop.myshopify.com', customer: {} });
    await flush();
    expect(prisma.shop.findUnique).toHaveBeenCalledTimes(1);
  });
});

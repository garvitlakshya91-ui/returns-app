// Behavioural tests for app/routes/api/settings.js (merchant shop settings).

const request = require('supertest');
const express = require('express');
const { installPrismaMock, fakeShop } = require('../helpers');

let app;
let prisma;
const ORIGINAL_ENV = { PORTAL_URL: process.env.PORTAL_URL, HOST: process.env.HOST };

function mountApp() {
  jest.resetModules();
  prisma = installPrismaMock();

  jest.doMock('../../app/middleware/auth', () => ({
    verifyShopifySession: (req, res, next) => {
      req.shopId = 'shop_test_1';
      req.shopDomain = 'test-shop.myshopify.com';
      req.shop = fakeShop({ id: 'shop_test_1' });
      next();
    },
  }));

  const a = express();
  a.use(express.json());
  a.use('/api/admin/settings', require('../../app/routes/api/settings'));
  return a;
}

beforeEach(() => {
  process.env.PORTAL_URL = ORIGINAL_ENV.PORTAL_URL;
  process.env.HOST = ORIGINAL_ENV.HOST;
  app = mountApp();
});

afterAll(() => {
  process.env.PORTAL_URL = ORIGINAL_ENV.PORTAL_URL;
  process.env.HOST = ORIGINAL_ENV.HOST;
});

const selectedShop = {
  name: 'Test Shop',
  email: 'test@shop.com',
  plan: 'FREE',
  currency: 'GBP',
  settings: { warehouseCity: 'Gloucester' },
  shopifyDomain: 'test-shop.myshopify.com',
};

describe('GET /api/admin/settings', () => {
  it('returns the selected shop fields plus a derived portalUrl', async () => {
    prisma.shop.findUnique.mockResolvedValue(selectedShop);

    const res = await request(app).get('/api/admin/settings');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ...selectedShop,
      portalUrl: 'https://portal.test.local/portal/test-shop',
    });
  });

  it('only selects safe columns (never the encrypted shopifyToken)', async () => {
    prisma.shop.findUnique.mockResolvedValue(selectedShop);
    await request(app).get('/api/admin/settings');

    expect(prisma.shop.findUnique).toHaveBeenCalledWith({
      where: { id: 'shop_test_1' },
      select: { name: true, email: true, plan: true, currency: true, settings: true, shopifyDomain: true },
    });
    const select = prisma.shop.findUnique.mock.calls[0][0].select;
    expect(select.shopifyToken).toBeUndefined();
  });

  it('derives the slug from the first label of the myshopify domain', async () => {
    prisma.shop.findUnique.mockResolvedValue({ ...selectedShop, shopifyDomain: 'acme-outdoors.myshopify.com' });
    const res = await request(app).get('/api/admin/settings');
    expect(res.body.portalUrl).toBe('https://portal.test.local/portal/acme-outdoors');
  });

  it('strips a trailing slash from PORTAL_URL', async () => {
    process.env.PORTAL_URL = 'https://returns.example.com/';
    app = mountApp();
    prisma.shop.findUnique.mockResolvedValue(selectedShop);

    const res = await request(app).get('/api/admin/settings');
    expect(res.body.portalUrl).toBe('https://returns.example.com/portal/test-shop');
  });

  it('falls back to HOST when PORTAL_URL is unset', async () => {
    delete process.env.PORTAL_URL;
    process.env.HOST = 'https://app.example.com';
    app = mountApp();
    prisma.shop.findUnique.mockResolvedValue(selectedShop);

    const res = await request(app).get('/api/admin/settings');
    expect(res.body.portalUrl).toBe('https://app.example.com/portal/test-shop');
  });

  it('returns an empty portalUrl when neither PORTAL_URL nor HOST is configured', async () => {
    delete process.env.PORTAL_URL;
    delete process.env.HOST;
    app = mountApp();
    prisma.shop.findUnique.mockResolvedValue(selectedShop);

    const res = await request(app).get('/api/admin/settings');
    expect(res.body.portalUrl).toBe('');
  });

  it('returns an empty portalUrl when the shop has no domain', async () => {
    prisma.shop.findUnique.mockResolvedValue({ ...selectedShop, shopifyDomain: null });
    const res = await request(app).get('/api/admin/settings');
    expect(res.body.portalUrl).toBe('');
  });

  it('degrades to { portalUrl: "" } when the shop row is missing (no 404)', async () => {
    prisma.shop.findUnique.mockResolvedValue(null);
    const res = await request(app).get('/api/admin/settings');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ portalUrl: '' });
  });

  it('500 { error: "Failed to load settings" } when prisma throws', async () => {
    prisma.shop.findUnique.mockRejectedValue(new Error('db down'));
    const res = await request(app).get('/api/admin/settings');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to load settings' });
  });
});

describe('PUT /api/admin/settings', () => {
  it('writes body.settings to the authenticated shop and echoes the stored settings', async () => {
    const settings = {
      warehouseLine1: '1 Dock Road',
      warehouseCity: 'Bristol',
      warehousePostcode: 'BS1 1AA',
      branding: { primaryColor: '#123456' },
      notifications: { emailOnCreate: true },
    };
    prisma.shop.update.mockImplementation(async ({ data }) => fakeShop({ settings: data.settings }));

    const res = await request(app).put('/api/admin/settings').send({ settings });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ settings });
    expect(prisma.shop.update).toHaveBeenCalledWith({
      where: { id: 'shop_test_1' },
      data: { settings },
    });
  });

  it('merges into the stored settings (reading them first) and keeps system keys like fulfillments from the DB', async () => {
    prisma.shop.findUnique.mockResolvedValue({ settings: { a: 1, fulfillments: { x: 'd' } } });
    prisma.shop.update.mockImplementation(async ({ data }) => fakeShop({ settings: data.settings }));

    const res = await request(app).put('/api/admin/settings').send({ settings: { b: 2, fulfillments: { hack: 1 } } });
    expect(res.status).toBe(200);
    expect(prisma.shop.findUnique).toHaveBeenCalledWith({ where: { id: 'shop_test_1' }, select: { settings: true } });
    expect(prisma.shop.update).toHaveBeenCalledWith({
      where: { id: 'shop_test_1' },
      data: { settings: { a: 1, b: 2, fulfillments: { x: 'd' } } },
    });
    expect(res.body).toEqual({ settings: { a: 1, b: 2, fulfillments: { x: 'd' } } });
  });

  it('an incoming value for a non-system key that is also stored wins over the stored one', async () => {
    prisma.shop.findUnique.mockResolvedValue({ settings: { warehouseCity: 'Gloucester', keep: true } });
    prisma.shop.update.mockImplementation(async ({ data }) => fakeShop({ settings: data.settings }));

    await request(app).put('/api/admin/settings').send({ settings: { warehouseCity: 'Bristol' } });
    expect(prisma.shop.update.mock.calls[0][0].data).toEqual({ settings: { warehouseCity: 'Bristol', keep: true } });
  });

  it('only ever touches the settings column — other body keys (plan, shopifyToken) are ignored', async () => {
    prisma.shop.update.mockImplementation(async ({ data }) => fakeShop({ settings: data.settings }));

    await request(app).put('/api/admin/settings').send({
      settings: { a: 1 },
      plan: 'PRO',
      shopifyToken: 'stolen',
      shopifyDomain: 'evil.myshopify.com',
    });
    expect(prisma.shop.update.mock.calls[0][0].data).toEqual({ settings: { a: 1 } });
  });

  it('responds with what prisma stored, not what was sent', async () => {
    prisma.shop.update.mockResolvedValue(fakeShop({ settings: { fromDb: true } }));
    const res = await request(app).put('/api/admin/settings').send({ settings: { sent: true } });
    expect(res.body).toEqual({ settings: { fromDb: true } });
  });

  it('400 "settings must be an object" when settings is not a plain object (string / array / null / number)', async () => {
    for (const bad of ['not-an-object', ['a'], null, 42]) {
      const res = await request(app).put('/api/admin/settings').send({ settings: bad });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'settings must be an object' });
    }
    expect(prisma.shop.findUnique).not.toHaveBeenCalled();
    expect(prisma.shop.update).not.toHaveBeenCalled();
  });

  it('client-sent system keys (fulfillments, uninstalledAt) are dropped when nothing is stored for them', async () => {
    prisma.shop.findUnique.mockResolvedValue({ settings: { a: 1 } });
    prisma.shop.update.mockImplementation(async ({ data }) => fakeShop({ settings: data.settings }));

    await request(app).put('/api/admin/settings').send({
      settings: { b: 2, fulfillments: { forged: true }, uninstalledAt: '2020-01-01' },
    });
    expect(prisma.shop.update.mock.calls[0][0].data).toEqual({ settings: { a: 1, b: 2 } });
  });

  it('client-sent system keys are replaced by the stored values when those exist', async () => {
    prisma.shop.findUnique.mockResolvedValue({ settings: { fulfillments: { o1: '2026-01-01' }, uninstalledAt: null } });
    prisma.shop.update.mockImplementation(async ({ data }) => fakeShop({ settings: data.settings }));

    await request(app).put('/api/admin/settings').send({
      settings: { fulfillments: { forged: true }, uninstalledAt: '2020-01-01', branding: { primaryColor: '#000' } },
    });
    expect(prisma.shop.update.mock.calls[0][0].data).toEqual({
      settings: { fulfillments: { o1: '2026-01-01' }, uninstalledAt: null, branding: { primaryColor: '#000' } },
    });
  });

  it('tolerates a missing shop row (merges onto an empty object, still stripping system keys)', async () => {
    prisma.shop.findUnique.mockResolvedValue(null);
    prisma.shop.update.mockImplementation(async ({ data }) => fakeShop({ settings: data.settings }));

    await request(app).put('/api/admin/settings').send({ settings: { a: 1, fulfillments: {} } });
    expect(prisma.shop.update.mock.calls[0][0].data).toEqual({ settings: { a: 1 } });
  });

  it('a body without settings is rejected with 400 and never touches prisma', async () => {
    prisma.shop.update.mockResolvedValue(fakeShop({ settings: { untouched: true } }));
    const res = await request(app).put('/api/admin/settings').send({});
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'settings must be an object' });
    expect(prisma.shop.update).not.toHaveBeenCalled();
  });

  it('500 { error: "Failed to save settings" } when prisma.update throws', async () => {
    prisma.shop.update.mockRejectedValue(new Error('db down'));
    const res = await request(app).put('/api/admin/settings').send({ settings: {} });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to save settings' });
  });

  it('500 { error: "Failed to save settings" } when reading the current settings throws', async () => {
    prisma.shop.findUnique.mockRejectedValue(new Error('db down'));
    const res = await request(app).put('/api/admin/settings').send({ settings: {} });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to save settings' });
    expect(prisma.shop.update).not.toHaveBeenCalled();
  });
});

const request = require('supertest');
const express = require('express');
const { installPrismaMock, fakeShop } = require('../helpers');

let app;
let prisma;

function bootstrap(plan = 'FREE') {
  jest.resetModules();
  prisma = installPrismaMock();

  jest.doMock('../../app/middleware/auth', () => ({
    verifyShopifySession: (req, res, next) => {
      req.shopId = 'shop_test_1';
      req.shopDomain = 'test-shop.myshopify.com';
      next();
    },
  }));

  prisma.shop.findUnique.mockResolvedValue(fakeShop({ id: 'shop_test_1', plan }));

  app = express();
  app.use(express.json());
  app.use('/api/admin/carriers', require('../../app/routes/api/carriers'));
}

describe('GET /api/admin/carriers', () => {
  it('returns configs with credentials redacted', async () => {
    bootstrap();
    prisma.carrierConfig.findMany.mockResolvedValue([
      { id: 'cc1', carrier: 'evri', isActive: true, credentials: { encrypted: 'secret' }, settings: {} },
    ]);
    const res = await request(app).get('/api/admin/carriers');
    expect(res.status).toBe(200);
    expect(res.body[0]).toEqual(
      expect.objectContaining({ carrier: 'evri', isActive: true, hasCredentials: true }),
    );
    // The raw encrypted blob is never sent to the client.
    expect(JSON.stringify(res.body)).not.toContain('secret');
  });
});

describe('POST /api/admin/carriers', () => {
  it('rejects an unsupported carrier', async () => {
    bootstrap();
    const res = await request(app).post('/api/admin/carriers').send({ carrier: 'fedex' });
    expect(res.status).toBe(400);
  });

  it('encrypts and stores credentials for a new carrier', async () => {
    bootstrap('FREE');
    prisma.carrierConfig.findMany.mockResolvedValue([]);
    prisma.carrierConfig.upsert.mockResolvedValue({
      id: 'cc1', carrier: 'evri', isActive: true, credentials: { encrypted: 'x' },
    });

    const res = await request(app)
      .post('/api/admin/carriers')
      .send({ carrier: 'evri', credentials: { apiKey: 'k123' }, isActive: true });

    expect(res.status).toBe(200);
    const arg = prisma.carrierConfig.upsert.mock.calls[0][0];
    // Credentials are encrypted, not stored in plaintext.
    expect(arg.create.credentials.encrypted).toBeDefined();
    expect(JSON.stringify(arg.create.credentials)).not.toContain('k123');
  });

  it('enforces the FREE plan single-carrier limit', async () => {
    bootstrap('FREE');
    // One carrier already active; connecting a second active one must fail.
    prisma.carrierConfig.findMany.mockResolvedValue([
      { carrier: 'evri', isActive: true, credentials: { encrypted: 'x' } },
    ]);

    const res = await request(app)
      .post('/api/admin/carriers')
      .send({ carrier: 'royalmail', credentials: { apiKey: 'k' }, isActive: true });

    expect(res.status).toBe(403);
    expect(res.body.carrierLimit).toBe(1);
    expect(prisma.carrierConfig.upsert).not.toHaveBeenCalled();
  });

  it('allows a second carrier on STARTER plan', async () => {
    bootstrap('STARTER');
    prisma.carrierConfig.findMany.mockResolvedValue([
      { carrier: 'evri', isActive: true, credentials: { encrypted: 'x' } },
    ]);
    prisma.carrierConfig.upsert.mockResolvedValue({
      id: 'cc2', carrier: 'royalmail', isActive: true, credentials: { encrypted: 'y' },
    });

    const res = await request(app)
      .post('/api/admin/carriers')
      .send({ carrier: 'royalmail', credentials: { apiKey: 'k' }, isActive: true });

    expect(res.status).toBe(200);
  });

  it('preserves existing credentials when none are supplied (e.g. toggling active)', async () => {
    bootstrap('STARTER');
    const stored = { encrypted: 'already-here' };
    prisma.carrierConfig.findMany.mockResolvedValue([
      { carrier: 'evri', isActive: true, credentials: stored },
    ]);
    prisma.carrierConfig.upsert.mockResolvedValue({
      id: 'cc1', carrier: 'evri', isActive: false, credentials: stored,
    });

    const res = await request(app)
      .post('/api/admin/carriers')
      .send({ carrier: 'evri', isActive: false }); // no credentials

    expect(res.status).toBe(200);
    const arg = prisma.carrierConfig.upsert.mock.calls[0][0];
    expect(arg.update.credentials).toEqual(stored);
  });
});

describe('DELETE /api/admin/carriers/:id', () => {
  it('deletes scoped to the shop', async () => {
    bootstrap();
    prisma.carrierConfig.deleteMany.mockResolvedValue({ count: 1 });
    const res = await request(app).delete('/api/admin/carriers/cc1');
    expect(res.status).toBe(200);
    expect(prisma.carrierConfig.deleteMany).toHaveBeenCalledWith({
      where: { id: 'cc1', shopId: 'shop_test_1' },
    });
  });
});

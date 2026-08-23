// Behavioural tests for app/routes/api/policies.js (merchant return-policy CRUD).

const request = require('supertest');
const express = require('express');
const { installPrismaMock, fakeShop } = require('../helpers');

let app;
let prisma;

function fakePolicy(overrides = {}) {
  return {
    id: 'pol_1',
    shopId: 'shop_test_1',
    name: 'Standard',
    windowDays: 30,
    conditions: {},
    resolutions: { allowRefund: true, allowStoreCredit: true, allowExchange: false },
    fees: null,
    isDefault: false,
    isActive: true,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

beforeEach(() => {
  jest.resetModules();
  prisma = installPrismaMock();

  jest.doMock('../../app/middleware/auth', () => ({
    verifyShopifySession: (req, res, next) => {
      req.shopId = 'shop_test_1';
      req.shopDomain = 'test-shop.myshopify.com';
      req.shop = fakeShop({ id: 'shop_test_1', plan: 'GROWTH' });
      next();
    },
  }));

  app = express();
  app.use(express.json());
  app.use('/api/admin/policies', require('../../app/routes/api/policies'));
});

describe('GET /api/admin/policies', () => {
  it('lists only this shop\'s policies, newest first', async () => {
    const rows = [fakePolicy({ id: 'pol_2' }), fakePolicy({ id: 'pol_1' })];
    prisma.returnPolicy.findMany.mockResolvedValue(rows);

    const res = await request(app).get('/api/admin/policies');
    expect(res.status).toBe(200);
    expect(res.body.map((p) => p.id)).toEqual(['pol_2', 'pol_1']);
    expect(prisma.returnPolicy.findMany).toHaveBeenCalledWith({
      where: { shopId: 'shop_test_1' },
      orderBy: { createdAt: 'desc' },
    });
  });

  it('returns an empty array when the shop has no policies', async () => {
    prisma.returnPolicy.findMany.mockResolvedValue([]);
    const res = await request(app).get('/api/admin/policies');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('500 { error: "Failed to load policies" } when prisma throws', async () => {
    prisma.returnPolicy.findMany.mockRejectedValue(new Error('db down'));
    const res = await request(app).get('/api/admin/policies');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to load policies' });
  });
});

describe('POST /api/admin/policies', () => {
  it('creates a policy for the authenticated shop with the supplied fields', async () => {
    prisma.returnPolicy.create.mockImplementation(async ({ data }) => fakePolicy({ id: 'pol_new', ...data }));

    const body = {
      name: 'Sale items',
      windowDays: 14,
      conditions: { productTags: ['sale'] },
      resolutions: { allowRefund: false, allowStoreCredit: true, allowExchange: true },
      fees: { changedMind: 2.5 },
      isDefault: true,
    };
    const res = await request(app).post('/api/admin/policies').send(body);

    expect(res.status).toBe(201);
    expect(res.body.id).toBe('pol_new');
    expect(prisma.returnPolicy.create).toHaveBeenCalledWith({
      data: { shopId: 'shop_test_1', ...body },
    });
  });

  it('ignores a shopId in the body — policies always belong to the session shop', async () => {
    prisma.returnPolicy.create.mockImplementation(async ({ data }) => fakePolicy(data));

    await request(app).post('/api/admin/policies').send({ name: 'Evil', shopId: 'someone_else' });
    const { data } = prisma.returnPolicy.create.mock.calls[0][0];
    expect(data.shopId).toBe('shop_test_1');
  });

  it('applies defaults: 30-day window, empty conditions, refund+credit resolutions, not default', async () => {
    prisma.returnPolicy.create.mockImplementation(async ({ data }) => fakePolicy(data));

    const res = await request(app).post('/api/admin/policies').send({ name: 'Minimal' });
    expect(res.status).toBe(201);
    expect(prisma.returnPolicy.create).toHaveBeenCalledWith({
      data: {
        shopId: 'shop_test_1',
        name: 'Minimal',
        windowDays: 30,
        conditions: {},
        resolutions: { allowRefund: true, allowStoreCredit: true, allowExchange: false },
        fees: undefined,
        isDefault: false,
      },
    });
  });

  it('treats windowDays: 0 as unset and falls back to 30 (|| semantics)', async () => {
    prisma.returnPolicy.create.mockImplementation(async ({ data }) => fakePolicy(data));
    await request(app).post('/api/admin/policies').send({ name: 'Zero', windowDays: 0 });
    expect(prisma.returnPolicy.create.mock.calls[0][0].data.windowDays).toBe(30);
  });

  it('unsets the shop\'s other default policies (before creating) when isDefault is true', async () => {
    const order = [];
    prisma.returnPolicy.updateMany.mockImplementation(async () => { order.push('updateMany'); return { count: 1 }; });
    prisma.returnPolicy.create.mockImplementation(async ({ data }) => { order.push('create'); return fakePolicy(data); });

    const res = await request(app).post('/api/admin/policies').send({ name: '  New default ', isDefault: true });
    expect(res.status).toBe(201);
    expect(prisma.returnPolicy.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.returnPolicy.updateMany).toHaveBeenCalledWith({
      where: { shopId: 'shop_test_1', isDefault: true },
      data: { isDefault: false },
    });
    expect(order).toEqual(['updateMany', 'create']);
    expect(prisma.returnPolicy.create.mock.calls[0][0].data).toMatchObject({ name: 'New default', isDefault: true });
  });

  it('does not touch other policies when isDefault is false / absent', async () => {
    prisma.returnPolicy.create.mockImplementation(async ({ data }) => fakePolicy(data));
    await request(app).post('/api/admin/policies').send({ name: 'Plain' });
    expect(prisma.returnPolicy.updateMany).not.toHaveBeenCalled();
  });

  it('400 "name is required" when name is missing or blank — prisma is never called', async () => {
    for (const body of [{ windowDays: 10 }, { name: '' }, { name: '   ' }]) {
      const res = await request(app).post('/api/admin/policies').send(body);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'name is required' });
    }
    expect(prisma.returnPolicy.create).not.toHaveBeenCalled();
    expect(prisma.returnPolicy.updateMany).not.toHaveBeenCalled();
  });

  it('only whitelisted fields reach prisma (id / unknown keys are stripped) and windowDays is coerced', async () => {
    prisma.returnPolicy.create.mockImplementation(async ({ data }) => fakePolicy(data));
    await request(app).post('/api/admin/policies').send({
      name: 'Coerced', id: 'forged', createdAt: '1999-01-01', bogus: true, windowDays: '14.6', isDefault: 'yes',
    });
    const { data } = prisma.returnPolicy.create.mock.calls[0][0];
    expect(Object.keys(data).sort()).toEqual(['conditions', 'fees', 'isDefault', 'name', 'resolutions', 'shopId', 'windowDays']);
    expect(data.windowDays).toBe(15);
    expect(data.isDefault).toBe(true);
  });

  it('500 { error: "Failed to create policy" } when prisma.create throws', async () => {
    prisma.returnPolicy.create.mockRejectedValue(new Error('db down'));
    const res = await request(app).post('/api/admin/policies').send({ name: 'X' });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to create policy' });
  });
});

describe('PUT /api/admin/policies/:id', () => {
  it('updates via updateMany scoped by id AND shopId', async () => {
    prisma.returnPolicy.updateMany.mockResolvedValue({ count: 1 });

    const res = await request(app).put('/api/admin/policies/pol_1').send({ windowDays: 60, isActive: false });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ count: 1 });
    expect(prisma.returnPolicy.updateMany).toHaveBeenCalledWith({
      where: { id: 'pol_1', shopId: 'shop_test_1' },
      data: { windowDays: 60, isActive: false },
    });
  });

  it('another shop\'s policy is not updated — responds 404 "Policy not found" when count is 0', async () => {
    prisma.returnPolicy.updateMany.mockResolvedValue({ count: 0 });

    const res = await request(app).put('/api/admin/policies/other_shops_policy').send({ windowDays: 60 });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Policy not found' });
    expect(prisma.returnPolicy.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.returnPolicy.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'other_shops_policy', shopId: 'shop_test_1' },
    }));
  });

  it('strips shopId / id / unknown keys from the body — only whitelisted fields reach prisma data', async () => {
    prisma.returnPolicy.updateMany.mockResolvedValue({ count: 1 });

    const res = await request(app).put('/api/admin/policies/pol_1').send({
      name: 'Renamed', shopId: 'other_shop', id: 'pol_other', createdAt: '1999-01-01', bogus: 1, isActive: false,
    });
    expect(res.status).toBe(200);
    expect(prisma.returnPolicy.updateMany.mock.calls[0][0]).toEqual({
      where: { id: 'pol_1', shopId: 'shop_test_1' },
      data: { name: 'Renamed', isActive: false },
    });
  });

  it('coerces windowDays to a positive rounded number, falling back to 30', async () => {
    prisma.returnPolicy.updateMany.mockResolvedValue({ count: 1 });
    await request(app).put('/api/admin/policies/pol_1').send({ windowDays: '45.4' });
    expect(prisma.returnPolicy.updateMany.mock.calls[0][0].data).toEqual({ windowDays: 45 });

    prisma.returnPolicy.updateMany.mockClear();
    await request(app).put('/api/admin/policies/pol_1').send({ windowDays: -3 });
    expect(prisma.returnPolicy.updateMany.mock.calls[0][0].data).toEqual({ windowDays: 30 });
  });

  it('400 "name cannot be empty" when a blank name is sent — prisma is never called', async () => {
    const res = await request(app).put('/api/admin/policies/pol_1').send({ name: '   ' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'name cannot be empty' });
    expect(prisma.returnPolicy.updateMany).not.toHaveBeenCalled();
  });

  it('when isDefault is true, first unsets the shop\'s other defaults (excluding this id), then updates', async () => {
    prisma.returnPolicy.updateMany
      .mockResolvedValueOnce({ count: 2 })   // unset other defaults
      .mockResolvedValueOnce({ count: 1 });  // the actual update

    const res = await request(app).put('/api/admin/policies/pol_1').send({ isDefault: true });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ count: 1 });
    expect(prisma.returnPolicy.updateMany).toHaveBeenCalledTimes(2);
    expect(prisma.returnPolicy.updateMany.mock.calls[0][0]).toEqual({
      where: { shopId: 'shop_test_1', isDefault: true, NOT: { id: 'pol_1' } },
      data: { isDefault: false },
    });
    expect(prisma.returnPolicy.updateMany.mock.calls[1][0]).toEqual({
      where: { id: 'pol_1', shopId: 'shop_test_1' },
      data: { isDefault: true },
    });
  });

  it('500 { error: "Failed to update policy" } when prisma throws', async () => {
    prisma.returnPolicy.updateMany.mockRejectedValue(new Error('db down'));
    const res = await request(app).put('/api/admin/policies/pol_1').send({ windowDays: 60 });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to update policy' });
  });
});

describe('unsupported methods', () => {
  it('DELETE /:id is not implemented (404)', async () => {
    const res = await request(app).delete('/api/admin/policies/pol_1');
    expect(res.status).toBe(404);
  });
});

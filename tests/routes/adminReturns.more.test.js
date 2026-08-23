// Additional behavioural coverage for app/routes/api/returns.js.
// The basics (happy paths for list/get/approve/reject/process, bulk validation,
// demo creation) live in adminReturns.test.js — this file covers the rest:
// pagination, error branches, bulk reject/process semantics + scoping, and the
// demo route's fallbacks.

const request = require('supertest');
const express = require('express');
const { installPrismaMock, fakeShop, fakeReturn } = require('../helpers');

let app;
let prisma;
let eventBus;
let RefundService;

const PROCESSABLE = ['RECEIVED', 'INSPECTING', 'APPROVED', 'LABEL_SENT', 'IN_TRANSIT'];

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

  jest.doMock('../../app/services/RefundService', () => ({
    processRefund: jest.fn().mockResolvedValue({ success: true, type: 'REFUND', amount: 42 }),
  }));

  // Keep the route's console.error noise out of the test output
  jest.spyOn(console, 'error').mockImplementation(() => {});

  app = express();
  app.use(express.json());
  app.use('/api/admin/returns', require('../../app/routes/api/returns'));

  eventBus = require('../../app/events/eventBus');
  RefundService = require('../../app/services/RefundService');
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// GET / — pagination + errors
// ---------------------------------------------------------------------------
describe('GET /api/admin/returns — pagination and errors', () => {
  it('defaults to page 1 / limit 20 and echoes them as numbers', async () => {
    prisma.return.findMany.mockResolvedValue([]);
    prisma.return.count.mockResolvedValue(0);

    const res = await request(app).get('/api/admin/returns');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ returns: [], total: 0, page: 1, limit: 20 });

    const arg = prisma.return.findMany.mock.calls[0][0];
    expect(arg.skip).toBe(0);
    expect(arg.take).toBe(20);
    expect(arg.orderBy).toEqual({ createdAt: 'desc' });
    expect(arg.include).toEqual({ items: true, label: true });
  });

  it('translates page/limit into skip/take', async () => {
    prisma.return.findMany.mockResolvedValue([]);
    prisma.return.count.mockResolvedValue(57);

    const res = await request(app).get('/api/admin/returns?page=3&limit=10');
    expect(res.status).toBe(200);
    expect(res.body.page).toBe(3);
    expect(res.body.limit).toBe(10);
    expect(res.body.total).toBe(57);

    const arg = prisma.return.findMany.mock.calls[0][0];
    expect(arg.skip).toBe(20);
    expect(arg.take).toBe(10);
  });

  it('applies the same shop+status filter to the count query', async () => {
    prisma.return.findMany.mockResolvedValue([]);
    prisma.return.count.mockResolvedValue(0);

    await request(app).get('/api/admin/returns?status=PROCESSED');
    expect(prisma.return.count).toHaveBeenCalledWith({
      where: { shopId: 'shop_test_1', status: 'PROCESSED' },
    });
  });

  it('500 with a generic JSON error when prisma throws', async () => {
    prisma.return.findMany.mockRejectedValue(new Error('db down'));
    prisma.return.count.mockResolvedValue(0);

    const res = await request(app).get('/api/admin/returns');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
    // Never leak the underlying error message to the merchant
    expect(JSON.stringify(res.body)).not.toMatch(/db down/);
  });
});

// ---------------------------------------------------------------------------
// GET /:id
// ---------------------------------------------------------------------------
describe('GET /api/admin/returns/:id — scoping and errors', () => {
  it('queries by id AND shopId so another shop\'s return is a 404', async () => {
    prisma.return.findFirst.mockResolvedValue(null);

    const res = await request(app).get('/api/admin/returns/other_shop_return');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Return not found' });

    expect(prisma.return.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'other_shop_return', shopId: 'shop_test_1' },
    }));
  });

  it('includes items, label and events (newest first)', async () => {
    prisma.return.findFirst.mockResolvedValue(fakeReturn({ id: 'r1' }));
    await request(app).get('/api/admin/returns/r1');

    const arg = prisma.return.findFirst.mock.calls[0][0];
    expect(arg.include).toEqual({
      items: true,
      label: true,
      events: { orderBy: { createdAt: 'desc' } },
    });
  });

  it('500 when prisma throws', async () => {
    prisma.return.findFirst.mockRejectedValue(new Error('boom'));
    const res = await request(app).get('/api/admin/returns/r1');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
  });
});

// ---------------------------------------------------------------------------
// PUT /:id/approve
// ---------------------------------------------------------------------------
describe('PUT /api/admin/returns/:id/approve — guards and errors', () => {
  it('only looks up returns in REQUESTED status for this shop', async () => {
    prisma.return.findFirst.mockResolvedValue(null);
    const res = await request(app).put('/api/admin/returns/r1/approve');

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/REQUESTED/);
    expect(prisma.return.findFirst).toHaveBeenCalledWith({
      where: { id: 'r1', shopId: 'shop_test_1', status: 'REQUESTED' },
    });
    expect(prisma.return.update).not.toHaveBeenCalled();
  });

  it('500 and no event when the update throws', async () => {
    prisma.return.findFirst.mockResolvedValue(fakeReturn({ id: 'r1' }));
    prisma.return.update.mockRejectedValue(new Error('write failed'));
    const spy = jest.spyOn(eventBus, 'emit');

    const res = await request(app).put('/api/admin/returns/r1/approve');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
    expect(spy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// PUT /:id/reject
// ---------------------------------------------------------------------------
describe('PUT /api/admin/returns/:id/reject — guards and errors', () => {
  it('404 when the return is not REQUESTED (scoped by shop)', async () => {
    prisma.return.findFirst.mockResolvedValue(null);
    const res = await request(app).put('/api/admin/returns/r1/reject').send({ reason: 'x' });

    expect(res.status).toBe(404);
    expect(prisma.return.findFirst).toHaveBeenCalledWith({
      where: { id: 'r1', shopId: 'shop_test_1', status: 'REQUESTED' },
    });
    expect(prisma.return.update).not.toHaveBeenCalled();
  });

  it('rejects with undefined notes when no reason is supplied', async () => {
    prisma.return.findFirst.mockResolvedValue(fakeReturn({ id: 'r1' }));
    prisma.return.update.mockResolvedValue(fakeReturn({ id: 'r1', status: 'REJECTED' }));

    const res = await request(app).put('/api/admin/returns/r1/reject').send({});
    expect(res.status).toBe(200);
    expect(prisma.return.update).toHaveBeenCalledWith({
      where: { id: 'r1' }, data: { status: 'REJECTED', notes: undefined },
    });
  });

  it('500 when prisma throws', async () => {
    prisma.return.findFirst.mockRejectedValue(new Error('boom'));
    const res = await request(app).put('/api/admin/returns/r1/reject').send({ reason: 'x' });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
  });
});

// ---------------------------------------------------------------------------
// PUT /:id/process
// ---------------------------------------------------------------------------
describe('PUT /api/admin/returns/:id/process — guards and delegation', () => {
  it('restricts the lookup to processable statuses for this shop', async () => {
    prisma.return.findFirst.mockResolvedValue(null);
    const res = await request(app).put('/api/admin/returns/r1/process');

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/processable/);
    expect(prisma.return.findFirst).toHaveBeenCalledWith({
      where: { id: 'r1', shopId: 'shop_test_1', status: { in: PROCESSABLE } },
    });
    expect(RefundService.processRefund).not.toHaveBeenCalled();
  });

  it('delegates to RefundService with the route id', async () => {
    prisma.return.findFirst.mockResolvedValue(fakeReturn({ id: 'r9', status: 'APPROVED' }));
    const res = await request(app).put('/api/admin/returns/r9/process');
    expect(res.status).toBe(200);
    expect(RefundService.processRefund).toHaveBeenCalledWith('r9');
  });

  it('500 with fallback message when the thrown error has no message', async () => {
    prisma.return.findFirst.mockResolvedValue(fakeReturn({ status: 'RECEIVED' }));
    RefundService.processRefund.mockRejectedValue(new Error(''));
    const res = await request(app).put('/api/admin/returns/r1/process');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to process refund');
  });

  it('500 when the lookup itself throws', async () => {
    prisma.return.findFirst.mockRejectedValue(new Error('db gone'));
    const res = await request(app).put('/api/admin/returns/r1/process');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('db gone');
  });
});

// ---------------------------------------------------------------------------
// POST /bulk
// ---------------------------------------------------------------------------
describe('POST /api/admin/returns/bulk', () => {
  it('400 when ids is missing or not an array', async () => {
    let res = await request(app).post('/api/admin/returns/bulk').send({ action: 'approve' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/ids/);

    res = await request(app).post('/api/admin/returns/bulk').send({ action: 'approve', ids: 'r1' });
    expect(res.status).toBe(400);
  });

  it('validates ids before action (empty ids + bad action → ids error)', async () => {
    const res = await request(app).post('/api/admin/returns/bulk').send({ action: 'nuke', ids: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/ids/);
  });

  it('400 "ids must be a non-empty array" when the body is absent entirely (no crash)', async () => {
    // No JSON body → req.body is undefined in Express 5 → guarded destructure
    // falls through to ids validation instead of throwing.
    const res = await request(app).post('/api/admin/returns/bulk');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'ids must be a non-empty array' });
    expect(prisma.return.findFirst).not.toHaveBeenCalled();
  });

  describe('approve', () => {
    it('scopes every lookup by shopId and REQUESTED status', async () => {
      prisma.return.findFirst.mockResolvedValue(fakeReturn({ id: 'r1' }));
      prisma.return.update.mockResolvedValue(fakeReturn({ id: 'r1', status: 'APPROVED' }));

      await request(app).post('/api/admin/returns/bulk').send({ action: 'approve', ids: ['r1', 'r2'] });

      expect(prisma.return.findFirst).toHaveBeenCalledTimes(2);
      expect(prisma.return.findFirst).toHaveBeenNthCalledWith(1, {
        where: { id: 'r1', shopId: 'shop_test_1', status: 'REQUESTED' },
      });
      expect(prisma.return.findFirst).toHaveBeenNthCalledWith(2, {
        where: { id: 'r2', shopId: 'shop_test_1', status: 'REQUESTED' },
      });
    });

    it('emits return.approved once per successful id', async () => {
      prisma.return.findFirst.mockResolvedValue(fakeReturn());
      prisma.return.update
        .mockResolvedValueOnce(fakeReturn({ id: 'r1', status: 'APPROVED' }))
        .mockResolvedValueOnce(fakeReturn({ id: 'r2', status: 'APPROVED' }));
      const spy = jest.spyOn(eventBus, 'emit');

      const res = await request(app).post('/api/admin/returns/bulk').send({ action: 'approve', ids: ['r1', 'r2'] });
      expect(res.body).toEqual({ action: 'approve', success: 2, failed: [] });

      const approved = spy.mock.calls.filter(([name]) => name === 'return.approved');
      expect(approved.map(([, p]) => p.returnId)).toEqual(['r1', 'r2']);
      expect(approved[0][1]).toMatchObject({ shopId: 'shop_test_1', approvedBy: 'merchant' });
    });

    it('a throwing update marks that id failed and continues with the rest', async () => {
      prisma.return.findFirst.mockResolvedValue(fakeReturn());
      prisma.return.update
        .mockRejectedValueOnce(new Error('deadlock'))
        .mockResolvedValueOnce(fakeReturn({ id: 'r2', status: 'APPROVED' }));

      const res = await request(app).post('/api/admin/returns/bulk').send({ action: 'approve', ids: ['r1', 'r2'] });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ action: 'approve', success: 1, failed: ['r1'] });
    });
  });

  describe('reject', () => {
    it('writes the supplied reason into notes and emits return.rejected', async () => {
      prisma.return.findFirst.mockResolvedValue(fakeReturn({ id: 'r1' }));
      prisma.return.update.mockResolvedValue(fakeReturn({ id: 'r1', status: 'REJECTED' }));
      const spy = jest.spyOn(eventBus, 'emit');

      const res = await request(app).post('/api/admin/returns/bulk')
        .send({ action: 'reject', ids: ['r1'], reason: 'Outside window' });

      expect(res.body).toEqual({ action: 'reject', success: 1, failed: [] });
      expect(prisma.return.update).toHaveBeenCalledWith({
        where: { id: 'r1' }, data: { status: 'REJECTED', notes: 'Outside window' },
      });
      expect(spy).toHaveBeenCalledWith('return.rejected', {
        returnId: 'r1', shopId: 'shop_test_1', reason: 'Outside window',
      });
    });

    it('defaults notes to "Rejected" when no reason is given', async () => {
      prisma.return.findFirst.mockResolvedValue(fakeReturn({ id: 'r1' }));
      prisma.return.update.mockResolvedValue(fakeReturn({ id: 'r1', status: 'REJECTED' }));

      await request(app).post('/api/admin/returns/bulk').send({ action: 'reject', ids: ['r1'] });
      expect(prisma.return.update).toHaveBeenCalledWith({
        where: { id: 'r1' }, data: { status: 'REJECTED', notes: 'Rejected' },
      });
    });

    it('only rejects REQUESTED returns of this shop; others are reported failed', async () => {
      prisma.return.findFirst
        .mockResolvedValueOnce(null)                        // r1: wrong shop / status
        .mockResolvedValueOnce(fakeReturn({ id: 'r2' }));   // r2 ok
      prisma.return.update.mockResolvedValue(fakeReturn({ id: 'r2', status: 'REJECTED' }));

      const res = await request(app).post('/api/admin/returns/bulk').send({ action: 'reject', ids: ['r1', 'r2'] });
      expect(res.body).toEqual({ action: 'reject', success: 1, failed: ['r1'] });
      expect(prisma.return.findFirst).toHaveBeenNthCalledWith(1, {
        where: { id: 'r1', shopId: 'shop_test_1', status: 'REQUESTED' },
      });
      expect(prisma.return.update).toHaveBeenCalledTimes(1);
    });
  });

  describe('process', () => {
    it('calls RefundService.processRefund for each processable, shop-owned return', async () => {
      prisma.return.findFirst.mockResolvedValue(fakeReturn({ status: 'RECEIVED' }));

      const res = await request(app).post('/api/admin/returns/bulk').send({ action: 'process', ids: ['a', 'b'] });
      expect(res.body).toEqual({ action: 'process', success: 2, failed: [] });

      expect(prisma.return.findFirst).toHaveBeenNthCalledWith(1, {
        where: { id: 'a', shopId: 'shop_test_1', status: { in: PROCESSABLE } },
      });
      expect(RefundService.processRefund).toHaveBeenCalledTimes(2);
      expect(RefundService.processRefund).toHaveBeenNthCalledWith(1, 'a');
      expect(RefundService.processRefund).toHaveBeenNthCalledWith(2, 'b');
    });

    it('does not touch prisma.return.update directly (RefundService owns the transition)', async () => {
      prisma.return.findFirst.mockResolvedValue(fakeReturn({ status: 'RECEIVED' }));
      await request(app).post('/api/admin/returns/bulk').send({ action: 'process', ids: ['a'] });
      expect(prisma.return.update).not.toHaveBeenCalled();
    });

    it('partial failure: RefundService rejection for one id does not abort the batch', async () => {
      prisma.return.findFirst.mockResolvedValue(fakeReturn({ status: 'RECEIVED' }));
      RefundService.processRefund
        .mockResolvedValueOnce({ success: true })
        .mockRejectedValueOnce(new Error('Shopify 502'))
        .mockResolvedValueOnce({ success: true });

      const res = await request(app).post('/api/admin/returns/bulk')
        .send({ action: 'process', ids: ['a', 'b', 'c'] });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ action: 'process', success: 2, failed: ['b'] });
      expect(RefundService.processRefund).toHaveBeenCalledTimes(3);
    });

    it('skips RefundService entirely for returns not in a processable status', async () => {
      prisma.return.findFirst.mockResolvedValue(null);
      const res = await request(app).post('/api/admin/returns/bulk').send({ action: 'process', ids: ['a'] });
      expect(res.body).toEqual({ action: 'process', success: 0, failed: ['a'] });
      expect(RefundService.processRefund).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// POST /demo
// ---------------------------------------------------------------------------
describe('POST /api/admin/returns/demo', () => {
  it('uses the merchant email/currency and seeds one demo line item', async () => {
    prisma.shop.findUnique.mockResolvedValue(fakeShop({ email: 'owner@shop.co', currency: 'EUR' }));
    prisma.return.create.mockImplementation(async ({ data }) => ({ id: 'demo1', ...data }));

    const res = await request(app).post('/api/admin/returns/demo');
    expect(res.status).toBe(201);

    expect(prisma.shop.findUnique).toHaveBeenCalledWith({ where: { id: 'shop_test_1' } });
    const { data, include } = prisma.return.create.mock.calls[0][0];
    expect(include).toEqual({ items: true });
    expect(data).toMatchObject({
      shopId: 'shop_test_1',
      shopifyOrderId: 'demo',
      customerEmail: 'owner@shop.co',
      customerName: 'Demo Customer',
      status: 'REQUESTED',
      resolution: 'REFUND',
      totalValue: 42.0,
      currency: 'EUR',
    });
    expect(data.shopifyOrderName).toMatch(/^#DEMO-\d{4}$/);
    expect(data.items.create).toHaveLength(1);
    expect(data.items.create[0]).toMatchObject({
      shopifyLineItemId: 'demo-li',
      sku: 'DEMO-SKU',
      quantity: 1,
      unitPrice: 42.0,
      reason: 'doesnt_fit',
      photoUrls: [],
    });
  });

  it('falls back to a placeholder email and GBP when the shop row is missing', async () => {
    prisma.shop.findUnique.mockResolvedValue(null);
    prisma.return.create.mockResolvedValue(fakeReturn({ id: 'demo1' }));

    const res = await request(app).post('/api/admin/returns/demo');
    expect(res.status).toBe(201);
    const { data } = prisma.return.create.mock.calls[0][0];
    expect(data.customerEmail).toBe('demo@returnsflow.uk');
    expect(data.currency).toBe('GBP');
  });

  it('emits return.created with the created id', async () => {
    prisma.shop.findUnique.mockResolvedValue(fakeShop());
    prisma.return.create.mockResolvedValue(fakeReturn({ id: 'demo_xyz' }));
    const spy = jest.spyOn(eventBus, 'emit');

    await request(app).post('/api/admin/returns/demo');
    expect(spy).toHaveBeenCalledWith('return.created', { returnId: 'demo_xyz', shopId: 'shop_test_1' });
  });

  it('500 and no event when the create throws', async () => {
    prisma.shop.findUnique.mockResolvedValue(fakeShop());
    prisma.return.create.mockRejectedValue(new Error('unique violation'));
    const spy = jest.spyOn(eventBus, 'emit');

    const res = await request(app).post('/api/admin/returns/demo');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to create demo return' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('is not gated by plan or monthly return count', async () => {
    // Re-mount with a FREE shop that has exhausted its allowance
    jest.resetModules();
    prisma = installPrismaMock();
    jest.doMock('../../app/middleware/auth', () => ({
      verifyShopifySession: (req, res, next) => {
        req.shopId = 'shop_test_1';
        req.shop = fakeShop({ plan: 'FREE', returnCount: 999 });
        next();
      },
    }));
    const freeApp = express();
    freeApp.use(express.json());
    freeApp.use('/api/admin/returns', require('../../app/routes/api/returns'));

    prisma.shop.findUnique.mockResolvedValue(fakeShop({ plan: 'FREE', returnCount: 999 }));
    prisma.return.create.mockResolvedValue(fakeReturn({ id: 'demo1' }));

    const res = await request(freeApp).post('/api/admin/returns/demo');
    expect(res.status).toBe(201);
    // And it does not bump the billing-cycle counter
    expect(prisma.shop.update).not.toHaveBeenCalled();
  });
});

const request = require('supertest');
const express = require('express');
const { installPrismaMock, fakeShop, fakeReturn } = require('../helpers');

let app;
let prisma;
let eventBus;
let labelService;

beforeEach(() => {
  jest.resetModules();
  prisma = installPrismaMock();

  // Mock the auth middleware so every request is authenticated as shop_test_1
  jest.doMock('../../app/middleware/auth', () => ({
    verifyShopifySession: (req, res, next) => {
      req.shopId = 'shop_test_1';
      req.shopDomain = 'test-shop.myshopify.com';
      req.shop = fakeShop({ id: 'shop_test_1', plan: 'GROWTH' });
      next();
    },
  }));

  // Stub RefundService — full coverage is in service tests
  jest.doMock('../../app/services/RefundService', () => ({
    processRefund: jest.fn().mockResolvedValue({ success: true, type: 'REFUND', amount: 50 }),
  }));
  // Approval checks the shop has a returns address (LabelService has its own tests)
  labelService = {
    hasReturnsAddress: jest.fn().mockResolvedValue(true),
    RETURNS_ADDRESS_REQUIRED_MESSAGE: 'Set your returns address before approving returns: Settings → Warehouse address.',
  };
  jest.doMock('../../app/services/LabelService', () => labelService);
  prisma.shop.findUnique.mockResolvedValue(fakeShop({ id: 'shop_test_1', settings: { warehouseLine1: '1 Dock Road', warehousePostcode: 'BS1 1AA' } }));

  app = express();
  app.use(express.json());
  app.use('/api/admin/returns', require('../../app/routes/api/returns'));

  eventBus = require('../../app/events/eventBus');
});

describe('GET /api/admin/returns', () => {
  it('lists returns scoped to req.shopId', async () => {
    prisma.return.findMany.mockResolvedValue([fakeReturn()]);
    prisma.return.count.mockResolvedValue(1);

    const res = await request(app).get('/api/admin/returns');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);

    expect(prisma.return.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { shopId: 'shop_test_1' },
    }));
  });

  it('filters by status query', async () => {
    prisma.return.findMany.mockResolvedValue([]);
    prisma.return.count.mockResolvedValue(0);
    await request(app).get('/api/admin/returns?status=APPROVED');
    expect(prisma.return.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { shopId: 'shop_test_1', status: 'APPROVED' },
    }));
  });
});

describe('GET /api/admin/returns/:id', () => {
  it('404 when scoped findFirst returns null', async () => {
    prisma.return.findFirst.mockResolvedValue(null);
    const res = await request(app).get('/api/admin/returns/missing');
    expect(res.status).toBe(404);
  });

  it('200 returns the record', async () => {
    prisma.return.findFirst.mockResolvedValue(fakeReturn({ id: 'r1' }));
    const res = await request(app).get('/api/admin/returns/r1');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('r1');
  });
});

describe('PUT /api/admin/returns/:id/approve', () => {
  it('404 when return not in REQUESTED status', async () => {
    prisma.return.findFirst.mockResolvedValue(null);
    const res = await request(app).put('/api/admin/returns/r1/approve');
    expect(res.status).toBe(404);
  });

  it('409 with a fix when the shop has no returns address — nothing is approved', async () => {
    labelService.hasReturnsAddress.mockResolvedValue(false);
    prisma.return.findFirst.mockResolvedValue(fakeReturn({ id: 'r1', status: 'REQUESTED' }));
    const spy = jest.spyOn(eventBus, 'emit');

    const res = await request(app).put('/api/admin/returns/r1/approve');

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: expect.stringMatching(/Settings → Warehouse address/), code: 'RETURNS_ADDRESS_MISSING' });
    expect(prisma.return.update).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalledWith('return.approved', expect.anything());
  });

  it('200 updates to APPROVED and emits event', async () => {
    prisma.return.findFirst.mockResolvedValue(fakeReturn({ id: 'r1', status: 'REQUESTED' }));
    prisma.return.update.mockResolvedValue(fakeReturn({ id: 'r1', status: 'APPROVED' }));

    const spy = jest.spyOn(eventBus, 'emit');
    const res = await request(app).put('/api/admin/returns/r1/approve');

    expect(res.status).toBe(200);
    expect(prisma.return.update).toHaveBeenCalledWith({
      where: { id: 'r1' }, data: { status: 'APPROVED' },
    });
    expect(spy).toHaveBeenCalledWith('return.approved', expect.objectContaining({
      returnId: 'r1', shopId: 'shop_test_1',
    }));
  });

  it('409 for a test return ("Create test return"): it has no real order to post a label from', async () => {
    prisma.return.findFirst.mockResolvedValue(fakeReturn({ id: 'r1', status: 'REQUESTED', shopifyOrderId: 'demo' }));
    const spy = jest.spyOn(eventBus, 'emit');

    const res = await request(app).put('/api/admin/returns/r1/approve');

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: expect.stringMatching(/test return.*real order/), code: 'TEST_RETURN' });
    expect(prisma.return.update).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalledWith('return.approved', expect.anything());
  });
});

describe('PUT /api/admin/returns/:id/reject', () => {
  it('200 updates to REJECTED with notes, emits event', async () => {
    prisma.return.findFirst.mockResolvedValue(fakeReturn({ id: 'r1' }));
    prisma.return.update.mockResolvedValue(fakeReturn({ id: 'r1', status: 'REJECTED' }));

    const spy = jest.spyOn(eventBus, 'emit');
    const res = await request(app).put('/api/admin/returns/r1/reject').send({ reason: 'Out of window' });

    expect(res.status).toBe(200);
    expect(prisma.return.update).toHaveBeenCalledWith({
      where: { id: 'r1' }, data: { status: 'REJECTED', notes: 'Out of window' },
    });
    expect(spy).toHaveBeenCalledWith('return.rejected', expect.objectContaining({
      reason: 'Out of window',
    }));
  });
});

describe('PUT /api/admin/returns/:id/process', () => {
  it('404 when status is outside the processable set', async () => {
    prisma.return.findFirst.mockResolvedValue(null);
    const res = await request(app).put('/api/admin/returns/r1/process');
    expect(res.status).toBe(404);
  });

  it('200 returns RefundService result on success', async () => {
    prisma.return.findFirst.mockResolvedValue(fakeReturn({ status: 'RECEIVED' }));
    const res = await request(app).put('/api/admin/returns/r1/process');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ success: true, type: 'REFUND' }));
  });

  it('500 propagates RefundService failures with the message', async () => {
    prisma.return.findFirst.mockResolvedValue(fakeReturn({ status: 'RECEIVED' }));
    const RefundService = require('../../app/services/RefundService');
    RefundService.processRefund.mockRejectedValue(new Error('Shopify is down'));
    const res = await request(app).put('/api/admin/returns/r1/process');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Shopify is down');
  });
});

describe('POST /api/admin/returns/bulk', () => {
  it('400 when ids is empty', async () => {
    const res = await request(app).post('/api/admin/returns/bulk').send({ action: 'approve', ids: [] });
    expect(res.status).toBe(400);
  });

  it('400 on an invalid action', async () => {
    const res = await request(app).post('/api/admin/returns/bulk').send({ action: 'nuke', ids: ['r1'] });
    expect(res.status).toBe(400);
  });

  it('409 for a bulk approve when the shop has no returns address — none approved', async () => {
    labelService.hasReturnsAddress.mockResolvedValue(false);
    const res = await request(app).post('/api/admin/returns/bulk').send({ action: 'approve', ids: ['r1', 'r2'] });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('RETURNS_ADDRESS_MISSING');
    expect(prisma.return.update).not.toHaveBeenCalled();
  });

  it('does not check the address for reject / process bulk actions', async () => {
    labelService.hasReturnsAddress.mockResolvedValue(false);
    prisma.return.findFirst.mockResolvedValue(fakeReturn({ id: 'r1', status: 'REQUESTED' }));
    prisma.return.update.mockResolvedValue(fakeReturn({ id: 'r1', status: 'REJECTED' }));
    const res = await request(app).post('/api/admin/returns/bulk').send({ action: 'reject', ids: ['r1'], reason: 'x' });
    expect(res.status).toBe(200);
    expect(labelService.hasReturnsAddress).not.toHaveBeenCalled();
  });

  it('approves found returns and reports the rest as failed', async () => {
    prisma.return.findFirst
      .mockResolvedValueOnce(fakeReturn({ id: 'r1', status: 'REQUESTED' })) // r1 found
      .mockResolvedValueOnce(null);                                          // r2 not REQUESTED
    prisma.return.update.mockResolvedValue(fakeReturn({ id: 'r1', status: 'APPROVED' }));

    const res = await request(app).post('/api/admin/returns/bulk').send({ action: 'approve', ids: ['r1', 'r2'] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ action: 'approve', success: 1, failed: ['r2'] });
  });

  it('bulk approve skips test returns (reported as failed, never approved)', async () => {
    prisma.return.findFirst
      .mockResolvedValueOnce(fakeReturn({ id: 'r1', status: 'REQUESTED' }))
      .mockResolvedValueOnce(fakeReturn({ id: 'r_test', status: 'REQUESTED', shopifyOrderId: 'demo' }));
    prisma.return.update.mockResolvedValue(fakeReturn({ id: 'r1', status: 'APPROVED' }));

    const res = await request(app).post('/api/admin/returns/bulk').send({ action: 'approve', ids: ['r1', 'r_test'] });

    expect(res.body).toEqual({ action: 'approve', success: 1, failed: ['r_test'] });
    expect(prisma.return.update).toHaveBeenCalledTimes(1);
    expect(prisma.return.update.mock.calls[0][0].where).toEqual({ id: 'r1' });
  });
});

describe('POST /api/admin/returns/demo', () => {
  it('creates a shop-scoped demo return and emits return.created', async () => {
    prisma.shop.findUnique.mockResolvedValue(fakeShop({ id: 'shop_test_1', email: 'm@shop.co' }));
    prisma.return.create.mockResolvedValue(fakeReturn({ id: 'demo1', shopifyOrderId: 'demo' }));
    const spy = jest.spyOn(eventBus, 'emit');

    const res = await request(app).post('/api/admin/returns/demo');
    expect(res.status).toBe(201);
    const createArg = prisma.return.create.mock.calls[0][0];
    expect(createArg.data.shopId).toBe('shop_test_1');
    expect(createArg.data.shopifyOrderId).toBe('demo');
    expect(spy).toHaveBeenCalledWith('return.created', expect.objectContaining({ shopId: 'shop_test_1' }));
  });
});

describe('PUT /api/admin/returns/:id/label — generate or retry the label', () => {
  let LabelService;
  let NotificationService;
  beforeEach(() => {
    LabelService = {
      generateLabel: jest.fn().mockResolvedValue({ id: 'lbl_1', trackingCode: 'TRK1', status: 'created' }),
      _advanceToLabelSent: jest.fn().mockResolvedValue({ count: 1 }),
    };
    NotificationService = { sendLabelReady: jest.fn().mockResolvedValue({ sent: true }) };
    jest.doMock('../../app/services/LabelService', () => LabelService);
    jest.doMock('../../app/services/NotificationService', () => NotificationService);
    prisma.returnEvent.create.mockResolvedValue({});
  });

  it('404 unless the return is approved and belongs to the shop', async () => {
    prisma.return.findFirst.mockResolvedValue(null);
    const res = await request(app).put('/api/admin/returns/r1/label');
    expect(res.status).toBe(404);
    expect(prisma.return.findFirst.mock.calls[0][0].where).toEqual({ id: 'r1', shopId: 'shop_test_1', status: { in: ['APPROVED', 'LABEL_SENT'] } });
  });

  it('generates the label and notes the retry on the timeline (LabelService emails the customer itself)', async () => {
    prisma.return.findFirst.mockResolvedValue(fakeReturn({ id: 'r1', status: 'APPROVED', label: null }));

    const res = await request(app).put('/api/admin/returns/r1/label');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 'lbl_1', trackingCode: 'TRK1' });
    expect(LabelService.generateLabel).toHaveBeenCalledWith('r1');
    expect(prisma.returnEvent.create).toHaveBeenCalledWith({
      data: { returnId: 'r1', type: 'label.generated', actor: 'merchant', data: { retry: true } },
    });
    expect(NotificationService.sendLabelReady).not.toHaveBeenCalled();
  });

  it('a label whose follow-up steps did not finish ("saved") is resumed through generateLabel, not handed back as-is', async () => {
    prisma.return.findFirst.mockResolvedValue(fakeReturn({ id: 'r1', status: 'APPROVED', label: { id: 'lbl_1', status: 'saved', trackingCode: 'TRK1' } }));
    const res = await request(app).put('/api/admin/returns/r1/label');
    expect(res.status).toBe(200);
    expect(LabelService.generateLabel).toHaveBeenCalledWith('r1');
  });

  it('returns the existing label without generating again, but still moves an APPROVED return on', async () => {
    prisma.return.findFirst.mockResolvedValue(fakeReturn({ id: 'r1', status: 'LABEL_SENT', label: { id: 'lbl_old', status: 'created', trackingCode: 'OLD' } }));
    const res = await request(app).put('/api/admin/returns/r1/label');
    expect(res.status).toBe(200);
    expect(res.body.trackingCode).toBe('OLD');
    expect(LabelService.generateLabel).not.toHaveBeenCalled();
    expect(LabelService._advanceToLabelSent).toHaveBeenCalledWith('r1');
  });

  it('422 with the reason when the label cannot be made (merchant can fix and retry)', async () => {
    prisma.return.findFirst.mockResolvedValue(fakeReturn({ id: 'r1', status: 'APPROVED', label: null }));
    LabelService.generateLabel.mockRejectedValue(new Error('No label was bought: add your returns address in Settings'));
    const res = await request(app).put('/api/admin/returns/r1/label');
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/returns address/);
    expect(NotificationService.sendLabelReady).not.toHaveBeenCalled();
  });
});

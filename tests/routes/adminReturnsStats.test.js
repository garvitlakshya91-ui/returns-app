// GET /api/admin/returns/stats — dashboard totals over every return.

const request = require('supertest');
const express = require('express');
const { installPrismaMock, fakeShop } = require('../helpers');

let app;
let prisma;

beforeEach(() => {
  jest.resetModules();
  prisma = installPrismaMock();
  jest.doMock('../../app/middleware/auth', () => ({
    verifyShopifySession: (req, res, next) => {
      req.shopId = 'shop_test_1';
      req.shop = fakeShop({ id: 'shop_test_1' });
      next();
    },
  }));
  app = express();
  app.use(express.json());
  app.use('/api/admin/returns', require('../../app/routes/api/returns'));
});

describe('GET /api/admin/returns/stats', () => {
  it('counts every status over the whole shop, not just the latest page', async () => {
    prisma.return.groupBy.mockResolvedValue([
      { status: 'REQUESTED', _count: { _all: 4 } },
      { status: 'LABEL_SENT', _count: { _all: 2 } },
      { status: 'RECEIVED', _count: { _all: 1 } },
      { status: 'PROCESSED', _count: { _all: 31 } },
      { status: 'REJECTED', _count: { _all: 3 } },
    ]);
    prisma.return.aggregate
      .mockResolvedValueOnce({ _sum: { totalValue: 3120 } })
      .mockResolvedValueOnce({ _sum: { refundAmount: 1840 } });
    prisma.shop.findUnique.mockResolvedValue({ currency: 'USD' });

    const res = await request(app).get('/api/admin/returns/stats');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      total: 41, pending: 4, inProgress: 3, processed: 31, rejected: 3,
      totalValue: 3120, refundedValue: 1840, currency: 'USD',
    });
    expect(prisma.return.groupBy.mock.calls[0][0].where).toEqual({ shopId: 'shop_test_1' });
    expect(prisma.return.aggregate.mock.calls[1][0].where).toEqual({ shopId: 'shop_test_1', status: 'PROCESSED' });
  });

  it('returns zeros for a shop with no returns', async () => {
    prisma.return.groupBy.mockResolvedValue([]);
    prisma.return.aggregate.mockResolvedValue({ _sum: {} });
    prisma.shop.findUnique.mockResolvedValue(null);
    const res = await request(app).get('/api/admin/returns/stats');
    expect(res.body).toEqual({ total: 0, pending: 0, inProgress: 0, processed: 0, rejected: 0, totalValue: 0, refundedValue: 0, currency: 'GBP' });
  });

  it('500 when the database throws', async () => {
    prisma.return.groupBy.mockRejectedValue(new Error('db down'));
    const res = await request(app).get('/api/admin/returns/stats');
    expect(res.status).toBe(500);
  });
});

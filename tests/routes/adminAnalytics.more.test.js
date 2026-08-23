// Error branches + gating details for app/routes/api/analytics.js.
// Happy paths and the basic FREE/STARTER 403 are in adminAnalytics.test.js.

const request = require('supertest');
const express = require('express');
const { installPrismaMock, fakeShop } = require('../helpers');

let app;
let AnalyticsService;
let logger;

function mountApp({ plan = 'GROWTH', withShop = true } = {}) {
  jest.resetModules();
  // planGating requires the real database module; mock it so no PrismaClient
  // (and its process signal handlers) is instantiated per mount.
  installPrismaMock();

  jest.doMock('../../app/middleware/auth', () => ({
    verifyShopifySession: (req, res, next) => {
      req.shopId = 'shop_test_1';
      if (withShop) req.shop = fakeShop({ plan });
      next();
    },
  }));

  jest.doMock('../../app/services/AnalyticsService', () => ({
    getSummary: jest.fn().mockResolvedValue({ totalReturns: 1 }),
    getTopReturnedSkus: jest.fn().mockResolvedValue([]),
    getTrend: jest.fn().mockResolvedValue([]),
    exportCsv: jest.fn().mockResolvedValue('a,b\n1,2'),
  }));

  jest.doMock('../../app/utils/logger', () => ({
    error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(),
  }));

  const a = express();
  a.use(express.json());
  a.use('/api/admin/analytics', require('../../app/routes/api/analytics'));

  AnalyticsService = require('../../app/services/AnalyticsService');
  logger = require('../../app/utils/logger');
  return a;
}

beforeEach(() => {
  app = mountApp();
});

describe('analytics error branches (service throws → 500 JSON, error logged)', () => {
  it('GET /summary', async () => {
    const err = new Error('summary exploded');
    AnalyticsService.getSummary.mockRejectedValue(err);

    const res = await request(app).get('/api/admin/analytics/summary');
    expect(res.status).toBe(500);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.body).toEqual({ error: 'Failed to load analytics' });
    expect(logger.error).toHaveBeenCalledWith({ err }, 'Analytics summary error');
  });

  it('GET /skus', async () => {
    const err = new Error('skus exploded');
    AnalyticsService.getTopReturnedSkus.mockRejectedValue(err);

    const res = await request(app).get('/api/admin/analytics/skus');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to load SKU analytics' });
    expect(logger.error).toHaveBeenCalledWith({ err }, 'SKU analytics error');
  });

  it('GET /trend', async () => {
    const err = new Error('trend exploded');
    AnalyticsService.getTrend.mockRejectedValue(err);

    const res = await request(app).get('/api/admin/analytics/trend');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to load trend' });
    expect(logger.error).toHaveBeenCalledWith({ err }, 'Trend analytics error');
  });

  it('GET /export responds JSON (not CSV headers) on failure', async () => {
    const err = new Error('export exploded');
    AnalyticsService.exportCsv.mockRejectedValue(err);

    const res = await request(app).get('/api/admin/analytics/export');
    expect(res.status).toBe(500);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.headers['content-disposition']).toBeUndefined();
    expect(res.body).toEqual({ error: 'Failed to export CSV' });
    expect(logger.error).toHaveBeenCalledWith({ err }, 'CSV export error');
  });

  it('never leaks the underlying error message to the client', async () => {
    AnalyticsService.getSummary.mockRejectedValue(new Error('SELECT * FROM secret_table failed'));
    const res = await request(app).get('/api/admin/analytics/summary');
    expect(JSON.stringify(res.body)).not.toMatch(/secret_table/);
  });
});

describe('query parsing edge cases', () => {
  it('non-numeric days falls back to 30', async () => {
    await request(app).get('/api/admin/analytics/summary?days=abc');
    expect(AnalyticsService.getSummary).toHaveBeenCalledWith('shop_test_1', 30);
  });

  it('days=0 falls back to 30 (|| semantics)', async () => {
    await request(app).get('/api/admin/analytics/trend?days=0');
    expect(AnalyticsService.getTrend).toHaveBeenCalledWith('shop_test_1', 30);
  });

  it('trend clamps days to 365', async () => {
    await request(app).get('/api/admin/analytics/trend?days=1000');
    expect(AnalyticsService.getTrend).toHaveBeenCalledWith('shop_test_1', 365);
  });

  it('skus defaults limit to 10 and tolerates garbage', async () => {
    await request(app).get('/api/admin/analytics/skus?limit=lots');
    expect(AnalyticsService.getTopReturnedSkus).toHaveBeenCalledWith('shop_test_1', 10);
  });
});

describe('plan gating applied to every analytics endpoint', () => {
  const endpoints = ['summary', 'skus', 'trend', 'export'];

  it.each(endpoints)('FREE plan → 403 upgradeRequired on /%s, service never called', async (ep) => {
    app = mountApp({ plan: 'FREE' });
    const res = await request(app).get(`/api/admin/analytics/${ep}`);

    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: 'Full analytics require Growth plan or higher',
      plan: 'FREE',
      upgradeRequired: true,
    });
    expect(AnalyticsService.getSummary).not.toHaveBeenCalled();
    expect(AnalyticsService.getTopReturnedSkus).not.toHaveBeenCalled();
    expect(AnalyticsService.getTrend).not.toHaveBeenCalled();
    expect(AnalyticsService.exportCsv).not.toHaveBeenCalled();
  });

  it('STARTER → 403 with plan echoed', async () => {
    app = mountApp({ plan: 'STARTER' });
    const res = await request(app).get('/api/admin/analytics/export');
    expect(res.status).toBe(403);
    expect(res.body.plan).toBe('STARTER');
    expect(res.body.upgradeRequired).toBe(true);
  });

  it('unknown plan value is treated as FREE (403)', async () => {
    app = mountApp({ plan: 'ENTERPRISE_LEGACY' });
    const res = await request(app).get('/api/admin/analytics/summary');
    expect(res.status).toBe(403);
  });

  it('401 when auth did not attach req.shop', async () => {
    app = mountApp({ withShop: false });
    const res = await request(app).get('/api/admin/analytics/summary');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Shop not authenticated' });
  });

  it('PRO passes the gate and attaches planLimits before the handler runs', async () => {
    app = mountApp({ plan: 'PRO' });
    const res = await request(app).get('/api/admin/analytics/summary');
    expect(res.status).toBe(200);
    expect(AnalyticsService.getSummary).toHaveBeenCalledWith('shop_test_1', 30);
  });
});

const request = require('supertest');
const express = require('express');
const { fakeShop } = require('../helpers');

function appWithShopPlan(plan) {
  jest.resetModules();

  jest.doMock('../../app/middleware/auth', () => ({
    verifyShopifySession: (req, res, next) => {
      req.shopId = 'shop_test_1';
      req.shop = fakeShop({ plan });
      next();
    },
  }));

  jest.doMock('../../app/services/AnalyticsService', () => ({
    getSummary: jest.fn().mockResolvedValue({ totalReturns: 5 }),
    getTopReturnedSkus: jest.fn().mockResolvedValue([{ sku: 'X', totalReturns: 2 }]),
    getTrend: jest.fn().mockResolvedValue([{ date: '2026-01-01', count: 1, value: 10 }]),
    exportCsv: jest.fn().mockResolvedValue('header\nrow'),
  }));

  const app = express();
  app.use(express.json());
  app.use('/api/admin/analytics', require('../../app/routes/api/analytics'));
  return app;
}

describe('analytics plan gating', () => {
  it.each(['FREE', 'STARTER'])('403 for %s plan', async (plan) => {
    const res = await request(appWithShopPlan(plan)).get('/api/admin/analytics/summary');
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Growth/);
  });

  it.each(['GROWTH', 'PRO'])('200 for %s plan', async (plan) => {
    const res = await request(appWithShopPlan(plan)).get('/api/admin/analytics/summary');
    expect(res.status).toBe(200);
  });
});

describe('analytics endpoints (GROWTH)', () => {
  let app;
  beforeEach(() => { app = appWithShopPlan('GROWTH'); });

  it('GET /summary forwards days query and returns the service result', async () => {
    const AnalyticsService = require('../../app/services/AnalyticsService');
    const res = await request(app).get('/api/admin/analytics/summary?days=14');
    expect(res.status).toBe(200);
    expect(res.body.totalReturns).toBe(5);
    expect(AnalyticsService.getSummary).toHaveBeenCalledWith('shop_test_1', 14);
  });

  it('clamps days to 365 maximum', async () => {
    const AnalyticsService = require('../../app/services/AnalyticsService');
    await request(app).get('/api/admin/analytics/summary?days=9999');
    expect(AnalyticsService.getSummary).toHaveBeenCalledWith('shop_test_1', 365);
  });

  it('GET /skus clamps limit to 50', async () => {
    const AnalyticsService = require('../../app/services/AnalyticsService');
    await request(app).get('/api/admin/analytics/skus?limit=100');
    expect(AnalyticsService.getTopReturnedSkus).toHaveBeenCalledWith('shop_test_1', 50);
  });

  it('GET /trend returns bucket array', async () => {
    const res = await request(app).get('/api/admin/analytics/trend');
    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({ date: '2026-01-01', count: 1 });
  });

  it('GET /export returns CSV with correct headers', async () => {
    const res = await request(app).get('/api/admin/analytics/export');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/attachment.*returns-/);
    expect(res.text).toBe('header\nrow');
  });
});

const { Router } = require('express');
const { verifyShopifySession } = require('../../middleware/auth');
const AnalyticsService = require('../../services/AnalyticsService');
const logger = require('../../utils/logger');

const router = Router();
router.use(verifyShopifySession);

/**
 * GET /api/admin/analytics/summary
 * Returns dashboard summary metrics.
 */
router.get('/summary', async (req, res) => {
  try {
    const days = Math.min(Number(req.query.days) || 30, 365);
    const data = await AnalyticsService.getSummary(req.shopId, days);
    res.json(data);
  } catch (err) {
    logger.error({ err }, 'Analytics summary error');
    res.status(500).json({ error: 'Failed to load analytics' });
  }
});

/**
 * GET /api/admin/analytics/skus
 * Top returned SKUs with reason breakdowns.
 */
router.get('/skus', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 10, 50);
    const data = await AnalyticsService.getTopReturnedSkus(req.shopId, limit);
    res.json(data);
  } catch (err) {
    logger.error({ err }, 'SKU analytics error');
    res.status(500).json({ error: 'Failed to load SKU analytics' });
  }
});

/**
 * GET /api/admin/analytics/trend
 * Daily return counts over time.
 */
router.get('/trend', async (req, res) => {
  try {
    const days = Math.min(Number(req.query.days) || 30, 365);
    const data = await AnalyticsService.getTrend(req.shopId, days);
    res.json(data);
  } catch (err) {
    logger.error({ err }, 'Trend analytics error');
    res.status(500).json({ error: 'Failed to load trend' });
  }
});

/**
 * GET /api/admin/analytics/export
 * Export all returns as CSV.
 */
router.get('/export', async (req, res) => {
  try {
    const csv = await AnalyticsService.exportCsv(req.shopId);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="returns-${Date.now()}.csv"`);
    res.send(csv);
  } catch (err) {
    logger.error({ err }, 'CSV export error');
    res.status(500).json({ error: 'Failed to export CSV' });
  }
});

module.exports = router;

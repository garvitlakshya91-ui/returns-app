const { createWorker, QUEUE_NAMES } = require('./queue');
const prisma = require('../config/database');

const worker = createWorker(QUEUE_NAMES.AGGREGATE_ANALYTICS, async (job) => {
  const { shopId, period, periodType } = job.data;

  try {
    // Count returns by status for the period
    const returns = await prisma.return.findMany({
      where: {
        shopId,
        createdAt: { gte: new Date(period) },
      },
      include: { items: true },
    });

    const metrics = {
      totalReturns: returns.length,
      byStatus: {},
      byReason: {},
      totalValue: 0,
      refundedValue: 0,
    };

    for (const r of returns) {
      metrics.byStatus[r.status] = (metrics.byStatus[r.status] || 0) + 1;
      metrics.totalValue += Number(r.totalValue);
      metrics.refundedValue += Number(r.refundAmount || 0);

      for (const item of r.items) {
        metrics.byReason[item.reason] = (metrics.byReason[item.reason] || 0) + 1;
      }
    }

    await prisma.analyticsSnapshot.upsert({
      where: {
        shopId_period_periodType: { shopId, period, periodType },
      },
      update: { metrics },
      create: { shopId, period, periodType, metrics },
    });

    return metrics;
  } catch (err) {
    console.error(`[Analytics] Aggregation failed for ${shopId}:`, err.message);
    throw err;
  }
});

module.exports = worker;

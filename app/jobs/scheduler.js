const { getQueue, QUEUE_NAMES } = require('./queue');
const prisma = require('../config/database');
const logger = require('../utils/logger');

/**
 * Schedule nightly analytics aggregation for all active shops.
 * Runs at 2am local time daily.
 */
async function scheduleNightlyAnalytics() {
  const queue = getQueue(QUEUE_NAMES.AGGREGATE_ANALYTICS);
  if (!queue) {
    logger.warn('Analytics queue unavailable — scheduler skipped');
    return;
  }

  const repeatable = await queue.getRepeatableJobs();
  for (const job of repeatable) {
    await queue.removeRepeatableByKey(job.key);
  }

  const shops = await prisma.shop.findMany({
    where: { shopifyToken: { not: '' } },
    select: { id: true },
  });

  for (const shop of shops) {
    await queue.add(
      `analytics-${shop.id}`,
      {
        shopId: shop.id,
        period: new Date().toISOString().slice(0, 10),
        periodType: 'daily',
      },
      { repeat: { pattern: '0 2 * * *' } },
    );
  }

  logger.info({ shopCount: shops.length }, 'Nightly analytics scheduled');
}

module.exports = { scheduleNightlyAnalytics };

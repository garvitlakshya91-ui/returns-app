const prisma = require('../config/database');

class AnalyticsService {
  /**
   * Get summary metrics for a shop over the last N days.
   */
  static async getSummary(shopId, days = 30) {
    const since = new Date(Date.now() - days * 86400000);

    const [total, processed, rejected, pending, agg] = await Promise.all([
      prisma.return.count({ where: { shopId, createdAt: { gte: since } } }),
      prisma.return.count({ where: { shopId, status: 'PROCESSED', createdAt: { gte: since } } }),
      prisma.return.count({ where: { shopId, status: 'REJECTED', createdAt: { gte: since } } }),
      prisma.return.count({ where: { shopId, status: 'REQUESTED', createdAt: { gte: since } } }),
      prisma.return.aggregate({
        where: { shopId, createdAt: { gte: since } },
        _sum: { totalValue: true, refundAmount: true },
      }),
    ]);

    return {
      periodDays: days,
      totalReturns: total,
      processedReturns: processed,
      rejectedReturns: rejected,
      pendingReturns: pending,
      totalValue: Number(agg._sum.totalValue || 0),
      refundedValue: Number(agg._sum.refundAmount || 0),
      revenueRetained: Number(agg._sum.totalValue || 0) - Number(agg._sum.refundAmount || 0),
    };
  }

  /**
   * Get top returned SKUs with reason breakdowns.
   */
  static async getTopReturnedSkus(shopId, limit = 10) {
    const items = await prisma.returnItem.groupBy({
      by: ['sku', 'productTitle'],
      where: { return: { shopId } },
      _count: { sku: true },
      _sum: { quantity: true },
      orderBy: { _count: { sku: 'desc' } },
      take: limit,
    });

    // Get reason breakdown per SKU
    const enriched = await Promise.all(items.map(async (item) => {
      const reasons = await prisma.returnItem.groupBy({
        by: ['reason'],
        where: { return: { shopId }, sku: item.sku },
        _count: { reason: true },
      });
      return {
        sku: item.sku,
        productTitle: item.productTitle,
        totalReturns: item._count.sku,
        totalQuantity: item._sum.quantity || 0,
        reasonBreakdown: reasons.reduce((acc, r) => {
          acc[r.reason] = r._count.reason;
          return acc;
        }, {}),
      };
    }));

    return enriched;
  }

  /**
   * Get return rate trend over time (daily counts).
   */
  static async getTrend(shopId, days = 30) {
    const since = new Date(Date.now() - days * 86400000);
    const returns = await prisma.return.findMany({
      where: { shopId, createdAt: { gte: since } },
      select: { createdAt: true, status: true, totalValue: true },
      orderBy: { createdAt: 'asc' },
    });

    const buckets = {};
    for (const r of returns) {
      const day = r.createdAt.toISOString().slice(0, 10);
      if (!buckets[day]) buckets[day] = { date: day, count: 0, value: 0 };
      buckets[day].count += 1;
      buckets[day].value += Number(r.totalValue);
    }
    return Object.values(buckets);
  }

  /**
   * Export all returns as CSV.
   */
  static async exportCsv(shopId) {
    const returns = await prisma.return.findMany({
      where: { shopId },
      include: { items: true },
      orderBy: { createdAt: 'desc' },
    });

    const rows = [
      [
        'Return ID', 'Order', 'Customer Name', 'Customer Email', 'Status', 'Resolution',
        'Total Value', 'Refund Amount', 'Currency', 'Items', 'Created At', 'Processed At',
      ].join(','),
    ];

    for (const r of returns) {
      rows.push([
        r.id,
        r.shopifyOrderName,
        escapeCsv(r.customerName),
        escapeCsv(r.customerEmail),
        r.status,
        r.resolution || '',
        r.totalValue,
        r.refundAmount || '',
        r.currency,
        r.items.length,
        r.createdAt.toISOString(),
        r.processedAt?.toISOString() || '',
      ].join(','));
    }

    return rows.join('\n');
  }
}

function escapeCsv(str) {
  if (str == null) return '';
  const s = String(str);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

module.exports = AnalyticsService;

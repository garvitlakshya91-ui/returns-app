const prisma = require('../config/database');

class AnalyticsService {
  /**
   * Get summary metrics for a shop over the last N days.
   */
  static async getSummary(shopId, days = 30) {
    const since = new Date(Date.now() - days * 86400000);

    const inPeriod = { shopId, createdAt: { gte: since } };
    const sum = (where, field) => prisma.return.aggregate({ where, _sum: { [field]: true } });
    const [total, processed, rejected, pending, value, refunded, credited, exchanged, open, shop] = await Promise.all([
      prisma.return.count({ where: inPeriod }),
      prisma.return.count({ where: { ...inPeriod, status: 'PROCESSED' } }),
      prisma.return.count({ where: { ...inPeriod, status: 'REJECTED' } }),
      prisma.return.count({ where: { ...inPeriod, status: 'REQUESTED' } }),
      sum(inPeriod, 'totalValue'),
      // Money that left the business: cash refunds actually processed.
      sum({ ...inPeriod, status: 'PROCESSED', resolution: 'REFUND' }, 'refundAmount'),
      // Value kept in the business: store credit issued, and exchanges.
      sum({ ...inPeriod, status: 'PROCESSED', resolution: 'STORE_CREDIT' }, 'refundAmount'),
      sum({ ...inPeriod, status: 'PROCESSED', resolution: 'EXCHANGE' }, 'totalValue'),
      // Not decided yet: neither refunded nor retained.
      sum({ ...inPeriod, status: { notIn: ['PROCESSED', 'REJECTED', 'CANCELLED'] } }, 'totalValue'),
      prisma.shop.findUnique({ where: { id: shopId }, select: { currency: true } }),
    ]);
    const n = (agg, field) => Number(agg?._sum?.[field] || 0);

    return {
      periodDays: days,
      currency: shop?.currency || 'GBP',
      totalReturns: total,
      processedReturns: processed,
      rejectedReturns: rejected,
      pendingReturns: pending,
      totalValue: n(value, 'totalValue'),
      refundedValue: n(refunded, 'refundAmount'),
      creditIssued: n(credited, 'refundAmount'),
      exchangedValue: n(exchanged, 'totalValue'),
      pendingValue: n(open, 'totalValue'),
      // Only resolved returns count: credit and exchanges keep the sale.
      revenueRetained: Math.round((n(credited, 'refundAmount') + n(exchanged, 'totalValue')) * 100) / 100,
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
   * Export returns as CSV: all of the shop's, or one customer's (GDPR data
   * request).
   */
  static async exportCsv(shopId, { customerEmail } = {}) {
    const returns = await prisma.return.findMany({
      where: { shopId, ...(customerEmail ? { customerEmail: { equals: customerEmail, mode: 'insensitive' } } : {}) },
      include: { items: true, label: true, events: { orderBy: { createdAt: 'asc' } } },
      orderBy: { createdAt: 'desc' },
    });

    const rows = [
      [
        'Return ID', 'Order', 'Customer Name', 'Customer Email', 'Status', 'Resolution',
        'Total Value', 'Refund Amount', 'Currency', 'Items', 'Item Details', 'Photo URLs',
        'Notes', 'Label', 'Events', 'Created At', 'Processed At',
      ].join(','),
    ];

    for (const r of returns) {
      const itemDetails = r.items.map((i) => {
        const detail = i.reasonDetail ? `: ${i.reasonDetail}` : '';
        return `${i.productTitle}${i.variantTitle ? ` (${i.variantTitle})` : ''} ×${i.quantity} [${i.reason}${detail}]`;
      }).join(' | ');
      const photos = r.items.flatMap((i) => i.photoUrls || []).join(' ');
      const label = r.label ? `${r.label.carrier} ${r.label.trackingCode || ''}`.trim() : '';
      const events = (r.events || []).map((e) => `${e.createdAt.toISOString()} ${e.type}`).join(' | ');
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
        escapeCsv(itemDetails),
        escapeCsv(photos),
        escapeCsv(r.notes),
        escapeCsv(label),
        escapeCsv(events),
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

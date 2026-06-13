const { installPrismaMock, fakeReturn } = require('../helpers');

let prisma;
let AnalyticsService;

beforeEach(() => {
  jest.resetModules();
  prisma = installPrismaMock();
  AnalyticsService = require('../../app/services/AnalyticsService');
});

describe('AnalyticsService.getSummary', () => {
  it('returns counts, totals, and computed revenueRetained', async () => {
    prisma.return.count
      .mockResolvedValueOnce(20) // total
      .mockResolvedValueOnce(15) // processed
      .mockResolvedValueOnce(2)  // rejected
      .mockResolvedValueOnce(3); // pending
    prisma.return.aggregate.mockResolvedValue({
      _sum: { totalValue: 1000, refundAmount: 600 },
    });

    const result = await AnalyticsService.getSummary('shop_test_1', 30);

    expect(result).toEqual({
      periodDays: 30,
      totalReturns: 20,
      processedReturns: 15,
      rejectedReturns: 2,
      pendingReturns: 3,
      totalValue: 1000,
      refundedValue: 600,
      revenueRetained: 400,
    });
  });

  it('treats nullish sums as zero', async () => {
    prisma.return.count.mockResolvedValue(0);
    prisma.return.aggregate.mockResolvedValue({
      _sum: { totalValue: null, refundAmount: null },
    });
    const result = await AnalyticsService.getSummary('shop_test_1');
    expect(result.totalValue).toBe(0);
    expect(result.refundedValue).toBe(0);
    expect(result.revenueRetained).toBe(0);
  });
});

describe('AnalyticsService.getTopReturnedSkus', () => {
  it('enriches each SKU with its reason breakdown', async () => {
    prisma.returnItem.groupBy
      // First call — top SKUs
      .mockResolvedValueOnce([
        { sku: 'WJ-M-NAV', productTitle: 'Wool jumper', _count: { sku: 5 }, _sum: { quantity: 6 } },
      ])
      // Per-SKU reason groupings
      .mockResolvedValueOnce([
        { reason: 'doesnt_fit', _count: { reason: 3 } },
        { reason: 'damaged', _count: { reason: 2 } },
      ]);

    const result = await AnalyticsService.getTopReturnedSkus('shop_test_1', 5);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      sku: 'WJ-M-NAV',
      productTitle: 'Wool jumper',
      totalReturns: 5,
      totalQuantity: 6,
      reasonBreakdown: { doesnt_fit: 3, damaged: 2 },
    });
  });
});

describe('AnalyticsService.getTrend', () => {
  it('buckets returns by YYYY-MM-DD', async () => {
    prisma.return.findMany.mockResolvedValue([
      { createdAt: new Date('2026-01-01T10:00:00Z'), status: 'PROCESSED', totalValue: 20 },
      { createdAt: new Date('2026-01-01T15:00:00Z'), status: 'PROCESSED', totalValue: 30 },
      { createdAt: new Date('2026-01-02T09:00:00Z'), status: 'REQUESTED', totalValue: 15 },
    ]);

    const result = await AnalyticsService.getTrend('shop_test_1', 30);

    expect(result).toEqual([
      { date: '2026-01-01', count: 2, value: 50 },
      { date: '2026-01-02', count: 1, value: 15 },
    ]);
  });

  it('returns an empty array when no returns', async () => {
    prisma.return.findMany.mockResolvedValue([]);
    const result = await AnalyticsService.getTrend('shop_test_1');
    expect(result).toEqual([]);
  });
});

describe('AnalyticsService.exportCsv', () => {
  it('emits a header row + one row per return', async () => {
    prisma.return.findMany.mockResolvedValue([
      fakeReturn({
        id: 'r1', shopifyOrderName: '#1001',
        customerName: 'Jane', customerEmail: 'j@x.com',
        status: 'PROCESSED', resolution: 'REFUND',
        totalValue: 100, refundAmount: 95, currency: 'GBP',
        items: [{}, {}], createdAt: new Date('2026-01-15'),
        processedAt: new Date('2026-01-20'),
      }),
    ]);
    const csv = await AnalyticsService.exportCsv('shop_test_1');
    const lines = csv.split('\n');
    expect(lines[0]).toContain('Return ID');
    expect(lines[0]).toContain('Refund Amount');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/r1,#1001/);
    expect(lines[1]).toMatch(/Jane,j@x.com,PROCESSED,REFUND/);
    expect(lines[1]).toMatch(/,100,95,GBP,2,/);
  });

  it('escapes commas and quotes in customer fields', async () => {
    prisma.return.findMany.mockResolvedValue([
      fakeReturn({
        customerName: 'Smith, John',
        customerEmail: 'a"b@x.com',
        items: [],
        createdAt: new Date('2026-01-15'),
        processedAt: null,
      }),
    ]);
    const csv = await AnalyticsService.exportCsv('shop_test_1');
    expect(csv).toContain('"Smith, John"');
    expect(csv).toContain('"a""b@x.com"');
  });
});

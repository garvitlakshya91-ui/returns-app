// Unrecovered managed-label postage is retried, not forgotten.

const { installPrismaMock, fakeShop, fakeReturn } = require('../helpers');

let prisma;
let billing;
let retryFailedLabelCharges;

const t = (daysAgo) => new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
const ev = (returnId, type, data, daysAgo = 1) => ({ returnId, type, data, createdAt: t(daysAgo) });

beforeEach(() => {
  jest.resetModules();
  prisma = installPrismaMock();
  jest.doMock('../../app/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
  billing = { recordLabelCharge: jest.fn().mockResolvedValue('gid://shopify/AppUsageRecord/9') };
  jest.doMock('../../app/services/BillingService', () => billing);
  ({ retryFailedLabelCharges } = require('../../app/jobs/retryLabelCharges'));
  prisma.return.findUnique.mockImplementation(async ({ where }) => fakeReturn({
    id: where.id, shop: fakeShop(), shopifyOrderName: '#1042', label: { carrier: 'evri', trackingCode: 'T' },
  }));
  prisma.returnEvent.create.mockResolvedValue({});
});

describe('retryFailedLabelCharges', () => {
  it('retries only returns whose latest state is a failed charge, and records the outcome', async () => {
    prisma.returnEvent.findMany.mockResolvedValue([
      ev('r_failed', 'label.charge_failed', { amount: 3.25, postage: 2.75 }),
      ev('r_recovered', 'label.charge_failed', { amount: 3.25, postage: 2.75 }, 3),
      ev('r_recovered', 'label.charged', { amount: 3.25 }, 2),
    ]);

    const result = await retryFailedLabelCharges();

    expect(billing.recordLabelCharge).toHaveBeenCalledTimes(1);
    expect(billing.recordLabelCharge).toHaveBeenCalledWith(expect.objectContaining({ id: 'shop_test_1' }), { amount: 3.25, description: 'Return label evri #1042' });
    expect(prisma.returnEvent.create).toHaveBeenCalledWith({
      data: { returnId: 'r_failed', type: 'label.charged', actor: 'system', data: { charged: true, amount: 3.25, postage: 2.75, usageRecordId: 'gid://shopify/AppUsageRecord/9', error: null, retry: 1 } },
    });
    expect(result).toEqual({ due: 1, recovered: 1, stillFailing: 0 });
    expect(prisma.returnEvent.findMany.mock.calls[0][0].where.createdAt.gte).toBeInstanceOf(Date);
  });

  it('a charge that still fails is recorded as another failed attempt; after 5 attempts it is left alone', async () => {
    billing.recordLabelCharge.mockResolvedValue(null);
    prisma.returnEvent.findMany.mockResolvedValue([
      ev('r_a', 'label.charge_failed', { amount: 3.25, postage: 2.75 }),
      ...Array.from({ length: 5 }, (_, i) => ev('r_exhausted', 'label.charge_failed', { amount: 3.25 }, 6 - i)),
    ]);

    const result = await retryFailedLabelCharges();

    expect(billing.recordLabelCharge).toHaveBeenCalledTimes(1);
    expect(prisma.returnEvent.create.mock.calls[0][0].data).toMatchObject({ returnId: 'r_a', type: 'label.charge_failed', data: { charged: false, retry: 1 } });
    expect(result).toEqual({ due: 1, recovered: 0, stillFailing: 1 });
  });

  it('skips events with no amount and returns that no longer exist', async () => {
    prisma.returnEvent.findMany.mockResolvedValue([
      ev('r_zero', 'label.charge_failed', { amount: 0 }),
      ev('r_gone', 'label.charge_failed', { amount: 3 }),
    ]);
    prisma.return.findUnique.mockResolvedValue(null);
    const result = await retryFailedLabelCharges();
    expect(billing.recordLabelCharge).not.toHaveBeenCalled();
    expect(result.due).toBe(1);
  });
});

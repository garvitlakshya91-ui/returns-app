// Unrecovered managed-label postage is retried, not forgotten.

const { installPrismaMock, fakeShop, fakeReturn } = require('../helpers');

let prisma;
let billing;
let idempotency;
let retryFailedLabelCharges;

const t = (daysAgo) => new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
const ev = (returnId, type, data, daysAgo = 1) => ({ returnId, type, data, createdAt: t(daysAgo) });

beforeEach(() => {
  jest.resetModules();
  prisma = installPrismaMock();
  jest.doMock('../../app/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
  billing = {
    reportLabelUsage: jest.fn().mockResolvedValue({ reported: true, meter: 'return_label', idempotencyKey: 'k', quantity: 1 }),
    labelChargeKey: (id) => `returnflow:label-charge:${id}`,
    LABEL_METER_HANDLE: 'return_label',
  };
  jest.doMock('../../app/services/BillingService', () => billing);
  idempotency = { claim: jest.fn().mockResolvedValue(true), release: jest.fn().mockResolvedValue(undefined) };
  jest.doMock('../../app/utils/idempotency', () => idempotency);
  ({ retryFailedLabelCharges } = require('../../app/jobs/retryLabelCharges'));
  prisma.return.findUnique.mockImplementation(async ({ where }) => fakeReturn({
    id: where.id, shop: fakeShop(), shopifyOrderName: '#1042', label: { carrier: 'evri', trackingCode: 'T' },
  }));
  prisma.returnEvent.create.mockResolvedValue({});
});

describe('retryFailedLabelCharges', () => {
  it('retries only returns whose latest state is a failed charge, and records the outcome', async () => {
    prisma.returnEvent.findMany.mockResolvedValue([
      ev('r_failed', 'label.charge_failed', { quantity: 1, postage: 2.75 }),
      ev('r_recovered', 'label.charge_failed', { quantity: 1, postage: 2.75 }, 3),
      ev('r_recovered', 'label.charged', { quantity: 1 }, 2),
    ]);

    const result = await retryFailedLabelCharges();

    expect(billing.reportLabelUsage).toHaveBeenCalledTimes(1);
    // Re-reported with the same idempotency key, so Shopify can never bill it twice.
    expect(billing.reportLabelUsage).toHaveBeenCalledWith(expect.objectContaining({ id: 'shop_test_1' }), { returnId: 'r_failed', quantity: 1 });
    // Claimed for the duration of the retry, then released.
    expect(idempotency.claim).toHaveBeenCalledWith('label-charge-retry:r_failed', 600);
    expect(idempotency.release).toHaveBeenCalledWith('label-charge-retry:r_failed');
    expect(prisma.returnEvent.create).toHaveBeenCalledWith({
      data: { returnId: 'r_failed', type: 'label.charged', actor: 'system', data: { charged: true, quantity: 1, postage: 2.75, meter: 'return_label', idempotencyKey: 'returnflow:label-charge:r_failed', error: null, retry: 1 } },
    });
    expect(result).toEqual({ due: 1, recovered: 1, stillFailing: 0 });
    expect(prisma.returnEvent.findMany.mock.calls[0][0].where.createdAt.gte).toBeInstanceOf(Date);
  });

  it('a charge that still fails is recorded as another failed attempt; after 5 attempts it is left alone', async () => {
    billing.reportLabelUsage.mockRejectedValue(new Error('App Events rejected the label usage event (503)'));
    prisma.returnEvent.findMany.mockResolvedValue([
      ev('r_a', 'label.charge_failed', { quantity: 1, postage: 2.75 }),
      ...Array.from({ length: 5 }, (_, i) => ev('r_exhausted', 'label.charge_failed', { quantity: 1 }, 6 - i)),
    ]);

    const result = await retryFailedLabelCharges();

    expect(billing.reportLabelUsage).toHaveBeenCalledTimes(1);
    expect(prisma.returnEvent.create.mock.calls[0][0].data).toMatchObject({ returnId: 'r_a', type: 'label.charge_failed', data: { charged: false, retry: 1, error: expect.stringMatching(/503/) } });
    expect(result).toEqual({ due: 1, recovered: 0, stillFailing: 1 });
  });

  it('a charge announced (charge_due) with no outcome for over 10 minutes is retried; a fresh one is left in flight', async () => {
    const minutesAgo = (m) => new Date(Date.now() - m * 60 * 1000);
    prisma.returnEvent.findMany.mockResolvedValue([
      { returnId: 'r_lost', type: 'label.charge_due', data: { quantity: 1, postage: 2.75 }, createdAt: minutesAgo(30) },
      { returnId: 'r_inflight', type: 'label.charge_due', data: { quantity: 1, postage: 2.75 }, createdAt: minutesAgo(2) },
      { returnId: 'r_settled', type: 'label.charge_due', data: { quantity: 1 }, createdAt: minutesAgo(40) },
      { returnId: 'r_settled', type: 'label.charged', data: { quantity: 1 }, createdAt: minutesAgo(39) },
    ]);

    const result = await retryFailedLabelCharges();

    expect(billing.reportLabelUsage).toHaveBeenCalledTimes(1);
    expect(billing.reportLabelUsage.mock.calls[0][1]).toEqual({ returnId: 'r_lost', quantity: 1 });
    expect(prisma.returnEvent.create.mock.calls[0][0].data).toMatchObject({ returnId: 'r_lost', type: 'label.charged', data: { charged: true, retry: 1 } });
    expect(prisma.returnEvent.findMany.mock.calls[0][0].where.type.in).toEqual(['label.charge_due', 'label.charge_failed', 'label.charged']);
    expect(result).toEqual({ due: 1, recovered: 1, stillFailing: 0 });
  });

  it('leaves a label alone when another worker holds the claim', async () => {
    idempotency.claim.mockResolvedValue(false);
    prisma.returnEvent.findMany.mockResolvedValue([ev('r_busy', 'label.charge_failed', { quantity: 1 })]);

    const result = await retryFailedLabelCharges();

    expect(billing.reportLabelUsage).not.toHaveBeenCalled();
    expect(prisma.returnEvent.create).not.toHaveBeenCalled();
    expect(idempotency.release).not.toHaveBeenCalled();
    expect(result).toEqual({ due: 1, recovered: 0, stillFailing: 0 });
  });

  it('skips events with no amount and returns that no longer exist', async () => {
    prisma.returnEvent.findMany.mockResolvedValue([
      ev('r_zero', 'label.charge_failed', { quantity: 0 }),
      ev('r_gone', 'label.charge_failed', { quantity: 1 }),
    ]);
    prisma.return.findUnique.mockResolvedValue(null);
    const result = await retryFailedLabelCharges();
    expect(billing.reportLabelUsage).not.toHaveBeenCalled();
    expect(result.due).toBe(1);
  });
});

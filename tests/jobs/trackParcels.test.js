// Outstanding return parcels are tracked with the carrier; a scan moves the
// return to IN_TRANSIT, a delivery to RECEIVED (and tells the customer).

const { installPrismaMock, fakeShop } = require('../helpers');

let prisma;
let labelService;
let adapter;
let logger;
let eventBus;
let job;

const label = (over = {}) => ({
  id: 'lbl_1', returnId: 'ret_1', carrier: 'evri', trackingCode: 'H01', labelUrl: 'https://cdn/l.pdf', status: 'created',
  trackingStatus: null, trackingDetail: null, createdAt: new Date(),
  return: { id: 'ret_1', shopId: 'shop_1', status: 'LABEL_SENT', shop: fakeShop({ id: 'shop_1' }) },
  ...over,
});

beforeEach(() => {
  jest.resetModules();
  prisma = installPrismaMock();
  logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  jest.doMock('../../app/utils/logger', () => logger);
  adapter = { _isLive: true, getTrackingStatus: jest.fn() };
  labelService = { getCarrierAdapter: jest.fn(() => adapter) };
  jest.doMock('../../app/services/LabelService', () => labelService);
  eventBus = require('../../app/events/eventBus');
  eventBus.removeAllListeners();
  prisma.returnLabel.update.mockResolvedValue({});
  prisma.returnEvent.create.mockResolvedValue({});
  prisma.return.updateMany.mockResolvedValue({ count: 1 });
  job = require('../../app/jobs/trackParcels');
});

describe('trackParcels — what it selects', () => {
  it('asks for real, finished labels on returns still expecting a parcel, no older than 60 days, by id', async () => {
    prisma.returnLabel.findMany.mockResolvedValue([]);
    const now = new Date('2026-10-30T12:00:00Z');

    await job.trackParcels({ now });

    const arg = prisma.returnLabel.findMany.mock.calls[0][0];
    expect(arg.where).toEqual({
      status: 'created',
      trackingCode: { not: null },
      labelUrl: { not: null }, // simulated labels have none and no parcel
      createdAt: { gt: new Date('2026-08-31T12:00:00Z') },
      return: { status: { in: ['LABEL_SENT', 'IN_TRANSIT'] } },
    });
    expect(arg.orderBy).toEqual({ id: 'asc' });
    expect(arg.take).toBe(100);
    expect(job.TRACK_FOR_DAYS).toBe(60);
  });
});

describe('trackParcels — moving the return along', () => {
  it('a first carrier scan records the tracking and moves LABEL_SENT to IN_TRANSIT', async () => {
    prisma.returnLabel.findMany.mockResolvedValue([label()]);
    adapter.getTrackingStatus.mockResolvedValue({ status: 'in_transit', detail: 'Collected from ParcelShop', location: 'Birmingham, GB', lastUpdate: new Date('2026-10-30T09:00:00Z') });

    const result = await job.trackParcels({ now: new Date('2026-10-30T12:00:00Z') });

    expect(adapter.getTrackingStatus).toHaveBeenCalledWith('H01', 'evri');
    expect(prisma.returnLabel.update).toHaveBeenCalledWith({
      where: { id: 'lbl_1' },
      data: {
        trackingCheckedAt: new Date('2026-10-30T12:00:00Z'),
        trackingStatus: 'in_transit', trackingDetail: 'Collected from ParcelShop', trackingLocation: 'Birmingham, GB',
        trackingAt: new Date('2026-10-30T09:00:00Z'),
      },
    });
    expect(prisma.returnEvent.create).toHaveBeenCalledWith({
      data: { returnId: 'ret_1', type: 'tracking.updated', actor: 'carrier', data: { status: 'in_transit', detail: 'Collected from ParcelShop', location: 'Birmingham, GB', at: '2026-10-30T09:00:00.000Z' } },
    });
    // Conditional, so a return that moved on meanwhile is never dragged back.
    expect(prisma.return.updateMany).toHaveBeenCalledWith({ where: { id: 'ret_1', status: 'LABEL_SENT' }, data: { status: 'IN_TRANSIT' } });
    expect(result).toEqual({ checked: 1, moved: 1, received: 0, failed: 0 });
  });

  it('a delivery moves the return to RECEIVED and announces it', async () => {
    prisma.returnLabel.findMany.mockResolvedValue([label({ trackingStatus: 'in_transit', return: { id: 'ret_1', shopId: 'shop_1', status: 'IN_TRANSIT', shop: fakeShop() } })]);
    adapter.getTrackingStatus.mockResolvedValue({ status: 'delivered', detail: 'Delivered', location: 'Sutton Coldfield, GB', lastUpdate: new Date() });
    const received = jest.fn();
    eventBus.on('return.received', received);

    const result = await job.trackParcels();

    expect(prisma.return.updateMany).toHaveBeenCalledWith({ where: { id: 'ret_1', status: { in: ['LABEL_SENT', 'IN_TRANSIT'] } }, data: { status: 'RECEIVED' } });
    expect(received).toHaveBeenCalledWith({ returnId: 'ret_1', shopId: 'shop_1', source: 'carrier' });
    expect(result).toEqual({ checked: 1, moved: 1, received: 1, failed: 0 });
  });

  it('does not announce a delivery the conditional update lost (the return had already moved on)', async () => {
    prisma.returnLabel.findMany.mockResolvedValue([label()]);
    adapter.getTrackingStatus.mockResolvedValue({ status: 'delivered', detail: 'Delivered', lastUpdate: new Date() });
    prisma.return.updateMany.mockResolvedValue({ count: 0 });
    const received = jest.fn();
    eventBus.on('return.received', received);

    const result = await job.trackParcels();

    expect(received).not.toHaveBeenCalled();
    expect(result).toEqual({ checked: 1, moved: 0, received: 0, failed: 0 });
  });

  it('an unchanged status only notes the check time: no event, no status change', async () => {
    prisma.returnLabel.findMany.mockResolvedValue([label({ trackingStatus: 'in_transit', trackingDetail: 'In transit' })]);
    adapter.getTrackingStatus.mockResolvedValue({ status: 'in_transit', detail: 'In transit', lastUpdate: new Date() });

    await job.trackParcels({ now: new Date('2026-10-30T12:00:00Z') });

    expect(prisma.returnLabel.update).toHaveBeenCalledWith({ where: { id: 'lbl_1' }, data: { trackingCheckedAt: new Date('2026-10-30T12:00:00Z') } });
    expect(prisma.returnEvent.create).not.toHaveBeenCalled();
    expect(prisma.return.updateMany).not.toHaveBeenCalled();
  });

  it('"unknown" from the carrier (not scanned yet) changes nothing but the check time', async () => {
    prisma.returnLabel.findMany.mockResolvedValue([label()]);
    adapter.getTrackingStatus.mockResolvedValue({ status: 'unknown', detail: 'Not found by the carrier yet' });

    await job.trackParcels();

    expect(prisma.returnLabel.update.mock.calls[0][0].data).toEqual({ trackingCheckedAt: expect.any(Date) });
    expect(prisma.returnEvent.create).not.toHaveBeenCalled();
  });

  it('a delivery problem goes on the timeline but leaves the status alone', async () => {
    prisma.returnLabel.findMany.mockResolvedValue([label({ trackingStatus: 'in_transit' })]);
    adapter.getTrackingStatus.mockResolvedValue({ status: 'failed', detail: 'Address not found', lastUpdate: new Date() });

    const result = await job.trackParcels();

    expect(prisma.returnEvent.create.mock.calls[0][0].data.data.status).toBe('failed');
    expect(prisma.return.updateMany).not.toHaveBeenCalled();
    expect(result).toEqual({ checked: 1, moved: 0, received: 0, failed: 0 });
  });
});

describe('trackParcels — what it leaves alone', () => {
  it('skips labels whose carrier adapter is simulated (no real parcel)', async () => {
    adapter._isLive = false;
    prisma.returnLabel.findMany.mockResolvedValue([label()]);
    const result = await job.trackParcels();
    expect(adapter.getTrackingStatus).not.toHaveBeenCalled();
    expect(prisma.returnLabel.update).not.toHaveBeenCalled();
    expect(result).toEqual({ checked: 0, moved: 0, received: 0, failed: 0 });
  });

  it('a carrier error on one label is counted and the rest still run', async () => {
    prisma.returnLabel.findMany.mockResolvedValue([label({ id: 'lbl_a', returnId: 'ret_a' }), label({ id: 'lbl_b', returnId: 'ret_b', trackingCode: 'H02' })]);
    adapter.getTrackingStatus.mockRejectedValueOnce(new Error('Shippo tracking failed (503)')).mockResolvedValueOnce({ status: 'in_transit', detail: 'x', lastUpdate: new Date() });

    const result = await job.trackParcels();

    expect(result).toEqual({ checked: 1, moved: 1, received: 0, failed: 1 });
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ returnId: 'ret_a', err: 'Shippo tracking failed (503)' }), 'Parcel tracking check failed');
  });

  it('never overlaps itself, and registers its schedule once', async () => {
    let finish;
    prisma.returnLabel.findMany.mockResolvedValueOnce([label()]).mockResolvedValue([]);
    adapter.getTrackingStatus.mockImplementationOnce(() => new Promise((r) => { finish = () => r({ status: 'unknown' }); }));
    const first = job.trackParcels();
    await new Promise((r) => setImmediate(r));
    await expect(job.trackParcels()).resolves.toMatchObject({ skippedRun: true });
    finish();
    await first;

    jest.useFakeTimers();
    const to = jest.spyOn(global, 'setTimeout');
    const iv = jest.spyOn(global, 'setInterval');
    expect(job.startParcelTracking()).toBe(true);
    expect(job.startParcelTracking()).toBe(false);
    expect(to).toHaveBeenCalledTimes(1);
    expect(iv.mock.calls[0][1]).toBe(30 * 60 * 1000);
    jest.useRealTimers();
  });
});

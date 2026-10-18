// Unfinished labels (crashed purchase, or saved but not emailed/charged)
// are picked up by a scheduled job, not left for the merchant to notice.

const { installPrismaMock } = require('../helpers');

let prisma;
let labelService;
let logger;
let job;

const row = (id, status = 'saved') => ({ id, returnId: `ret_${id}`, status });

beforeEach(() => {
  jest.resetModules();
  prisma = installPrismaMock();
  logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  jest.doMock('../../app/utils/logger', () => logger);
  labelService = { generateLabel: jest.fn().mockResolvedValue({ id: 'lbl', status: 'created' }) };
  jest.doMock('../../app/services/LabelService', () => labelService);
  job = require('../../app/jobs/recoverLabels');
});

describe('recoverUnfinishedLabels — what it selects', () => {
  it('asks the database for saved rows older than 5 min and buying rows older than 10, on OPEN returns only, by id', async () => {
    prisma.returnLabel.findMany.mockResolvedValue([]);
    const now = new Date('2026-10-18T10:00:00Z');

    await job.recoverUnfinishedLabels({ now });

    expect(job.SAVED_MIN_AGE_MS).toBe(5 * 60 * 1000);
    expect(job.BUYING_MIN_AGE_MS).toBe(10 * 60 * 1000);
    const arg = prisma.returnLabel.findMany.mock.calls[0][0];
    expect(arg.where).toEqual({
      OR: [
        { status: 'saved', createdAt: { lt: new Date('2026-10-18T09:55:00Z') } },
        { status: 'buying', createdAt: { lt: new Date('2026-10-18T09:50:00Z') } },
      ],
      // Closed returns are excluded IN THE QUERY, so they can never crowd out eligible labels.
      return: { status: { in: ['APPROVED', 'LABEL_SENT'] } },
    });
    expect(arg.orderBy).toEqual({ id: 'asc' });
    expect(arg.take).toBe(50);
    expect(arg.cursor).toBeUndefined();
  });

  it('walks every page by cursor, so labels that keep failing never block the ones after them', async () => {
    const pageOne = Array.from({ length: 50 }, (_, i) => row(`a${String(i).padStart(2, '0')}`));
    const pageTwo = [row('b00'), row('b01')];
    prisma.returnLabel.findMany.mockResolvedValueOnce(pageOne).mockResolvedValueOnce(pageTwo);
    labelService.generateLabel.mockRejectedValue(new Error('carrier cannot confirm')); // every first-page row fails
    labelService.generateLabel.mockResolvedValueOnce({ status: 'created' });

    const result = await job.recoverUnfinishedLabels();

    expect(prisma.returnLabel.findMany).toHaveBeenCalledTimes(2);
    expect(prisma.returnLabel.findMany.mock.calls[1][0]).toMatchObject({ cursor: { id: 'a49' }, skip: 1, take: 50 });
    expect(labelService.generateLabel).toHaveBeenCalledTimes(52);
    expect(labelService.generateLabel).toHaveBeenCalledWith('ret_b01');
    expect(result).toEqual({ due: 52, finished: 1, stillOpen: 0, failed: 51 });
  });

  it('stops when a page comes back short, and is quiet when there is nothing to do', async () => {
    prisma.returnLabel.findMany.mockResolvedValue([]);
    const result = await job.recoverUnfinishedLabels();
    expect(result).toEqual({ due: 0, finished: 0, stillOpen: 0, failed: 0 });
    expect(prisma.returnLabel.findMany).toHaveBeenCalledTimes(1);
    expect(labelService.generateLabel).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });
});

describe('recoverUnfinishedLabels — what it does', () => {
  it('resumes each label through generateLabel (which never buys twice) and reports what happened', async () => {
    prisma.returnLabel.findMany.mockResolvedValue([row('a'), row('b', 'buying'), row('d')]);
    labelService.generateLabel
      .mockResolvedValueOnce({ status: 'created' })
      .mockRejectedValueOnce(new Error('carrier cannot confirm'))
      .mockResolvedValueOnce({ status: 'saved' }); // email still failing

    const result = await job.recoverUnfinishedLabels();

    expect(labelService.generateLabel.mock.calls.map((c) => c[0])).toEqual(['ret_a', 'ret_b', 'ret_d']);
    expect(result).toEqual({ due: 3, finished: 1, stillOpen: 1, failed: 1 });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ returnId: 'ret_b', status: 'buying', err: 'carrier cannot confirm' }),
      'Unfinished label could not be recovered yet',
    );
    expect(logger.info).toHaveBeenCalledWith(result, 'Unfinished label recovery done');
  });

  it('never overlaps itself: a tick that fires while a run is in progress is skipped', async () => {
    let finishFirst;
    prisma.returnLabel.findMany.mockResolvedValueOnce([row('slow')]).mockResolvedValue([]);
    labelService.generateLabel.mockImplementationOnce(() => new Promise((r) => { finishFirst = () => r({ status: 'created' }); }));

    const first = job.recoverUnfinishedLabels();
    await new Promise((r) => setImmediate(r));
    const second = await job.recoverUnfinishedLabels();

    expect(second).toEqual({ due: 0, finished: 0, stillOpen: 0, failed: 0, skippedRun: true });
    expect(logger.info).toHaveBeenCalledWith('Unfinished label recovery already running; skipping this tick');
    finishFirst();
    await expect(first).resolves.toEqual({ due: 1, finished: 1, stillOpen: 0, failed: 0 });

    // Once the first run is over, the next tick runs normally again.
    await expect(job.recoverUnfinishedLabels()).resolves.toEqual({ due: 0, finished: 0, stillOpen: 0, failed: 0 });
  });

  it('a run that throws releases the "running" guard', async () => {
    prisma.returnLabel.findMany.mockRejectedValueOnce(new Error('db down')).mockResolvedValue([]);
    await expect(job.recoverUnfinishedLabels()).rejects.toThrow('db down');
    await expect(job.recoverUnfinishedLabels()).resolves.toEqual({ due: 0, finished: 0, stillOpen: 0, failed: 0 });
  });
});

describe('startLabelRecovery', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('registers one boot run and one 30-minute schedule, and a second call is a no-op', async () => {
    prisma.returnLabel.findMany.mockResolvedValue([]);
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
    const setIntervalSpy = jest.spyOn(global, 'setInterval');

    expect(job.startLabelRecovery()).toBe(true);
    expect(job.startLabelRecovery()).toBe(false);
    expect(job.startLabelRecovery()).toBe(false);

    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    expect(setTimeoutSpy.mock.calls[0][1]).toBe(30000);
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy.mock.calls[0][1]).toBe(30 * 60 * 1000);

    jest.advanceTimersByTime(30000);
    await Promise.resolve();
    expect(prisma.returnLabel.findMany).toHaveBeenCalledTimes(1); // the single boot run
  });
});

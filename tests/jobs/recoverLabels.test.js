// Unfinished labels (crashed purchase, or saved but not emailed/charged)
// are picked up by a scheduled job, not left for the merchant to notice.

const { installPrismaMock } = require('../helpers');

let prisma;
let labelService;
let logger;
let recoverUnfinishedLabels;
let SAVED_MIN_AGE_MS;
let BUYING_MIN_AGE_MS;

const minutesAgo = (m) => new Date(Date.now() - m * 60 * 1000);
const row = (id, status, ageMin, returnStatus = 'APPROVED') => ({
  id, returnId: `ret_${id}`, status, createdAt: minutesAgo(ageMin), return: { id: `ret_${id}`, status: returnStatus },
});

beforeEach(() => {
  jest.resetModules();
  prisma = installPrismaMock();
  logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  jest.doMock('../../app/utils/logger', () => logger);
  labelService = { generateLabel: jest.fn().mockResolvedValue({ id: 'lbl', status: 'created' }) };
  jest.doMock('../../app/services/LabelService', () => labelService);
  ({ recoverUnfinishedLabels, SAVED_MIN_AGE_MS, BUYING_MIN_AGE_MS } = require('../../app/jobs/recoverLabels'));
});

describe('recoverUnfinishedLabels', () => {
  it('asks for saved rows older than 5 minutes and buying rows older than 10, oldest first, in batches', async () => {
    prisma.returnLabel.findMany.mockResolvedValue([]);
    const now = new Date('2026-10-18T10:00:00Z');

    await recoverUnfinishedLabels({ now });

    expect(SAVED_MIN_AGE_MS).toBe(5 * 60 * 1000);
    expect(BUYING_MIN_AGE_MS).toBe(10 * 60 * 1000);
    const arg = prisma.returnLabel.findMany.mock.calls[0][0];
    expect(arg.where.OR).toEqual([
      { status: 'saved', createdAt: { lt: new Date('2026-10-18T09:55:00Z') } },
      { status: 'buying', createdAt: { lt: new Date('2026-10-18T09:50:00Z') } },
    ]);
    expect(arg.orderBy).toEqual({ createdAt: 'asc' });
    expect(arg.take).toBe(50);
    expect(arg.include).toEqual({ return: { select: { id: true, status: true } } });
  });

  it('resumes each unfinished label through generateLabel (which never buys twice) and reports what happened', async () => {
    prisma.returnLabel.findMany.mockResolvedValue([
      row('a', 'saved', 20),
      row('b', 'buying', 30, 'LABEL_SENT'),
      row('c', 'saved', 60, 'PROCESSED'), // return already closed: left alone
      row('d', 'saved', 15),
    ]);
    labelService.generateLabel
      .mockResolvedValueOnce({ status: 'created' })
      .mockRejectedValueOnce(new Error('carrier cannot confirm'))
      .mockResolvedValueOnce({ status: 'saved' }); // email still failing

    const result = await recoverUnfinishedLabels();

    expect(labelService.generateLabel.mock.calls.map((c) => c[0])).toEqual(['ret_a', 'ret_b', 'ret_d']);
    expect(result).toEqual({ due: 4, finished: 1, stillOpen: 1, failed: 1, skipped: 1 });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ returnId: 'ret_b', status: 'buying', err: 'carrier cannot confirm' }),
      'Unfinished label could not be recovered yet',
    );
    expect(logger.info).toHaveBeenCalledWith(result, 'Unfinished label recovery done');
  });

  it('is quiet when there is nothing to do', async () => {
    prisma.returnLabel.findMany.mockResolvedValue([]);
    const result = await recoverUnfinishedLabels();
    expect(result).toEqual({ due: 0, finished: 0, stillOpen: 0, failed: 0, skipped: 0 });
    expect(labelService.generateLabel).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });
});

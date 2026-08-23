// The generate-label BullMQ worker is a thin wrapper: it registers a processor
// on the GENERATE_LABEL queue that calls LabelService.generateLabel(returnId)
// and returns { labelId, trackingCode }. We capture the processor via a mocked
// createWorker and drive it directly — no Redis, no BullMQ.

let createWorker;
let labelService;

beforeEach(() => {
  jest.resetModules();

  createWorker = jest.fn().mockReturnValue({ name: 'fake-worker' });
  jest.doMock('../../app/jobs/queue', () => ({
    QUEUE_NAMES: {
      GENERATE_LABEL: 'generate-label',
      SEND_EMAIL: 'send-email',
      PROCESS_REFUND: 'process-refund',
      AGGREGATE_ANALYTICS: 'aggregate-analytics',
    },
    getQueue: jest.fn(),
    createWorker,
  }));

  labelService = { generateLabel: jest.fn() };
  jest.doMock('../../app/services/LabelService', () => labelService);

  jest.doMock('../../app/utils/logger', () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
  }));
});

function loadWorker() {
  const worker = require('../../app/jobs/generateLabel.worker');
  const [queueName, processor] = createWorker.mock.calls[0];
  return { worker, queueName, processor };
}

describe('generateLabel.worker', () => {
  it('registers a processor on the generate-label queue and exports the worker', () => {
    const { worker, queueName, processor } = loadWorker();
    expect(createWorker).toHaveBeenCalledTimes(1);
    expect(queueName).toBe('generate-label');
    expect(typeof processor).toBe('function');
    expect(worker).toEqual({ name: 'fake-worker' });
  });

  it('calls LabelService.generateLabel with job.data.returnId and returns labelId + trackingCode', async () => {
    labelService.generateLabel.mockResolvedValue({ id: 'lbl_42', trackingCode: 'EVRABC123', carrier: 'evri' });
    const { processor } = loadWorker();

    const result = await processor({ id: 'job_7', data: { returnId: 'ret_42' } });

    expect(labelService.generateLabel).toHaveBeenCalledTimes(1);
    expect(labelService.generateLabel).toHaveBeenCalledWith('ret_42');
    expect(result).toEqual({ labelId: 'lbl_42', trackingCode: 'EVRABC123' });
  });

  it('propagates LabelService errors so BullMQ marks the job failed (and can retry)', async () => {
    labelService.generateLabel.mockRejectedValue(new Error('carrier down'));
    const { processor } = loadWorker();

    await expect(processor({ id: 'job_8', data: { returnId: 'ret_43' } })).rejects.toThrow('carrier down');
  });

  it('exports null when the queue layer cannot create a worker (no Redis) without throwing', () => {
    createWorker.mockReturnValue(null);
    const worker = require('../../app/jobs/generateLabel.worker');
    expect(worker).toBeNull();
  });
});

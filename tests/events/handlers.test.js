// Behavioural tests for the approve → label → email → refund event pipeline.
// Each handler module registers a listener on the eventBus singleton when it is
// required, so we reset the module registry, install mocks, require the
// handler, then emit on the SAME eventBus instance the handler captured.

const { installPrismaMock, fakeReturn } = require('../helpers');

const {
  RETURN_CREATED,
  RETURN_APPROVED,
  LABEL_GENERATED,
  REFUND_PROCESSED,
} = require('../../app/events/emitters');

// Let every pending microtask / macrotask settle so the async handlers finish.
async function flush(times = 10) {
  for (let i = 0; i < times; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setImmediate(r));
  }
}

let prisma;
let notification;
let labelService;
let eventBus;
let consoleErrorSpy;
let consoleLogSpy;
let unhandled;
const onUnhandled = (err) => unhandled.push(err);

function installServiceMocks() {
  notification = {
    sendReturnConfirmation: jest.fn().mockResolvedValue({ id: 'msg_confirm' }),
    sendReturnApproved: jest.fn().mockResolvedValue({ id: 'msg_approved' }),
    sendLabelReady: jest.fn().mockResolvedValue({ id: 'msg_label' }),
    sendRefundProcessed: jest.fn().mockResolvedValue({ id: 'msg_refund' }),
    sendReturnRejected: jest.fn().mockResolvedValue({ id: 'msg_rejected' }),
  };
  jest.doMock('../../app/services/NotificationService', () => notification);

  labelService = {
    generateLabel: jest.fn().mockResolvedValue({ id: 'lbl_1', trackingCode: 'EVR123', carrier: 'evri' }),
  };
  jest.doMock('../../app/services/LabelService', () => labelService);
}

beforeEach(() => {
  jest.resetModules();
  prisma = installPrismaMock();
  installServiceMocks();
  consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  unhandled = [];
  process.on('unhandledRejection', onUnhandled);
});

afterEach(() => {
  process.off('unhandledRejection', onUnhandled);
  consoleErrorSpy.mockRestore();
  consoleLogSpy.mockRestore();
});

function loadHandler(name) {
  require(`../../app/events/handlers/${name}`);
  eventBus = require('../../app/events/eventBus');
}

// ---------------------------------------------------------------------------
// onReturnCreated
// ---------------------------------------------------------------------------
describe('onReturnCreated', () => {
  it('registers a listener for RETURN_CREATED', () => {
    loadHandler('onReturnCreated');
    expect(eventBus.listenerCount(RETURN_CREATED)).toBe(1);
  });

  it('logs a ReturnEvent (actor=customer) and emails the confirmation with the loaded return', async () => {
    const record = fakeReturn({ id: 'ret_c1', items: [{ id: 'i1' }] });
    prisma.return.findUnique.mockResolvedValue(record);
    prisma.returnEvent.create.mockResolvedValue({});
    loadHandler('onReturnCreated');

    eventBus.emit(RETURN_CREATED, { returnId: 'ret_c1', shopId: 'shop_test_1' });
    await flush();

    expect(prisma.return.findUnique).toHaveBeenCalledWith({
      where: { id: 'ret_c1' },
      include: { items: true },
    });
    expect(prisma.returnEvent.create).toHaveBeenCalledTimes(1);
    const evt = prisma.returnEvent.create.mock.calls[0][0].data;
    expect(evt).toMatchObject({ returnId: 'ret_c1', type: RETURN_CREATED, actor: 'customer' });
    expect(typeof evt.data.timestamp).toBe('string');
    expect(notification.sendReturnConfirmation).toHaveBeenCalledTimes(1);
    expect(notification.sendReturnConfirmation).toHaveBeenCalledWith(record);
    expect(unhandled).toHaveLength(0);
  });

  it('still logs the event but does not email when the return cannot be found', async () => {
    prisma.return.findUnique.mockResolvedValue(null);
    prisma.returnEvent.create.mockResolvedValue({});
    loadHandler('onReturnCreated');

    eventBus.emit(RETURN_CREATED, { returnId: 'ghost', shopId: 'shop_test_1' });
    await flush();

    expect(prisma.returnEvent.create).toHaveBeenCalledTimes(1);
    expect(notification.sendReturnConfirmation).not.toHaveBeenCalled();
  });

  it('catches DB errors and logs instead of producing an unhandled rejection', async () => {
    prisma.return.findUnique.mockRejectedValue(new Error('db down'));
    loadHandler('onReturnCreated');

    eventBus.emit(RETURN_CREATED, { returnId: 'ret_c1', shopId: 'shop_test_1' });
    await flush();

    expect(unhandled).toHaveLength(0);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining(`Error handling ${RETURN_CREATED}`),
      expect.any(Error),
    );
    expect(notification.sendReturnConfirmation).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// onReturnApproved — the critical approve → label → label-email sequence
// ---------------------------------------------------------------------------
describe('onReturnApproved', () => {
  const approvedRecord = fakeReturn({ id: 'ret_a1', status: 'APPROVED', items: [{ id: 'i1' }] });
  const labelledRecord = fakeReturn({ id: 'ret_a1', status: 'LABEL_SENT', label: { id: 'lbl_1' } });

  function primeHappyPath() {
    prisma.return.findUnique
      .mockResolvedValueOnce(approvedRecord) // first lookup (items)
      .mockResolvedValueOnce(labelledRecord); // second lookup (label)
    prisma.returnEvent.create.mockResolvedValue({});
  }

  it('logs the event, emails approval, generates the label, then emails the label — in order', async () => {
    primeHappyPath();
    loadHandler('onReturnApproved');

    eventBus.emit(RETURN_APPROVED, { returnId: 'ret_a1', shopId: 'shop_test_1', approvedBy: 'merchant:alice' });
    await flush();

    // ReturnEvent with approver as actor
    expect(prisma.returnEvent.create).toHaveBeenCalledTimes(1);
    expect(prisma.returnEvent.create.mock.calls[0][0].data).toMatchObject({
      returnId: 'ret_a1',
      type: RETURN_APPROVED,
      actor: 'merchant:alice',
    });

    // Emails + label
    expect(notification.sendReturnApproved).toHaveBeenCalledWith(approvedRecord);
    expect(labelService.generateLabel).toHaveBeenCalledWith('ret_a1');
    expect(notification.sendLabelReady).toHaveBeenCalledTimes(1);
    const [retArg, labelArg] = notification.sendLabelReady.mock.calls[0];
    expect(retArg).toBe(labelledRecord); // re-fetched WITH the label
    expect(labelArg).toEqual(expect.objectContaining({ id: 'lbl_1', trackingCode: 'EVR123' }));

    // Second lookup includes the label relation
    expect(prisma.return.findUnique).toHaveBeenNthCalledWith(2, {
      where: { id: 'ret_a1' },
      include: { label: true },
    });

    // Ordering: approved email → generateLabel → label email
    const order = [
      notification.sendReturnApproved.mock.invocationCallOrder[0],
      labelService.generateLabel.mock.invocationCallOrder[0],
      notification.sendLabelReady.mock.invocationCallOrder[0],
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(unhandled).toHaveLength(0);
  });

  it('defaults the event actor to "merchant" when approvedBy is omitted', async () => {
    primeHappyPath();
    loadHandler('onReturnApproved');

    eventBus.emit(RETURN_APPROVED, { returnId: 'ret_a1', shopId: 'shop_test_1' });
    await flush();

    expect(prisma.returnEvent.create.mock.calls[0][0].data.actor).toBe('merchant');
  });

  it('an approved-email failure does NOT block label generation or the label email', async () => {
    primeHappyPath();
    notification.sendReturnApproved.mockRejectedValue(new Error('resend 500'));
    loadHandler('onReturnApproved');

    eventBus.emit(RETURN_APPROVED, { returnId: 'ret_a1', shopId: 'shop_test_1' });
    await flush();

    expect(labelService.generateLabel).toHaveBeenCalledWith('ret_a1');
    expect(notification.sendLabelReady).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Approved email failed for ret_a1'),
      'resend 500',
    );
    expect(unhandled).toHaveLength(0);
  });

  it('a label-generation failure is caught and logged; no label email, no unhandled rejection', async () => {
    primeHappyPath();
    labelService.generateLabel.mockRejectedValue(new Error('carrier API down'));
    loadHandler('onReturnApproved');

    eventBus.emit(RETURN_APPROVED, { returnId: 'ret_a1', shopId: 'shop_test_1' });
    await flush();

    expect(notification.sendReturnApproved).toHaveBeenCalledTimes(1);
    expect(notification.sendLabelReady).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Label generation failed for ret_a1'),
      'carrier API down',
    );
    // The outer catch must NOT have fired — the failure was contained.
    expect(consoleErrorSpy).not.toHaveBeenCalledWith(
      expect.stringContaining(`Error handling ${RETURN_APPROVED}`),
      expect.anything(),
    );
    expect(unhandled).toHaveLength(0);
  });

  it('skips the approved email when the return is missing but still attempts label generation', async () => {
    prisma.return.findUnique.mockResolvedValue(null);
    prisma.returnEvent.create.mockResolvedValue({});
    loadHandler('onReturnApproved');

    eventBus.emit(RETURN_APPROVED, { returnId: 'ghost', shopId: 'shop_test_1' });
    await flush();

    expect(notification.sendReturnApproved).not.toHaveBeenCalled();
    expect(labelService.generateLabel).toHaveBeenCalledWith('ghost');
    // Second lookup returned null too → no label email
    expect(notification.sendLabelReady).not.toHaveBeenCalled();
  });

  it('a failure writing the ReturnEvent is caught by the outer handler (no label generated)', async () => {
    prisma.return.findUnique.mockResolvedValue(approvedRecord);
    prisma.returnEvent.create.mockRejectedValue(new Error('unique violation'));
    loadHandler('onReturnApproved');

    eventBus.emit(RETURN_APPROVED, { returnId: 'ret_a1', shopId: 'shop_test_1' });
    await flush();

    expect(labelService.generateLabel).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining(`Error handling ${RETURN_APPROVED}`),
      expect.any(Error),
    );
    expect(unhandled).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// onLabelGenerated
// ---------------------------------------------------------------------------
describe('onLabelGenerated', () => {
  it('moves the return to LABEL_SENT and logs a ReturnEvent carrying the labelId', async () => {
    prisma.return.update.mockResolvedValue({});
    prisma.returnEvent.create.mockResolvedValue({});
    loadHandler('onLabelGenerated');

    eventBus.emit(LABEL_GENERATED, { returnId: 'ret_l1', labelId: 'lbl_9' });
    await flush();

    expect(prisma.return.update).toHaveBeenCalledWith({
      where: { id: 'ret_l1' },
      data: { status: 'LABEL_SENT' },
    });
    expect(prisma.returnEvent.create).toHaveBeenCalledTimes(1);
    const evt = prisma.returnEvent.create.mock.calls[0][0].data;
    expect(evt).toMatchObject({ returnId: 'ret_l1', type: LABEL_GENERATED, actor: 'system' });
    expect(evt.data).toMatchObject({ labelId: 'lbl_9' });
  });

  it('does NOT send the label-ready email itself (onReturnApproved owns that)', async () => {
    prisma.return.update.mockResolvedValue({});
    prisma.returnEvent.create.mockResolvedValue({});
    loadHandler('onLabelGenerated');

    eventBus.emit(LABEL_GENERATED, { returnId: 'ret_l1', labelId: 'lbl_9' });
    await flush();

    expect(notification.sendLabelReady).not.toHaveBeenCalled();
  });

  it('catches a DB failure and logs it rather than rejecting', async () => {
    prisma.return.update.mockRejectedValue(new Error('db down'));
    loadHandler('onLabelGenerated');

    eventBus.emit(LABEL_GENERATED, { returnId: 'ret_l1', labelId: 'lbl_9' });
    await flush();

    expect(prisma.returnEvent.create).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining(`Error handling ${LABEL_GENERATED}`),
      expect.any(Error),
    );
    expect(unhandled).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// onRefundProcessed
// ---------------------------------------------------------------------------
describe('onRefundProcessed', () => {
  it('logs a ReturnEvent with amount + resolution and emails the refund confirmation', async () => {
    const record = fakeReturn({ id: 'ret_r1', status: 'PROCESSED', refundAmount: 42.5 });
    prisma.return.findUnique.mockResolvedValue(record);
    prisma.returnEvent.create.mockResolvedValue({});
    loadHandler('onRefundProcessed');

    eventBus.emit(REFUND_PROCESSED, { returnId: 'ret_r1', refundAmount: 42.5, resolution: 'REFUND' });
    await flush();

    expect(prisma.return.findUnique).toHaveBeenCalledWith({ where: { id: 'ret_r1' } });
    expect(prisma.returnEvent.create).toHaveBeenCalledTimes(1);
    const evt = prisma.returnEvent.create.mock.calls[0][0].data;
    expect(evt).toMatchObject({ returnId: 'ret_r1', type: REFUND_PROCESSED, actor: 'system' });
    expect(evt.data).toMatchObject({ refundAmount: 42.5, resolution: 'REFUND' });
    expect(notification.sendRefundProcessed).toHaveBeenCalledWith(record);
    expect(unhandled).toHaveLength(0);
  });

  it('does not touch return status itself (RefundService already set PROCESSED)', async () => {
    prisma.return.findUnique.mockResolvedValue(fakeReturn({ id: 'ret_r1' }));
    prisma.returnEvent.create.mockResolvedValue({});
    loadHandler('onRefundProcessed');

    eventBus.emit(REFUND_PROCESSED, { returnId: 'ret_r1', refundAmount: 10, resolution: 'STORE_CREDIT' });
    await flush();

    expect(prisma.return.update).not.toHaveBeenCalled();
  });

  it('logs the event but skips the email when the return is missing', async () => {
    prisma.return.findUnique.mockResolvedValue(null);
    prisma.returnEvent.create.mockResolvedValue({});
    loadHandler('onRefundProcessed');

    eventBus.emit(REFUND_PROCESSED, { returnId: 'ghost', refundAmount: 1, resolution: 'REFUND' });
    await flush();

    expect(prisma.returnEvent.create).toHaveBeenCalledTimes(1);
    expect(notification.sendRefundProcessed).not.toHaveBeenCalled();
  });

  it('an email failure is caught and logged (no unhandled rejection)', async () => {
    prisma.return.findUnique.mockResolvedValue(fakeReturn({ id: 'ret_r1' }));
    prisma.returnEvent.create.mockResolvedValue({});
    notification.sendRefundProcessed.mockRejectedValue(new Error('smtp'));
    loadHandler('onRefundProcessed');

    eventBus.emit(REFUND_PROCESSED, { returnId: 'ret_r1', refundAmount: 1, resolution: 'REFUND' });
    await flush();

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining(`Error handling ${REFUND_PROCESSED}`),
      expect.any(Error),
    );
    expect(unhandled).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Cross-handler: a single emit fans out to exactly the registered handlers
// ---------------------------------------------------------------------------
describe('pipeline wiring', () => {
  it('loading all four handlers registers one listener per event and does not double-register on re-require', () => {
    loadHandler('onReturnCreated');
    loadHandler('onReturnApproved');
    loadHandler('onLabelGenerated');
    loadHandler('onRefundProcessed');
    // Re-requiring is a cached module → no extra listeners
    loadHandler('onReturnApproved');

    expect(eventBus.listenerCount(RETURN_CREATED)).toBe(1);
    expect(eventBus.listenerCount(RETURN_APPROVED)).toBe(1);
    expect(eventBus.listenerCount(LABEL_GENERATED)).toBe(1);
    expect(eventBus.listenerCount(REFUND_PROCESSED)).toBe(1);
  });

  it('LabelService emitting LABEL_GENERATED after approval marks the return LABEL_SENT via onLabelGenerated', async () => {
    // Simulate the real LabelService side-effect: emit LABEL_GENERATED on the bus.
    prisma.return.findUnique.mockResolvedValue(fakeReturn({ id: 'ret_p1' }));
    prisma.return.update.mockResolvedValue({});
    prisma.returnEvent.create.mockResolvedValue({});
    loadHandler('onReturnApproved');
    loadHandler('onLabelGenerated');
    labelService.generateLabel.mockImplementation(async (returnId) => {
      eventBus.emit(LABEL_GENERATED, { returnId, labelId: 'lbl_p' });
      return { id: 'lbl_p', trackingCode: 'T1' };
    });

    eventBus.emit(RETURN_APPROVED, { returnId: 'ret_p1', shopId: 'shop_test_1' });
    await flush();

    expect(prisma.return.update).toHaveBeenCalledWith({
      where: { id: 'ret_p1' },
      data: { status: 'LABEL_SENT' },
    });
    const types = prisma.returnEvent.create.mock.calls.map((c) => c[0].data.type);
    expect(types).toEqual(expect.arrayContaining([RETURN_APPROVED, LABEL_GENERATED]));
    expect(notification.sendLabelReady).toHaveBeenCalledTimes(1);
  });
});

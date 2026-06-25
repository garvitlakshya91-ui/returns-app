const { installQueueMock, fakeReturn, fakeReturnItem } = require('../helpers');

let queue;
let NotificationService;

beforeEach(() => {
  jest.resetModules();
  queue = installQueueMock();
  NotificationService = require('../../app/services/NotificationService');
});

describe('NotificationService.sendEmail', () => {
  it('queues a send-email job with attempts + backoff', async () => {
    await NotificationService.sendEmail({
      to: 'jane@x.com',
      subject: 'Hi',
      template: 'ReturnConfirmed',
      data: { foo: 'bar' },
    });
    expect(queue.add).toHaveBeenCalledWith(
      'send-email',
      { to: 'jane@x.com', subject: 'Hi', template: 'ReturnConfirmed', data: { foo: 'bar' } },
      expect.objectContaining({
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
      }),
    );
  });
});

describe('NotificationService named-template helpers', () => {
  it('sendReturnConfirmation builds the right payload', async () => {
    const ret = fakeReturn({
      items: [fakeReturnItem({ productTitle: 'A', variantTitle: 'M', reason: 'doesnt_fit', quantity: 1 })],
    });
    await NotificationService.sendReturnConfirmation(ret);
    const args = queue.add.mock.calls[0][1];
    expect(args.template).toBe('ReturnConfirmed');
    expect(args.to).toBe(ret.customerEmail);
    expect(args.data.items[0]).toEqual({ title: 'A', variant: 'M', reason: 'doesnt_fit', quantity: 1 });
  });

  it('sendLabelReady includes carrier, tracking and labelUrl', async () => {
    const ret = fakeReturn();
    const label = { labelUrl: 'http://x', qrCodeUrl: 'data:image/png;base64,xx', carrier: 'evri', trackingCode: 'EVR1' };
    await NotificationService.sendLabelReady(ret, label);
    const args = queue.add.mock.calls[0][1];
    expect(args.template).toBe('LabelReady');
    expect(args.data.carrier).toBe('evri');
    expect(args.data.trackingCode).toBe('EVR1');
    expect(args.data.labelUrl).toBe('http://x');
  });

  it('sendRefundProcessed maps resolution → human text', async () => {
    const ret = fakeReturn({ resolution: 'STORE_CREDIT', refundAmount: 50 });
    await NotificationService.sendRefundProcessed(ret);
    const args = queue.add.mock.calls[0][1];
    expect(args.template).toBe('RefundProcessed');
    expect(args.data.resolutionText).toMatch(/store credit/i);
  });

  it('sendRefundProcessed falls back to "processed" for unknown resolutions', async () => {
    const ret = fakeReturn({ resolution: 'WAT' });
    await NotificationService.sendRefundProcessed(ret);
    const args = queue.add.mock.calls[0][1];
    expect(args.data.resolutionText).toBe('processed');
  });

  it('sendReturnRejected includes the reason', async () => {
    const ret = fakeReturn();
    await NotificationService.sendReturnRejected(ret, 'Outside return window');
    const args = queue.add.mock.calls[0][1];
    expect(args.template).toBe('ReturnRejected');
    expect(args.data.reason).toBe('Outside return window');
  });
});

describe('NotificationService — queue unavailable', () => {
  it('falls back to direct send (never throws) when queue is unavailable', async () => {
    jest.resetModules();
    jest.doMock('../../app/jobs/queue', () => ({
      QUEUE_NAMES: { SEND_EMAIL: 'send-email' },
      getQueue: () => null,
    }));
    // Stub the direct-send path so the test doesn't load esbuild/react-email.
    const sendEmailNow = jest.fn().mockResolvedValue({ sent: true, to: 'x', subject: 's' });
    jest.doMock('../../app/services/emailRenderer', () => ({ sendEmailNow }));

    const NS = require('../../app/services/NotificationService');
    const out = await NS.sendEmail({ to: 'x', subject: 's', template: 't', data: {} });

    expect(sendEmailNow).toHaveBeenCalledWith({ to: 'x', subject: 's', template: 't', data: {} });
    expect(out).toEqual({ sent: true, to: 'x', subject: 's' });
  });

  it('returns null and does not throw when the direct send also fails', async () => {
    jest.resetModules();
    jest.doMock('../../app/jobs/queue', () => ({
      QUEUE_NAMES: { SEND_EMAIL: 'send-email' },
      getQueue: () => null,
    }));
    jest.doMock('../../app/services/emailRenderer', () => ({
      sendEmailNow: jest.fn().mockRejectedValue(new Error('resend down')),
    }));

    const NS = require('../../app/services/NotificationService');
    const out = await NS.sendEmail({ to: 'x', subject: 's', template: 't', data: {} });
    expect(out).toBeNull();
  });
});

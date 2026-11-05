const { installQueueMock, installPrismaMock, fakeReturn, fakeReturnItem } = require('../helpers');

let queue;
let prisma;
let NotificationService;

beforeEach(() => {
  jest.resetModules();
  queue = installQueueMock();
  prisma = installPrismaMock();
  prisma.shop.findUnique.mockResolvedValue({
    name: 'Wildgrove & Co.',
    email: 'hello@wildgrove.co',
    settings: { primaryColor: '#FF8800', supportEmail: 'help@wildgrove.co', logoUrl: 'https://wildgrove.co/logo.png' },
  });
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
    // Merchant branding is resolved and attached to every email.
    expect(args.data.brand).toEqual({
      name: 'Wildgrove & Co.', color: '#FF8800', supportEmail: 'help@wildgrove.co', logoUrl: 'https://wildgrove.co/logo.png',
    });
  });

  it('sendLabelReady includes carrier, tracking and labelUrl', async () => {
    const ret = fakeReturn();
    const label = { labelUrl: 'http://x', qrCodeUrl: 'data:image/png;base64,xx', carrier: 'evri', trackingCode: 'EVR1' };
    await NotificationService.sendLabelReady(ret, label);
    const args = queue.add.mock.calls[0][1];
    expect(args.template).toBe('LabelReady');
    // The email shows the carrier's real name, not the stored code.
    expect(args.data.carrier).toBe('Evri');
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

describe('NotificationService.sendEmail direct: true', () => {
  it('skips the queue, sends now, and returns the real outcome', async () => {
    jest.resetModules();
    const q = installQueueMock();
    const sendEmailNow = jest.fn().mockResolvedValue({ sent: true, to: 'x', subject: 's', id: 'msg_1' });
    jest.doMock('../../app/services/emailRenderer', () => ({ sendEmailNow }));
    const NS = require('../../app/services/NotificationService');

    const out = await NS.sendEmail({ to: 'x', subject: 's', template: 't', data: {}, direct: true });

    expect(q.add).not.toHaveBeenCalled();
    expect(sendEmailNow).toHaveBeenCalledWith({ to: 'x', subject: 's', template: 't', data: {} });
    expect(out).toEqual({ sent: true, to: 'x', subject: 's', id: 'msg_1' });
  });

  it('lets a refusal through to the caller instead of swallowing it', async () => {
    jest.resetModules();
    installQueueMock();
    jest.doMock('../../app/services/emailRenderer', () => ({
      sendEmailNow: jest.fn().mockRejectedValue(new Error('Resend refused the email: invalid address')),
    }));
    const NS = require('../../app/services/NotificationService');
    await expect(NS.sendEmail({ to: 'x', subject: 's', template: 't', data: {}, direct: true }))
      .rejects.toThrow('Resend refused the email: invalid address');
  });

  it('sendLabelReady passes direct through', async () => {
    jest.resetModules();
    const q = installQueueMock();
    const p = installPrismaMock();
    p.shop.findUnique.mockResolvedValue({ name: 'S', email: 'e', settings: {} });
    const sendEmailNow = jest.fn().mockResolvedValue({ sent: true });
    jest.doMock('../../app/services/emailRenderer', () => ({ sendEmailNow }));
    const NS = require('../../app/services/NotificationService');

    await NS.sendLabelReady(fakeReturn(), { carrier: 'evri', trackingCode: 'T1', labelUrl: 'u', qrCodeUrl: 'q' }, { direct: true });
    expect(q.add).not.toHaveBeenCalled();
    expect(sendEmailNow).toHaveBeenCalledWith(expect.objectContaining({ template: 'LabelReady', to: 'jane@example.com' }));
  });
});

describe('NotificationService.sendNewReturnAlert (merchant)', () => {
  const shop = { email: 'owner@wildgrove.co', name: 'Wildgrove & Co.', settings: {}, shopifyDomain: 'wildgrove.myshopify.com', currency: 'GBP' };

  it('emails the shop address with the request summary and a deep link into the embedded app', async () => {
    process.env.SHOPIFY_API_KEY = 'apikey123';
    try {
      const ret = fakeReturn({
        id: 'ret_9', resolution: 'STORE_CREDIT', totalValue: 47.5,
        items: [fakeReturnItem({ productTitle: 'A', variantTitle: 'M', reason: 'doesnt_fit', reasonDetail: 'too tight', quantity: 2 })],
      });
      await NotificationService.sendNewReturnAlert(shop, ret);
      const args = queue.add.mock.calls[0][1];
      expect(args.to).toBe('owner@wildgrove.co');
      expect(args.template).toBe('NewReturnRequest');
      expect(args.subject).toBe('New return request — #1001');
      expect(args.data).toMatchObject({
        shopName: 'Wildgrove & Co.',
        orderName: '#1001',
        customerName: 'Jane Doe',
        customerEmail: 'jane@example.com',
        resolution: 'STORE_CREDIT',
        totalValue: 47.5,
        currency: 'GBP',
        returnUrl: 'https://admin.shopify.com/store/wildgrove/apps/apikey123/returns/ret_9',
      });
      expect(args.data.items[0]).toEqual({ title: 'A', variant: 'M', reason: 'doesnt_fit', detail: 'too tight', quantity: 2 });
    } finally {
      process.env.SHOPIFY_API_KEY = 'test_api_key'; // as tests/setupEnv.js sets it
    }
  });

  it('sends nothing when the merchant chose "No notification"', async () => {
    const out = await NotificationService.sendNewReturnAlert({ ...shop, settings: { merchantNotify: 'none' } }, fakeReturn());
    expect(out).toBeNull();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('sends nothing (and does not throw) when the shop has no email', async () => {
    const out = await NotificationService.sendNewReturnAlert({ ...shop, email: null }, fakeReturn());
    expect(out).toBeNull();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('omits the deep link when the api key is not configured', async () => {
    delete process.env.SHOPIFY_API_KEY;
    try {
      await NotificationService.sendNewReturnAlert(shop, fakeReturn());
      expect(queue.add.mock.calls[0][1].data.returnUrl).toBeNull();
    } finally {
      process.env.SHOPIFY_API_KEY = 'test_api_key';
    }
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

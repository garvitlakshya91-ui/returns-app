// NotificationService — fallback paths and branding edge cases not covered by
// NotificationService.test.js: queue lookup throwing, queue.add rejecting,
// branding lookup failures, and the direct-send path running against the
// real emailRenderer with/without a Resend key.

const { installPrismaMock, installResendMock, fakeReturn } = require('../helpers');

let prisma;

const RENDERER = '../../app/services/emailRenderer';

// `renderer`: a stub module for emailRenderer, or omit to use the real one.
// doMock registrations survive jest.resetModules(), so the real-module case
// must explicitly un-mock what an earlier test registered.
function load({ queue, renderer } = {}) {
  jest.resetModules();
  prisma = installPrismaMock();
  // Keep pino from spawning a pretty-print transport on every module reset.
  jest.doMock('../../app/utils/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() }));
  jest.doMock('../../app/jobs/queue', () => ({
    QUEUE_NAMES: { SEND_EMAIL: 'send-email' },
    getQueue: queue || (() => null),
  }));
  if (renderer) jest.doMock(RENDERER, () => renderer);
  else jest.dontMock(RENDERER);
  return require('../../app/services/NotificationService');
}

afterEach(() => {
  delete process.env.RESEND_API_KEY;
  delete process.env.RESEND_FROM;
});

describe('sendEmail — queue failure modes', () => {
  it('falls back to direct send when getQueue() itself throws', async () => {
    const sendEmailNow = jest.fn().mockResolvedValue({ sent: true, to: 'x', subject: 's' });
    const NS = load({ queue: () => { throw new Error('Redis connection refused'); }, renderer: { sendEmailNow } });

    const out = await NS.sendEmail({ to: 'x', subject: 's', template: 'ReturnApproved', data: { a: 1 } });

    expect(sendEmailNow).toHaveBeenCalledWith({ to: 'x', subject: 's', template: 'ReturnApproved', data: { a: 1 } });
    expect(out).toEqual({ sent: true, to: 'x', subject: 's' });
  });

  it('falls back to direct send when queue.add() rejects (e.g. Upstash over quota)', async () => {
    const add = jest.fn().mockRejectedValue(new Error('max requests limit exceeded'));
    const sendEmailNow = jest.fn().mockResolvedValue({ sent: true, to: 'x', subject: 's' });
    const NS = load({ queue: () => ({ add }), renderer: { sendEmailNow } });

    const out = await NS.sendEmail({ to: 'x', subject: 's', template: 'LabelReady', data: {} });

    expect(add).toHaveBeenCalledTimes(1);
    expect(sendEmailNow).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ sent: true, to: 'x', subject: 's' });
  });

  it('returns the queue job and never touches the direct path when the queue works', async () => {
    const add = jest.fn().mockResolvedValue({ id: 'job_9' });
    const sendEmailNow = jest.fn();
    const NS = load({ queue: () => ({ add }), renderer: { sendEmailNow } });

    const out = await NS.sendEmail({ to: 'x', subject: 's', template: 'LabelReady', data: {} });
    expect(out).toEqual({ id: 'job_9' });
    expect(sendEmailNow).not.toHaveBeenCalled();
  });

  it('swallows a direct-send failure after a queue.add failure and resolves null', async () => {
    const add = jest.fn().mockRejectedValue(new Error('queue down'));
    const NS = load({
      queue: () => ({ add }),
      renderer: { sendEmailNow: jest.fn().mockRejectedValue(new Error('resend down')) },
    });
    await expect(NS.sendEmail({ to: 'x', subject: 's', template: 't', data: {} })).resolves.toBeNull();
  });
});

describe('sendEmail — direct path through the real emailRenderer', () => {
  // The generic (non-JSX) fallback template keeps this test free of React
  // Email rendering, which is covered in emailRenderer.test.js.
  it('with no RESEND_API_KEY, skips Resend but still reports the email as sent', async () => {
    delete process.env.RESEND_API_KEY;
    const resend = installResendMock();
    const NS = load(); // getQueue → null
    const out = await NS.sendEmail({ to: 'jane@x.com', subject: 'Hi', template: 'GenericFallback', data: { k: 1 } });
    expect(out).toEqual({ sent: true, to: 'jane@x.com', subject: 'Hi' });
    expect(resend.send).not.toHaveBeenCalled();
  });

  it('with RESEND_API_KEY, sends via Resend using the default from-address', async () => {
    process.env.RESEND_API_KEY = 're_123';
    const resend = installResendMock();
    const NS = load();
    const out = await NS.sendEmail({ to: 'jane@x.com', subject: 'Hi', template: 'GenericFallback', data: { k: 1 } });
    expect(out).toEqual({ sent: true, to: 'jane@x.com', subject: 'Hi' });
    expect(resend.send).toHaveBeenCalledTimes(1);
    const payload = resend.send.mock.calls[0][0];
    expect(payload.from).toBe('ReturnFlow <onboarding@resend.dev>');
    expect(payload.to).toBe('jane@x.com');
    expect(payload.html).toContain('Notification: GenericFallback');
  });

  it('swallows a Resend error on the direct path (resolves null, never throws)', async () => {
    process.env.RESEND_API_KEY = 're_123';
    const resend = installResendMock();
    resend.send.mockRejectedValue(new Error('resend 500'));
    const NS = load();
    await expect(NS.sendEmail({ to: 'jane@x.com', subject: 'Hi', template: 'GenericFallback', data: {} })).resolves.toBeNull();
  });
});

describe('_branding', () => {
  it('returns ReturnFlow defaults when the shop lookup throws', async () => {
    const NS = load();
    prisma.shop.findUnique.mockRejectedValue(new Error('db down'));
    await expect(NS._branding('shop_1')).resolves.toEqual({
      name: 'ReturnFlow', color: '#4F46E5', supportEmail: null, logoUrl: null,
    });
  });

  it('returns defaults when the shop does not exist', async () => {
    const NS = load();
    prisma.shop.findUnique.mockResolvedValue(null);
    await expect(NS._branding('missing')).resolves.toEqual({
      name: 'ReturnFlow', color: '#4F46E5', supportEmail: null, logoUrl: null,
    });
  });

  it('selects only the branding fields it needs', async () => {
    const NS = load();
    prisma.shop.findUnique.mockResolvedValue({ name: 'S', email: 'e@s.com', settings: {} });
    await NS._branding('shop_1');
    expect(prisma.shop.findUnique).toHaveBeenCalledWith({
      where: { id: 'shop_1' },
      select: { name: true, email: true, settings: true },
    });
  });

  it.each([
    ['not-a-colour', '#4F46E5'],
    ['#FFF', '#4F46E5'],          // shorthand not accepted
    ['#12345G', '#4F46E5'],       // non-hex char
    ['red', '#4F46E5'],
    [42, '#4F46E5'],              // non-string
    ['#abcDEF', '#abcDEF'],       // valid 6-digit hex passes through untouched
  ])('sanitises primaryColor %p → %s', async (primaryColor, expected) => {
    const NS = load();
    prisma.shop.findUnique.mockResolvedValue({ name: 'S', email: 'e@s.com', settings: { primaryColor } });
    expect((await NS._branding('shop_1')).color).toBe(expected);
  });

  it.each([
    ['javascript:alert(1)', null],
    ['data:image/png;base64,AAAA', null],
    ['//cdn.example.com/logo.png', null],
    ['ftp://x/logo.png', null],
    [123, null],
    ['http://cdn.example.com/logo.png', 'http://cdn.example.com/logo.png'],
    ['HTTPS://CDN.EXAMPLE.COM/logo.png', 'HTTPS://CDN.EXAMPLE.COM/logo.png'],
  ])('only allows http(s) logo URLs: %p → %p', async (logoUrl, expected) => {
    const NS = load();
    prisma.shop.findUnique.mockResolvedValue({ name: 'S', email: 'e@s.com', settings: { logoUrl } });
    expect((await NS._branding('shop_1')).logoUrl).toBe(expected);
  });

  it('prefers settings.supportEmail, then the shop email, then null', async () => {
    const NS = load();
    prisma.shop.findUnique.mockResolvedValueOnce({ name: 'S', email: 'owner@s.com', settings: { supportEmail: 'help@s.com' } });
    expect((await NS._branding('shop_1')).supportEmail).toBe('help@s.com');
    prisma.shop.findUnique.mockResolvedValueOnce({ name: 'S', email: 'owner@s.com', settings: {} });
    expect((await NS._branding('shop_1')).supportEmail).toBe('owner@s.com');
    prisma.shop.findUnique.mockResolvedValueOnce({ name: 'S', email: null, settings: null });
    expect((await NS._branding('shop_1')).supportEmail).toBeNull();
  });

  it('falls back to the ReturnFlow name when the shop has no name', async () => {
    const NS = load();
    prisma.shop.findUnique.mockResolvedValue({ name: '', email: 'e@s.com', settings: {} });
    expect((await NS._branding('shop_1')).name).toBe('ReturnFlow');
  });
});

describe('sendReturnApproved', () => {
  it('queues the ReturnApproved template with branding and return details', async () => {
    const add = jest.fn().mockResolvedValue({ id: 'job' });
    const NS = load({ queue: () => ({ add }) });
    prisma.shop.findUnique.mockResolvedValue({ name: 'Wildgrove', email: 'hi@w.co', settings: { primaryColor: '#112233' } });

    const ret = fakeReturn({ id: 'ret_77', shopifyOrderName: '#2002', customerEmail: 'c@x.com', customerName: 'Chris' });
    await NS.sendReturnApproved(ret);

    expect(add).toHaveBeenCalledTimes(1);
    const [jobName, payload, opts] = add.mock.calls[0];
    expect(jobName).toBe('send-email');
    expect(payload).toEqual({
      to: 'c@x.com',
      subject: 'Return Approved — #2002',
      template: 'ReturnApproved',
      data: {
        brand: { name: 'Wildgrove', color: '#112233', supportEmail: 'hi@w.co', logoUrl: null },
        customerName: 'Chris',
        orderName: '#2002',
        returnId: 'ret_77',
      },
    });
    expect(opts).toMatchObject({ attempts: 3 });
  });

  it('still sends (with default branding) when the branding lookup fails', async () => {
    const add = jest.fn().mockResolvedValue({ id: 'job' });
    const NS = load({ queue: () => ({ add }) });
    prisma.shop.findUnique.mockRejectedValue(new Error('db down'));

    await NS.sendReturnApproved(fakeReturn());
    expect(add.mock.calls[0][1].data.brand).toEqual({ name: 'ReturnFlow', color: '#4F46E5', supportEmail: null, logoUrl: null });
  });
});

const request = require('supertest');
const express = require('express');
const { installPrismaMock, installStripeMock, fakeReturn } = require('../helpers');

let app;
let prisma;
let stripe;
let eventBus;

function rawBodyMiddleware(req, res, next) {
  let data = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => { data += chunk; });
  req.on('end', () => {
    req.rawBody = data;
    try { req.body = JSON.parse(data); } catch { req.body = {}; }
    next();
  });
}

beforeEach(() => {
  jest.resetModules();
  prisma = installPrismaMock();
  stripe = installStripeMock();

  app = express();
  app.use('/webhooks/stripe', rawBodyMiddleware);
  app.use('/webhooks/stripe', require('../../app/routes/stripeWebhook'));

  eventBus = require('../../app/events/eventBus');
});

describe('POST /webhooks/stripe', () => {
  it('400 when stripe-signature header is missing', async () => {
    const res = await request(app)
      .post('/webhooks/stripe')
      .set('content-type', 'application/json')
      .send('{}');
    expect(res.status).toBe(400);
  });

  it('400 when signature verification throws', async () => {
    stripe.webhooks.constructEvent.mockImplementation(() => { throw new Error('No matching signature'); });
    const res = await request(app)
      .post('/webhooks/stripe')
      .set('stripe-signature', 't=1,v1=bad')
      .set('content-type', 'application/json')
      .send('{}');
    expect(res.status).toBe(400);
    expect(res.text).toMatch(/No matching signature/);
  });

  it('200 + auto-approves return on checkout.session.completed', async () => {
    stripe.webhooks.constructEvent.mockReturnValue({
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_test',
          payment_intent: 'pi_test',
          amount_total: 250, currency: 'gbp',
          metadata: { returnId: 'r1', shopId: 's1' },
        },
      },
    });
    prisma.return.findUnique.mockResolvedValue(fakeReturn({ id: 'r1', shopId: 's1', status: 'REQUESTED' }));
    prisma.returnEvent.create.mockResolvedValue({});
    prisma.return.update.mockResolvedValue({});
    const emit = jest.spyOn(eventBus, 'emit');

    const res = await request(app)
      .post('/webhooks/stripe')
      .set('stripe-signature', 't=1,v1=ok')
      .set('content-type', 'application/json')
      .send('{}');

    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);

    await new Promise((r) => setImmediate(r));
    expect(prisma.return.update).toHaveBeenCalledWith({
      where: { id: 'r1' }, data: { status: 'APPROVED' },
    });
    expect(emit).toHaveBeenCalledWith('return.approved', expect.objectContaining({
      returnId: 'r1', approvedBy: 'stripe-payment',
    }));
  });

  it('does NOT re-approve a return already past REQUESTED (idempotency)', async () => {
    stripe.webhooks.constructEvent.mockReturnValue({
      type: 'checkout.session.completed',
      data: { object: { id: 'cs', metadata: { returnId: 'r1' } } },
    });
    prisma.return.findUnique.mockResolvedValue(fakeReturn({ id: 'r1', status: 'APPROVED' }));

    await request(app)
      .post('/webhooks/stripe')
      .set('stripe-signature', 't=1,v1=ok')
      .set('content-type', 'application/json')
      .send('{}');

    await new Promise((r) => setImmediate(r));
    expect(prisma.return.update).not.toHaveBeenCalled();
  });

  it('logs stripe.payment_failed event on async_payment_failed', async () => {
    stripe.webhooks.constructEvent.mockReturnValue({
      type: 'checkout.session.async_payment_failed',
      data: { object: { id: 'cs_fail', metadata: { returnId: 'r1' } } },
    });
    prisma.returnEvent.create.mockResolvedValue({});

    await request(app)
      .post('/webhooks/stripe')
      .set('stripe-signature', 't=1,v1=ok')
      .set('content-type', 'application/json')
      .send('{}');

    await new Promise((r) => setImmediate(r));
    expect(prisma.returnEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        type: 'stripe.payment_failed',
      }),
    }));
  });

  it('ignores irrelevant event types but still ACKs 200', async () => {
    stripe.webhooks.constructEvent.mockReturnValue({
      type: 'customer.created',
      data: { object: {} },
    });
    const res = await request(app)
      .post('/webhooks/stripe')
      .set('stripe-signature', 't=1,v1=ok')
      .set('content-type', 'application/json')
      .send('{}');
    expect(res.status).toBe(200);
    expect(prisma.return.update).not.toHaveBeenCalled();
  });

  it('500 (logged) when rawBody is missing — middleware ordering bug guard', async () => {
    // Build an app WITHOUT raw body middleware to provoke the rawBody-missing branch
    jest.resetModules();
    installPrismaMock();
    installStripeMock();
    const bareApp = express();
    bareApp.use(express.json());
    bareApp.use('/webhooks/stripe', require('../../app/routes/stripeWebhook'));

    const res = await request(bareApp)
      .post('/webhooks/stripe')
      .set('stripe-signature', 't=1,v1=ok')
      .send({});
    expect(res.status).toBe(500);
  });
});

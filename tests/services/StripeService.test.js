const { installStripeMock, fakeReturn } = require('../helpers');

let stripe;
let StripeService;

beforeEach(() => {
  jest.resetModules();
  stripe = installStripeMock();
  StripeService = require('../../app/services/StripeService');
});

describe('StripeService.createCheckoutSession', () => {
  it('creates a Checkout Session with correct amount and metadata', async () => {
    stripe.checkout.sessions.create.mockResolvedValue({
      id: 'cs_test_123',
      url: 'https://checkout.stripe.com/c/pay/cs_test_123',
    });

    const result = await StripeService.createCheckoutSession({
      returnRecord: fakeReturn({ id: 'ret_1', returnFee: 2.50, shopifyOrderName: '#1001' }),
      successUrl: 'https://portal/return/ret_1?paid=1',
      cancelUrl: 'https://portal/return/ret_1?paid=0',
    });

    expect(result.sessionId).toBe('cs_test_123');
    expect(result.url).toBe('https://checkout.stripe.com/c/pay/cs_test_123');
    expect(result.amountPence).toBe(250);

    const args = stripe.checkout.sessions.create.mock.calls[0][0];
    expect(args.line_items[0].price_data.unit_amount).toBe(250);
    expect(args.line_items[0].price_data.currency).toBe('gbp');
    expect(args.metadata.returnId).toBe('ret_1');
    expect(args.metadata.shopId).toBe('shop_test_1');
    expect(args.success_url).toContain('paid=1');
    expect(args.cancel_url).toContain('paid=0');
  });

  it('rounds the fee to whole pence', async () => {
    stripe.checkout.sessions.create.mockResolvedValue({ id: 'cs', url: 'u' });
    const result = await StripeService.createCheckoutSession({
      returnRecord: fakeReturn({ returnFee: 1.235 }),
      successUrl: 's', cancelUrl: 'c',
    });
    expect(result.amountPence).toBe(124);
  });

  it('throws when returnFee is zero or missing', async () => {
    await expect(StripeService.createCheckoutSession({
      returnRecord: fakeReturn({ returnFee: 0 }),
      successUrl: 's', cancelUrl: 'c',
    })).rejects.toThrow(/no fee/);

    await expect(StripeService.createCheckoutSession({
      returnRecord: fakeReturn({ returnFee: null }),
      successUrl: 's', cancelUrl: 'c',
    })).rejects.toThrow(/no fee/);
  });

  it('uses uppercase GBP from the return record but lowercases for Stripe', async () => {
    stripe.checkout.sessions.create.mockResolvedValue({ id: 'cs', url: 'u' });
    await StripeService.createCheckoutSession({
      returnRecord: fakeReturn({ returnFee: 5, currency: 'GBP' }),
      successUrl: 's', cancelUrl: 'c',
    });
    expect(stripe.checkout.sessions.create.mock.calls[0][0].line_items[0].price_data.currency).toBe('gbp');
  });
});

describe('StripeService.verifyWebhookSignature', () => {
  it('delegates to stripe.webhooks.constructEvent with the configured secret', () => {
    stripe.webhooks.constructEvent.mockReturnValue({ type: 'checkout.session.completed', data: {} });
    const event = StripeService.verifyWebhookSignature({
      rawBody: '{"type":"x"}',
      signature: 't=1,v1=abc',
    });
    expect(stripe.webhooks.constructEvent).toHaveBeenCalledWith(
      '{"type":"x"}',
      't=1,v1=abc',
      'whsec_test_dummy',
    );
    expect(event.type).toBe('checkout.session.completed');
  });

  it('throws when STRIPE_WEBHOOK_SECRET is unset', () => {
    const orig = process.env.STRIPE_WEBHOOK_SECRET;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    expect(() => StripeService.verifyWebhookSignature({
      rawBody: '{}', signature: 'x',
    })).toThrow(/STRIPE_WEBHOOK_SECRET/);
    process.env.STRIPE_WEBHOOK_SECRET = orig;
  });

  it('propagates stripe.constructEvent errors (bad signature)', () => {
    stripe.webhooks.constructEvent.mockImplementation(() => {
      throw new Error('No signatures found matching the expected signature');
    });
    expect(() => StripeService.verifyWebhookSignature({
      rawBody: '{}', signature: 'bad',
    })).toThrow(/No signatures/);
  });
});

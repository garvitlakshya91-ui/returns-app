const Stripe = require('stripe');
const logger = require('../utils/logger');

let stripeClient = null;
function getClient() {
  if (stripeClient) return stripeClient;
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error('STRIPE_SECRET_KEY is not configured');
  }
  stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY);
  return stripeClient;
}

class StripeService {
  /**
   * Create a Stripe Checkout Session to collect a return fee.
   * The session metadata carries the returnId so the webhook can route
   * the payment to the right record.
   */
  static async createCheckoutSession({ returnRecord, successUrl, cancelUrl }) {
    const stripe = getClient();

    const amountPence = Math.round(Number(returnRecord.returnFee || 0) * 100);
    if (amountPence <= 0) {
      throw new Error('Return has no fee to collect');
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: (returnRecord.currency || 'GBP').toLowerCase(),
          product_data: {
            name: `Return fee — ${returnRecord.shopifyOrderName}`,
            description: `Fee for return ${returnRecord.id}`,
          },
          unit_amount: amountPence,
        },
        quantity: 1,
      }],
      customer_email: returnRecord.customerEmail,
      metadata: {
        returnId: returnRecord.id,
        shopId: returnRecord.shopId,
      },
      success_url: successUrl,
      cancel_url: cancelUrl,
    });

    logger.info(
      { returnId: returnRecord.id, sessionId: session.id, amountPence },
      'Stripe Checkout Session created',
    );

    return {
      sessionId: session.id,
      url: session.url,
      amountPence,
    };
  }

  /**
   * Verify a Stripe webhook signature against the raw request body.
   * Throws on invalid signature.
   */
  static verifyWebhookSignature({ rawBody, signature }) {
    const stripe = getClient();
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET is not configured');
    return stripe.webhooks.constructEvent(rawBody, signature, secret);
  }
}

module.exports = StripeService;

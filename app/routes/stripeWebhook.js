const { Router } = require('express');
const prisma = require('../config/database');
const StripeService = require('../services/StripeService');
const eventBus = require('../events/eventBus');
const { RETURN_APPROVED } = require('../events/emitters');
const logger = require('../utils/logger');

const router = Router();

/**
 * POST /webhooks/stripe
 * Verifies signature with STRIPE_WEBHOOK_SECRET, then routes events.
 *
 * Relies on req.rawBody set by the raw-body middleware in app/index.js
 * (mounted at /webhooks before express.json).
 */
router.post('/', async (req, res) => {
  const signature = req.headers['stripe-signature'];
  if (!signature) {
    return res.status(400).send('Missing stripe-signature header');
  }
  if (!req.rawBody) {
    logger.error('Stripe webhook arrived without rawBody — middleware ordering problem');
    return res.status(500).send('Raw body unavailable');
  }

  let event;
  try {
    event = StripeService.verifyWebhookSignature({
      rawBody: req.rawBody,
      signature,
    });
  } catch (err) {
    logger.warn({ err: err.message }, 'Stripe webhook signature verification failed');
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // ACK Stripe immediately, process async
  res.status(200).json({ received: true });

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(event.data.object);
        break;
      case 'checkout.session.expired':
      case 'checkout.session.async_payment_failed':
        await handleCheckoutFailed(event.data.object, event.type);
        break;
      default:
        logger.info({ type: event.type }, 'Stripe webhook event ignored');
    }
  } catch (err) {
    logger.error({ err, eventType: event.type }, 'Stripe webhook handler error');
  }
});

async function handleCheckoutCompleted(session) {
  const returnId = session.metadata?.returnId;
  if (!returnId) {
    logger.warn({ sessionId: session.id }, 'Stripe session missing returnId metadata');
    return;
  }

  const returnRecord = await prisma.return.findUnique({
    where: { id: returnId },
  });
  if (!returnRecord) {
    logger.warn({ returnId, sessionId: session.id }, 'Stripe payment for unknown return');
    return;
  }

  // Idempotency: if already approved (or beyond), skip.
  if (returnRecord.status !== 'REQUESTED') {
    logger.info(
      { returnId, status: returnRecord.status },
      'Stripe payment received but return not in REQUESTED — skipping auto-approve',
    );
    return;
  }

  await prisma.returnEvent.create({
    data: {
      returnId,
      type: 'stripe.payment_completed',
      actor: 'system',
      data: {
        sessionId: session.id,
        paymentIntentId: session.payment_intent,
        amountTotal: session.amount_total,
        currency: session.currency,
        paidAt: new Date().toISOString(),
      },
    },
  });

  await prisma.return.update({
    where: { id: returnId },
    data: { status: 'APPROVED' },
  });

  eventBus.emit(RETURN_APPROVED, {
    returnId,
    shopId: returnRecord.shopId,
    approvedBy: 'stripe-payment',
  });

  logger.info({ returnId, sessionId: session.id }, 'Return auto-approved after Stripe payment');
}

async function handleCheckoutFailed(session, reason) {
  const returnId = session.metadata?.returnId;
  if (!returnId) return;

  await prisma.returnEvent.create({
    data: {
      returnId,
      type: 'stripe.payment_failed',
      actor: 'system',
      data: {
        sessionId: session.id,
        reason,
        failedAt: new Date().toISOString(),
      },
    },
  });

  logger.info({ returnId, reason }, 'Stripe checkout session failed — return remains in REQUESTED');
}

module.exports = router;

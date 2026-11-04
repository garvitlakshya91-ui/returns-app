const eventBus = require('../eventBus');
const { RETURN_RECEIVED } = require('../emitters');
const prisma = require('../../config/database');
const NotificationService = require('../../services/NotificationService');

// The parcel is back (the carrier reported delivery, or the merchant marked
// it received): note it on the timeline and tell the customer.
eventBus.on(RETURN_RECEIVED, async ({ returnId, source }) => {
  try {
    const returnRecord = await prisma.return.findUnique({ where: { id: returnId } });

    await prisma.returnEvent.create({
      data: {
        returnId,
        type: RETURN_RECEIVED,
        actor: source === 'merchant' ? 'merchant' : 'system',
        data: { source: source || 'carrier', timestamp: new Date().toISOString() },
      },
    });

    if (returnRecord) {
      await NotificationService.sendReturnReceived(returnRecord);
    }

    console.log(`[Event] Return received: ${returnId} (${source || 'carrier'})`);
  } catch (err) {
    console.error(`[Event] Error handling ${RETURN_RECEIVED}:`, err);
  }
});

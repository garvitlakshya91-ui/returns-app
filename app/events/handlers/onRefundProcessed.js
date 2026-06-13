const eventBus = require('../eventBus');
const { REFUND_PROCESSED } = require('../emitters');
const prisma = require('../../config/database');
const NotificationService = require('../../services/NotificationService');

eventBus.on(REFUND_PROCESSED, async ({ returnId, refundAmount, resolution }) => {
  try {
    const returnRecord = await prisma.return.findUnique({
      where: { id: returnId },
    });

    // Log event
    await prisma.returnEvent.create({
      data: {
        returnId,
        type: REFUND_PROCESSED,
        actor: 'system',
        data: { refundAmount, resolution, timestamp: new Date().toISOString() },
      },
    });

    // Send refund confirmation email
    if (returnRecord) {
      await NotificationService.sendRefundProcessed(returnRecord);
    }

    console.log(`[Event] Refund processed for return: ${returnId} — £${refundAmount}`);
  } catch (err) {
    console.error(`[Event] Error handling ${REFUND_PROCESSED}:`, err);
  }
});

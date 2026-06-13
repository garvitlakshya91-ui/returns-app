const eventBus = require('../eventBus');
const { RETURN_CREATED } = require('../emitters');
const prisma = require('../../config/database');
const NotificationService = require('../../services/NotificationService');

eventBus.on(RETURN_CREATED, async ({ returnId, shopId }) => {
  try {
    const returnRecord = await prisma.return.findUnique({
      where: { id: returnId },
      include: { items: true },
    });

    // Log event
    await prisma.returnEvent.create({
      data: {
        returnId,
        type: RETURN_CREATED,
        actor: 'customer',
        data: { timestamp: new Date().toISOString() },
      },
    });

    // Send confirmation email
    if (returnRecord) {
      await NotificationService.sendReturnConfirmation(returnRecord);
    }

    console.log(`[Event] Return created: ${returnId} for shop ${shopId}`);
  } catch (err) {
    console.error(`[Event] Error handling ${RETURN_CREATED}:`, err);
  }
});

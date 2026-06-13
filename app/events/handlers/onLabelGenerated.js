const eventBus = require('../eventBus');
const { LABEL_GENERATED } = require('../emitters');
const prisma = require('../../config/database');

eventBus.on(LABEL_GENERATED, async ({ returnId, labelId }) => {
  try {
    await prisma.return.update({
      where: { id: returnId },
      data: { status: 'LABEL_SENT' },
    });

    await prisma.returnEvent.create({
      data: {
        returnId,
        type: LABEL_GENERATED,
        actor: 'system',
        data: { labelId, timestamp: new Date().toISOString() },
      },
    });

    console.log(`[Event] Label generated for return: ${returnId}`);

    // TODO: Email customer with QR/label via NotificationService
  } catch (err) {
    console.error(`[Event] Error handling ${LABEL_GENERATED}:`, err);
  }
});

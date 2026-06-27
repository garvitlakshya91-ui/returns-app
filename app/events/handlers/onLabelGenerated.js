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

    // The customer "label ready" email is sent from onReturnApproved (which
    // owns the approve → generate-label → email sequence), so it is not
    // re-sent here.
  } catch (err) {
    console.error(`[Event] Error handling ${LABEL_GENERATED}:`, err);
  }
});

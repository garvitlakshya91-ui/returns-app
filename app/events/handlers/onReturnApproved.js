const eventBus = require('../eventBus');
const { RETURN_APPROVED } = require('../emitters');
const prisma = require('../../config/database');
const LabelService = require('../../services/LabelService');
const NotificationService = require('../../services/NotificationService');

eventBus.on(RETURN_APPROVED, async ({ returnId, shopId, approvedBy }) => {
  try {
    const returnRecord = await prisma.return.findUnique({
      where: { id: returnId },
      include: { items: true },
    });

    // Log event
    await prisma.returnEvent.create({
      data: {
        returnId,
        type: RETURN_APPROVED,
        actor: approvedBy || 'merchant',
        data: { timestamp: new Date().toISOString() },
      },
    });

    // Send approved email. Wrapped so an email failure can NEVER block
    // label generation (NotificationService is already non-throwing, but
    // this is belt-and-suspenders).
    if (returnRecord) {
      try {
        await NotificationService.sendReturnApproved(returnRecord);
      } catch (emailErr) {
        console.error(`[Event] Approved email failed for ${returnId}:`, emailErr.message);
      }
    }

    // Generate label automatically — this is the critical step and must
    // run regardless of whether the approved email succeeded.
    try {
      const label = await LabelService.generateLabel(returnId);
      console.log(`[Event] Label generated for return ${returnId}: ${label.trackingCode}`);

      // Send label email
      const updatedReturn = await prisma.return.findUnique({
        where: { id: returnId },
        include: { label: true },
      });
      if (updatedReturn) {
        await NotificationService.sendLabelReady(updatedReturn, label);
      }
    } catch (labelErr) {
      console.error(`[Event] Label generation failed for ${returnId}:`, labelErr.message);
    }

    console.log(`[Event] Return approved: ${returnId}`);
  } catch (err) {
    console.error(`[Event] Error handling ${RETURN_APPROVED}:`, err);
  }
});

const eventBus = require('../eventBus');
const { RETURN_APPROVED } = require('../emitters');
const prisma = require('../../config/database');
const LabelService = require('../../services/LabelService');
const NotificationService = require('../../services/NotificationService');

eventBus.on(RETURN_APPROVED, async ({ returnId, shopId, approvedBy, withoutLabel = false }) => {
  try {
    const returnRecord = await prisma.return.findUnique({
      where: { id: returnId },
      include: { items: true, shop: true },
    });

    // Log event
    await prisma.returnEvent.create({
      data: {
        returnId,
        type: RETURN_APPROVED,
        actor: approvedBy || 'merchant',
        data: { timestamp: new Date().toISOString(), withoutLabel: Boolean(withoutLabel) },
      },
    });

    // Send approved email. Wrapped so an email failure can NEVER block
    // label generation (NotificationService is already non-throwing, but
    // this is belt-and-suspenders). Without a label, the email carries the
    // address the customer should post the parcel to.
    if (returnRecord) {
      try {
        const returnsAddress = withoutLabel ? await LabelService.returnsAddress(returnRecord.shop) : null;
        await NotificationService.sendReturnApproved(returnRecord, { withoutLabel: Boolean(withoutLabel), returnsAddress });
      } catch (emailErr) {
        console.error(`[Event] Approved email failed for ${returnId}:`, emailErr.message);
      }
    }

    // Approved without a label: the merchant chose not to buy one. Nothing
    // more to do; the return waits for the parcel.
    if (withoutLabel) {
      console.log(`[Event] Return approved without a label: ${returnId}`);
      return;
    }

    // Generate label automatically — this is the critical step and must
    // run regardless of whether the approved email succeeded.
    try {
      // LabelService also emails the customer their label, as one of the
      // steps it records and resumes; nothing to send from here.
      const label = await LabelService.generateLabel(returnId);
      console.log(`[Event] Label generated for return ${returnId}: ${label.trackingCode}`);
    } catch (labelErr) {
      console.error(`[Event] Label generation failed for ${returnId}:`, labelErr.message);
      // Put the failure on the return's timeline so the merchant sees why no
      // label went out, instead of a return that silently stays Approved.
      try {
        await prisma.returnEvent.create({
          data: {
            returnId,
            type: 'label.failed',
            actor: 'system',
            data: { error: labelErr.message, code: labelErr.code || null },
          },
        });
      } catch (eventErr) {
        console.error(`[Event] Could not record label failure for ${returnId}:`, eventErr.message);
      }
    }

    console.log(`[Event] Return approved: ${returnId}`);
  } catch (err) {
    console.error(`[Event] Error handling ${RETURN_APPROVED}:`, err);
  }
});

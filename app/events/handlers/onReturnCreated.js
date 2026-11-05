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

      // And tell the merchant, unless they switched it off in Settings.
      // Never let this stop the customer-facing side above.
      try {
        const shop = await prisma.shop.findUnique({
          where: { id: returnRecord.shopId },
          select: { email: true, name: true, settings: true, shopifyDomain: true, currency: true },
        });
        if (shop) await NotificationService.sendNewReturnAlert(shop, returnRecord);
      } catch (err) {
        console.error(`[Event] Merchant alert for ${returnId} failed:`, err);
      }
    }

    console.log(`[Event] Return created: ${returnId} for shop ${shopId}`);
  } catch (err) {
    console.error(`[Event] Error handling ${RETURN_CREATED}:`, err);
  }
});

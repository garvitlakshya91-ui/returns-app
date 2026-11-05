const { getQueue, QUEUE_NAMES } = require('../jobs/queue');
const logger = require('../utils/logger');
const { carrierDisplayName } = require('../utils/carrierName');

class NotificationService {
  /**
   * Dispatch an email. Prefers the durable BullMQ queue (retries +
   * survives restarts). If the queue is unavailable — Redis down, over
   * quota, etc. — falls back to sending directly via Resend so a Redis
   * outage never drops a customer email or, worse, throws and aborts the
   * caller (e.g. the return.approved handler, which then never reaches
   * label generation). This method NEVER throws.
   *
   * With `direct: true` the queue is skipped and the email is sent now: the
   * result says whether it really left, and a refusal throws. The label flow
   * uses this because it records "emailed" in the return's ledger and
   * retries itself; a queued job that fails later would leave that record
   * wrong (and the merchant seeing a green tick) with nothing to retry.
   */
  static async sendEmail({ to, subject, template, data, direct = false }) {
    if (direct) {
      const { sendEmailNow } = require('./emailRenderer');
      return sendEmailNow({ to, subject, template, data });
    }

    // 1) Try the durable queue path.
    let queue = null;
    try {
      queue = getQueue(QUEUE_NAMES.SEND_EMAIL);
    } catch (err) {
      logger.warn({ err: err.message }, 'Could not get email queue — will send directly');
    }

    if (queue) {
      try {
        return await queue.add('send-email', { to, subject, template, data }, {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
        });
      } catch (err) {
        logger.warn({ err: err.message, to, template }, 'Email queue add failed — sending directly');
        // fall through to direct send
      }
    }

    // 2) Direct fallback. Best-effort (no retry/durability), but far
    //    better than dropping the email or throwing.
    try {
      const { sendEmailNow } = require('./emailRenderer');
      return await sendEmailNow({ to, subject, template, data });
    } catch (err) {
      logger.error({ err: err.message, to, template }, 'Direct email send failed');
      return null; // swallow — email failure must not break the caller
    }
  }

  /**
   * Resolve the merchant's email branding from their shop settings, so
   * customer emails carry the store's name/colour/support address instead of
   * generic ReturnFlow styling. Defensive: any failure → ReturnFlow defaults.
   */
  static async _branding(shopId) {
    try {
      const prisma = require('../config/database');
      const shop = await prisma.shop.findUnique({
        where: { id: shopId },
        select: { name: true, email: true, settings: true },
      });
      const s = shop?.settings || {};
      const color = typeof s.primaryColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(s.primaryColor)
        ? s.primaryColor
        : '#4F46E5';
      // Only allow http(s) image URLs in the email — never javascript:/data: etc.
      const logoUrl = typeof s.logoUrl === 'string' && /^https?:\/\//i.test(s.logoUrl) ? s.logoUrl : null;
      return {
        name: shop?.name || 'ReturnFlow',
        color,
        supportEmail: s.supportEmail || shop?.email || null,
        logoUrl,
      };
    } catch {
      return { name: 'ReturnFlow', color: '#4F46E5', supportEmail: null, logoUrl: null };
    }
  }

  /**
   * Send return confirmation email.
   */
  static async sendReturnConfirmation(returnRecord) {
    const brand = await NotificationService._branding(returnRecord.shopId);
    return NotificationService.sendEmail({
      to: returnRecord.customerEmail,
      subject: `Return Request Received — ${returnRecord.shopifyOrderName}`,
      template: 'ReturnConfirmed',
      data: {
        brand,
        customerName: returnRecord.customerName,
        orderName: returnRecord.shopifyOrderName,
        returnId: returnRecord.id,
        items: returnRecord.items?.map((i) => ({
          title: i.productTitle,
          variant: i.variantTitle,
          reason: i.reason,
          quantity: i.quantity,
        })),
      },
    });
  }

  /**
   * Send label ready email with QR code.
   */
  static async sendLabelReady(returnRecord, label, { direct = false } = {}) {
    const brand = await NotificationService._branding(returnRecord.shopId);
    return NotificationService.sendEmail({
      direct,
      to: returnRecord.customerEmail,
      subject: `Your Return Label is Ready — ${returnRecord.shopifyOrderName}`,
      template: 'LabelReady',
      data: {
        brand,
        customerName: returnRecord.customerName,
        orderName: returnRecord.shopifyOrderName,
        returnId: returnRecord.id,
        labelUrl: label.labelUrl,
        qrCodeUrl: label.qrCodeUrl,
        carrier: carrierDisplayName(label.carrier),
        trackingCode: label.trackingCode,
      },
    });
  }

  /**
   * Tell the merchant a customer has asked for a return (Settings →
   * Notifications, "Notify merchant on new return"). Off when the shop set
   * it to 'none'; otherwise goes to the shop's email. Returns null when
   * nothing was sent.
   */
  static async sendNewReturnAlert(shop, returnRecord) {
    const settings = shop?.settings || {};
    if (settings.merchantNotify === 'none') return null;
    const to = shop?.email;
    if (!to) {
      logger.warn({ shopId: returnRecord?.shopId }, 'No shop email to send the new-return alert to');
      return null;
    }

    const slug = shop.shopifyDomain ? String(shop.shopifyDomain).split('.')[0] : '';
    const apiKey = process.env.SHOPIFY_API_KEY;
    const returnUrl = slug && apiKey
      ? `https://admin.shopify.com/store/${slug}/apps/${apiKey}/returns/${returnRecord.id}`
      : null;

    return NotificationService.sendEmail({
      to,
      subject: `New return request — ${returnRecord.shopifyOrderName}`,
      template: 'NewReturnRequest',
      data: {
        brand: { name: 'ReturnFlow', color: '#4F46E5', supportEmail: null, logoUrl: null },
        shopName: shop.name || null,
        orderName: returnRecord.shopifyOrderName,
        customerName: returnRecord.customerName,
        customerEmail: returnRecord.customerEmail,
        resolution: returnRecord.resolution || null,
        totalValue: returnRecord.totalValue != null ? Number(returnRecord.totalValue) : null,
        currency: returnRecord.currency || shop.currency || 'GBP',
        returnUrl,
        items: (returnRecord.items || []).map((i) => ({
          title: i.productTitle,
          variant: i.variantTitle,
          reason: i.reason,
          detail: i.reasonDetail || null,
          quantity: i.quantity,
        })),
      },
    });
  }

  /**
   * Send refund processed confirmation.
   */
  static async sendRefundProcessed(returnRecord) {
    const resolutionText = {
      REFUND: 'refunded to your original payment method',
      STORE_CREDIT: 'issued as store credit on your account with the store',
      EXCHANGE: 'processed as an exchange',
    }[returnRecord.resolution] || 'processed';

    const brand = await NotificationService._branding(returnRecord.shopId);
    return NotificationService.sendEmail({
      to: returnRecord.customerEmail,
      subject: `Refund Processed — ${returnRecord.shopifyOrderName}`,
      template: 'RefundProcessed',
      data: {
        brand,
        customerName: returnRecord.customerName,
        orderName: returnRecord.shopifyOrderName,
        returnId: returnRecord.id,
        resolution: returnRecord.resolution,
        resolutionText,
        refundAmount: returnRecord.refundAmount,
        currency: returnRecord.currency || 'GBP',
      },
    });
  }

  /**
   * Send return approved notification.
   */
  static async sendReturnApproved(returnRecord, { withoutLabel = false, returnsAddress = null } = {}) {
    const brand = await NotificationService._branding(returnRecord.shopId);
    return NotificationService.sendEmail({
      to: returnRecord.customerEmail,
      subject: `Return Approved — ${returnRecord.shopifyOrderName}`,
      template: 'ReturnApproved',
      data: {
        brand,
        customerName: returnRecord.customerName,
        orderName: returnRecord.shopifyOrderName,
        returnId: returnRecord.id,
        // No label coming: the customer posts it themselves, to this address.
        withoutLabel: Boolean(withoutLabel),
        returnsAddress: withoutLabel ? returnsAddress : null,
      },
    });
  }

  /**
   * The parcel is back with the merchant: tell the customer.
   */
  static async sendReturnReceived(returnRecord) {
    const brand = await NotificationService._branding(returnRecord.shopId);
    return NotificationService.sendEmail({
      to: returnRecord.customerEmail,
      subject: `We've received your return — ${returnRecord.shopifyOrderName}`,
      template: 'ReturnReceived',
      data: {
        brand,
        customerName: returnRecord.customerName,
        orderName: returnRecord.shopifyOrderName,
        returnId: returnRecord.id,
      },
    });
  }

  /**
   * Send return rejected notification.
   */
  static async sendReturnRejected(returnRecord, reason) {
    const brand = await NotificationService._branding(returnRecord.shopId);
    return NotificationService.sendEmail({
      to: returnRecord.customerEmail,
      subject: `Return Request Update — ${returnRecord.shopifyOrderName}`,
      template: 'ReturnRejected',
      data: {
        brand,
        customerName: returnRecord.customerName,
        orderName: returnRecord.shopifyOrderName,
        returnId: returnRecord.id,
        reason,
      },
    });
  }
}

module.exports = NotificationService;

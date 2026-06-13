const { getQueue, QUEUE_NAMES } = require('../jobs/queue');

class NotificationService {
  /**
   * Queue an email to be sent via the send-email worker.
   */
  static async sendEmail({ to, subject, template, data }) {
    const queue = getQueue(QUEUE_NAMES.SEND_EMAIL);
    if (!queue) {
      // Fallback: log the email in dev
      console.log(`[Email] (queued) To: ${to} | Subject: ${subject} | Template: ${template}`);
      return null;
    }

    return queue.add('send-email', { to, subject, template, data }, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
    });
  }

  /**
   * Send return confirmation email.
   */
  static async sendReturnConfirmation(returnRecord) {
    return NotificationService.sendEmail({
      to: returnRecord.customerEmail,
      subject: `Return Request Received — ${returnRecord.shopifyOrderName}`,
      template: 'ReturnConfirmed',
      data: {
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
  static async sendLabelReady(returnRecord, label) {
    return NotificationService.sendEmail({
      to: returnRecord.customerEmail,
      subject: `Your Return Label is Ready — ${returnRecord.shopifyOrderName}`,
      template: 'LabelReady',
      data: {
        customerName: returnRecord.customerName,
        orderName: returnRecord.shopifyOrderName,
        returnId: returnRecord.id,
        labelUrl: label.labelUrl,
        qrCodeUrl: label.qrCodeUrl,
        carrier: label.carrier,
        trackingCode: label.trackingCode,
      },
    });
  }

  /**
   * Send refund processed confirmation.
   */
  static async sendRefundProcessed(returnRecord) {
    const resolutionText = {
      REFUND: 'refunded to your original payment method',
      STORE_CREDIT: 'issued as store credit (gift card sent to your email)',
      EXCHANGE: 'processed as an exchange',
    }[returnRecord.resolution] || 'processed';

    return NotificationService.sendEmail({
      to: returnRecord.customerEmail,
      subject: `Refund Processed — ${returnRecord.shopifyOrderName}`,
      template: 'RefundProcessed',
      data: {
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
  static async sendReturnApproved(returnRecord) {
    return NotificationService.sendEmail({
      to: returnRecord.customerEmail,
      subject: `Return Approved — ${returnRecord.shopifyOrderName}`,
      template: 'ReturnApproved',
      data: {
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
    return NotificationService.sendEmail({
      to: returnRecord.customerEmail,
      subject: `Return Request Update — ${returnRecord.shopifyOrderName}`,
      template: 'ReturnRejected',
      data: {
        customerName: returnRecord.customerName,
        orderName: returnRecord.shopifyOrderName,
        returnId: returnRecord.id,
        reason,
      },
    });
  }
}

module.exports = NotificationService;

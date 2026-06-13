const { createWorker, QUEUE_NAMES } = require('./queue');

const worker = createWorker(QUEUE_NAMES.SEND_EMAIL, async (job) => {
  const { to, subject, template, data } = job.data;

  try {
    // Use Resend if API key is configured
    if (process.env.RESEND_API_KEY) {
      const { Resend } = require('resend');
      const resend = new Resend(process.env.RESEND_API_KEY);

      const html = renderTemplate(template, data);

      await resend.emails.send({
        from: 'ReturnFlow <returns@returnflow.co.uk>',
        to,
        subject,
        html,
      });

      console.log(`[Email] Sent "${subject}" to ${to} via Resend`);
    } else {
      // Dev mode — just log
      console.log(`[Email] (dev) To: ${to} | Subject: ${subject} | Template: ${template}`);
    }

    return { sent: true, to, subject };
  } catch (err) {
    console.error(`[Email] Failed to send to ${to}:`, err.message);
    throw err;
  }
});

/**
 * Simple HTML email template renderer.
 * In production, replace with React Email or MJML templates.
 */
function renderTemplate(template, data) {
  const templates = {
    ReturnConfirmed: (d) => `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #4F46E5;">Return Request Received</h2>
        <p>Hi ${d.customerName},</p>
        <p>We've received your return request for order <strong>${d.orderName}</strong>.</p>
        <p>Your return ID is: <strong>${d.returnId}</strong></p>
        ${d.items ? `<ul>${d.items.map((i) => `<li>${i.title} (${i.variant}) — ${i.reason}</li>`).join('')}</ul>` : ''}
        <p>We'll review your request and get back to you shortly.</p>
        <p style="color: #6b7280; font-size: 12px;">Powered by ReturnFlow</p>
      </div>
    `,
    ReturnApproved: (d) => `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #059669;">Return Approved!</h2>
        <p>Hi ${d.customerName},</p>
        <p>Your return for order <strong>${d.orderName}</strong> has been approved.</p>
        <p>You'll receive your shipping label shortly.</p>
        <p style="color: #6b7280; font-size: 12px;">Powered by ReturnFlow</p>
      </div>
    `,
    LabelReady: (d) => `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #4F46E5;">Your Return Label is Ready</h2>
        <p>Hi ${d.customerName},</p>
        <p>Your return label for order <strong>${d.orderName}</strong> is ready.</p>
        <p><strong>Carrier:</strong> ${d.carrier}<br/>
           <strong>Tracking:</strong> ${d.trackingCode}</p>
        ${d.qrCodeUrl ? `<p>Show this QR code at the drop-off point:</p><img src="${d.qrCodeUrl}" alt="QR Code" style="width: 200px;"/>` : ''}
        ${d.labelUrl ? `<p><a href="${d.labelUrl}" style="background: #4F46E5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px;">Download Label</a></p>` : ''}
        <p style="color: #6b7280; font-size: 12px;">Powered by ReturnFlow</p>
      </div>
    `,
    RefundProcessed: (d) => `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #059669;">Refund Processed</h2>
        <p>Hi ${d.customerName},</p>
        <p>Your return for order <strong>${d.orderName}</strong> has been ${d.resolutionText}.</p>
        <p><strong>Amount:</strong> £${Number(d.refundAmount).toFixed(2)}</p>
        <p>Thank you for your patience.</p>
        <p style="color: #6b7280; font-size: 12px;">Powered by ReturnFlow</p>
      </div>
    `,
    ReturnRejected: (d) => `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #DC2626;">Return Request Update</h2>
        <p>Hi ${d.customerName},</p>
        <p>Unfortunately, your return for order <strong>${d.orderName}</strong> could not be approved.</p>
        ${d.reason ? `<p><strong>Reason:</strong> ${d.reason}</p>` : ''}
        <p>If you have questions, please contact the store directly.</p>
        <p style="color: #6b7280; font-size: 12px;">Powered by ReturnFlow</p>
      </div>
    `,
  };

  const render = templates[template];
  if (!render) return `<p>Notification: ${template}</p><pre>${JSON.stringify(data, null, 2)}</pre>`;
  return render(data);
}

module.exports = worker;

// Shared email rendering + direct-send logic, used by BOTH the BullMQ
// send-email worker (durable path) and NotificationService's fallback
// (direct path, when the queue/Redis is unavailable).
//
// esbuild-register lets us require the React Email components in
// emails/*.jsx straight from CommonJS. `jsx: 'automatic'` uses
// react/jsx-runtime so the templates don't need to import React.
require('esbuild-register/dist/node').register({
  extensions: ['.jsx'],
  jsx: 'automatic',
});

const React = require('react');
const path = require('path');
const { render } = require('@react-email/render');
const logger = require('../utils/logger');

const EMAILS_DIR = path.resolve(__dirname, '..', '..', 'emails');

const TEMPLATES = {
  ReturnConfirmed: () => require(path.join(EMAILS_DIR, 'ReturnConfirmed.jsx')),
  ReturnApproved:  () => require(path.join(EMAILS_DIR, 'ReturnApproved.jsx')),
  LabelReady:      () => require(path.join(EMAILS_DIR, 'LabelReady.jsx')),
  RefundProcessed: () => require(path.join(EMAILS_DIR, 'RefundProcessed.jsx')),
  ReturnRejected:  () => require(path.join(EMAILS_DIR, 'ReturnRejected.jsx')),
  ReturnReceived:  () => require(path.join(EMAILS_DIR, 'ReturnReceived.jsx')),
};

async function renderTemplate(name, data) {
  const loader = TEMPLATES[name];
  if (!loader) {
    return `<p>Notification: ${name}</p><pre>${JSON.stringify(data, null, 2)}</pre>`;
  }
  const mod = loader();
  const Component = mod.default || mod;
  return render(React.createElement(Component, data));
}

/**
 * Render the template and dispatch via Resend. Used by the worker and by
 * NotificationService's direct fallback. Throws on Resend failure so the
 * worker can retry; NotificationService catches it on the fallback path.
 */
async function sendEmailNow({ to, subject, template, data }) {
  const html = await renderTemplate(template, data);

  if (process.env.RESEND_API_KEY) {
    const { Resend } = require('resend');
    const resend = new Resend(process.env.RESEND_API_KEY);
    const from = process.env.RESEND_FROM || 'ReturnFlow <onboarding@resend.dev>';
    // The Resend SDK does not throw when it refuses an email (quota, rate
    // limit, unverified domain, bad address): it returns { data, error }.
    // Treat a refusal as a failure so the worker retries and it is logged,
    // instead of reporting an email as sent that never left.
    const { data: sentData, error } = (await resend.emails.send({ from, to, subject, html })) || {};
    if (error || !sentData?.id) {
      const reason = error?.message || error?.name || 'Resend returned no message id';
      logger.error({ to, subject, template, from, error: error || null }, 'Resend refused the email');
      const err = new Error(`Resend refused the email: ${reason}`);
      err.code = error?.name || 'RESEND_REFUSED';
      throw err;
    }
    logger.info({ to, subject, template, from, id: sentData.id }, 'Email sent via Resend');
    return { sent: true, to, subject, id: sentData.id };
  }

  logger.info({ to, subject, template }, '[Email] dev mode — no RESEND_API_KEY, skipping send');
  return { sent: true, to, subject };
}

module.exports = { renderTemplate, sendEmailNow };

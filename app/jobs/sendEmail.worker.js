// Register esbuild's runtime JSX transform so we can require the
// React Email components in emails/*.jsx directly from CommonJS.
// Must run before any `require()` of a .jsx file in this process.
//
// `jsx: 'automatic'` uses the modern react/jsx-runtime — the templates
// don't have to `import React`. The classic transform would emit
// React.createElement(...) calls referencing a `React` that isn't in
// scope, producing "React is not defined" at render time.
require('esbuild-register/dist/node').register({
  extensions: ['.jsx'],
  jsx: 'automatic',
});

const React = require('react');
const path = require('path');
const { render } = require('@react-email/render');
const { createWorker, QUEUE_NAMES } = require('./queue');
const logger = require('../utils/logger');

const EMAILS_DIR = path.resolve(__dirname, '..', '..', 'emails');

const TEMPLATES = {
  ReturnConfirmed: () => require(path.join(EMAILS_DIR, 'ReturnConfirmed.jsx')),
  ReturnApproved:  () => require(path.join(EMAILS_DIR, 'ReturnApproved.jsx')),
  LabelReady:      () => require(path.join(EMAILS_DIR, 'LabelReady.jsx')),
  RefundProcessed: () => require(path.join(EMAILS_DIR, 'RefundProcessed.jsx')),
  ReturnRejected:  () => require(path.join(EMAILS_DIR, 'ReturnRejected.jsx')),
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

const worker = createWorker(QUEUE_NAMES.SEND_EMAIL, async (job) => {
  const { to, subject, template, data } = job.data;

  try {
    const html = await renderTemplate(template, data);

    if (process.env.RESEND_API_KEY) {
      const { Resend } = require('resend');
      const resend = new Resend(process.env.RESEND_API_KEY);
      // Use RESEND_FROM env var so the address can change without touching
      // code when a real domain is verified. Falls back to Resend's free
      // testing address so unconfigured deployments still work in dev.
      const from = process.env.RESEND_FROM || 'ReturnFlow <onboarding@resend.dev>';
      await resend.emails.send({ from, to, subject, html });
      logger.info({ to, subject, template, from }, 'Email sent via Resend');
    } else {
      logger.info({ to, subject, template }, '[Email] dev mode — no RESEND_API_KEY, skipping send');
    }

    return { sent: true, to, subject };
  } catch (err) {
    logger.error({ err: err.message, to, template }, 'Email send failed');
    throw err;
  }
});

module.exports = worker;

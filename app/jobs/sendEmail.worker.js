// Durable email path: BullMQ worker that renders + sends queued emails,
// with automatic retries on failure. The actual render+send lives in
// emailRenderer.js so NotificationService can reuse it for the direct
// fallback when the queue/Redis is unavailable.
const { createWorker, QUEUE_NAMES } = require('./queue');
const { sendEmailNow } = require('../services/emailRenderer');
const logger = require('../utils/logger');

const worker = createWorker(QUEUE_NAMES.SEND_EMAIL, async (job) => {
  const { to, subject, template, data } = job.data;
  try {
    return await sendEmailNow({ to, subject, template, data });
  } catch (err) {
    logger.error({ err: err.message, to, template }, 'Email send failed');
    throw err; // let BullMQ retry
  }
});

module.exports = worker;

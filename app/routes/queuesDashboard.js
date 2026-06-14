// BullMQ admin dashboard mounted at /admin/queues. Gated by basic auth
// because the dashboard exposes job payloads (customer emails, return
// details) and the ability to retry/delete jobs.
//
// Credentials come from QUEUE_DASHBOARD_USER / QUEUE_DASHBOARD_PASS env
// vars. If either is unset, the route returns 503 instead of mounting —
// the dashboard NEVER goes online without explicit creds, so a missed
// config in production can't silently expose it.

const { createBullBoard } = require('@bull-board/api');
const { BullMQAdapter } = require('@bull-board/api/bullMQAdapter');
const { ExpressAdapter } = require('@bull-board/express');
const basicAuth = require('express-basic-auth');

const { getQueue, QUEUE_NAMES } = require('../jobs/queue');
const logger = require('../utils/logger');

function buildQueueRouter() {
  const user = process.env.QUEUE_DASHBOARD_USER;
  const pass = process.env.QUEUE_DASHBOARD_PASS;
  if (!user || !pass) {
    return (req, res) => res.status(503).send(
      'Queue dashboard disabled: set QUEUE_DASHBOARD_USER and QUEUE_DASHBOARD_PASS in env to enable.',
    );
  }

  const queues = Object.values(QUEUE_NAMES)
    .map((name) => getQueue(name))
    .filter(Boolean)
    .map((q) => new BullMQAdapter(q));

  if (queues.length === 0) {
    return (req, res) => res.status(503).send(
      'No BullMQ queues available — start with REDIS_URL set.',
    );
  }

  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath('/admin/queues');
  createBullBoard({ queues, serverAdapter });

  const router = require('express').Router();
  router.use(basicAuth({
    users: { [user]: pass },
    challenge: true,
    realm: 'ReturnFlow Queues',
  }));
  router.use(serverAdapter.getRouter());

  logger.info({ queues: queues.length }, 'Queue dashboard mounted at /admin/queues');
  return router;
}

module.exports = buildQueueRouter;

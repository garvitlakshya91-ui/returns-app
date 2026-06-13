const { Queue, Worker } = require('bullmq');
const { getRedis } = require('../config/redis');

const QUEUE_NAMES = {
  GENERATE_LABEL: 'generate-label',
  SEND_EMAIL: 'send-email',
  PROCESS_REFUND: 'process-refund',
  AGGREGATE_ANALYTICS: 'aggregate-analytics',
};

const queues = {};

/**
 * Get or create a BullMQ queue by name.
 */
function getQueue(name) {
  if (queues[name]) return queues[name];

  const connection = getRedis();
  if (!connection) {
    console.warn(`Cannot create queue "${name}" — Redis not available`);
    return null;
  }

  queues[name] = new Queue(name, { connection });
  return queues[name];
}

/**
 * Create a BullMQ worker for a given queue.
 */
function createWorker(name, processor, opts = {}) {
  const connection = getRedis();
  if (!connection) {
    console.warn(`Cannot create worker "${name}" — Redis not available`);
    return null;
  }

  const worker = new Worker(name, processor, {
    connection,
    concurrency: opts.concurrency || 5,
    ...opts,
  });

  worker.on('completed', (job) => {
    console.log(`[Queue] Job ${job.id} in "${name}" completed`);
  });

  worker.on('failed', (job, err) => {
    console.error(`[Queue] Job ${job?.id} in "${name}" failed:`, err.message);
  });

  return worker;
}

module.exports = { getQueue, createWorker, QUEUE_NAMES };

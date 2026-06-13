const { createWorker, QUEUE_NAMES } = require('./queue');
const RefundService = require('../services/RefundService');
const logger = require('../utils/logger');

const worker = createWorker(QUEUE_NAMES.PROCESS_REFUND, async (job) => {
  const { returnId } = job.data;
  logger.info({ jobId: job.id, returnId }, 'Processing refund');
  return RefundService.processRefund(returnId);
});

module.exports = worker;

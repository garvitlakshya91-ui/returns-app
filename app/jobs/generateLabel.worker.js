const { createWorker, QUEUE_NAMES } = require('./queue');
const LabelService = require('../services/LabelService');
const logger = require('../utils/logger');

const worker = createWorker(QUEUE_NAMES.GENERATE_LABEL, async (job) => {
  const { returnId } = job.data;
  logger.info({ jobId: job.id, returnId }, 'Generating label');
  const label = await LabelService.generateLabel(returnId);
  return { labelId: label.id, trackingCode: label.trackingCode };
});

module.exports = worker;

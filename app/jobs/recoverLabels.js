const prisma = require('../config/database');
const logger = require('../utils/logger');

// A 'saved' label whose follow-up steps have not finished within this long
// is picked up here; sooner, and the original attempt may still be running.
const SAVED_MIN_AGE_MS = 5 * 60 * 1000;
// A 'buying' row this old is a crashed purchase: LabelService reconciles it
// with the carrier (its own LOCK_STALE_MS, 10 minutes, must have passed).
const BUYING_MIN_AGE_MS = 10 * 60 * 1000;
const BATCH = 50;

/**
 * Labels the merchant should never have to notice: a purchase that crashed
 * before it was saved ('buying', stale) or one that was saved but whose
 * follow-up steps — return status, postage charge, customer email — did not
 * all finish ('saved'). generateLabel() reconciles or resumes each one, so
 * this job just finds them and calls it. Returns that are no longer open
 * (processed, rejected, cancelled) are left alone.
 */
async function recoverUnfinishedLabels({ now = new Date() } = {}) {
  const labels = await prisma.returnLabel.findMany({
    where: {
      OR: [
        { status: 'saved', createdAt: { lt: new Date(now.getTime() - SAVED_MIN_AGE_MS) } },
        { status: 'buying', createdAt: { lt: new Date(now.getTime() - BUYING_MIN_AGE_MS) } },
      ],
    },
    include: { return: { select: { id: true, status: true } } },
    orderBy: { createdAt: 'asc' },
    take: BATCH,
  });

  const LabelService = require('../services/LabelService');
  let finished = 0;
  let stillOpen = 0;
  let failed = 0;
  let skipped = 0;
  for (const label of labels) {
    if (!['APPROVED', 'LABEL_SENT'].includes(label.return?.status)) { skipped += 1; continue; }
    try {
      const result = await LabelService.generateLabel(label.returnId);
      if (result?.status === 'created') finished += 1; else stillOpen += 1;
    } catch (err) {
      failed += 1;
      logger.warn({ returnId: label.returnId, labelId: label.id, status: label.status, err: err.message }, 'Unfinished label could not be recovered yet');
    }
  }

  const summary = { due: labels.length, finished, stillOpen, failed, skipped };
  if (labels.length > 0) logger.info(summary, 'Unfinished label recovery done');
  return summary;
}

/** Run shortly after boot and every 30 minutes after. */
function startLabelRecovery() {
  const run = () => recoverUnfinishedLabels().catch((err) => logger.error({ err }, 'Label recovery failed'));
  setTimeout(run, 30000).unref();
  setInterval(run, 30 * 60 * 1000).unref();
}

module.exports = { recoverUnfinishedLabels, startLabelRecovery, SAVED_MIN_AGE_MS, BUYING_MIN_AGE_MS };

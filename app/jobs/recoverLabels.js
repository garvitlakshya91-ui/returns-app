const prisma = require('../config/database');
const logger = require('../utils/logger');

// A 'saved' label whose follow-up steps have not finished within this long
// is picked up here; sooner, and the original attempt may still be running.
const SAVED_MIN_AGE_MS = 5 * 60 * 1000;
// A 'buying' row this old is a crashed purchase: LabelService reconciles it
// with the carrier (its own LOCK_STALE_MS, 10 minutes, must have passed).
const BUYING_MIN_AGE_MS = 10 * 60 * 1000;
// Page size, and how many pages one run will walk (bounds a run's length;
// the next run carries on from the top since finished rows drop out).
const BATCH = 50;
const MAX_PAGES = 20;
// Returns whose label is still worth finishing.
const OPEN_RETURN_STATUSES = ['APPROVED', 'LABEL_SENT'];

// One run at a time per process: a slow run must not overlap the next tick.
let running = false;
let started = false;

/**
 * Labels the merchant should never have to notice: a purchase that crashed
 * before it was saved ('buying', stale) or one that was saved but whose
 * follow-up steps — return status, postage charge, customer email — did not
 * all finish ('saved'). generateLabel() reconciles or resumes each one, so
 * this job just finds them and calls it.
 *
 * Only labels on still-open returns are selected (in the query, so closed
 * returns can never crowd out eligible ones), and the set is walked page by
 * page by id, so a label that keeps failing never blocks the ones after it.
 */
async function recoverUnfinishedLabels({ now = new Date() } = {}) {
  if (running) {
    logger.info('Unfinished label recovery already running; skipping this tick');
    return { due: 0, finished: 0, stillOpen: 0, failed: 0, skippedRun: true };
  }
  running = true;
  try {
    const where = {
      OR: [
        { status: 'saved', createdAt: { lt: new Date(now.getTime() - SAVED_MIN_AGE_MS) } },
        { status: 'buying', createdAt: { lt: new Date(now.getTime() - BUYING_MIN_AGE_MS) } },
      ],
      return: { status: { in: OPEN_RETURN_STATUSES } },
    };

    const LabelService = require('../services/LabelService');
    const summary = { due: 0, finished: 0, stillOpen: 0, failed: 0 };
    let cursor = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const labels = await prisma.returnLabel.findMany({
        where,
        select: { id: true, returnId: true, status: true },
        orderBy: { id: 'asc' },
        take: BATCH,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (labels.length === 0) break;
      summary.due += labels.length;
      for (const label of labels) {
        try {
          const result = await LabelService.generateLabel(label.returnId);
          if (result?.status === 'created') summary.finished += 1; else summary.stillOpen += 1;
        } catch (err) {
          summary.failed += 1;
          logger.warn({ returnId: label.returnId, labelId: label.id, status: label.status, err: err.message }, 'Unfinished label could not be recovered yet');
        }
      }
      if (labels.length < BATCH) break;
      cursor = labels[labels.length - 1].id;
    }

    if (summary.due > 0) logger.info(summary, 'Unfinished label recovery done');
    return summary;
  } finally {
    running = false;
  }
}

/** Run shortly after boot and every 30 minutes after. Registering twice is a no-op. */
function startLabelRecovery() {
  if (started) return false;
  started = true;
  const run = () => recoverUnfinishedLabels().catch((err) => logger.error({ err }, 'Label recovery failed'));
  setTimeout(run, 30000).unref();
  setInterval(run, 30 * 60 * 1000).unref();
  return true;
}

module.exports = { recoverUnfinishedLabels, startLabelRecovery, SAVED_MIN_AGE_MS, BUYING_MIN_AGE_MS, BATCH, OPEN_RETURN_STATUSES };

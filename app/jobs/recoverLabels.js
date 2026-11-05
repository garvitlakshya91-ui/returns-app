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
// Labels older than this are left to the merchant (Retry / Finish label on
// the return page) so the sweep stays bounded by recent work.
const LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;
// Backoff after a failed attempt: 30 min, 1 h, 2 h ... capped at a day. A
// label that keeps failing is retried less and less often, which keeps it
// from taking an attempt away from one that has never been tried.
const BACKOFF_BASE_MS = 30 * 60 * 1000;
const BACKOFF_MAX_MS = 24 * 60 * 60 * 1000;
// Returns whose label is still worth finishing.
const OPEN_RETURN_STATUSES = ['APPROVED', 'LABEL_SENT'];

// One run at a time per process: a slow run must not overlap the next tick.
let running = false;
let started = false;

function backoffMs(attemptsSoFar) {
  return Math.min(BACKOFF_BASE_MS * 2 ** attemptsSoFar, BACKOFF_MAX_MS);
}

/**
 * Labels the merchant should never have to notice: a purchase that crashed
 * before it was saved ('buying', stale) or one that was saved but whose
 * follow-up steps — return status, postage charge, customer email — did not
 * all finish ('saved'). generateLabel() reconciles or resumes each one, so
 * this job just finds them and calls it.
 *
 * Only labels on still-open returns are selected (in the query, so closed
 * returns can never crowd out eligible ones). Each label carries its own
 * retry schedule in the row: never-tried labels go first, then the ones
 * whose backoff has expired, oldest due first. A label that fails is pushed
 * back with a growing delay, so the same failures cannot fill every run.
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
      createdAt: { gt: new Date(now.getTime() - LOOKBACK_MS) },
      // Only labels whose backoff (if any) has run out.
      AND: [{ OR: [{ nextRecoveryAt: null }, { nextRecoveryAt: { lte: now } }] }],
      return: { status: { in: OPEN_RETURN_STATUSES } },
    };
    // Never tried first (null sorts first), then longest-overdue; id breaks ties
    // so the cursor walk is stable.
    const orderBy = [{ nextRecoveryAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }, { id: 'asc' }];

    // Collect everything due BEFORE touching any row: processing a label
    // changes the very fields the pages are ordered and filtered by
    // (status, nextRecoveryAt), and a cursor walk over a set that shifts
    // under it stops early. The walk itself is bounded by BATCH × MAX_PAGES.
    const due = [];
    let cursor = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const labels = await prisma.returnLabel.findMany({
        where,
        select: { id: true, returnId: true, status: true, recoveryAttempts: true },
        orderBy,
        take: BATCH,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (labels.length === 0) break;
      due.push(...labels);
      if (labels.length < BATCH) break;
      cursor = labels[labels.length - 1].id;
    }

    const LabelService = require('../services/LabelService');
    const summary = { due: due.length, finished: 0, stillOpen: 0, failed: 0 };
    for (const label of due) {
      let done = false;
      try {
        const result = await LabelService.generateLabel(label.returnId);
        done = result?.status === 'created';
        if (done) summary.finished += 1; else summary.stillOpen += 1;
      } catch (err) {
        summary.failed += 1;
        logger.warn({ returnId: label.returnId, labelId: label.id, status: label.status, err: err.message }, 'Unfinished label could not be recovered yet');
      }
      if (!done) await scheduleRetry(label, now);
    }

    if (summary.due > 0) logger.info(summary, 'Unfinished label recovery done');
    return summary;
  } finally {
    running = false;
  }
}

/** Push a label that did not finish back by its backoff; never throws. */
async function scheduleRetry(label, now) {
  const attempts = Number(label.recoveryAttempts) || 0;
  try {
    await prisma.returnLabel.update({
      where: { id: label.id },
      data: { recoveryAttempts: attempts + 1, nextRecoveryAt: new Date(now.getTime() + backoffMs(attempts)) },
    });
  } catch (err) {
    logger.warn({ labelId: label.id, err: err.message }, 'Could not schedule the next recovery attempt');
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

module.exports = {
  recoverUnfinishedLabels, startLabelRecovery, backoffMs,
  SAVED_MIN_AGE_MS, BUYING_MIN_AGE_MS, LOOKBACK_MS, BACKOFF_BASE_MS, BACKOFF_MAX_MS, BATCH, OPEN_RETURN_STATUSES,
};

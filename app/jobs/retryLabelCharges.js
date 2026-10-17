const prisma = require('../config/database');
const logger = require('../utils/logger');
const { claim, release } = require('../utils/idempotency');

// Two workers (or two instances) must not retry the same label at once.
const CLAIM_TTL_SECONDS = 10 * 60;

// How far back to look for charges that never went through.
const LOOKBACK_DAYS = 30;
// Give up on a charge after this many attempts (each retry writes an event).
const MAX_ATTEMPTS = 5;
// A 'label.charge_due' with no outcome yet may still be in flight; only
// treat it as lost after this long.
const STALE_DUE_MS = 10 * 60 * 1000;

/**
 * Every managed label's postage is announced on the return's timeline as
 * label.charge_due before Shopify is asked, then recorded as label.charged
 * or label.charge_failed. This job finds the failed ones, and the announced
 * ones that never reached an outcome (a crash mid-charge), and tries the
 * usage charge again (the merchant may have upgraded, raised their cap, or
 * Shopify may simply have been down). The same idempotency key is used
 * every time, so Shopify refuses a duplicate. A success writes
 * label.charged, which takes the return out of the set.
 */
async function retryFailedLabelCharges({ now = new Date() } = {}) {
  const since = new Date(now.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const events = await prisma.returnEvent.findMany({
    where: { type: { in: ['label.charge_due', 'label.charge_failed', 'label.charged'] }, createdAt: { gte: since } },
    orderBy: { createdAt: 'asc' },
    select: { returnId: true, type: true, data: true, createdAt: true },
  });

  // Latest state per return: charged wins; count failed attempts; remember
  // what was announced as due and when.
  const state = new Map();
  for (const e of events) {
    const cur = state.get(e.returnId) || { charged: false, attempts: 0, last: null, dueAt: null };
    if (e.type === 'label.charged') cur.charged = true;
    else if (e.type === 'label.charge_due') { cur.dueAt = e.createdAt; cur.last = cur.last || e.data || {}; }
    else { cur.attempts += 1; cur.last = e.data || {}; }
    state.set(e.returnId, cur);
  }
  const due = [...state.entries()].filter(([, s]) => !s.charged
    && s.attempts < MAX_ATTEMPTS
    && Number(s.last?.amount) > 0
    // Failed at least once, or announced long enough ago that no outcome is coming.
    && (s.attempts > 0 || (s.dueAt && now.getTime() - new Date(s.dueAt).getTime() > STALE_DUE_MS)));

  let recovered = 0;
  let stillFailing = 0;
  for (const [returnId, s] of due) {
    // Atomic claim so parallel runs skip the same label; Shopify's
    // idempotency key below is the hard guarantee against a double charge.
    const claimKey = `label-charge-retry:${returnId}`;
    if (!(await claim(claimKey, CLAIM_TTL_SECONDS))) continue;
    const returnRecord = await prisma.return.findUnique({ where: { id: returnId }, include: { shop: true, label: true } });
    if (!returnRecord?.shop || !returnRecord.label) { await release(claimKey); continue; }
    const BillingService = require('../services/BillingService');
    const amount = Number(s.last.amount);
    let usageRecordId = null;
    let error = null;
    try {
      usageRecordId = await BillingService.recordLabelCharge(returnRecord.shop, {
        amount,
        description: `Return label ${returnRecord.label.carrier} ${returnRecord.shopifyOrderName}`,
        idempotencyKey: BillingService.labelChargeKey(returnId),
      });
    } catch (err) {
      error = err.message;
    }
    await prisma.returnEvent.create({
      data: {
        returnId,
        type: usageRecordId ? 'label.charged' : 'label.charge_failed',
        actor: 'system',
        data: {
          charged: Boolean(usageRecordId),
          amount,
          postage: s.last.postage ?? null,
          usageRecordId,
          error: usageRecordId ? null : (error || 'No usage line item or Shopify refused the charge'),
          retry: Math.max(1, s.attempts),
        },
      },
    }).catch((err) => logger.error({ returnId, err: err.message }, 'Could not record label charge retry'));
    if (usageRecordId) recovered += 1; else stillFailing += 1;
    await release(claimKey);
  }

  if (due.length > 0) logger.info({ due: due.length, recovered, stillFailing }, 'Managed-label charge retries done');
  return { due: due.length, recovered, stillFailing };
}

/** Run the retry on boot and every six hours after. */
function startLabelChargeRetries() {
  const run = () => retryFailedLabelCharges().catch((err) => logger.error({ err }, 'Label charge retry failed'));
  setTimeout(run, 15000).unref();
  setInterval(run, 6 * 60 * 60 * 1000).unref();
}

module.exports = { retryFailedLabelCharges, startLabelChargeRetries, MAX_ATTEMPTS, LOOKBACK_DAYS };

const prisma = require('../config/database');
const logger = require('../utils/logger');
const eventBus = require('../events/eventBus');
const { RETURN_RECEIVED } = require('../events/emitters');

// Labels are tracked while the return is on its way: from the label going
// out until the parcel is back (or the return is otherwise closed). After
// this long with no delivery the carrier will not have anything new to say.
const TRACK_FOR_DAYS = 60;
const BATCH = 100;
const MAX_PAGES = 20;
// Returns whose parcel is still expected.
const OPEN_STATUSES = ['LABEL_SENT', 'IN_TRANSIT'];

let running = false;
let started = false;

/**
 * Ask the carrier where each outstanding return parcel is, and move the
 * return along: a first scan makes it IN_TRANSIT, a delivery makes it
 * RECEIVED (which emails the customer and tells the merchant to check the
 * parcel). Every change is written to the return's timeline. Only real
 * labels are tracked; simulated ones have no parcel.
 */
async function trackParcels({ now = new Date() } = {}) {
  if (running) {
    logger.info('Parcel tracking already running; skipping this tick');
    return { checked: 0, moved: 0, received: 0, failed: 0, skippedRun: true };
  }
  running = true;
  try {
    const LabelService = require('../services/LabelService');
    const where = {
      status: 'created',
      trackingCode: { not: null },
      labelUrl: { not: null },
      createdAt: { gt: new Date(now.getTime() - TRACK_FOR_DAYS * 24 * 60 * 60 * 1000) },
      return: { status: { in: OPEN_STATUSES } },
    };
    const summary = { checked: 0, moved: 0, received: 0, failed: 0 };
    let cursor = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const labels = await prisma.returnLabel.findMany({
        where,
        include: { return: { include: { shop: { include: { carrierConfigs: true } } } } },
        orderBy: { id: 'asc' },
        take: BATCH,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (labels.length === 0) break;
      for (const label of labels) {
        try {
          const outcome = await trackOne(label, LabelService, now);
          if (outcome) {
            summary.checked += 1;
            if (outcome.moved) summary.moved += 1;
            if (outcome.received) summary.received += 1;
          }
        } catch (err) {
          summary.failed += 1;
          logger.warn({ returnId: label.returnId, trackingCode: label.trackingCode, err: err.message }, 'Parcel tracking check failed');
        }
      }
      if (labels.length < BATCH) break;
      cursor = labels[labels.length - 1].id;
    }
    if (summary.checked > 0 || summary.failed > 0) logger.info(summary, 'Parcel tracking done');
    return summary;
  } finally {
    running = false;
  }
}

/** Check one label. Returns null when the carrier cannot be asked. */
async function trackOne(label, LabelService, now) {
  const returnRecord = label.return;
  const adapter = LabelService.getCarrierAdapter(returnRecord.shop);
  // A simulated adapter has no real parcel to report on.
  if (adapter._isLive !== true || typeof adapter.getTrackingStatus !== 'function') return null;

  const result = await adapter.getTrackingStatus(label.trackingCode, label.carrier);
  const status = result?.status || 'unknown';
  const changed = status !== (label.trackingStatus || null)
    || (result?.detail || null) !== (label.trackingDetail || null);

  const data = { trackingCheckedAt: now };
  if (changed && status !== 'unknown') {
    data.trackingStatus = status;
    data.trackingDetail = result?.detail || null;
    data.trackingLocation = result?.location || null;
    data.trackingAt = result?.lastUpdate ? new Date(result.lastUpdate) : now;
  }
  await prisma.returnLabel.update({ where: { id: label.id }, data });
  if (!changed || status === 'unknown') return { moved: false, received: false };

  await prisma.returnEvent.create({
    data: {
      returnId: returnRecord.id,
      type: 'tracking.updated',
      actor: 'carrier',
      data: { status, detail: result?.detail || null, location: result?.location || null, at: data.trackingAt.toISOString() },
    },
  });

  // Move the return on, never backwards: only from the states before it.
  if (status === 'in_transit' && returnRecord.status === 'LABEL_SENT') {
    const r = await prisma.return.updateMany({ where: { id: returnRecord.id, status: 'LABEL_SENT' }, data: { status: 'IN_TRANSIT' } });
    return { moved: r.count > 0, received: false };
  }
  if (status === 'delivered' && OPEN_STATUSES.includes(returnRecord.status)) {
    const r = await prisma.return.updateMany({ where: { id: returnRecord.id, status: { in: OPEN_STATUSES } }, data: { status: 'RECEIVED' } });
    if (r.count > 0) eventBus.emit(RETURN_RECEIVED, { returnId: returnRecord.id, shopId: returnRecord.shopId, source: 'carrier' });
    return { moved: r.count > 0, received: r.count > 0 };
  }
  return { moved: false, received: false };
}

/** Run a minute after boot and every 30 minutes after. Registering twice is a no-op. */
function startParcelTracking() {
  if (started) return false;
  started = true;
  const run = () => trackParcels().catch((err) => logger.error({ err }, 'Parcel tracking failed'));
  setTimeout(run, 60000).unref();
  setInterval(run, 30 * 60 * 1000).unref();
  return true;
}

module.exports = { trackParcels, startParcelTracking, TRACK_FOR_DAYS, OPEN_STATUSES };

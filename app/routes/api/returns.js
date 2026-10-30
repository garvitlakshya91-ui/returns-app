const { Router } = require('express');
const { isTestReturn, TEST_RETURN_MESSAGE } = require('../../utils/testReturn');
const { verifyShopifySession } = require('../../middleware/auth');
const prisma = require('../../config/database');

const router = Router();

// All admin routes require Shopify session authentication
router.use(verifyShopifySession);

/**
 * GET /api/admin/returns
 * List returns with filtering. Scoped to authenticated shop.
 */
router.get('/', async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;

    const where = { shopId: req.shopId };
    if (status) where.status = status;

    const [returns, total] = await Promise.all([
      prisma.return.findMany({
        where,
        include: { items: true, label: true },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: Number(limit),
      }),
      prisma.return.count({ where }),
    ]);

    res.json({ returns, total, page: Number(page), limit: Number(limit) });
  } catch (err) {
    console.error('List returns error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/admin/returns/stats
 * Dashboard totals over every return the shop has, not just the latest page.
 */
router.get('/stats', async (req, res) => {
  try {
    const where = { shopId: req.shopId };
    const [byStatus, value, refunded, shop] = await Promise.all([
      prisma.return.groupBy({ by: ['status'], where, _count: { _all: true } }),
      prisma.return.aggregate({ where, _sum: { totalValue: true } }),
      prisma.return.aggregate({ where: { ...where, status: 'PROCESSED' }, _sum: { refundAmount: true } }),
      prisma.shop.findUnique({ where: { id: req.shopId }, select: { currency: true } }),
    ]);
    const counts = Object.fromEntries(byStatus.map((row) => [row.status, row._count._all]));
    const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
    res.json({
      total,
      pending: counts.REQUESTED || 0,
      inProgress: (counts.APPROVED || 0) + (counts.LABEL_SENT || 0) + (counts.IN_TRANSIT || 0)
        + (counts.RECEIVED || 0) + (counts.INSPECTING || 0),
      processed: counts.PROCESSED || 0,
      rejected: counts.REJECTED || 0,
      totalValue: Number(value._sum.totalValue || 0),
      refundedValue: Number(refunded._sum.refundAmount || 0),
      currency: shop?.currency || 'GBP',
    });
  } catch (err) {
    console.error('Return stats error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/admin/returns/bulk
 * Apply approve / reject / process to many returns at once. Each item is
 * handled independently — failures are reported, not fatal.
 */
router.post('/bulk', async (req, res) => {
  try {
    const { action, ids, reason } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'ids must be a non-empty array' });
    }
    if (!['approve', 'reject', 'process'].includes(action)) {
      return res.status(400).json({ error: 'action must be approve, reject or process' });
    }

    // Same rule as single approval: nothing is approved until returns have
    // somewhere to go.
    if (action === 'approve') {
      const LabelService = require('../../services/LabelService');
      const shop = await prisma.shop.findUnique({ where: { id: req.shopId } });
      if (!shop || !(await LabelService.hasReturnsAddress(shop))) {
        return res.status(409).json({ error: LabelService.RETURNS_ADDRESS_REQUIRED_MESSAGE, code: 'RETURNS_ADDRESS_MISSING' });
      }
    }

    const eventBus = require('../../events/eventBus');
    const emitters = require('../../events/emitters');
    let success = 0;
    const failed = [];

    for (const id of ids) {
      try {
        if (action === 'approve') {
          const r = await prisma.return.findFirst({ where: { id, shopId: req.shopId, status: 'REQUESTED' } });
          // Test returns have no real order to post a label from.
          if (!r || isTestReturn(r)) { failed.push(id); continue; }
          const updated = await prisma.return.update({ where: { id }, data: { status: 'APPROVED' } });
          eventBus.emit(emitters.RETURN_APPROVED, { returnId: updated.id, shopId: req.shopId, approvedBy: 'merchant' });
          success++;
        } else if (action === 'reject') {
          const r = await prisma.return.findFirst({ where: { id, shopId: req.shopId, status: 'REQUESTED' } });
          if (!r) { failed.push(id); continue; }
          const updated = await prisma.return.update({ where: { id }, data: { status: 'REJECTED', notes: reason || 'Rejected' } });
          eventBus.emit(emitters.RETURN_REJECTED, { returnId: updated.id, shopId: req.shopId, reason });
          success++;
        } else {
          const r = await prisma.return.findFirst({
            where: { id, shopId: req.shopId, status: { in: ['RECEIVED', 'INSPECTING', 'APPROVED', 'LABEL_SENT', 'IN_TRANSIT'] } },
          });
          if (!r) { failed.push(id); continue; }
          const RefundService = require('../../services/RefundService');
          await RefundService.processRefund(id);
          success++;
        }
      } catch (err) {
        console.error(`Bulk ${action} failed for ${id}:`, err.message);
        failed.push(id);
      }
    }

    res.json({ action, success, failed });
  } catch (err) {
    console.error('Bulk action error:', err);
    res.status(500).json({ error: 'Bulk action failed' });
  }
});

/**
 * POST /api/admin/returns/demo
 * Create a test-mode demo return so a merchant can walk the full flow
 * (approve → label → process) without a real Shopify order. Emails go to the
 * merchant's own address so they can see the customer experience.
 */
router.post('/demo', async (req, res) => {
  try {
    const shop = await prisma.shop.findUnique({ where: { id: req.shopId } });
    const ref = 1000 + Math.floor(Math.random() * 9000);

    const created = await prisma.return.create({
      data: {
        shopId: req.shopId,
        shopifyOrderId: 'demo',
        shopifyOrderName: `#DEMO-${ref}`,
        customerEmail: shop?.email || 'demo@returnsflow.uk',
        customerName: 'Demo Customer',
        status: 'REQUESTED',
        resolution: 'REFUND',
        totalValue: 42.0,
        currency: shop?.currency || 'GBP',
        notes: 'Test-mode demo return',
        items: {
          create: [{
            shopifyLineItemId: 'demo-li',
            shopifyProductId: 'demo-p',
            productTitle: 'Sample Product',
            variantTitle: 'Medium',
            sku: 'DEMO-SKU',
            quantity: 1,
            unitPrice: 42.0,
            reason: 'doesnt_fit',
            reasonDetail: 'A demo return so you can see how the flow works.',
            photoUrls: [],
          }],
        },
      },
      include: { items: true },
    });

    const eventBus = require('../../events/eventBus');
    const { RETURN_CREATED } = require('../../events/emitters');
    eventBus.emit(RETURN_CREATED, { returnId: created.id, shopId: req.shopId });

    res.status(201).json(created);
  } catch (err) {
    console.error('Demo return error:', err);
    res.status(500).json({ error: 'Failed to create demo return' });
  }
});

/**
 * GET /api/admin/returns/:id
 * Return detail with items, events, label.
 */
router.get('/:id', async (req, res) => {
  try {
    const returnRecord = await prisma.return.findFirst({
      where: { id: req.params.id, shopId: req.shopId },
      include: {
        items: true,
        label: true,
        events: { orderBy: { createdAt: 'desc' } },
      },
    });

    if (!returnRecord) {
      return res.status(404).json({ error: 'Return not found' });
    }

    res.json(returnRecord);
  } catch (err) {
    console.error('Get return error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PUT /api/admin/returns/:id/approve
 * Approve a return — triggers label generation.
 */
router.put('/:id/approve', async (req, res) => {
  try {
    const returnRecord = await prisma.return.findFirst({
      where: { id: req.params.id, shopId: req.shopId, status: 'REQUESTED' },
    });

    if (!returnRecord) {
      return res.status(404).json({ error: 'Return not found or not in REQUESTED status' });
    }

    // A test return has no real order or customer address, so its label
    // could only fail. Say so instead of approving it.
    if (isTestReturn(returnRecord)) {
      return res.status(409).json({ error: TEST_RETURN_MESSAGE, code: 'TEST_RETURN' });
    }

    // Approval buys a label, and a label needs somewhere to go. Refuse now,
    // with a fix the merchant can act on, rather than approving a return
    // that can never ship.
    const LabelService = require('../../services/LabelService');
    const shop = await prisma.shop.findUnique({ where: { id: req.shopId } });
    if (!shop || !(await LabelService.hasReturnsAddress(shop))) {
      return res.status(409).json({ error: LabelService.RETURNS_ADDRESS_REQUIRED_MESSAGE, code: 'RETURNS_ADDRESS_MISSING' });
    }

    const updated = await prisma.return.update({
      where: { id: req.params.id },
      data: { status: 'APPROVED' },
    });

    const eventBus = require('../../events/eventBus');
    const { RETURN_APPROVED } = require('../../events/emitters');
    eventBus.emit(RETURN_APPROVED, {
      returnId: updated.id,
      shopId: req.shopId,
      approvedBy: 'merchant',
    });

    res.json(updated);
  } catch (err) {
    console.error('Approve return error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PUT /api/admin/returns/:id/received
 * The parcel is back. Normally the carrier's tracking does this (see
 * jobs/trackParcels); this is for when it does not: a carrier without
 * tracking, or a parcel that turned up before the scan.
 */
router.put('/:id/received', async (req, res) => {
  try {
    const returnRecord = await prisma.return.findFirst({
      where: { id: req.params.id, shopId: req.shopId, status: { in: ['LABEL_SENT', 'IN_TRANSIT'] } },
    });
    if (!returnRecord) {
      return res.status(404).json({ error: 'Return not found, or its parcel is not expected (it needs a label out and not yet received)' });
    }
    const updated = await prisma.return.updateMany({
      where: { id: returnRecord.id, status: { in: ['LABEL_SENT', 'IN_TRANSIT'] } },
      data: { status: 'RECEIVED' },
    });
    if (updated.count === 0) {
      return res.status(409).json({ error: 'This return has just changed; reload and try again' });
    }
    const eventBus = require('../../events/eventBus');
    const { RETURN_RECEIVED } = require('../../events/emitters');
    eventBus.emit(RETURN_RECEIVED, { returnId: returnRecord.id, shopId: req.shopId, source: 'merchant' });
    res.json({ ...returnRecord, status: 'RECEIVED' });
  } catch (err) {
    console.error('Mark received error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PUT /api/admin/returns/:id/label
 * Generate (or retry) the label for an approved return whose label failed.
 * Safe to call twice: LabelService holds a lock per return and returns an
 * existing label instead of buying another.
 */
router.put('/:id/label', async (req, res) => {
  try {
    const returnRecord = await prisma.return.findFirst({
      where: { id: req.params.id, shopId: req.shopId, status: { in: ['APPROVED', 'LABEL_SENT'] } },
      include: { label: true },
    });
    if (!returnRecord) {
      return res.status(404).json({ error: 'Return not found or not approved' });
    }
    const LabelService = require('../../services/LabelService');
    if (returnRecord.label && returnRecord.label.status === 'created') {
      // Fully finished (status moved, charged, customer emailed); make sure
      // the return moved on with it and hand it back.
      await LabelService._advanceToLabelSent(returnRecord.id);
      return res.json(returnRecord.label);
    }

    // Anything else — no label, a failed attempt, or a label whose follow-up
    // steps (status, charge, customer email) did not finish — is generated
    // or resumed by LabelService, which also sends the customer's email.
    const label = await LabelService.generateLabel(returnRecord.id);
    await prisma.returnEvent.create({
      data: { returnId: returnRecord.id, type: 'label.generated', actor: 'merchant', data: { retry: true } },
    }).catch(() => {});
    res.json(label);
  } catch (err) {
    // The reason is already on the timeline (LABEL_FAILED); tell the merchant too.
    res.status(422).json({ error: err.message || 'Label generation failed' });
  }
});

/**
 * PUT /api/admin/returns/:id/reject
 * Reject a return with reason.
 */
router.put('/:id/reject', async (req, res) => {
  try {
    const { reason } = req.body;

    const returnRecord = await prisma.return.findFirst({
      where: { id: req.params.id, shopId: req.shopId, status: 'REQUESTED' },
    });

    if (!returnRecord) {
      return res.status(404).json({ error: 'Return not found or not in REQUESTED status' });
    }

    const updated = await prisma.return.update({
      where: { id: req.params.id },
      data: { status: 'REJECTED', notes: reason },
    });

    const eventBus = require('../../events/eventBus');
    const { RETURN_REJECTED } = require('../../events/emitters');
    eventBus.emit(RETURN_REJECTED, { returnId: updated.id, shopId: req.shopId, reason });

    res.json(updated);
  } catch (err) {
    console.error('Reject return error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PUT /api/admin/returns/:id/process
 * Process refund/credit/exchange via Shopify API.
 */
router.put('/:id/process', async (req, res) => {
  try {
    const returnRecord = await prisma.return.findFirst({
      where: {
        id: req.params.id,
        shopId: req.shopId,
        status: { in: ['RECEIVED', 'INSPECTING', 'APPROVED', 'LABEL_SENT', 'IN_TRANSIT'] },
      },
    });

    if (!returnRecord) {
      return res.status(404).json({ error: 'Return not found or not in a processable status' });
    }

    const RefundService = require('../../services/RefundService');
    const result = await RefundService.processRefund(req.params.id);

    res.json(result);
  } catch (err) {
    console.error('Process refund error:', err);
    res.status(500).json({ error: err.message || 'Failed to process refund' });
  }
});

module.exports = router;

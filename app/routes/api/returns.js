const { Router } = require('express');
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

const prisma = require('../config/database');
const ShopToken = require('./ShopToken');
const PolicyEngine = require('./PolicyEngine');
const { EXCHANGES_ENABLED } = require('../config/features');

// Reason codes the portal offers; anything else is rejected.
const REASONS = new Set([
  'doesnt_fit', 'changed_mind', 'not_as_described', 'damaged', 'wrong_item', 'quality', 'other',
]);

// Which policy switch each resolution needs.
const RESOLUTION_SWITCH = {
  REFUND: 'allowRefund',
  STORE_CREDIT: 'allowStoreCredit',
  EXCHANGE: 'allowExchange',
};

// Return statuses that still hold a claim on the order's items beyond what
// Shopify already knows. A processed return has been refunded on Shopify,
// so its units are already out of refundableQuantity; counting it again
// would hide units the customer can still return. Rejected and cancelled
// returns hold nothing.
const CLAIMING_STATUSES = ['REQUESTED', 'APPROVED', 'LABEL_SENT', 'IN_TRANSIT', 'RECEIVED', 'INSPECTING'];

const MAX_LINE_ITEMS = 100;

class ValidationError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

// Everything the portal needs to know about an order, fetched once by id.
const ORDER_QUERY = `
  query returnOrder($id: ID!) {
    order(id: $id) {
      id
      name
      email
      currencyCode
      createdAt
      displayFulfillmentStatus
      fulfillments(first: 1) { createdAt }
      lineItems(first: ${MAX_LINE_ITEMS}) {
        edges {
          node {
            id
            title
            variantTitle
            sku
            quantity
            refundableQuantity
            originalUnitPriceSet { shopMoney { amount } }
            discountedUnitPriceAfterAllDiscountsSet { shopMoney { amount } }
            image { url }
            product { id tags collections(first: 10) { edges { node { handle } } } }
            variant { id }
          }
        }
      }
    }
  }
`;

const REAL_ORDER_GID = /^gid:\/\/shopify\/Order\/\d+$/;

/**
 * Server-side truth for everything a return request claims. The browser only
 * sends which line items, how many, why, and the wanted resolution; prices,
 * titles, eligibility and remaining quantities all come from Shopify and our
 * own open returns.
 */
class ReturnValidation {
  static get EXCHANGES_ENABLED() { return EXCHANGES_ENABLED; }

  /** Resolutions a customer may pick for this item under its policy. */
  static allowedResolutions(policyResolutions) {
    const r = policyResolutions || {};
    const allowed = [];
    if (r.allowRefund !== false) allowed.push('REFUND');
    if (r.allowStoreCredit !== false) allowed.push('STORE_CREDIT');
    if (r.allowExchange === true && EXCHANGES_ENABLED) allowed.push('EXCHANGE');
    return allowed;
  }

  /**
   * Fetch the order and work out which items are returnable and how many of
   * each. Used by both the lookup (to show the customer) and the create
   * (to check what they sent).
   */
  static async loadOrder(shop, orderId) {
    const client = await ShopToken.graphqlClient(shop);
    const resp = await client.request(ORDER_QUERY, { variables: { id: orderId } });
    const order = resp.data?.order;
    if (!order) throw new ValidationError(404, 'Order not found. Please check your email and order number.');

    const fulfilledAt = order.fulfillments?.[0]?.createdAt || order.createdAt;
    const lineItems = (order.lineItems?.edges || []).map((e) => e.node);

    // Quantities already claimed by open returns on this order.
    const openReturns = await prisma.return.findMany({
      where: { shopId: shop.id, shopifyOrderId: order.id, status: { in: CLAIMING_STATUSES } },
      include: { items: true },
    });
    const claimed = {};
    for (const ret of openReturns) {
      for (const item of ret.items) {
        claimed[item.shopifyLineItemId] = (claimed[item.shopifyLineItemId] || 0) + item.quantity;
      }
    }

    const items = [];
    for (const li of lineItems) {
      // What the customer actually paid per unit, after every discount
      // including order-level and code discounts.
      const price = Number(li.discountedUnitPriceAfterAllDiscountsSet?.shopMoney?.amount ?? li.originalUnitPriceSet?.shopMoney?.amount ?? 0);
      const eligibility = await PolicyEngine.evaluateEligibility(shop.id, {
        price,
        tags: li.product?.tags || [],
        collections: (li.product?.collections?.edges || []).map((e) => e.node.handle),
      }, fulfilledAt);
      const refundableQuantity = li.refundableQuantity ?? li.quantity;
      const remaining = Math.max(0, refundableQuantity - (claimed[li.id] || 0));
      const eligible = eligibility.eligible && remaining > 0;
      items.push({
        id: li.id,
        lineItemId: li.id,
        productId: li.product?.id || null,
        variantId: li.variant?.id || null,
        title: li.title,
        variantTitle: li.variantTitle,
        price,
        quantity: remaining,
        // Shopify's own count of units still refundable; createReturn
        // re-checks against it under a lock.
        refundableQuantity,
        sku: li.sku,
        imageUrl: li.image?.url || null,
        eligible,
        ineligibleReason: eligibility.eligible ? (remaining > 0 ? null : 'Already returned') : eligibility.reason,
        resolutions: eligible ? ReturnValidation.allowedResolutions(eligibility.resolutions) : [],
        policyId: eligibility.policy?.id || null,
        // The matched policy's fee table, so the fee follows the policy that
        // made the item eligible rather than the shop default.
        fees: eligibility.policy?.fees || null,
      });
    }

    return {
      order: {
        id: order.id,
        name: order.name,
        email: order.email,
        currency: order.currencyCode,
        fulfillmentStatus: order.displayFulfillmentStatus,
        fulfilledAt,
      },
      items,
      openReturns,
    };
  }

  /**
   * Check a create-return request and return the server-built items to save.
   * Throws ValidationError with an HTTP status on any problem.
   */
  static async validateCreate(shop, { orderId, customerEmail, items, resolution }) {
    if (!REAL_ORDER_GID.test(String(orderId || ''))) {
      throw new ValidationError(400, 'orderId is required — please start again from the order lookup step');
    }
    if (!customerEmail || typeof customerEmail !== 'string') {
      throw new ValidationError(400, 'customerEmail is required');
    }
    if (!Array.isArray(items) || items.length === 0) {
      throw new ValidationError(400, 'items and resolution are required');
    }
    if (!RESOLUTION_SWITCH[resolution]) {
      throw new ValidationError(400, 'resolution must be REFUND, STORE_CREDIT or EXCHANGE');
    }
    if (resolution === 'EXCHANGE' && !EXCHANGES_ENABLED) {
      throw new ValidationError(400, 'Exchanges are not available yet. Please choose a refund or store credit.');
    }

    // Shape of each requested item, before anything is fetched.
    const wanted = new Map();
    for (const raw of items) {
      const lineItemId = String(raw?.lineItemId || '');
      const quantity = Number(raw?.quantity);
      if (!lineItemId) throw new ValidationError(400, 'Each item needs a lineItemId');
      if (!Number.isInteger(quantity) || quantity < 1) {
        throw new ValidationError(400, 'Each item quantity must be a whole number of 1 or more');
      }
      if (!REASONS.has(raw?.reason)) throw new ValidationError(400, 'Each item needs a valid return reason');
      if (wanted.has(lineItemId)) throw new ValidationError(400, 'Each item may only appear once');
      wanted.set(lineItemId, {
        quantity,
        reason: raw.reason,
        reasonDetail: raw.reasonDetail ? String(raw.reasonDetail).slice(0, 1000) : null,
      });
    }

    const { order, items: orderItems } = await ReturnValidation.loadOrder(shop, orderId);

    // Ownership: the email on the request must be the email on the order.
    if (!order.email || order.email.toLowerCase() !== customerEmail.trim().toLowerCase()) {
      throw new ValidationError(404, 'Order not found. Please check your email and order number.');
    }

    const byId = new Map(orderItems.map((i) => [i.lineItemId, i]));
    const validated = [];
    let nothingLeft = true;
    for (const [lineItemId, req] of wanted) {
      const item = byId.get(lineItemId);
      if (!item) throw new ValidationError(400, 'One of the items is not on this order');
      if (item.quantity > 0) nothingLeft = false;
      if (!item.eligible) {
        if (item.ineligibleReason === 'Already returned') continue; // handled below
        throw new ValidationError(400, `"${item.title}" is not eligible for return: ${item.ineligibleReason}`);
      }
      if (req.quantity > item.quantity) {
        throw new ValidationError(400, `Only ${item.quantity} of "${item.title}" can still be returned`);
      }
      if (!item.resolutions.includes(resolution)) {
        throw new ValidationError(400, `"${item.title}" cannot be returned for ${resolution.toLowerCase().replace('_', ' ')}`);
      }
      validated.push({
        lineItemId: item.lineItemId,
        productId: item.productId,
        variantId: item.variantId,
        productTitle: item.title,
        variantTitle: item.variantTitle,
        sku: item.sku,
        quantity: req.quantity,
        unitPrice: item.price,
        reason: req.reason,
        reasonDetail: req.reasonDetail,
        photoUrls: [],
        refundableQuantity: item.refundableQuantity,
        policyFees: item.fees,
      });
    }
    if (nothingLeft || validated.length === 0) {
      throw new ValidationError(409, 'A return for these items is already open');
    }

    return { order, items: validated };
  }
}

ReturnValidation.ValidationError = ValidationError;
ReturnValidation.CLAIMING_STATUSES = CLAIMING_STATUSES;

module.exports = ReturnValidation;

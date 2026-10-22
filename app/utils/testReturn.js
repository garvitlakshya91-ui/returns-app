// A test return (from "Create test return" in the dashboard) is not tied to
// a real Shopify order, so it has no customer address to post a label from.
// Approving one would only end in a failed label, so it cannot be approved.

const TEST_RETURN_MESSAGE = 'This is a test return, so it cannot be approved: approving books a real carrier label, '
  + 'which needs a real order and customer address. To try the full flow, place an order in your store '
  + 'and start a return from your returns portal.';

function isTestReturn(returnRecord) {
  return !String(returnRecord?.shopifyOrderId || '').startsWith('gid://shopify/Order/');
}

module.exports = { isTestReturn, TEST_RETURN_MESSAGE };

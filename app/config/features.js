// Feature switches for flows that exist in code but are not finished enough
// to offer to customers. Each is off unless its env var is exactly "true".

// Exchanges: the portal has no replacement-item picker yet, the draft order
// does not net off the returned value, and the app lacks write_draft_orders.
// Keep off until all three are done.
const EXCHANGES_ENABLED = process.env.EXCHANGES_ENABLED === 'true';

module.exports = { EXCHANGES_ENABLED };

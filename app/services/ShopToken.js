// Central access-token handling for Shopify's *expiring* offline tokens.
//
// Public apps created on/after 1 Apr 2026 (ours: June 2026) MUST use expiring
// offline access tokens — requesting a legacy non-expiring token is refused
// with 403 Forbidden. Expiring tokens last ~60 minutes and come with a
// refresh token (~90 days), so every Shopify API call must go through
// getAccessToken(), which transparently refreshes and re-persists the pair.
//
// Storage format (Shop.shopifyToken, encrypted at rest):
//   - legacy: the bare access token string (pre-existing installs)
//   - expiring: JSON { accessToken, refreshToken, expiresAt, refreshTokenExpiresAt }
const shopify = require('../config/shopify');
const prisma = require('../config/database');
const { encrypt, decrypt } = require('../utils/encryption');
const logger = require('../utils/logger');

// Refresh when within 5 minutes of expiry — avoids 401s from clock skew and
// long-running requests.
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

// One refresh per shop at a time; concurrent callers await the same promise.
const inFlight = new Map();

/** Serialize a @shopify/shopify-api Session into the encrypted storage blob. */
function serializeSession(session) {
  if (session.refreshToken) {
    return encrypt(JSON.stringify({
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      expiresAt: session.expires ? new Date(session.expires).toISOString() : null,
      refreshTokenExpiresAt: session.refreshTokenExpires
        ? new Date(session.refreshTokenExpires).toISOString()
        : null,
    }));
  }
  // Non-expiring token (legacy installs / dev stores)
  return encrypt(session.accessToken);
}

/** Decrypt + parse the stored blob; tolerates the legacy bare-token format. */
function parseStored(encryptedValue) {
  const raw = decrypt(encryptedValue);
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.accessToken) return parsed;
  } catch {
    // legacy bare token string
  }
  return { accessToken: raw, refreshToken: null, expiresAt: null, refreshTokenExpiresAt: null };
}

/**
 * True when the stored credentials can no longer be used or refreshed —
 * the auth middleware then re-provisions via token exchange.
 */
function needsReauth(shop) {
  if (!shop?.shopifyToken) return true;
  let stored;
  try {
    stored = parseStored(shop.shopifyToken);
  } catch {
    return true; // undecryptable blob
  }
  if (!stored.refreshToken) return false; // legacy non-expiring token
  if (!stored.refreshTokenExpiresAt) return false;
  return new Date(stored.refreshTokenExpiresAt).getTime() <= Date.now();
}

/**
 * Return a currently-valid access token for the shop, refreshing (and
 * persisting the new pair) when the stored one is expired or about to be.
 * On an unrecoverable refresh failure the stored token is cleared so the
 * next embedded request re-provisions the shop via token exchange.
 */
async function getAccessToken(shop) {
  if (!shop?.shopifyToken) {
    throw new Error(`No Shopify access token stored for ${shop?.shopifyDomain || 'unknown shop'}`);
  }
  const stored = parseStored(shop.shopifyToken);
  if (!stored.refreshToken) return stored.accessToken; // legacy non-expiring

  const expiresAt = stored.expiresAt ? new Date(stored.expiresAt).getTime() : 0;
  if (expiresAt - Date.now() > REFRESH_MARGIN_MS) return stored.accessToken;

  if (inFlight.has(shop.id)) return inFlight.get(shop.id);
  const promise = (async () => {
    try {
      const { session } = await shopify.auth.refreshToken({
        shop: shop.shopifyDomain,
        refreshToken: stored.refreshToken,
      });
      await prisma.shop.update({
        where: { id: shop.id },
        data: { shopifyToken: serializeSession(session) },
      });
      logger.info({ shop: shop.shopifyDomain }, 'Shopify access token refreshed');
      return session.accessToken;
    } catch (err) {
      logger.error({ err, shop: shop.shopifyDomain }, 'Token refresh failed — clearing stored token for re-auth');
      // Self-heal: the next embedded request re-runs token exchange.
      await prisma.shop.update({
        where: { id: shop.id },
        data: { shopifyToken: '' },
      }).catch(() => {});
      throw err;
    }
  })();
  inFlight.set(shop.id, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(shop.id);
  }
}

/** Convenience: a GraphQL client wired with a fresh access token. */
async function graphqlClient(shop) {
  const accessToken = await getAccessToken(shop);
  return new shopify.clients.Graphql({
    session: { shop: shop.shopifyDomain, accessToken },
  });
}

module.exports = { getAccessToken, graphqlClient, serializeSession, parseStored, needsReauth };

const { getRedis } = require('../config/redis');
const logger = require('./logger');

const TTL_SECONDS = 60 * 60 * 24; // 24h — Shopify's webhook retry window is shorter
const KEY_PREFIX = 'idem:';

/**
 * Atomic check-and-set. Returns true if this is the first time we've seen
 * `key`, false if we've already processed it.
 *
 * Uses Redis SET NX EX for the atomic claim. When Redis is unavailable
 * (dev fallback), returns true so processing isn't blocked — the cost is
 * losing idempotency, which is acceptable in dev.
 */
async function claim(key, ttlSeconds = TTL_SECONDS) {
  if (!key) return true; // No key, no dedup possible; allow processing
  const redis = getRedis();
  if (!redis) return true;

  try {
    const result = await redis.set(
      `${KEY_PREFIX}${key}`,
      Date.now().toString(),
      'EX',
      ttlSeconds,
      'NX',
    );
    return result === 'OK';
  } catch (err) {
    logger.warn({ err: err.message, key }, 'Idempotency check failed — allowing through');
    return true;
  }
}

/**
 * Give a claimed key back, so the same delivery can be processed on retry.
 * Used when processing failed after the claim was taken.
 */
async function release(key) {
  if (!key) return;
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.del(`${KEY_PREFIX}${key}`);
  } catch (err) {
    logger.warn({ err: err.message, key }, 'Idempotency release failed');
  }
}

module.exports = { claim, release };

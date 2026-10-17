const { getRedis } = require('../config/redis');
const logger = require('./logger');

const TTL_SECONDS = 60 * 60 * 24; // 24h — Shopify's webhook retry window is shorter
// How long a claim is held while work is in progress. If the process dies
// mid-way the lease lapses and the next delivery of the same event is
// processed instead of being dropped as a duplicate.
const LEASE_SECONDS = 10 * 60;
const KEY_PREFIX = 'idem:';
const PROCESSING = 'processing';
const DONE = 'done';

/**
 * Atomic check-and-set: take a processing lease on `key`. Returns true if
 * this is the first time we've seen `key` (or an earlier lease lapsed),
 * false if it is held or completed. Call complete() when the work is done
 * so the key stays claimed for the full window, or release() if it failed.
 *
 * Uses Redis SET NX EX for the atomic claim. When Redis is unavailable
 * (dev fallback), returns true so processing isn't blocked — the cost is
 * losing idempotency, which is acceptable in dev.
 */
async function claim(key, ttlSeconds = LEASE_SECONDS) {
  if (!key) return true; // No key, no dedup possible; allow processing
  const redis = getRedis();
  if (!redis) return true;

  try {
    const result = await redis.set(
      `${KEY_PREFIX}${key}`,
      PROCESSING,
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

/** Mark a claimed key as finished; it stays claimed for the whole window. */
async function complete(key, ttlSeconds = TTL_SECONDS) {
  if (!key) return;
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.set(`${KEY_PREFIX}${key}`, DONE, 'EX', ttlSeconds);
  } catch (err) {
    logger.warn({ err: err.message, key }, 'Idempotency complete failed');
  }
}

/**
 * What is known about a key: 'processing' (lease held, work in progress),
 * 'done' (finished within the window), or null (never seen / lapsed).
 */
async function status(key) {
  if (!key) return null;
  const redis = getRedis();
  if (!redis) return null;
  try {
    const value = await redis.get(`${KEY_PREFIX}${key}`);
    if (value === null || value === undefined) return null;
    return value === PROCESSING ? PROCESSING : DONE;
  } catch (err) {
    logger.warn({ err: err.message, key }, 'Idempotency status failed');
    return null;
  }
}

module.exports = { claim, release, complete, status, LEASE_SECONDS, TTL_SECONDS };

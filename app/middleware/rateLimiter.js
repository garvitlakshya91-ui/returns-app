const rateLimit = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');
const { getRedis } = require('../config/redis');
const logger = require('../utils/logger');

function makeStore() {
  const redis = getRedis();
  if (!redis) {
    logger.warn('Rate limiter using in-memory store — switch to Redis for production');
    return undefined;
  }
  return new RedisStore({
    sendCommand: (...args) => redis.call(...args),
    prefix: 'rl:',
  });
}

/**
 * Wrap a limiter so a backing-store outage (e.g. Redis over quota,
 * connection lost) fails OPEN — the request is allowed instead of 500ing
 * the whole endpoint. Rate limiting is a protective measure, not a
 * correctness one; losing it temporarily is far better than an outage.
 *
 * express-rate-limit signals a store error by calling next(err). When the
 * limit is actually exceeded it ends the response itself and never calls
 * next, so this wrapper only intercepts the error path.
 */
function failOpen(limiter) {
  return (req, res, next) => {
    limiter(req, res, (err) => {
      if (err) {
        logger.warn({ err: err.message }, 'Rate limiter store error — failing open');
        return next();
      }
      next();
    });
  };
}

// All portal endpoints — moderately permissive (users with photo upload
// retries can legitimately fire 50+ requests in a session).
const portalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  store: makeStore(),
  message: { error: 'Too many requests. Please try again later.' },
});

// Order lookup — tighter because this is the main credential-stuffing
// attack surface (email + order # enumeration).
const lookupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  store: makeStore(),
  message: { error: 'Too many lookup attempts. Please try again later.' },
});

// Return creation — modest cap. A legitimate user creates 1-2 returns.
const createReturnLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  store: makeStore(),
  message: { error: 'Too many return submissions. Please try again later.' },
});

// Admin API — laxer because authenticated merchant traffic is trusted.
// Per-IP cap protects against scripted abuse.
const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  store: makeStore(),
  message: { error: 'Too many admin API requests. Please slow down.' },
});

// Export fail-open-wrapped versions so a Redis outage degrades gracefully
// (no rate limiting) instead of taking down the endpoint.
module.exports = {
  portalLimiter: failOpen(portalLimiter),
  lookupLimiter: failOpen(lookupLimiter),
  createReturnLimiter: failOpen(createReturnLimiter),
  adminLimiter: failOpen(adminLimiter),
};

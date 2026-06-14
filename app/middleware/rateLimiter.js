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

module.exports = { portalLimiter, lookupLimiter, createReturnLimiter, adminLimiter };

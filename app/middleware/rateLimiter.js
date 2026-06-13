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

const portalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  store: makeStore(),
  message: { error: 'Too many requests. Please try again later.' },
});

const lookupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  store: makeStore(),
  message: { error: 'Too many lookup attempts. Please try again later.' },
});

module.exports = { portalLimiter, lookupLimiter };

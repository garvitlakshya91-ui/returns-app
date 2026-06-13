const Redis = require('ioredis');

let redis = null;

function getRedis() {
  if (!redis) {
    const url = process.env.REDIS_URL;
    if (!url) {
      console.warn('REDIS_URL not set — Redis features disabled');
      return null;
    }
    redis = new Redis(url, {
      maxRetriesPerRequest: null, // Required by BullMQ
      enableReadyCheck: false,
    });
    redis.on('error', (err) => console.error('Redis error:', err.message));
    redis.on('connect', () => console.log('Redis connected'));
  }
  return redis;
}

module.exports = { getRedis };

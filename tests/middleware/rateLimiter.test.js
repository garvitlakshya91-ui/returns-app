// Behavioural tests for app/middleware/rateLimiter.js.
//
// Two modes are exercised:
//   1. Redis unavailable (installRedisMock → getRedis() === null) — the limiters
//      fall back to express-rate-limit's in-memory store. We drive real
//      requests through the smaller limiters (createReturn max 5, lookup max 30)
//      and assert the 429 + standard RateLimit-* headers as coded.
//   2. Redis available — rate-limit-redis is mocked so we can assert each
//      limiter gets its OWN key prefix (the double-count regression the module
//      comment warns about) and that sendCommand delegates to redis.call().
// Plus the failOpen wrapper: a store error must let the request through.
const request = require('supertest');
const express = require('express');
const { installRedisMock } = require('../helpers');

function buildApp(limiters) {
  const app = express();
  app.use(express.json());
  app.get('/portal', limiters.portalLimiter, (req, res) => res.json({ ok: true }));
  app.post('/lookup', limiters.lookupLimiter, (req, res) => res.json({ ok: true }));
  app.post('/create', limiters.createReturnLimiter, (req, res) => res.json({ ok: true }));
  app.get('/admin', limiters.adminLimiter, (req, res) => res.json({ ok: true }));
  return app;
}

describe('rateLimiter — in-memory fallback when Redis is unavailable', () => {
  let app;
  let limiters;

  beforeEach(() => {
    jest.resetModules();
    installRedisMock();
    limiters = require('../../app/middleware/rateLimiter');
    app = buildApp(limiters);
  });

  it('exports four fail-open wrapped middlewares', () => {
    for (const name of ['portalLimiter', 'lookupLimiter', 'createReturnLimiter', 'adminLimiter']) {
      expect(typeof limiters[name]).toBe('function');
      expect(limiters[name].length).toBe(3); // (req, res, next)
    }
  });

  it('createReturnLimiter allows 5 submissions per IP then returns 429 with the coded JSON message', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await request(app).post('/create').send({});
      expect(res.status).toBe(200);
    }
    const blocked = await request(app).post('/create').send({});
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({ error: 'Too many return submissions. Please try again later.' });
  });

  it('sends standard RateLimit-* headers and no legacy X-RateLimit-* headers', async () => {
    const res = await request(app).post('/create').send({});
    expect(res.status).toBe(200);
    expect(res.headers['ratelimit-limit']).toBe('5');
    expect(res.headers['ratelimit-remaining']).toBe('4');
    expect(res.headers['ratelimit-reset']).toBeDefined();
    expect(res.headers['x-ratelimit-limit']).toBeUndefined();
    expect(res.headers['x-ratelimit-remaining']).toBeUndefined();
  });

  it('RateLimit-Remaining counts down per request and hits 0 on the last allowed call', async () => {
    const remaining = [];
    for (let i = 0; i < 5; i++) {
      const res = await request(app).post('/create').send({});
      remaining.push(res.headers['ratelimit-remaining']);
    }
    expect(remaining).toEqual(['4', '3', '2', '1', '0']);
  });

  it('lookupLimiter allows 30 lookups then 429s with its own message', async () => {
    const results = [];
    for (let i = 0; i < 31; i++) {
      const res = await request(app).post('/lookup').send({});
      results.push(res.status);
    }
    expect(results.slice(0, 30).every((s) => s === 200)).toBe(true);
    expect(results[30]).toBe(429);
    const blocked = await request(app).post('/lookup').send({});
    expect(blocked.body).toEqual({ error: 'Too many lookup attempts. Please try again later.' });
    expect(blocked.headers['ratelimit-limit']).toBe('30');
  });

  it('limiters are independent: exhausting createReturnLimiter does not block lookups', async () => {
    for (let i = 0; i < 6; i++) await request(app).post('/create').send({});
    const res = await request(app).post('/lookup').send({});
    expect(res.status).toBe(200);
    expect(res.headers['ratelimit-remaining']).toBe('29');
  });

  it('portalLimiter and adminLimiter advertise their configured caps (120 and 600)', async () => {
    const portal = await request(app).get('/portal');
    expect(portal.status).toBe(200);
    expect(portal.headers['ratelimit-limit']).toBe('120');

    const admin = await request(app).get('/admin');
    expect(admin.status).toBe(200);
    expect(admin.headers['ratelimit-limit']).toBe('600');
  });

  it('stacking portalLimiter + lookupLimiter on one route does not double-count either (separate stores)', async () => {
    const stacked = express();
    stacked.post('/lookup', limiters.portalLimiter, limiters.lookupLimiter, (req, res) => res.json({ ok: true }));

    const res1 = await request(stacked).post('/lookup');
    const res2 = await request(stacked).post('/lookup');
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    // The innermost (lookup) limiter writes the headers last: 30 cap, 2 used.
    expect(res2.headers['ratelimit-limit']).toBe('30');
    expect(res2.headers['ratelimit-remaining']).toBe('28');
  });

  it('counts per client IP (different IPs get independent budgets)', async () => {
    // Express trusts X-Forwarded-For only when trust proxy is set; enable it
    // on a local app so we can simulate two distinct clients.
    const perIp = express();
    perIp.set('trust proxy', 1);
    perIp.post('/create', limiters.createReturnLimiter, (req, res) => res.json({ ok: true }));

    for (let i = 0; i < 5; i++) {
      await request(perIp).post('/create').set('X-Forwarded-For', '203.0.113.10');
    }
    const blockedA = await request(perIp).post('/create').set('X-Forwarded-For', '203.0.113.10');
    const freshB = await request(perIp).post('/create').set('X-Forwarded-For', '203.0.113.20');
    expect(blockedA.status).toBe(429);
    expect(freshB.status).toBe(200);
  });
});

describe('rateLimiter — Redis-backed store wiring', () => {
  let RedisStoreCtor;
  let redisCall;

  beforeEach(() => {
    jest.resetModules();
    redisCall = jest.fn().mockResolvedValue('OK');
    jest.doMock('../../app/config/redis', () => ({
      getRedis: () => ({ call: redisCall }),
    }));
    RedisStoreCtor = jest.fn().mockImplementation(function (opts) {
      this.opts = opts;
      // Minimal express-rate-limit store contract so construction succeeds;
      // we never drive traffic through this fake.
      this.init = jest.fn();
      this.increment = jest.fn();
      this.decrement = jest.fn();
      this.resetKey = jest.fn();
    });
    jest.doMock('rate-limit-redis', () => ({ RedisStore: RedisStoreCtor }));
  });

  it('gives each limiter its own Redis key prefix so stacked limiters never double-count', () => {
    require('../../app/middleware/rateLimiter');

    const prefixes = RedisStoreCtor.mock.calls.map(([opts]) => opts.prefix);
    expect(prefixes).toEqual(['rl:portal:', 'rl:lookup:', 'rl:create:', 'rl:admin:']);
    expect(new Set(prefixes).size).toBe(4);
  });

  it('sendCommand delegates to redis.call with the raw command args', async () => {
    require('../../app/middleware/rateLimiter');
    const { sendCommand } = RedisStoreCtor.mock.calls[0][0];
    await sendCommand('INCR', 'rl:portal:1.2.3.4');
    expect(redisCall).toHaveBeenCalledWith('INCR', 'rl:portal:1.2.3.4');
  });
});

describe('rateLimiter — failOpen wrapper', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it('lets the request through when the underlying limiter reports a store error', async () => {
    // Simulate express-rate-limit signalling a backing-store failure via next(err).
    const storeErr = new Error('Redis connection lost');
    const inner = jest.fn((req, res, next) => next(storeErr));
    jest.doMock('express-rate-limit', () => jest.fn(() => inner));
    installRedisMock();
    const limiters = require('../../app/middleware/rateLimiter');

    const app = express();
    const handler = jest.fn((req, res) => res.json({ ok: true }));
    // Error handler to prove the error never propagates past the wrapper.
    app.get('/x', limiters.portalLimiter, handler);
    app.use((err, req, res, next) => res.status(599).json({ leaked: err.message })); // eslint-disable-line no-unused-vars

    const res = await request(app).get('/x');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(handler).toHaveBeenCalled();
    expect(inner).toHaveBeenCalled();
  });

  it('passes through normally when the limiter calls next() without error', async () => {
    const inner = jest.fn((req, res, next) => next());
    jest.doMock('express-rate-limit', () => jest.fn(() => inner));
    installRedisMock();
    const limiters = require('../../app/middleware/rateLimiter');

    const app = express();
    app.get('/x', limiters.adminLimiter, (req, res) => res.json({ ok: true }));
    const res = await request(app).get('/x');
    expect(res.status).toBe(200);
  });

  it('does not interfere when the limiter ends the response itself (429 path never calls next)', async () => {
    const inner = jest.fn((req, res) => res.status(429).json({ error: 'limited' }));
    jest.doMock('express-rate-limit', () => jest.fn(() => inner));
    installRedisMock();
    const limiters = require('../../app/middleware/rateLimiter');

    const app = express();
    const handler = jest.fn((req, res) => res.json({ ok: true }));
    app.get('/x', limiters.lookupLimiter, handler);
    const res = await request(app).get('/x');
    expect(res.status).toBe(429);
    expect(handler).not.toHaveBeenCalled();
  });

  it('configures each limiter with the documented window/max and no legacy headers', () => {
    const rateLimit = jest.fn(() => (req, res, next) => next());
    jest.doMock('express-rate-limit', () => rateLimit);
    installRedisMock();
    require('../../app/middleware/rateLimiter');

    const configs = rateLimit.mock.calls.map(([opts]) => ({
      windowMs: opts.windowMs, max: opts.max, standardHeaders: opts.standardHeaders, legacyHeaders: opts.legacyHeaders, store: opts.store,
    }));
    expect(configs).toEqual([
      { windowMs: 15 * 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false, store: undefined },
      { windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false, store: undefined },
      { windowMs: 60 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false, store: undefined },
      { windowMs: 15 * 60 * 1000, max: 600, standardHeaders: true, legacyHeaders: false, store: undefined },
    ]);
  });
});

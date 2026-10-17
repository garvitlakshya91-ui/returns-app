// app/utils/idempotency.js — atomic first-seen claims backed by Redis SET NX EX,
// degrading to "always allow" when Redis is absent or failing.
let claim;
let release;
let complete;
let status;
let LEASE_SECONDS;
let fakeRedis;
let logger;

/** In-memory Redis double honouring SET key value EX ttl NX semantics. */
function makeFakeRedis() {
  const store = new Map();
  return {
    store,
    set: jest.fn(async (key, value, ...args) => {
      const nx = args.includes('NX');
      if (nx && store.has(key)) return null;
      store.set(key, { value, args });
      return 'OK';
    }),
    get: jest.fn(async (key) => (store.has(key) ? store.get(key).value : null)),
    del: jest.fn(async (key) => (store.delete(key) ? 1 : 0)),
  };
}

beforeEach(() => {
  jest.resetModules();
  fakeRedis = undefined;
  jest.doMock('../../app/config/redis', () => ({
    getRedis: jest.fn(() => fakeRedis),
  }));
  jest.doMock('../../app/utils/logger', () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
  }));
  logger = require('../../app/utils/logger');
  ({ claim, release, complete, status, LEASE_SECONDS } = require('../../app/utils/idempotency'));
});

describe('claim() without Redis (dev / test fallback)', () => {
  it('always allows processing, even for repeated keys', async () => {
    fakeRedis = null;
    await expect(claim('shopify:wh-1')).resolves.toBe(true);
    await expect(claim('shopify:wh-1')).resolves.toBe(true);
    await expect(claim('shopify:wh-1')).resolves.toBe(true);
  });

  it('does not log a warning in the no-Redis path (it is the expected dev mode)', async () => {
    fakeRedis = null;
    await claim('k');
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe('claim() with Redis', () => {
  beforeEach(() => { fakeRedis = makeFakeRedis(); });

  it('first claim of a key succeeds, every later claim of the same key is refused', async () => {
    await expect(claim('shopify:wh-42')).resolves.toBe(true);
    await expect(claim('shopify:wh-42')).resolves.toBe(false);
    await expect(claim('shopify:wh-42')).resolves.toBe(false);
    expect(fakeRedis.set).toHaveBeenCalledTimes(3);
  });

  it('distinct keys are claimed independently', async () => {
    await expect(claim('a')).resolves.toBe(true);
    await expect(claim('b')).resolves.toBe(true);
    await expect(claim('a')).resolves.toBe(false);
    await expect(claim('b')).resolves.toBe(false);
  });

  it('uses an atomic SET ... EX <lease> NX under the idem: prefix, storing "processing"', async () => {
    await claim('shopify:wh-7');
    // A short lease while work is in progress: if the process dies the key
    // lapses and the retry is processed instead of dropped as a duplicate.
    expect(fakeRedis.set).toHaveBeenCalledWith('idem:shopify:wh-7', 'processing', 'EX', 10 * 60, 'NX');
    expect(LEASE_SECONDS).toBe(600);
  });

  it('complete() keeps the key for the full 24h window as "done"; status() tells the two apart', async () => {
    await expect(status('shopify:wh-8')).resolves.toBeNull();
    await claim('shopify:wh-8');
    await expect(status('shopify:wh-8')).resolves.toBe('processing');
    await complete('shopify:wh-8');
    expect(fakeRedis.set).toHaveBeenLastCalledWith('idem:shopify:wh-8', 'done', 'EX', 60 * 60 * 24);
    await expect(status('shopify:wh-8')).resolves.toBe('done');
    await expect(claim('shopify:wh-8')).resolves.toBe(false);
  });

  it('release() after a failure makes the key claimable again at once', async () => {
    await claim('shopify:wh-9');
    await release('shopify:wh-9');
    await expect(status('shopify:wh-9')).resolves.toBeNull();
    await expect(claim('shopify:wh-9')).resolves.toBe(true);
  });

  it('complete()/status() are no-ops without Redis and fail soft on Redis errors', async () => {
    fakeRedis = null;
    await expect(complete('k')).resolves.toBeUndefined();
    await expect(status('k')).resolves.toBeNull();
    fakeRedis = makeFakeRedis();
    fakeRedis.get.mockRejectedValueOnce(new Error('timeout'));
    await expect(status('k')).resolves.toBeNull();
    expect(logger.warn).toHaveBeenCalledWith({ err: 'timeout', key: 'k' }, 'Idempotency status failed');
  });

  it('concurrent claims of the same key: exactly one wins', async () => {
    const results = await Promise.all([claim('race'), claim('race'), claim('race'), claim('race')]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('treats any non-"OK" reply as already-claimed', async () => {
    fakeRedis.set.mockResolvedValueOnce(null);
    await expect(claim('x')).resolves.toBe(false);
    fakeRedis.set.mockResolvedValueOnce('QUEUED');
    await expect(claim('y')).resolves.toBe(false);
    fakeRedis.set.mockResolvedValueOnce('OK');
    await expect(claim('z')).resolves.toBe(true);
  });

  it('fails open when Redis errors: allows processing and logs a warning with the key', async () => {
    fakeRedis.set.mockRejectedValueOnce(new Error('READONLY You can\'t write against a read only replica'));
    await expect(claim('shopify:wh-err')).resolves.toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      { err: expect.stringMatching(/READONLY/), key: 'shopify:wh-err' },
      'Idempotency check failed — allowing through',
    );
  });

  it('after a transient Redis error the same key can still be claimed once it recovers', async () => {
    fakeRedis.set.mockRejectedValueOnce(new Error('timeout'));
    await expect(claim('k')).resolves.toBe(true); // failed open — nothing stored
    await expect(claim('k')).resolves.toBe(true); // first real claim
    await expect(claim('k')).resolves.toBe(false);
  });

  it('TTL expiry makes a key claimable again (simulated expiry)', async () => {
    await expect(claim('ttl')).resolves.toBe(true);
    await expect(claim('ttl')).resolves.toBe(false);
    fakeRedis.store.delete('idem:ttl'); // Redis evicts after EX seconds
    await expect(claim('ttl')).resolves.toBe(true);
  });
});

describe('claim() with no key', () => {
  it.each([undefined, null, ''])('%p → allowed without touching Redis', async (key) => {
    fakeRedis = makeFakeRedis();
    await expect(claim(key)).resolves.toBe(true);
    await expect(claim(key)).resolves.toBe(true);
    expect(fakeRedis.set).not.toHaveBeenCalled();
  });
});

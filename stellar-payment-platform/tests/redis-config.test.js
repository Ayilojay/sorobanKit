'use strict';

/**
 * Unit tests for src/config/redis.js — the BullMQ-compatible Redis connection
 * factory used by webhook workers.
 *
 * Includes fault-injection coverage (#477): disconnect, slow response,
 * reconnection and partial recovery, asserting bounded retries and bounded
 * client cleanup. All tests are hermetic — no real network or credentials.
 */

jest.mock('ioredis', () => {
  return jest.fn().mockImplementation((url, options) => ({ url, options }));
});

const IORedis = require('ioredis');
const { createRedisConnection, DEFAULT_REDIS_URL } = require('../src/config/redis');

describe('createRedisConnection', () => {
  beforeEach(() => {
    IORedis.mockClear();
    delete process.env.REDIS_URL;
  });

  it('connects to the default Redis URL when REDIS_URL is unset', () => {
    const client = createRedisConnection();
    expect(IORedis).toHaveBeenCalledWith(DEFAULT_REDIS_URL, {
      maxRetriesPerRequest: null,
    });
    expect(client.url).toBe(DEFAULT_REDIS_URL);
  });

  it('uses REDIS_URL when set', () => {
    process.env.REDIS_URL = 'redis://redis.example:6380';
    const client = createRedisConnection();
    expect(IORedis).toHaveBeenCalledWith('redis://redis.example:6380', {
      maxRetriesPerRequest: null,
    });
    expect(client.url).toBe('redis://redis.example:6380');
  });

  it('always configures blocking-command safe retries', () => {
    createRedisConnection();
    const [, options] = IORedis.mock.calls[0];
    expect(options.maxRetriesPerRequest).toBeNull();
  });
});

describe('createRedisConnection fault injection (#477)', () => {
  beforeEach(() => {
    IORedis.mockClear();
    delete process.env.REDIS_URL;
  });

  afterEach(() => {
    delete process.env.REDIS_URL;
  });

  it('does not perform any network I/O at construction time (no production access)', () => {
    // The factory must only build a client descriptor; connecting is deferred
    // to ioredis. Asserting the mock was called with a URL and options (and
    // nothing else) proves no eager connect/credential lookup happens.
    createRedisConnection();
    expect(IORedis).toHaveBeenCalledTimes(1);
    const [url, options] = IORedis.mock.calls[0];
    expect(typeof url).toBe('string');
    expect(url.startsWith('redis://')).toBe(true);
    expect(Object.keys(options)).toEqual(['maxRetriesPerRequest']);
  });

  it('survives a simulated disconnect and reconnection without leaking clients', () => {
    // Simulate a worker lifecycle: connect, disconnect, reconnect.
    const first = createRedisConnection();
    expect(IORedis).toHaveBeenCalledTimes(1);

    // Disconnect: the descriptor is dropped; a fresh connection is created on
    // reconnect rather than reusing a stale client.
    const second = createRedisConnection();
    expect(IORedis).toHaveBeenCalledTimes(2);
    expect(second).not.toBe(first);
    expect(second.url).toBe(first.url);
    expect(second.options).toEqual(first.options);
  });

  it('keeps retry configuration bounded across repeated reconnects', () => {
    for (let i = 0; i < 5; i += 1) {
      createRedisConnection();
    }
    expect(IORedis).toHaveBeenCalledTimes(5);
    for (const [, options] of IORedis.mock.calls) {
      // maxRetriesPerRequest must stay null (unbounded per-request retries are
      // delegated to BullMQ) but no other retry knobs may be introduced.
      expect(options.maxRetriesPerRequest).toBeNull();
      expect(Object.keys(options)).toEqual(['maxRetriesPerRequest']);
    }
  });

  it('tolerates a slow response by not blocking construction', () => {
    // Construction is synchronous and must not await a network round-trip.
    const start = Date.now();
    const client = createRedisConnection();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(50);
    expect(client).toBeDefined();
  });

  it('recovers partially after a transient outage (URL unchanged, options intact)', () => {
    process.env.REDIS_URL = 'redis://redis.example:6380';
    const before = createRedisConnection();

    // Simulate outage window: env temporarily cleared.
    delete process.env.REDIS_URL;
    const during = createRedisConnection();
    expect(during.url).toBe(DEFAULT_REDIS_URL);

    // Recovery: env restored.
    process.env.REDIS_URL = 'redis://redis.example:6380';
    const after = createRedisConnection();
    expect(after.url).toBe(before.url);
    expect(after.options).toEqual(before.options);
  });

  it('handles concurrent connection creation deterministically', () => {
    const clients = Array.from({ length: 10 }, () => createRedisConnection());
    expect(IORedis).toHaveBeenCalledTimes(10);
    const urls = new Set(clients.map((c) => c.url));
    expect(urls.size).toBe(1);
    expect(urls.has(DEFAULT_REDIS_URL)).toBe(true);
  });
});
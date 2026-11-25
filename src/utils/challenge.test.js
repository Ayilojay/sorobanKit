'use strict';

jest.mock('../config/redis');
jest.mock('../utils/logger', () => ({ logger: { warn: jest.fn(), info: jest.fn() } }));

const { getRedisClient } = require('../config/redis');
const { issueChallenge, verifyChallenge } = require('./challenge');

function makeStore() {
  const store = new Map();
  return {
    set: jest.fn(async (key, val, _px, _ttl) => { store.set(key, val); }),
    get: jest.fn(async (key) => store.get(key) ?? null),
    getdel: jest.fn(async (key) => {
      const val = store.get(key) ?? null;
      store.delete(key);
      return val;
    }),
    _store: store,
  };
}

let redis;
beforeEach(() => {
  redis = makeStore();
  getRedisClient.mockReturnValue(redis);
  process.env.SERVICE_DOMAIN = 'test.local';
  process.env.STELLAR_NETWORK = 'testnet';
});

describe('issueChallenge', () => {
  it('returns a nonce and challengeString', async () => {
    const result = await issueChallenge({ address: 'GABC', network: 'testnet' });
    expect(result.nonce).toHaveLength(64);
    expect(result.challengeString).toContain('test.local');
    expect(result.challengeString).toContain('GABC');
  });

  it('stores the challenge in Redis', async () => {
    const { nonce } = await issueChallenge({ address: 'GABC', network: 'testnet' });
    expect(redis.set).toHaveBeenCalledWith(
      expect.stringContaining(nonce),
      expect.any(String),
      'PX',
      expect.any(Number)
    );
  });

  it('throws when Redis is unavailable', async () => {
    getRedisClient.mockReturnValue(null);
    await expect(issueChallenge({ address: 'GABC' })).rejects.toThrow('Redis unavailable');
  });
});

describe('verifyChallenge', () => {
  it('throws CHALLENGE_INVALID when nonce not found', async () => {
    const ownershipService = { verifyOwnership: jest.fn() };
    const err = await verifyChallenge({ nonce: 'missing', signature: 'sig', signerKey: 'key', ownershipService })
      .catch((e) => e);
    expect(err.code).toBe('CHALLENGE_INVALID');
  });

  it('throws CHALLENGE_INVALID on second use (nonce consumed)', async () => {
    const { nonce } = await issueChallenge({ address: 'GABC', network: 'testnet' });
    // manually mark as consumed by clearing
    redis._store.delete(`challenge:${nonce}`);
    const ownershipService = { verifyOwnership: jest.fn() };
    const err = await verifyChallenge({ nonce, signature: 'sig', signerKey: 'key', ownershipService })
      .catch((e) => e);
    expect(err.code).toBe('CHALLENGE_INVALID');
  });

  it('throws CHALLENGE_DOMAIN_MISMATCH when domain differs', async () => {
    const { nonce } = await issueChallenge({ address: 'GABC', network: 'testnet' });
    process.env.SERVICE_DOMAIN = 'other.local'; // change domain after issue
    const { issueChallenge: ic2 } = jest.requireActual('./challenge');
    // Inject payload with wrong domain directly
    const payload = JSON.parse(redis._store.get(`challenge:${nonce}`));
    payload.domain = 'wrong.local';
    redis._store.set(`challenge:${nonce}`, JSON.stringify(payload));
    const ownershipService = { verifyOwnership: jest.fn() };
    const err = await verifyChallenge({ nonce, signature: 'sig', signerKey: 'key', ownershipService })
      .catch((e) => e);
    expect(err.code).toBe('CHALLENGE_DOMAIN_MISMATCH');
  });
});

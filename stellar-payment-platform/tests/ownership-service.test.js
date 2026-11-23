'use strict';

/**
 * Unit tests for src/services/ownershipService.js.
 *
 * The real @stellar/stellar-sdk ships ESM entry points Jest 29 cannot parse,
 * so Keypair.verify is stubbed while the message-hashing and validation logic
 * inside verifyFreighterSignedMessage is exercised for real.
 */

jest.mock('@stellar/stellar-sdk', () => {
  const mockVerify = jest.fn();
  return {
    Keypair: {
      fromPublicKey: jest.fn(() => ({ verify: mockVerify })),
      random: jest.fn(() => ({ publicKey: () => 'GFAKE' })),
    },
    StrKey: {
      isValidEd25519PublicKey: (value) =>
        typeof value === 'string' && value.startsWith('G') && value.length === 56,
    },
    __mockVerify: mockVerify,
  };
});

jest.mock('../prismaClient', () => ({
  prisma: {
    user: {
      findUnique: jest.fn(),
    },
  },
}));

jest.mock('../src/db', () => ({
  poolGet: jest.fn(),
}));

jest.mock('../src/multisigner-verifier', () => ({
  verifyMultiSignerThreshold: jest.fn(),
}));

jest.mock('../src/utils', () => {
  const actual = jest.requireActual('../src/utils');
  return {
    ...actual,
    shouldFallbackToLocalRegistry: jest.fn().mockReturnValue(false),
  };
});

const { prisma } = require('../prismaClient');
const { poolGet } = require('../src/db');
const { verifyMultiSignerThreshold } = require('../src/multisigner-verifier');
const sdk = require('@stellar/stellar-sdk');
const {
  authenticateUsernameOwner,
  verifyFreighterSignedMessage,
  getCachedAccountSigners,
  setSignerRedisClient,
  clearSignerCache,
  SIGNER_CACHE_TTL_MS,
  SIGNER_CACHE_KEY_PREFIX,
} = require('../src/services/ownershipService');

const crypto = require('crypto');

const VALID_ADDRESS = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const OTHER_ADDRESS = 'GAPUQZH3WZUXHEMUGZN5ZYU4D4GHCFEMOGUINU6MF345GBD2QXNYYIEQ';

const hashMessage = (message) => {
  const prefix = Buffer.from('Stellar Signed Message:\n', 'utf8');
  const payload = Buffer.concat([prefix, Buffer.from(message, 'utf8')]);
  return crypto.createHash('sha256').update(payload).digest();
};

const BASE64_SIGNATURE = Buffer.alloc(64, 7).toString('base64');

describe('verifyFreighterSignedMessage', () => {
  beforeEach(() => {
    sdk.__mockVerify.mockReset();
    sdk.__mockVerify.mockReturnValue(true);
  });

  it('accepts a valid signed message from the registered account', () => {
    const message = 'webhook:alice';

    const result = verifyFreighterSignedMessage({
      message,
      signature: BASE64_SIGNATURE,
      publicKey: VALID_ADDRESS,
    });

    expect(result).toBe(VALID_ADDRESS);
    expect(sdk.__mockVerify).toHaveBeenCalledTimes(1);
    // The verified payload must be the sha256 hash of the prefixed message.
    const [messageHash, signatureBuffer] = sdk.__mockVerify.mock.calls[0];
    expect(messageHash).toEqual(hashMessage(message));
    expect(Buffer.isBuffer(signatureBuffer)).toBe(true);
  });

  it('accepts a Buffer signature directly', () => {
    const result = verifyFreighterSignedMessage({
      message: 'webhook:alice',
      signature: Buffer.alloc(64, 1),
      publicKey: VALID_ADDRESS,
    });

    expect(result).toBe(VALID_ADDRESS);
    expect(sdk.__mockVerify).toHaveBeenCalledTimes(1);
  });

  it('rejects an invalid signer address format', () => {
    expect(() =>
      verifyFreighterSignedMessage({
        message: 'webhook:alice',
        signature: BASE64_SIGNATURE,
        publicKey: 'not-a-valid-address',
      }),
    ).toThrow(/Invalid signer address format/);
  });

  it('rejects a signature in an unsupported format', () => {
    expect(() =>
      verifyFreighterSignedMessage({
        message: 'webhook:alice',
        signature: 12345,
        publicKey: VALID_ADDRESS,
      }),
    ).toThrow(/Invalid message signature format/);
  });

  it('rejects a signature that does not verify', () => {
    sdk.__mockVerify.mockReturnValue(false);

    expect(() =>
      verifyFreighterSignedMessage({
        message: 'webhook:alice',
        signature: BASE64_SIGNATURE,
        publicKey: VALID_ADDRESS,
      }),
    ).toThrow(/Signature verification failed/);
  });

  it('rejects a valid signature from a different signer address', () => {
    expect(() =>
      verifyFreighterSignedMessage({
        message: 'webhook:alice',
        signature: BASE64_SIGNATURE,
        signerAddress: OTHER_ADDRESS,
        publicKey: VALID_ADDRESS,
      }),
    ).toThrow(/Signer address does not match the registered account/);
  });
});

describe('authenticateUsernameOwner', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearSignerCache();
    setSignerRedisClient(null);
    sdk.__mockVerify.mockReturnValue(true);
    prisma.user.findUnique.mockResolvedValue({
      username: 'alice',
      address: VALID_ADDRESS,
    });
  });

  it('returns the user record after verifying a Freighter signature', async () => {
    const result = await authenticateUsernameOwner({
      username: 'alice',
      signature: BASE64_SIGNATURE,
      publicKey: VALID_ADDRESS,
    });

    expect(result.username).toBe('alice');
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { username: 'alice*localhost' },
      select: { username: true, address: true },
    });
  });

  it('uses the multi-signer path when the signature is a Stellar address', async () => {
    verifyMultiSignerThreshold.mockResolvedValue({ success: true });

    const result = await authenticateUsernameOwner({
      username: 'alice',
      signature: OTHER_ADDRESS,
    });

    expect(result.username).toBe('alice');
    expect(verifyMultiSignerThreshold).toHaveBeenCalledWith(
      VALID_ADDRESS,
      [OTHER_ADDRESS],
      { operationType: 'management' },
    );
  });

  it('rejects a failed multi-signer verification', async () => {
    verifyMultiSignerThreshold.mockResolvedValue({
      success: false,
      errorMessage: 'Not enough signers',
    });

    await expect(
      authenticateUsernameOwner({ username: 'alice', signature: OTHER_ADDRESS }),
    ).rejects.toMatchObject({ message: 'Not enough signers', statusCode: 401 });
  });

  it('rejects a missing username', async () => {
    await expect(
      authenticateUsernameOwner({ username: '', signature: 'x' }),
    ).rejects.toMatchObject({ message: 'Missing required field: username.', statusCode: 400 });
  });

  it('rejects a missing signature', async () => {
    await expect(
      authenticateUsernameOwner({ username: 'alice', signature: '' }),
    ).rejects.toMatchObject({ message: 'Missing required field: signature.', statusCode: 400 });
  });

  it('rejects an unregistered username', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    await expect(
      authenticateUsernameOwner({ username: 'ghost', signature: 'x' }),
    ).rejects.toMatchObject({ message: 'Username not registered.', statusCode: 404 });
  });

  it('falls back to the local registry when the primary lookup fails', async () => {
    prisma.user.findUnique.mockRejectedValue(new Error('db unavailable'));
    const { shouldFallbackToLocalRegistry } = require('../src/utils');
    shouldFallbackToLocalRegistry.mockReturnValue(true);
    poolGet.mockResolvedValue({ username: 'alice', address: VALID_ADDRESS });

    const result = await authenticateUsernameOwner({
      username: 'alice',
      signature: BASE64_SIGNATURE,
    });

    expect(result.username).toBe('alice');
    expect(poolGet).toHaveBeenCalledWith(
      'SELECT username, address FROM username_registry WHERE username = $1 LIMIT 1',
      ['alice*localhost'],
    );
  });

  // ── Multi-sig array path (2-of-3 and similar threshold scenarios) ─────

  it('accepts an array of two signer addresses for a 2-of-3 multi-sig account', async () => {
    verifyMultiSignerThreshold.mockResolvedValue({ success: true });

    // Two valid co-signer addresses supplied together.
    const SIGNER_1 = 'GBPUQZH3WZUXHEMUGZN5ZYU4D4GHCFEMOGUINU6MF345GBD2QXNYYIEQ';
    const SIGNER_2 = 'GCPUQZH3WZUXHEMUGZN5ZYU4D4GHCFEMOGUINU6MF345GBD2QXNYYIEQ';

    const result = await authenticateUsernameOwner({
      username: 'alice',
      signature: [SIGNER_1, SIGNER_2],
    });

    expect(result.username).toBe('alice');
    expect(verifyMultiSignerThreshold).toHaveBeenCalledWith(
      VALID_ADDRESS,
      [SIGNER_1, SIGNER_2],
      { operationType: 'management' },
    );
  });

  it('rejects when multi-sig array verification fails threshold check', async () => {
    verifyMultiSignerThreshold.mockResolvedValue({
      success: false,
      errorMessage: 'Insufficient signing weight. Required: 2, Provided: 1',
    });

    const SIGNER_1 = 'GBPUQZH3WZUXHEMUGZN5ZYU4D4GHCFEMOGUINU6MF345GBD2QXNYYIEQ';

    await expect(
      authenticateUsernameOwner({
        username: 'alice',
        signature: [SIGNER_1],
      }),
    ).rejects.toMatchObject({
      message: 'Insufficient signing weight. Required: 2, Provided: 1',
      statusCode: 401,
    });
  });

  it('rejects an empty signer array', async () => {
    await expect(
      authenticateUsernameOwner({ username: 'alice', signature: [] }),
    ).rejects.toMatchObject({ message: 'Missing required field: signature.', statusCode: 400 });
  });

  it('routes single-signer accounts through the Freighter path, not multi-sig', async () => {
    // A base64 signature (not an address) should never call verifyMultiSignerThreshold.
    const result = await authenticateUsernameOwner({
      username: 'alice',
      signature: BASE64_SIGNATURE,
      publicKey: VALID_ADDRESS,
    });

    expect(result.username).toBe('alice');
    expect(verifyMultiSignerThreshold).not.toHaveBeenCalled();
    expect(sdk.__mockVerify).toHaveBeenCalledTimes(1);
  });
});

describe('centralized ownership enforcement (#383)', () => {
  const {
    buildRequestPrincipal,
    assertPrincipalOwnsUsername,
    assertPrincipalOwnsAddress,
    assertPrincipalOwnsResource,
    isPublicFederationRead,
  } = require('../src/services/ownershipService');

  const principalFor = (address = VALID_ADDRESS, username = 'alice') =>
    buildRequestPrincipal({ address, username });

  beforeEach(() => {
    jest.clearAllMocks();
    clearSignerCache();
    setSignerRedisClient(null);
    prisma.user.findUnique.mockResolvedValue({
      username: 'alice',
      address: VALID_ADDRESS,
    });
  });

  it('builds a typed principal from the authenticated session only', () => {
    const principal = principalFor();

    expect(principal).toMatchObject({
      address: VALID_ADDRESS,
      username: 'alice',
      authenticated: true,
    });
    expect(Object.isFrozen(principal)).toBe(true);
  });

  it('rejects a principal built without an authenticated address', () => {
    expect(() => buildRequestPrincipal({ username: 'alice' })).toThrow(
      /authenticated address/i,
    );
  });

  it('rejects a caller-supplied username in the body that differs from the principal', () => {
    const principal = principalFor();

    expect(() =>
      assertPrincipalOwnsUsername(principal, { username: 'mallory' }),
    ).toThrow(/does not own/i);
  });

  it('rejects a caller-supplied address in the query that differs from the principal', () => {
    const principal = principalFor();

    expect(() =>
      assertPrincipalOwnsAddress(principal, { address: OTHER_ADDRESS }),
    ).toThrow(/does not own/i);
  });

  it('allows the request when the supplied username matches the principal', () => {
    const principal = principalFor();

    expect(() =>
      assertPrincipalOwnsUsername(principal, { username: 'alice' }),
    ).not.toThrow();
  });

  it('denies cross-user access to another account resource', async () => {
    const principal = principalFor();

    await expect(
      assertPrincipalOwnsResource(principal, {
        resourceType: 'username',
        resourceId: 'bob',
        loadOwner: async () => ({ username: 'bob', address: OTHER_ADDRESS }),
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('allows access when the resource owner matches the principal', async () => {
    const principal = principalFor();

    await expect(
      assertPrincipalOwnsResource(principal, {
        resourceType: 'username',
        resourceId: 'alice',
        loadOwner: async () => ({ username: 'alice', address: VALID_ADDRESS }),
      }),
    ).resolves.toBe(true);
  });

  it('denies access when the resource does not exist', async () => {
    const principal = principalFor();

    await expect(
      assertPrincipalOwnsResource(principal, {
        resourceType: 'username',
        resourceId: 'ghost',
        loadOwner: async () => null,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('still allows public federation reads without a principal', () => {
    expect(
      isPublicFederationRead({ method: 'GET', path: '/federation' }),
    ).toBe(true);
    expect(
      isPublicFederationRead({ method: 'GET', path: '/.well-known/stellar.toml' }),
    ).toBe(true);
  });

  it('does not treat mutating federation routes as public reads', () => {
    expect(
      isPublicFederationRead({ method: 'POST', path: '/federation' }),
    ).toBe(false);
    expect(
      isPublicFederationRead({ method: 'GET', path: '/webhooks' }),
    ).toBe(false);
  });

  it('enforces ownership at the service layer even when routes are bypassed', async () => {
    prisma.user.findUnique.mockResolvedValue({
      username: 'bob',
      address: OTHER_ADDRESS,
    });

    await expect(
      authenticateUsernameOwner({
        username: 'bob',
        signature: BASE64_SIGNATURE,
        publicKey: VALID_ADDRESS,
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('rejects a spoofed publicKey that does not match the registered account', async () => {
    await expect(
      authenticateUsernameOwner({
        username: 'alice',
        signature: BASE64_SIGNATURE,
        publicKey: OTHER_ADDRESS,
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('Horizon signer list cache (#281)', () => {
  const SAMPLE_SIGNERS = {
    accountId: VALID_ADDRESS,
    signers: [{ key: OTHER_ADDRESS, weight: 2, signer_type: 'ed25519_public_key' }],
    thresholds: { low_threshold: 1, med_threshold: 2, high_threshold: 2 },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    clearSignerCache();
    setSignerRedisClient(null);
    prisma.user.findUnique.mockResolvedValue({
      username: 'alice',
      address: VALID_ADDRESS,
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('defaults SIGNER_CACHE_TTL_MS to 60 seconds (60000 ms)', () => {
    expect(SIGNER_CACHE_TTL_MS).toBe(60000);
  });

  it('uses cached signers on the second ownership check for the same address (cache hit & miss)', async () => {
    const mockRedis = {
      isReady: true,
      get: jest.fn().mockResolvedValue(null),
      pSetEx: jest.fn().mockResolvedValue('OK'),
    };
    verifyMultiSignerThreshold.mockResolvedValue({
      success: true,
      signers: SAMPLE_SIGNERS.signers,
      thresholds: SAMPLE_SIGNERS.thresholds,
    });

    // First call: cache miss -> fetches from Horizon via verifyMultiSignerThreshold & writes to Redis
    const first = await authenticateUsernameOwner({
      username: 'alice',
      signature: OTHER_ADDRESS,
      redisClient: mockRedis,
    });
    expect(first.username).toBe('alice');
    expect(verifyMultiSignerThreshold).toHaveBeenCalledTimes(1);
    expect(mockRedis.pSetEx).toHaveBeenCalledWith(
      `${SIGNER_CACHE_KEY_PREFIX}${VALID_ADDRESS}`,
      SIGNER_CACHE_TTL_MS,
      expect.any(String),
    );

    // Second call for the same address: cache hit -> does not invoke verifyMultiSignerThreshold again
    const second = await authenticateUsernameOwner({
      username: 'alice',
      signature: OTHER_ADDRESS,
      redisClient: mockRedis,
    });
    expect(second.username).toBe('alice');
    expect(verifyMultiSignerThreshold).toHaveBeenCalledTimes(1);
  });

  it('serves cached signers directly from Redis when in-memory cache is cold', async () => {
    const mockRedis = {
      isReady: true,
      get: jest.fn().mockResolvedValue(JSON.stringify(SAMPLE_SIGNERS)),
      pSetEx: jest.fn(),
    };

    const result = await authenticateUsernameOwner({
      username: 'alice',
      signature: OTHER_ADDRESS,
      redisClient: mockRedis,
    });

    expect(result.username).toBe('alice');
    expect(mockRedis.get).toHaveBeenCalledWith(`${SIGNER_CACHE_KEY_PREFIX}${VALID_ADDRESS}`);
    expect(verifyMultiSignerThreshold).not.toHaveBeenCalled();
  });

  it('expires the cached signer list after SIGNER_CACHE_TTL_MS', async () => {
    let now = 1_700_000_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);

    const fetchFn = jest.fn().mockResolvedValue(SAMPLE_SIGNERS);

    // 1. Miss at t=0
    const first = await getCachedAccountSigners(VALID_ADDRESS, { fetchFn, ttlMs: 60_000 });
    expect(first).toEqual(SAMPLE_SIGNERS);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    // 2. Hit before TTL expires (t + 59,999ms)
    now += 59_999;
    const second = await getCachedAccountSigners(VALID_ADDRESS, { fetchFn, ttlMs: 60_000 });
    expect(second).toEqual(SAMPLE_SIGNERS);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    // 3. Expired at t + 60,000ms -> fetches from Horizon again
    now += 1;
    const third = await getCachedAccountSigners(VALID_ADDRESS, { fetchFn, ttlMs: 60_000 });
    expect(third).toEqual(SAMPLE_SIGNERS);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('falls through to Horizon without throwing 503 when Redis is unavailable', async () => {
    const failingRedis = {
      isReady: true,
      get: jest.fn().mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:6379')),
      pSetEx: jest.fn().mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:6379')),
    };
    verifyMultiSignerThreshold.mockResolvedValue({ success: true });

    const result = await authenticateUsernameOwner({
      username: 'alice',
      signature: OTHER_ADDRESS,
      redisClient: failingRedis,
    });

    expect(result.username).toBe('alice');
    expect(failingRedis.get).toHaveBeenCalledWith(`${SIGNER_CACHE_KEY_PREFIX}${VALID_ADDRESS}`);
    expect(verifyMultiSignerThreshold).toHaveBeenCalledTimes(1);
  });
});
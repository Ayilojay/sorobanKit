'use strict';

/**
 * Unit tests for src/services/registrationService.js — transferAccount.
 */

jest.mock('@stellar/stellar-sdk', () => ({
  StrKey: {
    isValidEd25519PublicKey: (value) =>
      typeof value === 'string' && value.startsWith('G') && value.length === 56,
  },
}));

jest.mock('../prismaClient', () => ({
  prisma: {
    user: {
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      findFirst: jest.fn(),
    },
    $transaction: jest.fn(),
  },
}));

jest.mock('../src/multisigner-verifier', () => ({
  verifyMultiSignerThreshold: jest.fn(),
}));

jest.mock('../src/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const { prisma } = require('../prismaClient');
const { verifyMultiSignerThreshold } = require('../src/multisigner-verifier');
const {
  transferAccount,
  removeAlias,
  assignPrimaryUsername,
} = require('../src/services/registrationService');

const VALID_NEW_ADDRESS = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

describe('transferAccount', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    verifyMultiSignerThreshold.mockResolvedValue({ success: true });
    prisma.user.findUnique.mockResolvedValue({
      username: 'alice',
      address: 'GAPUQZH3WZUXHEMUGZN5ZYU4D4GHCFEMOGUINU6MF345GBD2QXNYYIEQ',
    });
    prisma.user.update.mockResolvedValue({ username: 'alice', address: VALID_NEW_ADDRESS });
  });

  it('transfers a username to a new verified address', async () => {
    const updated = await transferAccount(
      'alice',
      'GAPUQZH3WZUXHEMUGZN5ZYU4D4GHCFEMOGUINU6MF345GBD2QXNYYIEQ',
      VALID_NEW_ADDRESS,
      'sig-old',
      'sig-new',
    );

    expect(updated.address).toBe(VALID_NEW_ADDRESS);
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { username: 'alice' },
      data: { address: VALID_NEW_ADDRESS },
    });
    expect(verifyMultiSignerThreshold).toHaveBeenCalledTimes(2);
  });

  it('rejects a missing username', async () => {
    await expect(
      transferAccount('', 'old', VALID_NEW_ADDRESS, 's1', 's2'),
    ).rejects.toMatchObject({ message: 'Username is required', statusCode: 400 });
  });

  it('rejects missing addresses', async () => {
    await expect(
      transferAccount('alice', null, VALID_NEW_ADDRESS, 's1', 's2'),
    ).rejects.toMatchObject({
      message: 'Both oldAddress and newAddress are required',
      statusCode: 400,
    });
  });

  it('rejects an invalid new Stellar address', async () => {
    await expect(
      transferAccount('alice', 'old', 'not-valid', 's1', 's2'),
    ).rejects.toMatchObject({
      message: 'Invalid Stellar Public Key format for new address',
      statusCode: 400,
    });
  });

  it('rejects missing signatures', async () => {
    await expect(
      transferAccount('alice', 'old', VALID_NEW_ADDRESS, '', 's2'),
    ).rejects.toMatchObject({
      message: 'Signatures from both old and new addresses are required',
      statusCode: 400,
    });
  });

  it('rejects an unknown user with 404', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    await expect(
      transferAccount('ghost', 'old', VALID_NEW_ADDRESS, 's1', 's2'),
    ).rejects.toMatchObject({ message: 'User not found', statusCode: 404 });
  });

  it('rejects an address that does not match the current record', async () => {
    await expect(
      transferAccount('alice', 'GDIFFERENTADDRESS', VALID_NEW_ADDRESS, 's1', 's2'),
    ).rejects.toMatchObject({
      message: 'Old address does not match current record',
      statusCode: 400,
    });
  });

  it('rejects a failed old-address signature verification', async () => {
    verifyMultiSignerThreshold.mockResolvedValue({
      success: false,
      errorMessage: 'Old signature invalid',
    });
    await expect(
      transferAccount('alice', 'GAPUQZH3WZUXHEMUGZN5ZYU4D4GHCFEMOGUINU6MF345GBD2QXNYYIEQ', VALID_NEW_ADDRESS, 's1', 's2'),
    ).rejects.toMatchObject({ message: 'Old signature invalid', statusCode: 401 });
  });

  it('rejects a failed new-address signature verification', async () => {
    verifyMultiSignerThreshold
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false, errorMessage: 'New signature invalid' });
    await expect(
      transferAccount('alice', 'GAPUQZH3WZUXHEMUGZN5ZYU4D4GHCFEMOGUINU6MF345GBD2QXNYYIEQ', VALID_NEW_ADDRESS, 's1', 's2'),
    ).rejects.toMatchObject({ message: 'New signature invalid', statusCode: 401 });
  });

  // ── Username normalisation ────────────────────────────────────────────────────

  it('normalises a mixed-case username to lowercase before the DB lookup', async () => {
    await transferAccount(
      'Alice',
      'GAPUQZH3WZUXHEMUGZN5ZYU4D4GHCFEMOGUINU6MF345GBD2QXNYYIEQ',
      VALID_NEW_ADDRESS,
      'sig-old',
      'sig-new',
    );

    expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { username: 'alice' } });
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { username: 'alice' } }),
    );
  });

  it('normalises an ALL-CAPS username to lowercase before the DB lookup', async () => {
    await transferAccount(
      'ALICE',
      'GAPUQZH3WZUXHEMUGZN5ZYU4D4GHCFEMOGUINU6MF345GBD2QXNYYIEQ',
      VALID_NEW_ADDRESS,
      'sig-old',
      'sig-new',
    );

    expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { username: 'alice' } });
  });
});

// ── Primary-username invariant ────────────────────────────────────────────────

/**
 * Builds a fake `withTransaction` that runs the callback against a supplied
 * transactional client, mirroring the real helper's contract.
 */
function makeWithTransaction(txClient) {
  return jest.fn(async (fn) => fn(txClient));
}

describe('removeAlias', () => {
  let tx;

  beforeEach(() => {
    jest.clearAllMocks();
    tx = {
      user: {
        findUnique: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
        findFirst: jest.fn(),
      },
    };
  });

  it('clears isPrimary when the removed row is the primary username', async () => {
    tx.user.findUnique.mockResolvedValue({
      id: 'row-1',
      username: 'alice',
      address: VALID_NEW_ADDRESS,
      isPrimary: true,
    });
    tx.user.update.mockResolvedValue({ id: 'row-1', isPrimary: false });

    const withTransaction = makeWithTransaction(tx);
    await removeAlias('alice', VALID_NEW_ADDRESS, { withTransaction });

    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: 'row-1' },
      data: { isPrimary: false },
    });
    expect(withTransaction).toHaveBeenCalledTimes(1);
  });

  it('leaves isPrimary untouched when the removed row is not primary', async () => {
    tx.user.findUnique.mockResolvedValue({
      id: 'row-2',
      username: 'alice',
      address: VALID_NEW_ADDRESS,
      isPrimary: false,
    });

    const withTransaction = makeWithTransaction(tx);
    await removeAlias('alice', VALID_NEW_ADDRESS, { withTransaction });

    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it('rejects an unknown alias with 404', async () => {
    tx.user.findUnique.mockResolvedValue(null);

    const withTransaction = makeWithTransaction(tx);
    await expect(
      removeAlias('ghost', VALID_NEW_ADDRESS, { withTransaction }),
    ).rejects.toMatchObject({ message: 'Alias not found', statusCode: 404 });
  });
});

describe('assignPrimaryUsername', () => {
  let tx;

  beforeEach(() => {
    jest.clearAllMocks();
    tx = {
      user: {
        findUnique: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
        findFirst: jest.fn(),
      },
    };
  });

  it('succeeds when no primary exists for the address', async () => {
    tx.user.findFirst.mockResolvedValue(null);
    tx.user.update.mockResolvedValue({ id: 'row-1', isPrimary: true });

    const withTransaction = makeWithTransaction(tx);
    const result = await assignPrimaryUsername('alice', VALID_NEW_ADDRESS, {
      withTransaction,
    });

    expect(result).toEqual({ id: 'row-1', isPrimary: true });
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { username_address: { username: 'alice', address: VALID_NEW_ADDRESS } },
      data: { isPrimary: true },
    });
  });

  it('throws a 409 CONFLICT when a concurrent primary already exists (P2002)', async () => {
    tx.user.findFirst.mockResolvedValue(null);
    const p2002 = Object.assign(new Error('Unique constraint failed'), {
      code: 'P2002',
    });
    tx.user.update.mockRejectedValue(p2002);

    const withTransaction = makeWithTransaction(tx);
    await expect(
      assignPrimaryUsername('alice', VALID_NEW_ADDRESS, { withTransaction }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'CONFLICT',
    });
  });

  it('rolls back the transaction when the update fails', async () => {
    tx.user.findFirst.mockResolvedValue(null);
    tx.user.update.mockRejectedValue(new Error('boom'));

    // Simulate a transactional helper that rolls back on error.
    const withTransaction = jest.fn(async (fn) => {
      try {
        return await fn(tx);
      } catch (err) {
        tx.rolledBack = true;
        throw err;
      }
    });

    await expect(
      assignPrimaryUsername('alice', VALID_NEW_ADDRESS, { withTransaction }),
    ).rejects.toThrow('boom');

    expect(tx.rolledBack).toBe(true);
    expect(withTransaction).toHaveBeenCalledTimes(1);
  });
});
'use strict';

jest.mock('dotenv', () => ({ config: jest.fn() }));

jest.mock('@stellar/stellar-sdk', () => {
  const mockCallFn = jest.fn();
  const mockPaymentsForTransaction = jest.fn().mockReturnValue({ call: mockCallFn });
  const mockPayments = jest.fn().mockReturnValue({
    forAccount: jest.fn().mockReturnValue({
      order: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      cursor: jest.fn().mockReturnThis(),
      call: mockCallFn,
    }),
    forTransaction: mockPaymentsForTransaction,
  });
  const mockTransactionCall = jest.fn();
  const mockTransactions = jest.fn().mockReturnValue({
    transaction: jest.fn().mockReturnValue({ call: mockTransactionCall }),
  });
  const mockLedgersCall = jest.fn();
  const mockLedgers = jest.fn().mockReturnValue({ latest: jest.fn().mockReturnValue({ call: mockLedgersCall }) });

  const mockServerInstance = {
    loadAccount: jest.fn(),
    payments: mockPayments,
    transactions: mockTransactions,
    ledgers: mockLedgers,
  };

  const Horizon = {
    Server: jest.fn().mockReturnValue(mockServerInstance),
  };

  return {
    Horizon,
    __mockServer: mockServerInstance,
    __mockCallFn: mockCallFn,
    __mockTransactionCall: mockTransactionCall,
    __mockLedgersCall: mockLedgersCall,
  };
});

jest.mock('../src/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  httpLogger: (req, res, next) => next(),
}));

const { __mockServer, __mockCallFn, __mockTransactionCall } = require('@stellar/stellar-sdk');
const {
  loadAccount,
  fetchTransaction,
  fetchPaymentsForTransaction,
  fetchPaymentsForAccount,
  fetchFirstPaymentsPage,
  wrapPageWithBreaker,
  createBreaker,
  HORIZON_BASE,
  BREAKER_THRESHOLD,
  resolveNetworkIdentity,
  DEFAULT_NETWORK,
  buildTransactionIdentity,
  upsertLedgerTransaction,
} = require('../src/services/stellarService');

describe('StellarService — Circuit Breaker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('configuration', () => {
    it('exports HORIZON_BASE from env or default', () => {
      expect(typeof HORIZON_BASE).toBe('string');
      expect(HORIZON_BASE).toMatch(/^https?:\/\//);
    });

    it('exports BREAKER_THRESHOLD as a number', () => {
      expect(typeof BREAKER_THRESHOLD).toBe('number');
      expect(BREAKER_THRESHOLD).toBeGreaterThan(0);
    });
  });

  describe('createBreaker', () => {
    it('creates a circuit breaker that passes through results', async () => {
      const fn = jest.fn().mockResolvedValue('ok');
      const breaker = createBreaker(fn, {
        timeout: 1000,
        volumeThreshold: 1,
        errorThresholdPercentage: 1,
        resetTimeout: 1000,
      });

      const result = await breaker.fire();
      expect(result).toBe('ok');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('trips open after configured volume threshold failures', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('fail'));
      const breaker = createBreaker(fn, {
        timeout: 1000,
        volumeThreshold: 2,
        errorThresholdPercentage: 1,
        resetTimeout: 60000,
      });

      for (let i = 0; i < 2; i++) {
        try { await breaker.fire(); } catch (_e) { /* trip breaker */ }
      }

      expect(breaker.opened).toBe(true);

      const callsBefore = fn.mock.calls.length;
      await expect(breaker.fire()).rejects.toThrow();
      expect(fn.mock.calls.length).toBe(callsBefore);
    });

    it('wraps errors as CircuitBreakerOpenError when open', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('fail'));
      const breaker = createBreaker(fn, {
        timeout: 1000,
        volumeThreshold: 2,
        errorThresholdPercentage: 1,
        resetTimeout: 60000,
      });

      for (let i = 0; i < 2; i++) {
        try { await breaker.fire(); } catch (_e) { /* trip breaker */ }
      }

      try {
        await breaker.fire();
        throw new Error('Expected error to be thrown');
      } catch (err) {
        expect(err.code).toBe('EOPENBREAKER');
      }
    });

    it('recovers after resetTimeout', async () => {
      const fn = jest.fn()
        .mockRejectedValueOnce(new Error('fail'))
        .mockRejectedValueOnce(new Error('fail'))
        .mockResolvedValueOnce('recovered');

      const breaker = createBreaker(fn, {
        timeout: 1000,
        volumeThreshold: 2,
        errorThresholdPercentage: 1,
        resetTimeout: 50, // very short for testing
      });

      for (let i = 0; i < 2; i++) {
        try { await breaker.fire(); } catch (_e) { /* trip breaker */ }
      }
      expect(breaker.opened).toBe(true);

      // Wait for reset timeout to allow halfOpen
      await new Promise((r) => setTimeout(r, 100));

      const result = await breaker.fire();
      expect(result).toBe('recovered');
      expect(breaker.opened).toBe(false);
    });
  });

  describe('loadAccount', () => {
    it('returns account from Horizon via circuit breaker', async () => {
      const mockAccount = { id: 'GABC', signers: [], thresholds: {}, sequence: '1', balances: [] };
      __mockServer.loadAccount.mockResolvedValue(mockAccount);

      const result = await loadAccount('GABC');

      expect(__mockServer.loadAccount).toHaveBeenCalledWith('GABC');
      expect(result).toEqual(mockAccount);
    });

    it('propagates Horizon errors when circuit is closed', async () => {
      const error = new Error('Not found');
      error.response = { status: 404 };
      __mockServer.loadAccount.mockRejectedValue(error);

      await expect(loadAccount('GABC')).rejects.toThrow('Not found');
    });

    it('throws CircuitBreakerOpenError when circuit is open', async () => {
      __mockServer.loadAccount.mockRejectedValue(new Error('ECONNREFUSED'));

      // Trip the breaker
      for (let i = 0; i < 6; i++) {
        try { await loadAccount('GABC'); } catch (_e) { /* trip breaker */ }
      }

      try {
        await loadAccount('GABC');
        throw new Error('Expected error to be thrown');
      } catch (err) {
        expect(err.code).toBe('EOPENBREAKER');
      }
    });
  });

  describe('fetchTransaction', () => {
    it('returns transaction via circuit breaker', async () => {
      const mockTx = { hash: 'abc123', created_at: '2024-01-01T00:00:00Z' };
      __mockTransactionCall.mockResolvedValue(mockTx);

      const result = await fetchTransaction('abc123');
      expect(result).toEqual(mockTx);
    });

    it('propagates Horizon errors when circuit is closed', async () => {
      __mockTransactionCall.mockRejectedValue(new Error('timeout'));

      await expect(fetchTransaction('abc123')).rejects.toThrow('timeout');
    });
  });

  describe('fetchPaymentsForTransaction', () => {
    it('returns payments via circuit breaker', async () => {
      const mockPayments = { records: [{ id: 1 }] };
      __mockCallFn.mockResolvedValue(mockPayments);

      const result = await fetchPaymentsForTransaction('abc123');
      expect(result).toEqual(mockPayments);
    });
  });

  describe('fetchPaymentsForAccount', () => {
    it('returns paginated payments via circuit breaker', async () => {
      const mockPage = { _embedded: { records: [] }, _links: {} };
      __mockCallFn.mockResolvedValue(mockPage);

      const result = await fetchPaymentsForAccount({
        address: 'GABC',
        limit: 10,
        cursor: 'now',
        order: 'desc',
      });

      expect(result).toEqual(mockPage);
    });
  });

  describe('fetchFirstPaymentsPage', () => {
    it('returns a page with circuit-breaker-protected next()', async () => {
      const mockNextFn = jest.fn().mockResolvedValue({ records: [] });
      const mockPage = { records: [{ id: 1 }], next: mockNextFn };
      __mockCallFn.mockResolvedValue(mockPage);

      const result = await fetchFirstPaymentsPage({
        address: 'GABC',
        order: 'desc',
        pageSize: 200,
      });

      expect(result.records).toEqual([{ id: 1 }]);
      expect(typeof result.next).toBe('function');

      const nextPage = await result.next();
      expect(nextPage).toEqual({ records: [] });
    });
  });

  describe('wrapPageWithBreaker', () => {
    it('wraps page.next() with circuit breaker', async () => {
      const mockNext = jest.fn().mockResolvedValue({ records: [2] });
      const page = { records: [1], next: mockNext };

      const wrapped = wrapPageWithBreaker(page);

      expect(wrapped.records).toEqual([1]);
      expect(typeof wrapped.next).toBe('function');

      const result = await wrapped.next();
      expect(result).toEqual({ records: [2] });
      expect(mockNext).toHaveBeenCalled();
    });

    it('returns page as-is if no next() function', () => {
      const page = { records: [1] };
      const wrapped = wrapPageWithBreaker(page);
      expect(wrapped).toBe(page);
    });

    it('returns falsy values as-is', () => {
      expect(wrapPageWithBreaker(null)).toBeNull();
      expect(wrapPageWithBreaker(undefined)).toBeUndefined();
    });

    it('fast-fails with CircuitBreakerOpenError when circuit is open', async () => {
      const mockNext = jest.fn().mockRejectedValue(new Error('timeout'));
      const page = { records: [1], next: mockNext };

      const wrapped = wrapPageWithBreaker(page);

      // Trip the breaker
      for (let i = 0; i < 6; i++) {
        try { await wrapped.next(); } catch (_e) { /* trip breaker */ }
      }

      try {
        await wrapped.next();
        throw new Error('Expected error to be thrown');
      } catch (err) {
        expect(err.code).toBe('EOPENBREAKER');
      }
    });
  });
});

describe('StellarService — network-aware transaction identity', () => {
  const HASH = 'a'.repeat(64);

  /**
   * Minimal in-memory stand-in for the ledger_transactions table with the
   * composite UNIQUE (network, transaction_hash) constraint applied.
   */
  function createLedgerStore() {
    const rows = [];
    return {
      rows,
      async insert({ network, transaction_hash, ledger }) {
        const duplicate = rows.some(
          (r) => r.network === network && r.transaction_hash === transaction_hash,
        );
        if (duplicate) {
          const err = new Error('duplicate key value violates unique constraint');
          err.code = '23505';
          throw err;
        }
        const row = { network, transaction_hash, ledger };
        rows.push(row);
        return row;
      },
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.STELLAR_NETWORK;
  });

  describe('resolveNetworkIdentity', () => {
    it('defaults to the public network when nothing is configured', () => {
      expect(DEFAULT_NETWORK).toBe('public');
      expect(resolveNetworkIdentity()).toBe('public');
    });

    it('honours an explicit network argument', () => {
      expect(resolveNetworkIdentity('testnet')).toBe('testnet');
      expect(resolveNetworkIdentity('futurenet')).toBe('futurenet');
    });

    it('falls back to STELLAR_NETWORK env when no argument is given', () => {
      process.env.STELLAR_NETWORK = 'testnet';
      expect(resolveNetworkIdentity()).toBe('testnet');
    });

    it('normalises case and whitespace', () => {
      expect(resolveNetworkIdentity('  TESTNET ')).toBe('testnet');
    });

    it('rejects empty or non-string network values', () => {
      expect(() => resolveNetworkIdentity('')).toThrow();
      expect(() => resolveNetworkIdentity('   ')).toThrow();
      expect(() => resolveNetworkIdentity(42)).toThrow();
    });
  });

  describe('buildTransactionIdentity', () => {
    it('builds a composite identity from network and hash', () => {
      expect(buildTransactionIdentity({ network: 'testnet', hash: HASH })).toEqual({
        network: 'testnet',
        transaction_hash: HASH,
      });
    });

    it('applies the default network policy when network is omitted', () => {
      expect(buildTransactionIdentity({ hash: HASH })).toEqual({
        network: 'public',
        transaction_hash: HASH,
      });
    });

    it('rejects a missing or malformed hash', () => {
      expect(() => buildTransactionIdentity({ network: 'public' })).toThrow();
      expect(() => buildTransactionIdentity({ network: 'public', hash: 'short' })).toThrow();
    });
  });

  describe('unique (network, transaction_hash) constraint', () => {
    it('allows the same hash on two distinct networks', async () => {
      const store = createLedgerStore();

      await store.insert({ network: 'public', transaction_hash: HASH, ledger: 1 });
      await store.insert({ network: 'testnet', transaction_hash: HASH, ledger: 1 });

      expect(store.rows).toHaveLength(2);
      expect(store.rows.map((r) => r.network).sort()).toEqual(['public', 'testnet']);
    });

    it('rejects a duplicate (network, hash) pair', async () => {
      const store = createLedgerStore();

      await store.insert({ network: 'public', transaction_hash: HASH, ledger: 1 });

      await expect(
        store.insert({ network: 'public', transaction_hash: HASH, ledger: 2 }),
      ).rejects.toMatchObject({ code: '23505' });
      expect(store.rows).toHaveLength(1);
    });

    it('treats network comparison as exact (no implicit defaulting on insert)', async () => {
      const store = createLedgerStore();

      await store.insert({ network: 'public', transaction_hash: HASH, ledger: 1 });

      await expect(
        store.insert({ network: 'PUBLIC', transaction_hash: HASH, ledger: 2 }),
      ).resolves.toBeDefined();
    });
  });

  describe('backfill default network policy', () => {
    it('assigns the default network to pre-existing rows lacking one', () => {
      const legacyRows = [
        { transaction_hash: HASH, ledger: 1 },
        { transaction_hash: 'b'.repeat(64), ledger: 2 },
      ];

      const backfilled = legacyRows.map((row) => ({
        ...row,
        network: row.network || DEFAULT_NETWORK,
      }));

      expect(backfilled.every((r) => r.network === 'public')).toBe(true);
      expect(backfilled.map((r) => r.transaction_hash)).toEqual(
        legacyRows.map((r) => r.transaction_hash),
      );
    });

    it('preserves an existing network value during backfill', () => {
      const row = { transaction_hash: HASH, ledger: 1, network: 'testnet' };
      const backfilled = { ...row, network: row.network || DEFAULT_NETWORK };
      expect(backfilled.network).toBe('testnet');
    });
  });

  describe('upsertLedgerTransaction', () => {
    it('includes the network in the upsert payload', async () => {
      const store = createLedgerStore();
      const upsert = jest.fn((row) => store.insert(row));

      await upsertLedgerTransaction(
        { hash: HASH, ledger: 7, network: 'testnet' },
        { upsert },
      );

      expect(upsert).toHaveBeenCalledTimes(1);
      expect(upsert.mock.calls[0][0]).toMatchObject({
        network: 'testnet',
        transaction_hash: HASH,
      });
    });

    it('applies the default network when the caller omits it', async () => {
      const store = createLedgerStore();
      const upsert = jest.fn((row) => store.insert(row));

      await upsertLedgerTransaction({ hash: HASH, ledger: 7 }, { upsert });

      expect(upsert.mock.calls[0][0].network).toBe(DEFAULT_NETWORK);
    });

    it('is idempotent for a repeated upsert of the same (network, hash)', async () => {
      const store = createLedgerStore();
      const upsert = jest.fn((row) => store.insert(row));

      await upsertLedgerTransaction({ hash: HASH, ledger: 7, network: 'public' }, { upsert });
      await expect(
        upsertLedgerTransaction({ hash: HASH, ledger: 7, network: 'public' }, { upsert }),
      ).rejects.toMatchObject({ code: '23505' });
      expect(store.rows).toHaveLength(1);
    });

    it('handles concurrent upserts of the same hash on different networks', async () => {
      const store = createLedgerStore();
      const upsert = jest.fn((row) => store.insert(row));

      const results = await Promise.all([
        upsertLedgerTransaction({ hash: HASH, ledger: 1, network: 'public' }, { upsert }),
        upsertLedgerTransaction({ hash: HASH, ledger: 1, network: 'testnet' }, { upsert }),
      ]);

      expect(results).toHaveLength(2);
      expect(store.rows).toHaveLength(2);
      expect(store.rows.map((r) => r.network).sort()).toEqual(['public', 'testnet']);
    });

    it('rejects one of two concurrent upserts of the same (network, hash)', async () => {
      const store = createLedgerStore();
      const upsert = jest.fn((row) => store.insert(row));

      const settled = await Promise.allSettled([
        upsertLedgerTransaction({ hash: HASH, ledger: 1, network: 'public' }, { upsert }),
        upsertLedgerTransaction({ hash: HASH, ledger: 1, network: 'public' }, { upsert }),
      ]);

      const fulfilled = settled.filter((s) => s.status === 'fulfilled');
      const rejected = settled.filter((s) => s.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason.code).toBe('23505');
      expect(store.rows).toHaveLength(1);
    });
  });
});

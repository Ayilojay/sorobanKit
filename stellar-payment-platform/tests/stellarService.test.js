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
  observeSubmissionToFinality,
  getConfirmationLagSnapshot,
  resetConfirmationLagMetrics,
  CONFIRMATION_LAG_OBJECTIVE_MS,
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

  describe('ledger confirmation lag instrumentation', () => {
    beforeEach(() => {
      resetConfirmationLagMetrics();
    });

    it('exports a documented confirmation lag objective', () => {
      expect(typeof CONFIRMATION_LAG_OBJECTIVE_MS).toBe('number');
      expect(CONFIRMATION_LAG_OBJECTIVE_MS).toBeGreaterThan(0);
    });

    it('records submission-to-finality observations labeled by network and outcome', () => {
      observeSubmissionToFinality({
        network: 'testnet',
        outcome: 'success',
        submittedAt: 1000,
        finalizedAt: 3500,
      });

      const snapshot = getConfirmationLagSnapshot();
      const series = snapshot.series.find(
        (s) => s.network === 'testnet' && s.outcome === 'success'
      );

      expect(series).toBeDefined();
      expect(series.count).toBe(1);
      expect(series.lagMs).toBe(2500);
    });

    it('never includes user identifiers in metric labels', () => {
      observeSubmissionToFinality({
        network: 'testnet',
        outcome: 'success',
        submittedAt: 0,
        finalizedAt: 1000,
        account: 'GABCDEF1234567890',
        intentId: 'intent-42',
        txHash: 'deadbeef',
      });

      const snapshot = getConfirmationLagSnapshot();
      const serialized = JSON.stringify(snapshot);

      expect(serialized).not.toContain('GABCDEF1234567890');
      expect(serialized).not.toContain('intent-42');
      expect(serialized).not.toContain('deadbeef');

      for (const series of snapshot.series) {
        expect(Object.keys(series.labels).sort()).toEqual(['network', 'outcome']);
      }
    });

    it('aggregates percentiles across multiple observations', () => {
      const lags = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
      lags.forEach((lag, i) => {
        observeSubmissionToFinality({
          network: 'mainnet',
          outcome: 'success',
          submittedAt: i * 10000,
          finalizedAt: i * 10000 + lag,
        });
      });

      const snapshot = getConfirmationLagSnapshot();
      const series = snapshot.series.find(
        (s) => s.network === 'mainnet' && s.outcome === 'success'
      );

      expect(series.count).toBe(10);
      expect(series.p50).toBeGreaterThanOrEqual(500);
      expect(series.p50).toBeLessThanOrEqual(600);
      expect(series.p95).toBeGreaterThanOrEqual(900);
      expect(series.p95).toBeLessThanOrEqual(1000);
      expect(series.p99).toBeGreaterThanOrEqual(900);
    });

    it('tracks failures separately from successes', () => {
      observeSubmissionToFinality({
        network: 'testnet',
        outcome: 'success',
        submittedAt: 0,
        finalizedAt: 1000,
      });
      observeSubmissionToFinality({
        network: 'testnet',
        outcome: 'failure',
        submittedAt: 0,
        finalizedAt: 5000,
      });

      const snapshot = getConfirmationLagSnapshot();
      expect(snapshot.series).toHaveLength(2);
      expect(
        snapshot.series.find((s) => s.outcome === 'success').count
      ).toBe(1);
      expect(
        snapshot.series.find((s) => s.outcome === 'failure').count
      ).toBe(1);
    });

    it('flags breach when p95 exceeds the documented objective', () => {
      for (let i = 0; i < 20; i++) {
        observeSubmissionToFinality({
          network: 'mainnet',
          outcome: 'success',
          submittedAt: 0,
          finalizedAt: CONFIRMATION_LAG_OBJECTIVE_MS * 2,
        });
      }

      const snapshot = getConfirmationLagSnapshot();
      const series = snapshot.series.find(
        (s) => s.network === 'mainnet' && s.outcome === 'success'
      );

      expect(series.objectiveBreached).toBe(true);
    });

    it('does not flag breach when p95 is within the documented objective', () => {
      for (let i = 0; i < 20; i++) {
        observeSubmissionToFinality({
          network: 'mainnet',
          outcome: 'success',
          submittedAt: 0,
          finalizedAt: Math.floor(CONFIRMATION_LAG_OBJECTIVE_MS / 2),
        });
      }

      const snapshot = getConfirmationLagSnapshot();
      const series = snapshot.series.find(
        (s) => s.network === 'mainnet' && s.outcome === 'success'
      );

      expect(series.objectiveBreached).toBe(false);
    });

    it('ignores observations with missing or invalid timestamps', () => {
      observeSubmissionToFinality({
        network: 'testnet',
        outcome: 'success',
        submittedAt: undefined,
        finalizedAt: 1000,
      });
      observeSubmissionToFinality({
        network: 'testnet',
        outcome: 'success',
        submittedAt: 2000,
        finalizedAt: 1000,
      });

      const snapshot = getConfirmationLagSnapshot();
      expect(snapshot.series).toHaveLength(0);
    });

    it('resetConfirmationLagMetrics clears accumulated observations', () => {
      observeSubmissionToFinality({
        network: 'testnet',
        outcome: 'success',
        submittedAt: 0,
        finalizedAt: 1000,
      });
      expect(getConfirmationLagSnapshot().series).toHaveLength(1);

      resetConfirmationLagMetrics();
      expect(getConfirmationLagSnapshot().series).toHaveLength(0);
    });

    it('handles concurrent observations without losing counts', async () => {
      const observations = Array.from({ length: 50 }, (_, i) =>
        Promise.resolve().then(() =>
          observeSubmissionToFinality({
            network: 'testnet',
            outcome: 'success',
            submittedAt: i * 1000,
            finalizedAt: i * 1000 + 500,
          })
        )
      );

      await Promise.all(observations);

      const snapshot = getConfirmationLagSnapshot();
      const series = snapshot.series.find(
        (s) => s.network === 'testnet' && s.outcome === 'success'
      );
      expect(series.count).toBe(50);
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

describe('StellarService — fault injection (Horizon outages)', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    // Restore any global fetch we may have stubbed so no test leaks network access.
    if (originalFetch === undefined) {
      delete global.fetch;
    } else {
      global.fetch = originalFetch;
    }
  });

  const makeBreaker = (fn, overrides = {}) =>
    createBreaker(fn, {
      timeout: 1000,
      volumeThreshold: 2,
      errorThresholdPercentage: 1,
      resetTimeout: 60000,
      ...overrides,
    });

  const tripBreaker = async (breaker, times = 2) => {
    for (let i = 0; i < times; i++) {
      try { await breaker.fire(); } catch (_e) { /* expected */ }
    }
  };

  describe('disconnect', () => {
    it('opens the breaker on repeated connection refused errors', async () => {
      const fn = jest.fn().mockRejectedValue(
        Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
      );
      const breaker = makeBreaker(fn);

      await tripBreaker(breaker);

      expect(breaker.opened).toBe(true);
      const callsBefore = fn.mock.calls.length;
      await expect(breaker.fire()).rejects.toMatchObject({ code: 'EOPENBREAKER' });
      // Fast-fail must not hit the underlying transport.
      expect(fn.mock.calls.length).toBe(callsBefore);
    });

    it('opens the breaker on DNS resolution failures', async () => {
      const fn = jest.fn().mockRejectedValue(
        Object.assign(new Error('getaddrinfo ENOTFOUND horizon.stellar.org'), { code: 'ENOTFOUND' })
      );
      const breaker = makeBreaker(fn);

      await tripBreaker(breaker);

      expect(breaker.opened).toBe(true);
    });

    it('does not open the breaker for a single transient disconnect', async () => {
      const fn = jest.fn()
        .mockRejectedValueOnce(Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' }))
        .mockResolvedValueOnce('ok');
      const breaker = makeBreaker(fn, { volumeThreshold: 5 });

      await expect(breaker.fire()).rejects.toThrow('ECONNRESET');
      await expect(breaker.fire()).resolves.toBe('ok');
      expect(breaker.opened).toBe(false);
    });
  });

  describe('slow responses', () => {
    it('times out slow calls and counts them toward the breaker', async () => {
      const fn = jest.fn().mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve('late'), 200))
      );
      const breaker = makeBreaker(fn, { timeout: 20 });

      await tripBreaker(breaker);

      expect(breaker.opened).toBe(true);
    });

    it('does not leak pending timers after a timeout', async () => {
      const fn = jest.fn().mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve('late'), 500))
      );
      const breaker = makeBreaker(fn, { timeout: 10 });

      try { await breaker.fire(); } catch (_e) { /* expected timeout */ }

      // Allow the underlying slow promise to settle; no unhandled rejection should occur.
      await new Promise((r) => setTimeout(r, 600));
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  describe('reconnection and partial recovery', () => {
    it('closes the breaker after a successful half-open probe', async () => {
      const fn = jest.fn()
        .mockRejectedValueOnce(new Error('down'))
        .mockRejectedValueOnce(new Error('down'))
        .mockResolvedValueOnce('back');
      const breaker = makeBreaker(fn, { resetTimeout: 30 });

      await tripBreaker(breaker);
      expect(breaker.opened).toBe(true);

      await new Promise((r) => setTimeout(r, 60));

      await expect(breaker.fire()).resolves.toBe('back');
      expect(breaker.opened).toBe(false);
    });

    it('re-opens the breaker when the half-open probe fails', async () => {
      const fn = jest.fn()
        .mockRejectedValueOnce(new Error('down'))
        .mockRejectedValueOnce(new Error('down'))
        .mockRejectedValueOnce(new Error('still down'));
      const breaker = makeBreaker(fn, { resetTimeout: 30 });

      await tripBreaker(breaker);
      expect(breaker.opened).toBe(true);

      await new Promise((r) => setTimeout(r, 60));

      await expect(breaker.fire()).rejects.toThrow('still down');
      expect(breaker.opened).toBe(true);
    });

    it('handles partial recovery: success then failure keeps breaker closed until threshold', async () => {
      const fn = jest.fn()
        .mockResolvedValueOnce('ok')
        .mockRejectedValueOnce(new Error('flaky'))
        .mockResolvedValueOnce('ok');
      const breaker = makeBreaker(fn, { volumeThreshold: 5 });

      await expect(breaker.fire()).resolves.toBe('ok');
      await expect(breaker.fire()).rejects.toThrow('flaky');
      await expect(breaker.fire()).resolves.toBe('ok');
      expect(breaker.opened).toBe(false);
    });
  });

  describe('concurrency', () => {
    it('counts concurrent failures toward a single open transition', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('down'));
      const breaker = makeBreaker(fn, { volumeThreshold: 3 });

      const results = await Promise.allSettled([
        breaker.fire(),
        breaker.fire(),
        breaker.fire(),
        breaker.fire(),
      ]);

      expect(results.every((r) => r.status === 'rejected')).toBe(true);
      expect(breaker.opened).toBe(true);
    });
  });

  describe('no production network access', () => {
    it('never calls global fetch while exercising the breaker', async () => {
      const fetchSpy = jest.fn(() => {
        throw new Error('unexpected production network access');
      });
      global.fetch = fetchSpy;

      const fn = jest.fn().mockRejectedValue(new Error('down'));
      const breaker = makeBreaker(fn);

      await tripBreaker(breaker);
      try { await breaker.fire(); } catch (_e) { /* fast-fail */ }

      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('loadAccount uses the mocked Horizon server, not real network', async () => {
      const fetchSpy = jest.fn(() => {
        throw new Error('unexpected production network access');
      });
      global.fetch = fetchSpy;

      __mockServer.loadAccount.mockRejectedValue(new Error('ECONNREFUSED'));
      for (let i = 0; i < 6; i++) {
        try { await loadAccount('GABC'); } catch (_e) { /* trip breaker */ }
      }

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(__mockServer.loadAccount).toHaveBeenCalled();
    });
  });
});

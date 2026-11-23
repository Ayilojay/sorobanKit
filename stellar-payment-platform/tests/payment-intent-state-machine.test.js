'use strict';

/**
 * Tests for the payment intent state machine transition guard.
 *
 * Covers:
 *  - The full transition matrix (valid transitions succeed, invalid ones throw CONFLICT/409).
 *  - COMPLETED -> PROCESSING specifically returns 409.
 *  - Concurrent updates: exactly one is rejected when racing.
 */

const {
  VALID_TRANSITIONS,
  assertValidTransition,
  updatePaymentIntentStatus,
} = require('../src/services/paymentIntentStateMachine');

const { ApiError } = require('../src/errors/ApiError');

const {
  SUBMISSION_TO_FINALITY_BUCKETS_SECONDS,
  RECONCILIATION_BACKLOG_OBJECTIVE_SECONDS,
  observeSubmissionToFinality,
  setOldestUnreconciledIntentAge,
  recordReconciliationBacklog,
  resetLedgerMetricsForTests,
  renderLedgerMetrics,
  getLedgerMetricSamples,
} = require('../src/observability/ledgerMetrics');

const ALL_STATUSES = ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED'];

/**
 * Build a minimal in-memory Prisma-like mock for payment intents.
 * The mock supports `findUnique` and `update` and simulates the
 * guard being enforced inside the service layer.
 */
function createMockPrisma(initialStatus = 'PENDING') {
  const store = {
    id: 'pi_test_1',
    status: initialStatus,
  };

  return {
    store,
    paymentIntent: {
      async findUnique({ where }) {
        if (where.id !== store.id) return null;
        return { ...store };
      },
      async update({ where, data }) {
        if (where.id !== store.id) {
          throw new Error('Record not found');
        }
        // Simulate a small async delay to widen the race window.
        await new Promise((resolve) => setTimeout(resolve, 5));
        store.status = data.status;
        return { ...store };
      },
    },
  };
}

describe('payment intent state machine', () => {
  describe('VALID_TRANSITIONS map', () => {
    it('defines an entry for every known status', () => {
      for (const status of ALL_STATUSES) {
        expect(VALID_TRANSITIONS).toHaveProperty(status);
        expect(Array.isArray(VALID_TRANSITIONS[status])).toBe(true);
      }
    });

    it('only references known statuses', () => {
      for (const status of ALL_STATUSES) {
        for (const target of VALID_TRANSITIONS[status]) {
          expect(ALL_STATUSES).toContain(target);
        }
      }
    });

    it('does not allow COMPLETED -> PROCESSING', () => {
      expect(VALID_TRANSITIONS.COMPLETED).not.toContain('PROCESSING');
    });
  });

  describe('assertValidTransition', () => {
    // Build the full matrix.
    for (const from of ALL_STATUSES) {
      for (const to of ALL_STATUSES) {
        const isValid = (VALID_TRANSITIONS[from] || []).includes(to);

        if (isValid) {
          it(`allows ${from} -> ${to}`, () => {
            expect(() => assertValidTransition(from, to)).not.toThrow();
          });
        } else {
          it(`rejects ${from} -> ${to} with CONFLICT`, () => {
            let caught;
            try {
              assertValidTransition(from, to);
            } catch (err) {
              caught = err;
            }
            expect(caught).toBeInstanceOf(ApiError);
            expect(caught.code).toBe('CONFLICT');
            expect(caught.status).toBe(409);
          });
        }
      }
    }

    it('rejects COMPLETED -> PROCESSING with 409', () => {
      let caught;
      try {
        assertValidTransition('COMPLETED', 'PROCESSING');
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ApiError);
      expect(caught.code).toBe('CONFLICT');
      expect(caught.status).toBe(409);
    });

    it('rejects unknown source status', () => {
      expect(() => assertValidTransition('BOGUS', 'PENDING')).toThrow(ApiError);
    });

    it('rejects unknown target status', () => {
      expect(() => assertValidTransition('PENDING', 'BOGUS')).toThrow(ApiError);
    });
  });

  describe('updatePaymentIntentStatus', () => {
    it('succeeds for a valid transition (PENDING -> PROCESSING)', async () => {
      const prisma = createMockPrisma('PENDING');
      const result = await updatePaymentIntentStatus(prisma, 'pi_test_1', 'PROCESSING');
      expect(result.status).toBe('PROCESSING');
      expect(prisma.store.status).toBe('PROCESSING');
    });

    it('throws CONFLICT/409 for COMPLETED -> PROCESSING', async () => {
      const prisma = createMockPrisma('COMPLETED');
      await expect(
        updatePaymentIntentStatus(prisma, 'pi_test_1', 'PROCESSING'),
      ).rejects.toMatchObject({ code: 'CONFLICT', status: 409 });
      // Status must remain unchanged.
      expect(prisma.store.status).toBe('COMPLETED');
    });

    it('throws CONFLICT/409 for every invalid transition without mutating state', async () => {
      for (const from of ALL_STATUSES) {
        for (const to of ALL_STATUSES) {
          const isValid = (VALID_TRANSITIONS[from] || []).includes(to);
          if (isValid) continue;

          const prisma = createMockPrisma(from);
          await expect(
            updatePaymentIntentStatus(prisma, 'pi_test_1', to),
          ).rejects.toMatchObject({ code: 'CONFLICT', status: 409 });
          expect(prisma.store.status).toBe(from);
        }
      }
    });

    it('succeeds for every valid transition', async () => {
      for (const from of ALL_STATUSES) {
        for (const to of VALID_TRANSITIONS[from] || []) {
          const prisma = createMockPrisma(from);
          const result = await updatePaymentIntentStatus(prisma, 'pi_test_1', to);
          expect(result.status).toBe(to);
          expect(prisma.store.status).toBe(to);
        }
      }
    });

    it('throws NOT_FOUND when the intent does not exist', async () => {
      const prisma = createMockPrisma('PENDING');
      await expect(
        updatePaymentIntentStatus(prisma, 'does_not_exist', 'PROCESSING'),
      ).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    });

    it('rejects a concurrent race so exactly one update wins', async () => {
      const prisma = createMockPrisma('PENDING');

      // Two concurrent updates from PENDING. Only one may legally
      // transition PENDING -> PROCESSING; the other must be rejected
      // because by the time it re-reads state it is no longer PENDING.
      const results = await Promise.allSettled([
        updatePaymentIntentStatus(prisma, 'pi_test_1', 'PROCESSING'),
        updatePaymentIntentStatus(prisma, 'pi_test_1', 'PROCESSING'),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toBeInstanceOf(ApiError);
      expect(rejected[0].reason.code).toBe('CONFLICT');
      expect(rejected[0].reason.status).toBe(409);
      expect(prisma.store.status).toBe('PROCESSING');
    });

    it('rejects a race between conflicting targets', async () => {
      const prisma = createMockPrisma('PENDING');

      const results = await Promise.allSettled([
        updatePaymentIntentStatus(prisma, 'pi_test_1', 'PROCESSING'),
        updatePaymentIntentStatus(prisma, 'pi_test_1', 'CANCELLED'),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason.code).toBe('CONFLICT');
      expect(rejected[0].reason.status).toBe(409);
    });
  });
});

describe('ledger observability metrics', () => {
  beforeEach(() => {
    resetLedgerMetricsForTests();
  });

  describe('submission-to-finality histogram', () => {
    it('exposes documented bucket boundaries in ascending order', () => {
      expect(Array.isArray(SUBMISSION_TO_FINALITY_BUCKETS_SECONDS)).toBe(true);
      expect(SUBMISSION_TO_FINALITY_BUCKETS_SECONDS.length).toBeGreaterThan(0);
      for (let i = 1; i < SUBMISSION_TO_FINALITY_BUCKETS_SECONDS.length; i += 1) {
        expect(SUBMISSION_TO_FINALITY_BUCKETS_SECONDS[i]).toBeGreaterThan(
          SUBMISSION_TO_FINALITY_BUCKETS_SECONDS[i - 1],
        );
      }
    });

    it('records an observation with only network/operation/status labels', () => {
      observeSubmissionToFinality({
        network: 'testnet',
        operation: 'payment_intent',
        status: 'COMPLETED',
        seconds: 3.5,
      });

      const samples = getLedgerMetricSamples('submission_to_finality_seconds');
      expect(samples.length).toBeGreaterThan(0);
      for (const sample of samples) {
        expect(Object.keys(sample.labels).sort()).toEqual(
          ['network', 'operation', 'status'].sort(),
        );
        expect(sample.labels.network).toBe('testnet');
        expect(sample.labels.operation).toBe('payment_intent');
        expect(sample.labels.status).toBe('COMPLETED');
      }
    });

    it('places observations in the correct cumulative bucket', () => {
      observeSubmissionToFinality({
        network: 'testnet',
        operation: 'payment_intent',
        status: 'COMPLETED',
        seconds: 3.5,
      });

      const samples = getLedgerMetricSamples('submission_to_finality_seconds');
      const buckets = samples.filter((s) => s.type === 'histogram_bucket');
      const firstBoundary = SUBMISSION_TO_FINALITY_BUCKETS_SECONDS[0];

      for (const bucket of buckets) {
        const le = Number(bucket.labels.le);
        if (le >= 3.5) {
          expect(bucket.value).toBe(1);
        } else {
          expect(bucket.value).toBe(0);
        }
      }
      expect(firstBoundary).toBeGreaterThan(0);
    });

    it('treats an observation exactly on a bucket boundary as inclusive', () => {
      const boundary = SUBMISSION_TO_FINALITY_BUCKETS_SECONDS[0];
      observeSubmissionToFinality({
        network: 'testnet',
        operation: 'payment_intent',
        status: 'COMPLETED',
        seconds: boundary,
      });

      const samples = getLedgerMetricSamples('submission_to_finality_seconds');
      const bucket = samples.find(
        (s) => s.type === 'histogram_bucket' && Number(s.labels.le) === boundary,
      );
      expect(bucket).toBeDefined();
      expect(bucket.value).toBe(1);
    });

    it('accumulates multiple observations into the +Inf bucket', () => {
      for (const seconds of [0.5, 2, 30]) {
        observeSubmissionToFinality({
          network: 'mainnet',
          operation: 'payment_intent',
          status: 'COMPLETED',
          seconds,
        });
      }

      const samples = getLedgerMetricSamples('submission_to_finality_seconds');
      const infBucket = samples.find(
        (s) => s.type === 'histogram_bucket' && s.labels.le === '+Inf',
      );
      expect(infBucket).toBeDefined();
      expect(infBucket.value).toBe(3);
    });

    it('keeps series separate per network', () => {
      observeSubmissionToFinality({
        network: 'mainnet',
        operation: 'payment_intent',
        status: 'COMPLETED',
        seconds: 1,
      });
      observeSubmissionToFinality({
        network: 'testnet',
        operation: 'payment_intent',
        status: 'COMPLETED',
        seconds: 1,
      });

      const samples = getLedgerMetricSamples('submission_to_finality_seconds');
      const networks = new Set(samples.map((s) => s.labels.network));
      expect(networks).toEqual(new Set(['mainnet', 'testnet']));
    });

    it('rejects observations with missing or invalid labels', () => {
      expect(() =>
        observeSubmissionToFinality({ operation: 'payment_intent', status: 'COMPLETED', seconds: 1 }),
      ).toThrow();
      expect(() =>
        observeSubmissionToFinality({ network: 'testnet', status: 'COMPLETED', seconds: 1 }),
      ).toThrow();
      expect(() =>
        observeSubmissionToFinality({ network: 'testnet', operation: 'payment_intent', seconds: 1 }),
      ).toThrow();
    });

    it('rejects user identifiers smuggled into labels', () => {
      expect(() =>
        observeSubmissionToFinality({
          network: 'testnet',
          operation: 'payment_intent',
          status: 'COMPLETED',
          seconds: 1,
          userId: 'user_123',
        }),
      ).toThrow();
      expect(() =>
        observeSubmissionToFinality({
          network: 'testnet',
          operation: 'payment_intent',
          status: 'COMPLETED',
          seconds: 1,
          intentId: 'pi_test_1',
        }),
      ).toThrow();
    });

    it('rejects negative or non-finite durations', () => {
      for (const seconds of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(() =>
          observeSubmissionToFinality({
            network: 'testnet',
            operation: 'payment_intent',
            status: 'COMPLETED',
            seconds,
          }),
        ).toThrow();
      }
    });
  });

  describe('oldest unreconciled intent age gauge', () => {
    it('documents a positive reconciliation backlog objective', () => {
      expect(RECONCILIATION_BACKLOG_OBJECTIVE_SECONDS).toBeGreaterThan(0);
    });

    it('sets the gauge per network', () => {
      setOldestUnreconciledIntentAge({ network: 'mainnet', seconds: 42 });
      setOldestUnreconciledIntentAge({ network: 'testnet', seconds: 7 });

      const samples = getLedgerMetricSamples('oldest_unreconciled_intent_age_seconds');
      const byNetwork = Object.fromEntries(
        samples.map((s) => [s.labels.network, s.value]),
      );
      expect(byNetwork.mainnet).toBe(42);
      expect(byNetwork.testnet).toBe(7);
    });

    it('accepts zero age when the backlog is empty', () => {
      setOldestUnreconciledIntentAge({ network: 'mainnet', seconds: 0 });
      const samples = getLedgerMetricSamples('oldest_unreconciled_intent_age_seconds');
      expect(samples).toHaveLength(1);
      expect(samples[0].value).toBe(0);
    });

    it('only uses the network label', () => {
      setOldestUnreconciledIntentAge({ network: 'mainnet', seconds: 5 });
      const samples = getLedgerMetricSamples('oldest_unreconciled_intent_age_seconds');
      for (const sample of samples) {
        expect(Object.keys(sample.labels)).toEqual(['network']);
      }
    });

    it('rejects missing network, negative ages, and extra labels', () => {
      expect(() => setOldestUnreconciledIntentAge({ seconds: 5 })).toThrow();
      expect(() =>
        setOldestUnreconciledIntentAge({ network: 'mainnet', seconds: -1 }),
      ).toThrow();
      expect(() =>
        setOldestUnreconciledIntentAge({ network: 'mainnet', seconds: 5, intentId: 'pi_1' }),
      ).toThrow();
    });

    it('records backlog breaches against the documented objective', () => {
      const below = recordReconciliationBacklog({
        network: 'mainnet',
        seconds: RECONCILIATION_BACKLOG_OBJECTIVE_SECONDS - 1,
      });
      const above = recordReconciliationBacklog({
        network: 'mainnet',
        seconds: RECONCILIATION_BACKLOG_OBJECTIVE_SECONDS + 1,
      });

      expect(below.breached).toBe(false);
      expect(above.breached).toBe(true);
    });

    it('treats age exactly at the objective as not breached', () => {
      const result = recordReconciliationBacklog({
        network: 'mainnet',
        seconds: RECONCILIATION_BACKLOG_OBJECTIVE_SECONDS,
      });
      expect(result.breached).toBe(false);
    });
  });

  describe('rendering', () => {
    it('renders Prometheus text without user identifiers', () => {
      observeSubmissionToFinality({
        network: 'testnet',
        operation: 'payment_intent',
        status: 'COMPLETED',
        seconds: 2,
      });
      setOldestUnreconciledIntentAge({ network: 'testnet', seconds: 10 });

      const text = renderLedgerMetrics();
      expect(text).toContain('submission_to_finality_seconds');
      expect(text).toContain('oldest_unreconciled_intent_age_seconds');
      expect(text).not.toMatch(/user_?id/i);
      expect(text).not.toMatch(/intent_?id/i);
    });
  });
});
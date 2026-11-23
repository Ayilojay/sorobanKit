'use strict';

/**
 * Focused tests for the transactional outbox (issue #391).
 *
 * Covers:
 *  - Writing outbox rows in the same transaction as domain changes (atomicity).
 *  - Successful dispatch of pending events.
 *  - Bounded retry exhaustion for failing dispatches.
 *  - Idempotent redelivery of an already-processed event.
 *  - Reconciliation query for stuck events.
 */

const assert = require('assert');
const { randomUUID } = require('crypto');

// ---------------------------------------------------------------------------
// In-memory transactional store used to exercise the outbox semantics without
// requiring a live database. It models the same guarantees the production
// implementation must provide: atomic commit of domain + outbox rows, versioned
// outbox rows, bounded retries, idempotent consumers, and reconciliation.
// ---------------------------------------------------------------------------

const OUTBOX_STATUS = Object.freeze({
  PENDING: 'pending',
  PROCESSING: 'processing',
  PROCESSED: 'processed',
  FAILED: 'failed',
});

class InMemoryTransactionalStore {
  constructor({ maxAttempts = 3, stuckAfterMs = 60_000, now = () => Date.now() } = {}) {
    this.maxAttempts = maxAttempts;
    this.stuckAfterMs = stuckAfterMs;
    this.now = now;

    // Committed state.
    this.domains = new Map(); // id -> record
    this.outbox = new Map(); // id -> outbox row
    this.processedEventIds = new Set(); // consumer-side idempotency ledger

    // Transaction state.
    this._tx = null;
  }

  // -- Transaction lifecycle -------------------------------------------------

  begin() {
    if (this._tx) {
      throw new Error('transaction already in progress');
    }
    this._tx = {
      domains: new Map(),
      outbox: new Map(),
    };
  }

  commit() {
    if (!this._tx) {
      throw new Error('no transaction in progress');
    }
    for (const [id, record] of this._tx.domains) {
      this.domains.set(id, record);
    }
    for (const [id, row] of this._tx.outbox) {
      this.outbox.set(id, row);
    }
    this._tx = null;
  }

  rollback() {
    this._tx = null;
  }

  // -- Domain + outbox writes ------------------------------------------------

  writeDomainAndEvent({ domainId, eventType, payload, aggregateVersion }) {
    if (!this._tx) {
      throw new Error('writeDomainAndEvent must run inside a transaction');
    }
    const domainRecord = {
      id: domainId,
      version: aggregateVersion,
      updatedAt: this.now(),
    };
    this._tx.domains.set(domainId, domainRecord);

    const eventId = randomUUID();
    const outboxRow = {
      id: eventId,
      aggregateId: domainId,
      aggregateVersion,
      eventType,
      payload,
      status: OUTBOX_STATUS.PENDING,
      attempts: 0,
      lastError: null,
      createdAt: this.now(),
      updatedAt: this.now(),
      processedAt: null,
    };
    this._tx.outbox.set(eventId, outboxRow);
    return { domainRecord, outboxRow };
  }

  // -- Dispatch --------------------------------------------------------------

  pendingEvents() {
    return [...this.outbox.values()]
      .filter((row) => row.status === OUTBOX_STATUS.PENDING)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /**
   * Dispatch a single outbox row through the given handler with bounded
   * retries. The handler is expected to be idempotent; the store records
   * processed event ids so redelivery is a no-op.
   */
  async dispatch(row, handler) {
    if (row.status === OUTBOX_STATUS.PROCESSED) {
      return { outcome: 'already-processed', attempts: row.attempts };
    }

    // Idempotent consumer: if the handler already recorded this event, mark
    // the outbox row processed without re-invoking the handler.
    if (this.processedEventIds.has(row.id)) {
      row.status = OUTBOX_STATUS.PROCESSED;
      row.processedAt = this.now();
      row.updatedAt = this.now();
      return { outcome: 'already-processed', attempts: row.attempts };
    }

    let lastError = null;
    while (row.attempts < this.maxAttempts) {
      row.attempts += 1;
      row.status = OUTBOX_STATUS.PROCESSING;
      row.updatedAt = this.now();
      try {
        await handler(row);
        this.processedEventIds.add(row.id);
        row.status = OUTBOX_STATUS.PROCESSED;
        row.processedAt = this.now();
        row.updatedAt = this.now();
        row.lastError = null;
        return { outcome: 'processed', attempts: row.attempts };
      } catch (err) {
        lastError = err;
        row.lastError = err && err.message ? err.message : String(err);
        row.updatedAt = this.now();
      }
    }

    row.status = OUTBOX_STATUS.FAILED;
    row.updatedAt = this.now();
    return { outcome: 'exhausted', attempts: row.attempts, error: lastError };
  }

  async dispatchAll(handler) {
    const results = [];
    for (const row of this.pendingEvents()) {
      results.push({ id: row.id, ...(await this.dispatch(row, handler)) });
    }
    return results;
  }

  // -- Reconciliation --------------------------------------------------------

  /**
   * Return outbox rows that are stuck: either pending/processing rows older
   * than the stuck threshold, or rows that have exhausted retries.
   */
  findStuckEvents() {
    const cutoff = this.now() - this.stuckAfterMs;
    return [...this.outbox.values()].filter((row) => {
      if (row.status === OUTBOX_STATUS.FAILED) {
        return true;
      }
      if (
        (row.status === OUTBOX_STATUS.PENDING ||
          row.status === OUTBOX_STATUS.PROCESSING) &&
        row.updatedAt <= cutoff
      ) {
        return true;
      }
      return false;
    });
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test('writes domain change and outbox row atomically on commit', async () => {
  const store = new InMemoryTransactionalStore();
  store.begin();
  const { outboxRow } = store.writeDomainAndEvent({
    domainId: 'payment-1',
    eventType: 'payment.created',
    payload: { amount: 100 },
    aggregateVersion: 1,
  });
  assert.strictEqual(store.domains.size, 0, 'domain not visible before commit');
  assert.strictEqual(store.outbox.size, 0, 'outbox not visible before commit');
  store.commit();

  assert.strictEqual(store.domains.size, 1);
  assert.strictEqual(store.outbox.size, 1);
  const row = store.outbox.get(outboxRow.id);
  assert.strictEqual(row.status, OUTBOX_STATUS.PENDING);
  assert.strictEqual(row.aggregateVersion, 1);
  assert.strictEqual(row.eventType, 'payment.created');
});

test('rolls back both domain change and outbox row together', async () => {
  const store = new InMemoryTransactionalStore();
  store.begin();
  store.writeDomainAndEvent({
    domainId: 'payment-2',
    eventType: 'payment.created',
    payload: { amount: 200 },
    aggregateVersion: 1,
  });
  store.rollback();

  assert.strictEqual(store.domains.size, 0);
  assert.strictEqual(store.outbox.size, 0);
});

test('successfully dispatches pending events', async () => {
  const store = new InMemoryTransactionalStore();
  store.begin();
  store.writeDomainAndEvent({
    domainId: 'payment-3',
    eventType: 'payment.created',
    payload: { amount: 300 },
    aggregateVersion: 1,
  });
  store.commit();

  const handled = [];
  const results = await store.dispatchAll(async (row) => {
    handled.push(row.id);
  });

  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].outcome, 'processed');
  assert.strictEqual(handled.length, 1);
  const row = [...store.outbox.values()][0];
  assert.strictEqual(row.status, OUTBOX_STATUS.PROCESSED);
  assert.ok(row.processedAt !== null);
});

test('exhausts bounded retries and marks event failed', async () => {
  const store = new InMemoryTransactionalStore({ maxAttempts: 3 });
  store.begin();
  store.writeDomainAndEvent({
    domainId: 'payment-4',
    eventType: 'payment.created',
    payload: { amount: 400 },
    aggregateVersion: 1,
  });
  store.commit();

  let calls = 0;
  const results = await store.dispatchAll(async () => {
    calls += 1;
    throw new Error('downstream unavailable');
  });

  assert.strictEqual(calls, 3, 'handler invoked exactly maxAttempts times');
  assert.strictEqual(results[0].outcome, 'exhausted');
  assert.strictEqual(results[0].attempts, 3);
  const row = [...store.outbox.values()][0];
  assert.strictEqual(row.status, OUTBOX_STATUS.FAILED);
  assert.strictEqual(row.attempts, 3);
  assert.strictEqual(row.lastError, 'downstream unavailable');
});

test('redelivery of an already-processed event is idempotent', async () => {
  const store = new InMemoryTransactionalStore();
  store.begin();
  const { outboxRow } = store.writeDomainAndEvent({
    domainId: 'payment-5',
    eventType: 'payment.created',
    payload: { amount: 500 },
    aggregateVersion: 1,
  });
  store.commit();

  let calls = 0;
  const handler = async () => {
    calls += 1;
  };

  const first = await store.dispatch(store.outbox.get(outboxRow.id), handler);
  assert.strictEqual(first.outcome, 'processed');
  assert.strictEqual(calls, 1);

  // Simulate redelivery of the same event id.
  const second = await store.dispatch(store.outbox.get(outboxRow.id), handler);
  assert.strictEqual(second.outcome, 'already-processed');
  assert.strictEqual(calls, 1, 'handler not invoked again');

  // Simulate a consumer-side duplicate where the outbox row was reset but the
  // consumer ledger already recorded the event.
  const row = store.outbox.get(outboxRow.id);
  row.status = OUTBOX_STATUS.PENDING;
  const third = await store.dispatch(row, handler);
  assert.strictEqual(third.outcome, 'already-processed');
  assert.strictEqual(calls, 1, 'handler still not invoked again');
  assert.strictEqual(row.status, OUTBOX_STATUS.PROCESSED);
});

test('reconciliation query returns stuck events', async () => {
  let clock = 1_000_000;
  const store = new InMemoryTransactionalStore({
    maxAttempts: 1,
    stuckAfterMs: 1_000,
    now: () => clock,
  });

  // Event A: pending and will become stale.
  store.begin();
  const a = store.writeDomainAndEvent({
    domainId: 'payment-6',
    eventType: 'payment.created',
    payload: { amount: 600 },
    aggregateVersion: 1,
  });
  store.commit();

  // Event B: will exhaust retries and be marked failed.
  store.begin();
  const b = store.writeDomainAndEvent({
    domainId: 'payment-7',
    eventType: 'payment.created',
    payload: { amount: 700 },
    aggregateVersion: 1,
  });
  store.commit();

  // Event C: processed successfully, should not be reported.
  store.begin();
  const c = store.writeDomainAndEvent({
    domainId: 'payment-8',
    eventType: 'payment.created',
    payload: { amount: 800 },
    aggregateVersion: 1,
  });
  store.commit();

  await store.dispatch(store.outbox.get(b.outboxRow.id), async () => {
    throw new Error('boom');
  });
  await store.dispatch(store.outbox.get(c.outboxRow.id), async () => {});

  // Advance the clock past the stuck threshold for event A.
  clock += 2_000;

  const stuck = store.findStuckEvents();
  const stuckIds = stuck.map((row) => row.id).sort();
  const expected = [a.outboxRow.id, b.outboxRow.id].sort();
  assert.deepStrictEqual(stuckIds, expected);

  const failedRow = stuck.find((row) => row.id === b.outboxRow.id);
  assert.strictEqual(failedRow.status, OUTBOX_STATUS.FAILED);

  const staleRow = stuck.find((row) => row.id === a.outboxRow.id);
  assert.strictEqual(staleRow.status, OUTBOX_STATUS.PENDING);
});

test('reconciliation excludes fresh pending events', async () => {
  const store = new InMemoryTransactionalStore({ stuckAfterMs: 60_000 });
  store.begin();
  store.writeDomainAndEvent({
    domainId: 'payment-9',
    eventType: 'payment.created',
    payload: { amount: 900 },
    aggregateVersion: 1,
  });
  store.commit();

  const stuck = store.findStuckEvents();
  assert.strictEqual(stuck.length, 0);
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

(async () => {
  let passed = 0;
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed += 1;
      // eslint-disable-next-line no-console
      console.log(`ok - ${name}`);
    } catch (err) {
      failed += 1;
      // eslint-disable-next-line no-console
      console.error(`not ok - ${name}`);
      // eslint-disable-next-line no-console
      console.error(err && err.stack ? err.stack : err);
    }
  }
  // eslint-disable-next-line no-console
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exitCode = 1;
  }
})();
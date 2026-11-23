'use strict';

/**
 * Transactional outbox for domain events (issue #391).
 *
 * Domain mutations enqueue an OutboxEvent row *inside the same transaction*
 * as the mutation itself (see `enqueueOutboxEvent`). A dispatcher then reads
 * pending rows, delivers them to consumers with bounded retries and
 * exponential backoff, and marks them processed or failed. Consumers are
 * expected to be idempotent keyed on (eventId, version); the dispatcher
 * passes both along and records delivery attempts.
 *
 * A reconciliation helper reports stuck / failed events so operators can
 * inspect or replay them.
 */

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BASE_DELAY_MS = 250;
const DEFAULT_MAX_DELAY_MS = 30_000;
const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_STUCK_AFTER_MS = 5 * 60 * 1000;

const OUTBOX_STATUS = Object.freeze({
  PENDING: 'pending',
  PROCESSING: 'processing',
  PROCESSED: 'processed',
  FAILED: 'failed',
});

/**
 * Compute the exponential backoff delay for a given attempt (1-based).
 * delay = min(base * 2^(attempt-1), max)
 */
function computeBackoffDelay(attempt, baseDelayMs = DEFAULT_BASE_DELAY_MS, maxDelayMs = DEFAULT_MAX_DELAY_MS) {
  const safeAttempt = Math.max(1, Math.floor(attempt));
  const raw = baseDelayMs * Math.pow(2, safeAttempt - 1);
  return Math.min(raw, maxDelayMs);
}

function nowIso(clock) {
  const d = typeof clock === 'function' ? clock() : new Date();
  return (d instanceof Date ? d : new Date(d)).toISOString();
}

/**
 * Enqueue a domain event into the outbox.
 *
 * MUST be called with the same transaction/client used for the domain
 * mutation so the row commits or rolls back atomically with it.
 *
 * @param {object} params
 * @param {object} params.client  DB client bound to the current transaction.
 * @param {string} params.aggregateType
 * @param {string} params.aggregateId
 * @param {string} params.eventType
 * @param {object} [params.payload]
 * @param {number} [params.version]  Aggregate/event version (defaults to 1).
 * @param {string} [params.idempotencyKey] Optional dedupe key.
 * @param {Function} [params.clock]
 * @returns {Promise<object>} the inserted outbox row
 */
async function enqueueOutboxEvent({
  client,
  aggregateType,
  aggregateId,
  eventType,
  payload = {},
  version = 1,
  idempotencyKey = null,
  clock,
}) {
  if (!client || typeof client.query !== 'function') {
    throw new TypeError('enqueueOutboxEvent requires a transactional DB client');
  }
  if (!aggregateType || !aggregateId || !eventType) {
    throw new TypeError('enqueueOutboxEvent requires aggregateType, aggregateId and eventType');
  }
  if (!Number.isInteger(version) || version < 1) {
    throw new TypeError('enqueueOutboxEvent requires a positive integer version');
  }

  const createdAt = nowIso(clock);
  const result = await client.query(
    `INSERT INTO outbox_events
       (aggregate_type, aggregate_id, event_type, payload, version,
        idempotency_key, status, attempts, next_attempt_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8, $8, $8)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING *`,
    [
      aggregateType,
      aggregateId,
      eventType,
      JSON.stringify(payload),
      version,
      idempotencyKey,
      OUTBOX_STATUS.PENDING,
      createdAt,
    ],
  );

  // If the idempotency key already existed, fetch the existing row so callers
  // get a stable reference (idempotent enqueue).
  if (result.rows.length === 0 && idempotencyKey) {
    const existing = await client.query(
      `SELECT * FROM outbox_events WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    return existing.rows[0] || null;
  }
  return result.rows[0] || null;
}

/**
 * Transactional outbox dispatcher.
 */
class OutboxDispatcher {
  /**
   * @param {object} deps
   * @param {object} deps.db  Pool/client with `.query`.
   * @param {Function} deps.handler  async (event) => void. Must be idempotent
   *   keyed on event.id + event.version.
   * @param {number} [deps.maxAttempts]
   * @param {number} [deps.baseDelayMs]
   * @param {number} [deps.maxDelayMs]
   * @param {number} [deps.batchSize]
   * @param {Function} [deps.clock]
   * @param {Function} [deps.sleep]  Injectable for tests.
   * @param {object} [deps.logger]
   */
  constructor({
    db,
    handler,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    maxDelayMs = DEFAULT_MAX_DELAY_MS,
    batchSize = DEFAULT_BATCH_SIZE,
    clock,
    sleep,
    logger = console,
  }) {
    if (!db || typeof db.query !== 'function') {
      throw new TypeError('OutboxDispatcher requires a db with .query');
    }
    if (typeof handler !== 'function') {
      throw new TypeError('OutboxDispatcher requires a handler function');
    }
    this.db = db;
    this.handler = handler;
    this.maxAttempts = maxAttempts;
    this.baseDelayMs = baseDelayMs;
    this.maxDelayMs = maxDelayMs;
    this.batchSize = batchSize;
    this.clock = clock;
    this.sleep = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.logger = logger;
  }

  /**
   * Claim a batch of due pending events using SELECT ... FOR UPDATE SKIP LOCKED
   * so concurrent dispatchers do not double-process rows.
   */
  async claimBatch(limit = this.batchSize) {
    const now = nowIso(this.clock);
    const result = await this.db.query(
      `UPDATE outbox_events
          SET status = $1, updated_at = $2
        WHERE id IN (
          SELECT id FROM outbox_events
           WHERE status = $3
             AND next_attempt_at <= $2
           ORDER BY next_attempt_at ASC, id ASC
           LIMIT $4
           FOR UPDATE SKIP LOCKED
        )
        RETURNING *`,
      [OUTBOX_STATUS.PROCESSING, now, OUTBOX_STATUS.PENDING, limit],
    );
    return result.rows;
  }

  /**
   * Dispatch one event through the handler, applying bounded retries.
   * Returns { status, attempts }.
   */
  async dispatchEvent(event) {
    const attempts = (event.attempts || 0) + 1;
    try {
      await this.handler({
        id: event.id,
        eventId: event.id,
        version: event.version,
        aggregateType: event.aggregate_type,
        aggregateId: event.aggregate_id,
        eventType: event.event_type,
        payload: typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload,
        attempts,
      });

      const processedAt = nowIso(this.clock);
      await this.db.query(
        `UPDATE outbox_events
            SET status = $1, attempts = $2, processed_at = $3, updated_at = $3, last_error = NULL
          WHERE id = $4`,
        [OUTBOX_STATUS.PROCESSED, attempts, processedAt, event.id],
      );
      return { status: OUTBOX_STATUS.PROCESSED, attempts };
    } catch (err) {
      const message = err && err.message ? String(err.message) : String(err);
      const exhausted = attempts >= this.maxAttempts;
      const updatedAt = nowIso(this.clock);

      if (exhausted) {
        await this.db.query(
          `UPDATE outbox_events
              SET status = $1, attempts = $2, last_error = $3, updated_at = $4
            WHERE id = $5`,
          [OUTBOX_STATUS.FAILED, attempts, message, updatedAt, event.id],
        );
        if (this.logger && typeof this.logger.error === 'function') {
          this.logger.error(
            `[outbox] event ${event.id} failed permanently after ${attempts} attempts: ${message}`,
          );
        }
        return { status: OUTBOX_STATUS.FAILED, attempts, error: message };
      }

      const delay = computeBackoffDelay(attempts, this.baseDelayMs, this.maxDelayMs);
      const nextAttemptAt = new Date(
        (typeof this.clock === 'function' ? this.clock() : new Date()).getTime() + delay,
      ).toISOString();

      await this.db.query(
        `UPDATE outbox_events
            SET status = $1, attempts = $2, last_error = $3,
                next_attempt_at = $4, updated_at = $5
          WHERE id = $6`,
        [OUTBOX_STATUS.PENDING, attempts, message, nextAttemptAt, updatedAt, event.id],
      );
      if (this.logger && typeof this.logger.warn === 'function') {
        this.logger.warn(
          `[outbox] event ${event.id} attempt ${attempts} failed, retrying in ${delay}ms: ${message}`,
        );
      }
      return { status: OUTBOX_STATUS.PENDING, attempts, error: message, retryInMs: delay };
    }
  }

  /**
   * Process a single batch. Returns a summary.
   */
  async runOnce() {
    const events = await this.claimBatch();
    const summary = { claimed: events.length, processed: 0, retried: 0, failed: 0 };
    for (const event of events) {
      const outcome = await this.dispatchEvent(event);
      if (outcome.status === OUTBOX_STATUS.PROCESSED) summary.processed += 1;
      else if (outcome.status === OUTBOX_STATUS.FAILED) summary.failed += 1;
      else summary.retried += 1;
    }
    return summary;
  }

  /**
   * Drain due events until no more are claimable. Bounded by maxBatches to
   * avoid unbounded loops in a single tick.
   */
  async drain({ maxBatches = 100 } = {}) {
    const totals = { batches: 0, claimed: 0, processed: 0, retried: 0, failed: 0 };
    for (let i = 0; i < maxBatches; i += 1) {
      const summary = await this.runOnce();
      totals.batches += 1;
      totals.claimed += summary.claimed;
      totals.processed += summary.processed;
      totals.retried += summary.retried;
      totals.failed += summary.failed;
      if (summary.claimed === 0) break;
    }
    return totals;
  }
}

/**
 * Reconciliation report for stuck or failed outbox events.
 *
 * @param {object} params
 * @param {object} params.db
 * @param {number} [params.stuckAfterMs]  Age after which a processing/pending
 *   event is considered stuck.
 * @param {Function} [params.clock]
 * @returns {Promise<{stuck: object[], failed: object[], counts: object}>}
 */
async function reconcileOutbox({
  db,
  stuckAfterMs = DEFAULT_STUCK_AFTER_MS,
  clock,
}) {
  if (!db || typeof db.query !== 'function') {
    throw new TypeError('reconcileOutbox requires a db with .query');
  }
  const now = typeof clock === 'function' ? clock() : new Date();
  const nowMs = (now instanceof Date ? now : new Date(now)).getTime();
  const stuckBefore = new Date(nowMs - stuckAfterMs).toISOString();

  const stuckResult = await db.query(
    `SELECT * FROM outbox_events
      WHERE status IN ($1, $2)
        AND updated_at <= $3
      ORDER BY updated_at ASC`,
    [OUTBOX_STATUS.PENDING, OUTBOX_STATUS.PROCESSING, stuckBefore],
  );

  const failedResult = await db.query(
    `SELECT * FROM outbox_events
      WHERE status = $1
      ORDER BY updated_at ASC`,
    [OUTBOX_STATUS.FAILED],
  );

  const countsResult = await db.query(
    `SELECT status, COUNT(*)::int AS count
       FROM outbox_events
      GROUP BY status`,
  );

  const counts = {};
  for (const row of countsResult.rows) {
    counts[row.status] = row.count;
  }

  return {
    stuck: stuckResult.rows,
    failed: failedResult.rows,
    counts,
    generatedAt: new Date(nowMs).toISOString(),
  };
}

module.exports = {
  OUTBOX_STATUS,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_BASE_DELAY_MS,
  DEFAULT_MAX_DELAY_MS,
  DEFAULT_BATCH_SIZE,
  DEFAULT_STUCK_AFTER_MS,
  computeBackoffDelay,
  enqueueOutboxEvent,
  OutboxDispatcher,
  reconcileOutbox,
};
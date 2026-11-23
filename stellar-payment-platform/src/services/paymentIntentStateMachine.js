'use strict';

const { EventEmitter } = require('events');
const { ApiError } = require('../errors');

/**
 * Valid state transitions for a payment intent.
 *
 * Terminal states (COMPLETED, FAILED, CANCELLED) have no outgoing transitions.
 */
const VALID_TRANSITIONS = Object.freeze({
  PENDING: Object.freeze(['PROCESSING', 'CANCELLED']),
  PROCESSING: Object.freeze(['COMPLETED', 'FAILED']),
  COMPLETED: Object.freeze([]),
  FAILED: Object.freeze([]),
  CANCELLED: Object.freeze([]),
});

const ALL_STATUSES = Object.freeze(Object.keys(VALID_TRANSITIONS));

/**
 * Default maximum number of concurrent SSE subscribers.
 */
const DEFAULT_MAX_SSE_CONNECTIONS = 100;

/**
 * Default heartbeat interval (ms) for SSE connections.
 */
const DEFAULT_SSE_HEARTBEAT_MS = 15000;

/**
 * Bounded registry of server-sent-event subscribers for payment intent status
 * updates.
 *
 * Each subscriber receives versioned events (`{ version, ... }`) so clients can
 * resume from a reconnect cursor. The registry enforces a hard connection limit
 * and guarantees that every subscriber is removed on disconnect so slow or
 * abandoned clients cannot leak resources.
 */
class PaymentIntentEventStream extends EventEmitter {
  /**
   * @param {object} [options]
   * @param {number} [options.maxConnections]
   * @param {number} [options.heartbeatMs]
   */
  constructor(options = {}) {
    super();
    this.setMaxListeners(0);
    this.maxConnections =
      Number.isInteger(options.maxConnections) && options.maxConnections > 0
        ? options.maxConnections
        : DEFAULT_MAX_SSE_CONNECTIONS;
    this.heartbeatMs =
      Number.isInteger(options.heartbeatMs) && options.heartbeatMs > 0
        ? options.heartbeatMs
        : DEFAULT_SSE_HEARTBEAT_MS;
    this.version = 0;
    this._subscribers = new Map();
    this._nextSubscriberId = 1;
  }

  /**
   * Number of currently connected subscribers.
   * @returns {number}
   */
  get size() {
    return this._subscribers.size;
  }

  /**
   * Registers a subscriber.
   *
   * @param {object} params
   * @param {string} [params.paymentIntentId] - Optional filter; when set the
   *   subscriber only receives events for that payment intent.
   * @param {number} [params.lastEventId] - Reconnect cursor; the subscriber is
   *   told the current version so it can detect gaps.
   * @param {function} params.send - Called with each event payload.
   * @param {function} [params.onHeartbeat] - Called on each heartbeat tick.
   * @returns {{ id: number, version: number, close: function }}
   * @throws {ApiError} TOO_MANY_REQUESTS when the connection limit is reached.
   */
  subscribe({ paymentIntentId, lastEventId, send, onHeartbeat } = {}) {
    if (typeof send !== 'function') {
      throw new ApiError('BAD_REQUEST', 'SSE subscriber requires a send function');
    }
    if (this._subscribers.size >= this.maxConnections) {
      throw new ApiError(
        'TOO_MANY_REQUESTS',
        `SSE connection limit reached (${this.maxConnections})`
      );
    }

    const id = this._nextSubscriberId++;
    const subscriber = {
      id,
      paymentIntentId: paymentIntentId || null,
      send,
      onHeartbeat: typeof onHeartbeat === 'function' ? onHeartbeat : null,
      timer: null,
      closed: false,
    };

    if (this.heartbeatMs > 0 && subscriber.onHeartbeat) {
      subscriber.timer = setInterval(() => {
        if (subscriber.closed) {
          return;
        }
        try {
          subscriber.onHeartbeat();
        } catch (_err) {
          // A failing heartbeat means the client is gone; drop it.
          this.unsubscribe(id);
        }
      }, this.heartbeatMs);
      if (typeof subscriber.timer.unref === 'function') {
        subscriber.timer.unref();
      }
    }

    this._subscribers.set(id, subscriber);

    const cursor = Number.isInteger(lastEventId) ? lastEventId : 0;
    if (cursor > 0 && cursor < this.version) {
      // Client missed events while disconnected; tell it to resync.
      this._safeSend(subscriber, {
        type: 'resync',
        version: this.version,
        lastEventId: cursor,
      });
    }

    return {
      id,
      version: this.version,
      close: () => this.unsubscribe(id),
    };
  }

  /**
   * Removes a subscriber and clears its heartbeat timer. Safe to call twice.
   *
   * @param {number} id
   * @returns {boolean} true if a subscriber was removed
   */
  unsubscribe(id) {
    const subscriber = this._subscribers.get(id);
    if (!subscriber) {
      return false;
    }
    subscriber.closed = true;
    if (subscriber.timer) {
      clearInterval(subscriber.timer);
      subscriber.timer = null;
    }
    this._subscribers.delete(id);
    return true;
  }

  /**
   * Removes all subscribers. Used on shutdown.
   */
  closeAll() {
    for (const id of Array.from(this._subscribers.keys())) {
      this.unsubscribe(id);
    }
  }

  /**
   * Publishes a versioned status event to matching subscribers.
   *
   * @param {object} params
   * @param {string} params.paymentIntentId
   * @param {string} params.status
   * @param {string} [params.previousStatus]
   * @param {object} [params.data]
   * @returns {{ version: number, delivered: number }}
   */
  publish({ paymentIntentId, status, previousStatus, data } = {}) {
    this.version += 1;
    const event = {
      type: 'payment_intent.status',
      version: this.version,
      paymentIntentId,
      status,
      previousStatus: previousStatus || null,
      data: data || null,
      timestamp: new Date().toISOString(),
    };

    let delivered = 0;
    for (const subscriber of Array.from(this._subscribers.values())) {
      if (subscriber.paymentIntentId && subscriber.paymentIntentId !== paymentIntentId) {
        continue;
      }
      if (this._safeSend(subscriber, event)) {
        delivered += 1;
      }
    }

    this.emit('event', event);
    return { version: event.version, delivered };
  }

  /**
   * @private
   */
  _safeSend(subscriber, payload) {
    if (subscriber.closed) {
      return false;
    }
    try {
      subscriber.send(payload);
      return true;
    } catch (_err) {
      // Slow or disconnected client: drop it so resources are released.
      this.unsubscribe(subscriber.id);
      return false;
    }
  }
}

/**
 * Process-wide default event stream used by the state machine helpers.
 */
const defaultEventStream = new PaymentIntentEventStream();

/**
 * Returns true if transitioning from `from` to `to` is allowed.
 *
 * @param {string} from
 * @param {string} to
 * @returns {boolean}
 */
function isValidTransition(from, to) {
  const allowed = VALID_TRANSITIONS[from];
  if (!allowed) {
    return false;
  }
  return allowed.includes(to);
}

/**
 * Throws an ApiError('CONFLICT') if the transition is not allowed.
 *
 * @param {string} from
 * @param {string} to
 * @param {string} [paymentIntentId]
 */
function assertValidTransition(from, to, paymentIntentId) {
  if (!isValidTransition(from, to)) {
    const idSuffix = paymentIntentId ? ` for payment intent ${paymentIntentId}` : '';
    throw new ApiError(
      'CONFLICT',
      `Invalid payment intent status transition from ${from} to ${to}${idSuffix}`
    );
  }
}

/**
 * Builds a Prisma `where` clause that only matches the record if it is still
 * in the expected `from` status. This makes the update atomic: if another
 * writer changed the status in the meantime, the update matches zero rows.
 *
 * @param {string} id
 * @param {string} from
 * @returns {object}
 */
function buildGuardedWhere(id, from) {
  return { id, status: from };
}

/**
 * Performs a guarded status update on a payment intent.
 *
 * The update is concurrency-safe: the `where` clause includes the expected
 * current status, so two concurrent updates from the same source status cannot
 * both succeed. The loser observes `count === 0` and receives a CONFLICT.
 *
 * @param {object} prisma - Prisma client (or transaction client)
 * @param {object} params
 * @param {string} params.id - Payment intent id
 * @param {string} params.to - Target status
 * @param {object} [params.data] - Additional fields to update
 * @returns {Promise<object>} The updated payment intent
 */
async function updatePaymentIntentStatus(prisma, { id, to, data = {}, eventStream } = {}) {
  if (!ALL_STATUSES.includes(to)) {
    throw new ApiError('CONFLICT', `Unknown payment intent status: ${to}`);
  }

  const current = await prisma.paymentIntent.findUnique({
    where: { id },
    select: { id: true, status: true },
  });

  if (!current) {
    throw new ApiError('NOT_FOUND', `Payment intent ${id} not found`);
  }

  assertValidTransition(current.status, to, id);

  const result = await prisma.paymentIntent.updateMany({
    where: buildGuardedWhere(id, current.status),
    data: { ...data, status: to },
  });

  if (!result || result.count === 0) {
    // Another writer changed the status between our read and write.
    throw new ApiError(
      'CONFLICT',
      `Payment intent ${id} was modified concurrently; status transition to ${to} rejected`
    );
  }

  const updated = await prisma.paymentIntent.findUnique({ where: { id } });
  publishStatusEvent(eventStream, {
    paymentIntentId: id,
    status: to,
    previousStatus: current.status,
    data: updated,
  });
  return updated;
}

/**
 * Publishes a status event to the given stream (or the process-wide default).
 *
 * @param {PaymentIntentEventStream} [eventStream]
 * @param {object} params
 */
function publishStatusEvent(eventStream, params) {
  const stream = eventStream || defaultEventStream;
  if (!stream || typeof stream.publish !== 'function') {
    return null;
  }
  return stream.publish(params);
}

/**
 * Concurrency-safe transition that performs the read, validation, and write
 * inside a single transaction using a conditional update. Prefer this when a
 * transaction client is available.
 *
 * @param {object} prisma - Prisma client
 * @param {object} params
 * @param {string} params.id
 * @param {string} params.to
 * @param {object} [params.data]
 * @returns {Promise<object>}
 */
async function updatePaymentIntentStatusTx(prisma, { id, to, data = {}, eventStream } = {}) {
  if (!ALL_STATUSES.includes(to)) {
    throw new ApiError('CONFLICT', `Unknown payment intent status: ${to}`);
  }

  const { updated, previousStatus } = await prisma.$transaction(async (tx) => {
    const current = await tx.paymentIntent.findUnique({
      where: { id },
      select: { id: true, status: true },
    });

    if (!current) {
      throw new ApiError('NOT_FOUND', `Payment intent ${id} not found`);
    }

    assertValidTransition(current.status, to, id);

    const result = await tx.paymentIntent.updateMany({
      where: buildGuardedWhere(id, current.status),
      data: { ...data, status: to },
    });

    if (!result || result.count === 0) {
      throw new ApiError(
        'CONFLICT',
        `Payment intent ${id} was modified concurrently; status transition to ${to} rejected`
      );
    }

    const record = await tx.paymentIntent.findUnique({ where: { id } });
    return { updated: record, previousStatus: current.status };
  });

  // Publish only after the transaction commits so subscribers never observe
  // events for rolled-back transitions.
  publishStatusEvent(eventStream, {
    paymentIntentId: id,
    status: to,
    previousStatus,
    data: updated,
  });
  return updated;
}

module.exports = {
  VALID_TRANSITIONS,
  ALL_STATUSES,
  DEFAULT_MAX_SSE_CONNECTIONS,
  DEFAULT_SSE_HEARTBEAT_MS,
  PaymentIntentEventStream,
  defaultEventStream,
  isValidTransition,
  assertValidTransition,
  buildGuardedWhere,
  publishStatusEvent,
  updatePaymentIntentStatus,
  updatePaymentIntentStatusTx,
};
'use strict';

const { CONFLICT } = require('../errors');

/**
 * Registration service.
 *
 * Handles username registration against an address. Registration is
 * idempotent for an identical username+address pair: re-registering the
 * same pair returns success with `already_registered: true` instead of
 * throwing a conflict. A username that belongs to a different address is
 * still a genuine conflict.
 *
 * Soft-delete / username reuse semantics (issue #406):
 *
 * - Reservation duration: when a username is soft-deleted it stays reserved
 *   to its previous owner for `RESERVATION_MS` (30 days). During this window
 *   the username cannot be registered by anyone else.
 * - Restoration proof: the previous owner may restore the username at any
 *   time during the reservation window by presenting the same address that
 *   owned it. A mismatched address is rejected as a conflict.
 * - Post-expiry reuse: once the reservation window has elapsed the username
 *   becomes freely reusable by any address, and the previous owner loses the
 *   exclusive right to restore it.
 * - Transactional transitions: delete, restore, and registration are applied
 *   through the database's atomic transition primitives so that concurrent
 *   operations cannot produce multiple owners for the same username.
 *
 * Versioned event metadata (issue #407):
 *
 * Persisted registration events carry a JSON metadata envelope with an
 * explicit schema identifier. Before an event is written to the database it
 * is validated against its declared schema version. Historical rows written
 * before versioning existed (no `schema` field) are adapted to the current
 * schema on read. Events declaring an unknown future schema version are
 * treated as forward-incompatible: they are retained (never dropped) but are
 * not re-emitted or mutated, so a newer writer's data survives a downgrade.
 */

const MAX_ALIASES_PER_ADDRESS = 5;

// How long a soft-deleted username stays reserved to its previous owner.
const RESERVATION_MS = 30 * 24 * 60 * 60 * 1000;

// Schema identifier stamped onto every persisted registration event.
const EVENT_SCHEMA = 'registration.event';
const EVENT_SCHEMA_VERSION = 1;

// Highest schema version this build understands. Anything above is a future
// version and is retained but not interpreted.
const SUPPORTED_EVENT_SCHEMA_VERSION = EVENT_SCHEMA_VERSION;

const EVENT_TYPES = Object.freeze({
  REGISTERED: 'registered',
  SOFT_DELETED: 'soft_deleted',
  RESTORED: 'restored',
});

class RegistrationService {
  constructor(db, { now = () => Date.now() } = {}) {
    this.db = db;
    this.now = now;
  }

  /**
   * Register a username for an address.
   *
   * @param {string} username
   * @param {string} address
   * @returns {Promise<{ ok: true, already_registered: boolean }>}
   * @throws {Error} CONFLICT when the username is taken by a different address
   *                 or the address has reached its alias limit.
   */
  async register(username, address) {
    const existing = await this.db.getRegistration(username);

    if (existing) {
      if (existing.address === address) {
        // Idempotent re-registration of the exact same pair.
        return { ok: true, already_registered: true };
      }

      if (existing.deleted_at) {
        // Soft-deleted username: reusable only after the reservation expires.
        if (!this._isReservationExpired(existing)) {
          throw new CONFLICT(
            'Username is reserved by its previous owner until the reservation expires'
          );
        }
      } else {
        // Username is taken by a different address.
        throw new CONFLICT('Username already registered to a different address');
      }
    }

    const aliasCount = await this.db.countAliasesForAddress(address);
    if (aliasCount >= MAX_ALIASES_PER_ADDRESS) {
      throw new CONFLICT('Address has reached the maximum number of aliases');
    }

    // Atomic transition: only succeeds if the username is still free or its
    // reservation has expired, preventing concurrent registrations from
    // producing multiple owners.
    const created = await this.db.createRegistration(username, address, {
      expectedDeletedAt: existing ? existing.deleted_at : null,
      reservationExpiredAt: existing ? this._reservationExpiresAt(existing) : null,
      event: this._buildEvent(EVENT_TYPES.REGISTERED, { username, address }),
    });

    if (created === false) {
      throw new CONFLICT('Username was claimed concurrently');
    }

    return { ok: true, already_registered: false };
  }

  /**
   * Soft-delete a username owned by `address`.
   *
   * @param {string} username
   * @param {string} address
   * @returns {Promise<{ ok: true, reserved_until: number }>}
   * @throws {Error} CONFLICT when the username is not owned by `address`.
   */
  async softDelete(username, address) {
    const existing = await this.db.getRegistration(username);

    if (!existing || existing.address !== address || existing.deleted_at) {
      throw new CONFLICT('Username is not owned by this address');
    }

    const deletedAt = this.now();
    const deleted = await this.db.softDeleteRegistration(username, address, {
      deletedAt,
      expectedDeletedAt: null,
      event: this._buildEvent(EVENT_TYPES.SOFT_DELETED, {
        username,
        address,
        deleted_at: deletedAt,
        reserved_until: deletedAt + RESERVATION_MS,
      }),
    });

    if (deleted === false) {
      throw new CONFLICT('Username was modified concurrently');
    }

    return { ok: true, reserved_until: deletedAt + RESERVATION_MS };
  }

  /**
   * Restore a soft-deleted username for its previous owner.
   *
   * @param {string} username
   * @param {string} address
   * @returns {Promise<{ ok: true }>}
   * @throws {Error} CONFLICT when the username is not soft-deleted, is owned
   *                 by a different address, or the reservation has expired.
   */
  async restore(username, address) {
    const existing = await this.db.getRegistration(username);

    if (!existing || !existing.deleted_at) {
      throw new CONFLICT('Username is not soft-deleted');
    }

    if (existing.address !== address) {
      throw new CONFLICT('Username is not owned by this address');
    }

    if (this._isReservationExpired(existing)) {
      throw new CONFLICT('Reservation has expired; username is no longer restorable');
    }

    const restored = await this.db.restoreRegistration(username, address, {
      expectedDeletedAt: existing.deleted_at,
      event: this._buildEvent(EVENT_TYPES.RESTORED, { username, address }),
    });

    if (restored === false) {
      throw new CONFLICT('Username was modified concurrently');
    }

    return { ok: true };
  }

  /**
   * Build a versioned event metadata envelope for persistence.
   *
   * The envelope is validated against its declared schema version before it
   * is handed to the database layer, so malformed payloads never reach
   * storage.
   *
   * @param {string} type
   * @param {object} data
   * @returns {{ schema: string, version: number, type: string, data: object }}
   */
  _buildEvent(type, data) {
    const event = {
      schema: EVENT_SCHEMA,
      version: EVENT_SCHEMA_VERSION,
      type,
      data,
    };
    this._validateEvent(event);
    return event;
  }

  /**
   * Validate an event envelope against its declared schema version.
   *
   * @param {object} event
   * @throws {Error} when the envelope is malformed or declares an
   *                 unsupported schema version.
   */
  _validateEvent(event) {
    if (!event || typeof event !== 'object') {
      throw new Error('Event metadata must be an object');
    }
    if (event.schema !== EVENT_SCHEMA) {
      throw new Error(`Unknown event schema: ${event.schema}`);
    }
    if (!Number.isInteger(event.version) || event.version < 1) {
      throw new Error(`Invalid event schema version: ${event.version}`);
    }
    if (event.version > SUPPORTED_EVENT_SCHEMA_VERSION) {
      throw new Error(
        `Unsupported future event schema version: ${event.version}`
      );
    }
    if (!Object.values(EVENT_TYPES).includes(event.type)) {
      throw new Error(`Unknown event type: ${event.type}`);
    }
    if (!event.data || typeof event.data !== 'object') {
      throw new Error('Event data must be an object');
    }
  }

  /**
   * Adapt a persisted event row to the current schema.
   *
   * - Historical unversioned rows (no `schema`/`version`) are upgraded to the
   *   current schema version.
   * - Rows declaring an unknown future version are retained as-is and flagged
   *   `forward_incompatible: true` so callers can skip interpretation without
   *   discarding data.
   *
   * @param {object} row
   * @returns {object}
   */
  adaptEvent(row) {
    if (!row || typeof row !== 'object') {
      throw new Error('Event row must be an object');
    }

    if (row.schema === undefined && row.version === undefined) {
      // Historical unversioned row: upgrade in place.
      return {
        ...row,
        schema: EVENT_SCHEMA,
        version: EVENT_SCHEMA_VERSION,
        adapted: true,
      };
    }

    if (
      row.schema === EVENT_SCHEMA &&
      Number.isInteger(row.version) &&
      row.version > SUPPORTED_EVENT_SCHEMA_VERSION
    ) {
      // Unknown future version: retain, do not interpret.
      return { ...row, forward_incompatible: true };
    }

    this._validateEvent(row);
    return { ...row, adapted: false };
  }

  _reservationExpiresAt(registration) {
    return registration.deleted_at + RESERVATION_MS;
  }

  _isReservationExpired(registration) {
    return this.now() >= this._reservationExpiresAt(registration);
  }
}

RegistrationService.RESERVATION_MS = RESERVATION_MS;
RegistrationService.EVENT_SCHEMA = EVENT_SCHEMA;
RegistrationService.EVENT_SCHEMA_VERSION = EVENT_SCHEMA_VERSION;
RegistrationService.SUPPORTED_EVENT_SCHEMA_VERSION = SUPPORTED_EVENT_SCHEMA_VERSION;
RegistrationService.EVENT_TYPES = EVENT_TYPES;

module.exports = RegistrationService;

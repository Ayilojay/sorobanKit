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
 */

const MAX_ALIASES_PER_ADDRESS = 5;

// How long a soft-deleted username stays reserved to its previous owner.
const RESERVATION_MS = 30 * 24 * 60 * 60 * 1000;

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
    });

    if (restored === false) {
      throw new CONFLICT('Username was modified concurrently');
    }

    return { ok: true };
  }

  _reservationExpiresAt(registration) {
    return registration.deleted_at + RESERVATION_MS;
  }

  _isReservationExpired(registration) {
    return this.now() >= this._reservationExpiresAt(registration);
  }
}

RegistrationService.RESERVATION_MS = RESERVATION_MS;

module.exports = RegistrationService;

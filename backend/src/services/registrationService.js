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
 * The service also exposes a snapshot-based upgrade simulation used to
 * validate candidate migrations against representative ledger snapshots
 * before they are applied to live state.
 */

const MAX_ALIASES_PER_ADDRESS = 5;

// State versions this service knows how to read and migrate.
const SUPPORTED_STATE_VERSIONS = Object.freeze([1, 2, 3]);
const LATEST_STATE_VERSION = SUPPORTED_STATE_VERSIONS[SUPPORTED_STATE_VERSIONS.length - 1];

class RegistrationService {
  constructor(db) {
    this.db = db;
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

      // Username is taken by a different address.
      throw new CONFLICT('Username already registered to a different address');
    }

    const aliasCount = await this.db.countAliasesForAddress(address);
    if (aliasCount >= MAX_ALIASES_PER_ADDRESS) {
      throw new CONFLICT('Address has reached the maximum number of aliases');
    }

    await this.db.createRegistration(username, address);

    return { ok: true, already_registered: false };
  }

  /**
   * Simulate a contract upgrade against a representative ledger snapshot.
   *
   * The snapshot is validated (layout + state version) BEFORE any mutation is
   * performed. Unsupported layouts or state versions are rejected up front so
   * a candidate migration can never partially mutate an unknown layout.
   *
   * @param {object} snapshot representative ledger snapshot
   * @param {object} [options]
   * @param {number} [options.targetVersion] desired state version
   * @param {Function} [options.migrate] candidate migration applied per step
   * @returns {Promise<{ ok: boolean, fromVersion: number, toVersion: number,
   *   applied: number[], reads: object, invariants: object[] }>}
   * @throws {Error} CONFLICT when the snapshot layout/version is unsupported
   */
  async simulateUpgrade(snapshot, options = {}) {
    const targetVersion = options.targetVersion == null
      ? LATEST_STATE_VERSION
      : options.targetVersion;

    // Validate BEFORE any mutation.
    this._assertSupportedSnapshot(snapshot);
    if (!SUPPORTED_STATE_VERSIONS.includes(targetVersion)) {
      throw new CONFLICT(`Unsupported target state version: ${targetVersion}`);
    }
    if (targetVersion < snapshot.stateVersion) {
      throw new CONFLICT(
        `Cannot downgrade from state version ${snapshot.stateVersion} to ${targetVersion}`
      );
    }

    // Work on a deep copy so the caller's snapshot is never mutated.
    const working = JSON.parse(JSON.stringify(snapshot));
    const applied = [];

    for (let v = working.stateVersion; v < targetVersion; v += 1) {
      const next = v + 1;
      if (typeof options.migrate === 'function') {
        await options.migrate(working, v, next);
      }
      working.stateVersion = next;
      applied.push(next);
    }

    const reads = await this._runCriticalReads(working);
    const invariants = this._checkInvariants(working);

    return {
      ok: invariants.every((inv) => inv.ok),
      fromVersion: snapshot.stateVersion,
      toVersion: working.stateVersion,
      applied,
      reads,
      invariants,
    };
  }

  /**
   * Reject unsupported snapshot layouts/state versions before mutation.
   * @private
   */
  _assertSupportedSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') {
      throw new CONFLICT('Snapshot must be an object');
    }
    if (!Number.isInteger(snapshot.stateVersion)) {
      throw new CONFLICT('Snapshot is missing a valid stateVersion');
    }
    if (!SUPPORTED_STATE_VERSIONS.includes(snapshot.stateVersion)) {
      throw new CONFLICT(`Unsupported snapshot state version: ${snapshot.stateVersion}`);
    }
    if (!Array.isArray(snapshot.registrations)) {
      throw new CONFLICT('Unsupported snapshot layout: registrations must be an array');
    }
    for (const entry of snapshot.registrations) {
      if (!entry || typeof entry.username !== 'string' || typeof entry.address !== 'string') {
        throw new CONFLICT('Unsupported snapshot layout: malformed registration entry');
      }
    }
  }

  /**
   * Run critical reads against the migrated snapshot.
   * @private
   */
  async _runCriticalReads(working) {
    const byUsername = new Map();
    const byAddress = new Map();
    for (const entry of working.registrations) {
      byUsername.set(entry.username, entry.address);
      byAddress.set(entry.address, (byAddress.get(entry.address) || 0) + 1);
    }
    return {
      registrationCount: working.registrations.length,
      uniqueUsernames: byUsername.size,
      uniqueAddresses: byAddress.size,
    };
  }

  /**
   * Check invariants that must hold after migration.
   * @private
   */
  _checkInvariants(working) {
    const seen = new Set();
    const perAddress = new Map();
    let uniqueUsernames = true;
    let aliasLimitRespected = true;

    for (const entry of working.registrations) {
      if (seen.has(entry.username)) {
        uniqueUsernames = false;
      }
      seen.add(entry.username);

      const count = (perAddress.get(entry.address) || 0) + 1;
      perAddress.set(entry.address, count);
      if (count > MAX_ALIASES_PER_ADDRESS) {
        aliasLimitRespected = false;
      }
    }

    return [
      { name: 'unique_usernames', ok: uniqueUsernames },
      { name: 'alias_limit_respected', ok: aliasLimitRespected },
      { name: 'state_version_supported', ok: SUPPORTED_STATE_VERSIONS.includes(working.stateVersion) },
    ];
  }
}

RegistrationService.SUPPORTED_STATE_VERSIONS = SUPPORTED_STATE_VERSIONS;
RegistrationService.LATEST_STATE_VERSION = LATEST_STATE_VERSION;

module.exports = RegistrationService;

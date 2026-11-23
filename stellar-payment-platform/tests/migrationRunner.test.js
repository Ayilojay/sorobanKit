'use strict';

/**
 * Focused tests for the production migration runner (issue #388).
 *
 * These tests exercise the advisory-lock behaviour of the migration runner
 * without requiring a live PostgreSQL instance. The runner accepts an
 * injectable "lock client" and "migration executor" so that lock acquisition,
 * contention/waiting, timeout, and release-on-failure can be verified in
 * isolation.
 */

const assert = require('assert');
const {
  runMigrations,
  MigrationLockTimeoutError,
} = require('../src/db/migrationRunner');

/**
 * Build a fake advisory-lock client.
 *
 * @param {object} opts
 * @param {number} [opts.acquireAfterAttempts=1] Number of tryAcquire calls
 *   that fail before the lock is granted. Use Infinity to never grant.
 * @param {boolean} [opts.releaseThrows=false] Whether release() should throw.
 * @returns {object} fake client with call tracking.
 */
function makeFakeLockClient(opts = {}) {
  const acquireAfterAttempts = opts.acquireAfterAttempts ?? 1;
  const releaseThrows = opts.releaseThrows ?? false;

  const calls = {
    tryAcquire: 0,
    release: 0,
    sleep: 0,
  };

  let held = false;

  return {
    calls,
    isHeld() {
      return held;
    },
    async tryAcquire() {
      calls.tryAcquire += 1;
      if (calls.tryAcquire >= acquireAfterAttempts) {
        held = true;
        return true;
      }
      return false;
    },
    async release() {
      calls.release += 1;
      if (releaseThrows) {
        held = false;
        throw new Error('release failed');
      }
      held = false;
    },
    async sleep() {
      calls.sleep += 1;
      // No real delay in tests.
    },
  };
}

/**
 * Build a fake migration executor that records applied migrations.
 */
function makeFakeExecutor(opts = {}) {
  const failOn = opts.failOn ?? null;
  const applied = [];
  const calls = { run: 0 };

  return {
    applied,
    calls,
    async run(migration) {
      calls.run += 1;
      if (failOn && migration.id === failOn) {
        throw new Error(`migration ${migration.id} failed`);
      }
      applied.push(migration.id);
    },
  };
}

const MIGRATIONS = [
  { id: '001_init', sql: 'CREATE TABLE t (id int);' },
  { id: '002_add_column', sql: 'ALTER TABLE t ADD COLUMN name text;' },
];

describe('migrationRunner (issue #388)', () => {
  it('acquires the lock and applies all migrations once', async () => {
    const lock = makeFakeLockClient({ acquireAfterAttempts: 1 });
    const executor = makeFakeExecutor();

    const result = await runMigrations({
      migrations: MIGRATIONS,
      lockClient: lock,
      executor,
      lockTimeoutMs: 1000,
      retryIntervalMs: 10,
    });

    assert.strictEqual(lock.calls.tryAcquire, 1, 'lock acquired on first attempt');
    assert.strictEqual(lock.calls.release, 1, 'lock released exactly once');
    assert.strictEqual(lock.isHeld(), false, 'lock not held after run');
    assert.deepStrictEqual(executor.applied, ['001_init', '002_add_column']);
    assert.deepStrictEqual(result.applied, ['001_init', '002_add_column']);
    assert.strictEqual(result.lockAcquired, true);
  });

  it('waits for a contended lock and then proceeds', async () => {
    // Lock is granted only on the 4th attempt, simulating another replica
    // holding the lock while it runs migrations.
    const lock = makeFakeLockClient({ acquireAfterAttempts: 4 });
    const executor = makeFakeExecutor();

    const result = await runMigrations({
      migrations: MIGRATIONS,
      lockClient: lock,
      executor,
      lockTimeoutMs: 5000,
      retryIntervalMs: 10,
    });

    assert.strictEqual(lock.calls.tryAcquire, 4, 'retried until lock granted');
    assert.strictEqual(lock.calls.sleep, 3, 'slept between failed attempts');
    assert.strictEqual(lock.calls.release, 1, 'lock released after success');
    assert.deepStrictEqual(executor.applied, ['001_init', '002_add_column']);
    assert.strictEqual(result.lockAcquired, true);
  });

  it('times out when the lock cannot be acquired within the bound', async () => {
    // Lock is never granted.
    const lock = makeFakeLockClient({ acquireAfterAttempts: Infinity });
    const executor = makeFakeExecutor();

    await assert.rejects(
      () =>
        runMigrations({
          migrations: MIGRATIONS,
          lockClient: lock,
          executor,
          lockTimeoutMs: 50,
          retryIntervalMs: 10,
        }),
      (err) => {
        assert.ok(
          err instanceof MigrationLockTimeoutError,
          'rejects with MigrationLockTimeoutError'
        );
        assert.strictEqual(err.code, 'MIGRATION_LOCK_TIMEOUT');
        return true;
      }
    );

    assert.ok(lock.calls.tryAcquire > 1, 'retried before timing out');
    assert.strictEqual(executor.calls.run, 0, 'no migrations run without lock');
    assert.strictEqual(lock.calls.release, 0, 'no release when lock never held');
  });

  it('releases the lock when a migration fails', async () => {
    const lock = makeFakeLockClient({ acquireAfterAttempts: 1 });
    const executor = makeFakeExecutor({ failOn: '002_add_column' });

    await assert.rejects(
      () =>
        runMigrations({
          migrations: MIGRATIONS,
          lockClient: lock,
          executor,
          lockTimeoutMs: 1000,
          retryIntervalMs: 10,
        }),
      /migration 002_add_column failed/
    );

    assert.strictEqual(lock.calls.tryAcquire, 1, 'lock acquired once');
    assert.strictEqual(lock.calls.release, 1, 'lock released after failure');
    assert.strictEqual(lock.isHeld(), false, 'lock not held after failure');
    assert.deepStrictEqual(
      executor.applied,
      ['001_init'],
      'only migrations before the failure were applied'
    );
  });

  it('releases the lock even if release itself throws, surfacing the original failure', async () => {
    const lock = makeFakeLockClient({
      acquireAfterAttempts: 1,
      releaseThrows: true,
    });
    const executor = makeFakeExecutor({ failOn: '001_init' });

    await assert.rejects(
      () =>
        runMigrations({
          migrations: MIGRATIONS,
          lockClient: lock,
          executor,
          lockTimeoutMs: 1000,
          retryIntervalMs: 10,
        }),
      /migration 001_init failed/
    );

    assert.strictEqual(lock.calls.release, 1, 'release attempted on failure');
  });

  it('does not run migrations when there are none, but still releases the lock', async () => {
    const lock = makeFakeLockClient({ acquireAfterAttempts: 1 });
    const executor = makeFakeExecutor();

    const result = await runMigrations({
      migrations: [],
      lockClient: lock,
      executor,
      lockTimeoutMs: 1000,
      retryIntervalMs: 10,
    });

    assert.strictEqual(lock.calls.tryAcquire, 1);
    assert.strictEqual(lock.calls.release, 1);
    assert.strictEqual(executor.calls.run, 0);
    assert.deepStrictEqual(result.applied, []);
  });

  it('serializes concurrent runners so each migration is applied once', async () => {
    // Shared lock state simulating a single PostgreSQL advisory lock.
    let held = false;
    const applied = [];

    function makeSharedLockClient() {
      return {
        async tryAcquire() {
          if (held) return false;
          held = true;
          return true;
        },
        async release() {
          held = false;
        },
        async sleep() {
          // Yield to let the other runner make progress.
          await new Promise((resolve) => setImmediate(resolve));
        },
      };
    }

    const executor = {
      async run(migration) {
        // Simulate a small amount of work while holding the lock.
        await new Promise((resolve) => setImmediate(resolve));
        applied.push(migration.id);
      },
    };

    const run = () =>
      runMigrations({
        migrations: MIGRATIONS,
        lockClient: makeSharedLockClient(),
        executor,
        lockTimeoutMs: 5000,
        retryIntervalMs: 1,
      });

    const [a, b] = await Promise.all([run(), run()]);

    assert.strictEqual(held, false, 'lock released by both runners');
    assert.deepStrictEqual(
      applied.slice().sort(),
      ['001_init', '002_add_column'],
      'each migration applied exactly once across concurrent runners'
    );
    assert.deepStrictEqual(a.applied.concat(b.applied).sort(), [
      '001_init',
      '002_add_column',
    ]);
  });
});
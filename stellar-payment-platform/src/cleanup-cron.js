const cron = require('node-cron');
const { logger } = require('./logger');

/**
 * Number of days after which a registration is considered stale.
 * Accounts older than this threshold and not matching any active network
 * address will be removed; those that do match will be flagged instead.
 */
const STALE_THRESHOLD_DAYS = 90;

function getWebhookDlqMaxAgeDays() {
  const configuredDays = Number(process.env.WEBHOOK_DLQ_MAX_AGE_DAYS);
  return Number.isInteger(configuredDays) && configuredDays > 0 ? configuredDays : 30;
}

/**
 * A set of "active" Stellar network addresses that should never be fully
 * removed.  In a real deployment this would be populated dynamically (e.g.
 * by querying Horizon), but a hard-coded set is sufficient for testnet
 * hygiene purposes.
 */
const ACTIVE_NETWORK_ADDRESSES = new Set([
  'GAPUQZH3WZUXHEMUGZN5ZYU4D4GHCFEMOGUINU6MF345GBD2QXNYYIEQ',
]);

/**
 * Runs the stale-account cleanup logic against the provided Prisma client.
 * The function is exported separately so it can be unit-tested without needing
 * a live cron scheduler.
 *
 * Behaviour:
 *   - Registrations older than STALE_THRESHOLD_DAYS whose address is NOT in
 *     ACTIVE_NETWORK_ADDRESSES are permanently deleted.
 *   - Registrations older than STALE_THRESHOLD_DAYS whose address IS in
 *     ACTIVE_NETWORK_ADDRESSES are flagged by setting flaggedAt to the
 *     current timestamp (only if not already flagged).
 *
 * @param {import('@prisma/client').PrismaClient} prisma - A Prisma client.
 * @returns {Promise<{pruned: number, flagged: number}>}
 */
async function runCleanup(prisma) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - STALE_THRESHOLD_DAYS);

  const webhookDlqMaxAgeDays = getWebhookDlqMaxAgeDays();
  const dlqCutoff = new Date();
  dlqCutoff.setDate(dlqCutoff.getDate() - webhookDlqMaxAgeDays);

  const activeAddresses = [...ACTIVE_NETWORK_ADDRESSES];

  // 1. Delete stale rows that are NOT active network addresses.
  const pruneResult = await prisma.user.deleteMany({
    where: {
      createdAt: { lt: cutoff },
      address: { notIn: activeAddresses },
    },
  });

  // 2. Flag stale rows that ARE active network addresses.
  const flagResult = await prisma.user.updateMany({
    where: {
      createdAt: { lt: cutoff },
      address: { in: activeAddresses },
      flaggedAt: null,
    },
    data: { flaggedAt: new Date() },
  });

  const dlqPruneResult = await prisma.webhookDLQ.deleteMany({
    where: { movedAt: { lt: dlqCutoff } },
  });

  const pruned = pruneResult.count;
  const flagged = flagResult.count;
  const dlqPruned = dlqPruneResult.count;

  logger.info('Purge completed', { table: 'User', operation: 'deleteMany', count: pruned });
  logger.info('Purge completed', { table: 'User', operation: 'updateMany', count: flagged });
  logger.info('[cleanup-cron] Pruned old webhook DLQ entries', { count: dlqPruned });

  return { pruned, flagged, dlqPruned };
}

/**
 * Default upper bound (in ms) that `stopCleanupJob` will wait for an in-flight
 * sweep to finish before giving up.  Overridable via the
 * CLEANUP_SHUTDOWN_TIMEOUT_MS environment variable.
 */
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

function getShutdownTimeoutMs() {
  const configured = Number(process.env.CLEANUP_SHUTDOWN_TIMEOUT_MS);
  return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_SHUTDOWN_TIMEOUT_MS;
}

/**
 * Registers a weekly cron job (every Sunday at midnight) that calls
 * `runCleanup` and logs the results.
 *
 * The returned handle exposes `stop({ timeoutMs })`, which prevents any new
 * sweep from starting and awaits the currently in-flight sweep (if any) so
 * that callers can drain background work before closing Prisma.  `stop()` is
 * idempotent and safe to call multiple times.
 *
 * @param {import('@prisma/client').PrismaClient} prisma - A Prisma client.
 * @returns {{ stop: (options?: { timeoutMs?: number }) => Promise<void> }}
 */
function scheduleCleanupJob(prisma) {
  let stopped = false;
  let inFlight = null;
  let stopPromise = null;

  // Cron expression: "0 0 * * 0" → runs at 00:00 every Sunday.
  const task = cron.schedule('0 0 * * 0', async () => {
    if (stopped) {
      logger.info('[cleanup-cron] Sweep skipped: cleanup job is shutting down.');
      return;
    }

    logger.info('[cleanup-cron] Starting stale-account sweep…');
    const run = (async () => {
      try {
        const { pruned, flagged, dlqPruned } = await runCleanup(prisma);
        const total = pruned + flagged + dlqPruned;
        logger.info('[cleanup-cron] Sweep complete', { pruned, flagged, dlqPruned, total });
      } catch (err) {
        logger.error('[cleanup-cron] Sweep failed:', err.message);
      }
    })();

    inFlight = run;
    try {
      await run;
    } finally {
      if (inFlight === run) {
        inFlight = null;
      }
    }
  });

  logger.info('[cleanup-cron] Weekly cleanup job scheduled (Sundays at midnight).');

  /**
   * Stops the scheduled job and drains any in-flight sweep.
   *
   * @param {{ timeoutMs?: number }} [options]
   * @returns {Promise<void>}
   */
  function stop(options = {}) {
    if (stopPromise) {
      return stopPromise;
    }

    stopped = true;

    stopPromise = (async () => {
      try {
        if (task && typeof task.stop === 'function') {
          task.stop();
        } else if (task && typeof task.destroy === 'function') {
          task.destroy();
        }
      } catch (err) {
        logger.error('[cleanup-cron] Failed to stop scheduled job:', err.message);
      }

      const pending = inFlight;
      if (!pending) {
        logger.info('[cleanup-cron] Cleanup job stopped (no in-flight sweep).');
        return;
      }

      const timeoutMs =
        Number.isInteger(options.timeoutMs) && options.timeoutMs > 0
          ? options.timeoutMs
          : getShutdownTimeoutMs();

      let timer = null;
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs);
        if (typeof timer.unref === 'function') {
          timer.unref();
        }
      });

      try {
        const outcome = await Promise.race([pending.then(() => 'drained'), timeout]);
        if (outcome === 'timeout') {
          logger.warn('[cleanup-cron] Timed out waiting for in-flight sweep to drain.', {
            timeoutMs,
          });
        } else {
          logger.info('[cleanup-cron] In-flight sweep drained.');
        }
      } finally {
        if (timer) {
          clearTimeout(timer);
        }
      }
    })();

    return stopPromise;
  }

  return { stop };
}

module.exports = {
  scheduleCleanupJob,
  runCleanup,
  STALE_THRESHOLD_DAYS,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
};

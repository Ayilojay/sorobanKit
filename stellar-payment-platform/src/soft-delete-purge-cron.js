'use strict';

const cron = require('node-cron');
const { logger } = require('./logger');

/**
 * Days after soft-delete before a user row is permanently removed.
 *
 * Configurable via the PURGE_RETENTION_DAYS environment variable so operators
 * on regulated platforms can extend retention for compliance (e.g. 90 or 365
 * days) without code changes.
 *
 * Defaults to 30 days. Values that are not positive integers are rejected at
 * startup to prevent silent misconfiguration.
 */
const _rawRetention = process.env.PURGE_RETENTION_DAYS;
const SOFT_DELETE_RETENTION_DAYS = (() => {
  if (_rawRetention === undefined || _rawRetention === '') return 30;
  const parsed = parseInt(_rawRetention, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      `PURGE_RETENTION_DAYS must be a positive integer, got: "${_rawRetention}"`,
    );
  }
  return parsed;
})();

logger.info(`[soft-delete-purge] Retention window: ${SOFT_DELETE_RETENTION_DAYS} day(s)`);

/**
 * Permanently deletes user rows whose soft-delete timestamp is older than
 * {@link SOFT_DELETE_RETENTION_DAYS} days.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @returns {Promise<number>} Number of purged records.
 */
async function runSoftDeletePurge(prisma) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - SOFT_DELETE_RETENTION_DAYS);

  // Collect the usernames of users eligible for purge so their activity logs
  // can be removed explicitly. This is defense-in-depth: if the schema lacks
  // `onDelete: Cascade` on ActivityLog → User, relying on cascades alone would
  // orphan activity rows or trigger foreign key constraint errors.
  const expiredUsers = await prisma.user.findMany({
    where: {
      deletedAt: { lt: cutoff },
    },
    select: { username: true },
  });

  const usernames = expiredUsers.map((u) => u.username);

  if (usernames.length === 0) {
    return 0;
  }

  const [, result] = await prisma.$transaction([
    prisma.activityLog.deleteMany({
      where: { username: { in: usernames } },
    }),
    prisma.user.deleteMany({
      where: {
        deletedAt: { lt: cutoff },
      },
    }),
  ]);

  return result.count;
}

/**
 * Schedules a daily midnight cron job that purges expired soft-deleted users.
 *
 * The returned handle is shutdown-aware: calling `stop()` prevents any new
 * purge runs from starting and awaits the currently in-flight run (if any),
 * bounded by `timeoutMs`, so the caller can drain the job before closing
 * Prisma. `stop()` is idempotent and safe to call multiple times.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {{ timeoutMs?: number }} [options]
 * @returns {{ stop: (options?: { timeoutMs?: number }) => Promise<void> }}
 */
function scheduleSoftDeletePurgeJob(prisma, options = {}) {
  const defaultTimeoutMs =
    Number.isInteger(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : 30_000;

  let stopped = false;
  let inFlight = null;

  const task = cron.schedule('0 0 * * *', () => {
    if (stopped) {
      logger.info('[soft-delete-purge] Skipping purge run: job is shutting down');
      return;
    }

    logger.info('[soft-delete-purge] Starting soft-delete purge…');
    const run = (async () => {
      try {
        const purged = await runSoftDeletePurge(prisma);
        logger.info('[soft-delete-purge] Soft-delete purge complete', { purged });
      } catch (err) {
        logger.error('[soft-delete-purge] Soft-delete purge failed', { err: err.message });
      }
    })();

    inFlight = run;
    run.finally(() => {
      if (inFlight === run) inFlight = null;
    });
  });

  logger.info('[soft-delete-purge] Daily soft-delete purge job scheduled (midnight)');

  async function stop(stopOptions = {}) {
    if (stopped) {
      // Still await any in-flight run so repeated calls remain safe.
      if (inFlight) await inFlight;
      return;
    }
    stopped = true;

    try {
      if (task && typeof task.stop === 'function') task.stop();
      if (task && typeof task.destroy === 'function') task.destroy();
    } catch (err) {
      logger.error('[soft-delete-purge] Failed to stop cron task', { err: err.message });
    }

    if (!inFlight) {
      logger.info('[soft-delete-purge] Purge job stopped (no in-flight run)');
      return;
    }

    const timeoutMs =
      Number.isInteger(stopOptions.timeoutMs) && stopOptions.timeoutMs > 0
        ? stopOptions.timeoutMs
        : defaultTimeoutMs;

    logger.info('[soft-delete-purge] Waiting for in-flight purge run to drain', { timeoutMs });

    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => {
        logger.warn('[soft-delete-purge] Timed out waiting for in-flight purge run', {
          timeoutMs,
        });
        resolve();
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    });

    try {
      await Promise.race([inFlight, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }

    logger.info('[soft-delete-purge] Purge job stopped');
  }

  return { stop };
}

module.exports = {
  scheduleSoftDeletePurgeJob,
  runSoftDeletePurge,
  SOFT_DELETE_RETENTION_DAYS,
};

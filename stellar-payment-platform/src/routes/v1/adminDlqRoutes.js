'use strict';

const { asyncHandler } = require('../../middleware/asyncHandler');
const { ApiError } = require('../../errors');
const { listDLQEntries, replayFromDLQ } = require('../../webhookWorker');
const {
  ADMIN_PERMISSIONS,
  requirePermission,
  auditAdminAction,
} = require('../../middleware/adminPermissions');

module.exports = (router, adminAuth, getPrisma) => {
  // ── Dead Letter Queue (DLQ) ────────────────────────────────────────────

  /**
   * GET /admin/dlq
   * List dead-letter-queue entries.  Supports optional `?username=` filter,
   * `?limit=` (default 50, max 200), and `?offset=` (default 0).
   */
  router.get(
    '/admin/dlq',
    adminAuth,
    requirePermission(ADMIN_PERMISSIONS.READ),
    asyncHandler(async (req, res, next) => {
      const { prisma } = getPrisma();
      const username =
        typeof req.query.username === 'string'
          ? req.query.username.trim()
          : undefined;
      const limit = Math.min(
        Math.max(parseInt(req.query.limit, 10) || 50, 1),
        200,
      );
      const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

      try {
        const { entries, total } = await listDLQEntries(
          prisma,
          async (sql, params) => {
            // Fallback path not used in normal operation; provide empty impl
            return [];
          },
          { username, limit, offset },
        );

        return res.status(200).json({
          ok: true,
          total,
          limit,
          offset,
          entries: entries.map((e) => ({
            id: e.id,
            webhook_id: e.webhookId,
            webhook_url: e.webhookUrl,
            username: e.username,
            event_type: e.eventType,
            failure_reason: e.failureReason,
            delivery_attempts: e.deliveryAttempts,
            moved_at: (e.movedAt instanceof Date
              ? e.movedAt
              : new Date(e.movedAt)
            ).toISOString(),
            replayed: e.replayed,
            replayed_at: e.replayedAt
              ? (e.replayedAt instanceof Date
                  ? e.replayedAt
                  : new Date(e.replayedAt)
                ).toISOString()
              : null,
          })),
        });
      } catch (error) {
        return next(error);
      }
    }),
  );

  /**
   * POST /admin/dlq/:id/replay
   * Manually replay a dead-letter-queue entry — retries delivery once.
   */
  router.post(
    '/admin/dlq/:id/replay',
    adminAuth,
    requirePermission(ADMIN_PERMISSIONS.OPERATIONAL),
    asyncHandler(async (req, res, next) => {
      const { prisma } = getPrisma();
      const id =
        typeof req.params?.id === 'string' ? req.params.id.trim() : '';

      if (!id) {
        await auditAdminAction(req, {
          action: 'dlq.replay',
          permission: ADMIN_PERMISSIONS.OPERATIONAL,
          outcome: 'failure',
          reason: 'invalid_input',
          target: null,
        });
        return next(new ApiError('INVALID_INPUT', 'DLQ entry id is required in URL path.'));
      }

      try {
        const result = await replayFromDLQ(prisma, async (sql, params) => [], id);

        if (!result.ok) {
          const code = result.error === 'DLQ entry not found' ? 'NOT_FOUND' : 'CONFLICT';
          await auditAdminAction(req, {
            action: 'dlq.replay',
            permission: ADMIN_PERMISSIONS.OPERATIONAL,
            outcome: 'failure',
            reason: result.error,
            target: id,
          });
          return next(new ApiError(code, result.error));
        }

        await auditAdminAction(req, {
          action: 'dlq.replay',
          permission: ADMIN_PERMISSIONS.OPERATIONAL,
          outcome: 'success',
          target: id,
        });

        return res.status(200).json({ ok: true, replayed: true });
      } catch (error) {
        await auditAdminAction(req, {
          action: 'dlq.replay',
          permission: ADMIN_PERMISSIONS.OPERATIONAL,
          outcome: 'failure',
          reason: error && error.message ? error.message : 'unknown_error',
          target: id,
        });
        return next(error);
      }
    }),
  );

};

'use strict';

/**
 * src/routes/v1/adminRoutes.js
 *
 * Admin-only endpoints.  All routes require the ADMIN_API_KEY header or
 * query parameter.
 *
 * Routes
 *  POST /admin/block          – flag (soft-block) an address
 *  GET  /admin/export         – stream transaction records as CSV or JSON
 *  GET  /admin/stats/routing  – fetch historical payment routing statistics
 */
const express = require('express');
const registerAdminExport = require('./adminExport');
const registerAdminDlqRoutes = require('./adminDlqRoutes');
const registerAdminUserRoutes = require('./adminUserRoutes');
const { invalidateFederationCache } = require('../../federationCache');
const { invalidateStatsCache, getCachedStats, buildRoutingStatsCacheKey } = require('../../cache/statsCache');
const { asyncHandler } = require('../../middleware/asyncHandler');
const { validateSchema } = require('../../middleware/validateSchema');
const {
  adminRoutingStatsQuerySchema,
  adminAuditLogsQuerySchema,
} = require('../../schemas');
const { getRoutingStats } = require('../../services/statsService');
const { auditLogMiddleware } = require('../../middleware/auditLog');
const { idempotencyMiddleware } = require('../../../middleware/idempotency');
const { ACTIVITY_ACTIONS, recordActivity } = require('../../services/activityService');
const { PRIMARY_USERNAME_ORDER } = require('../../utils');
const { ApiError } = require('../../errors');
const {
  PERMISSIONS,
  requirePermission,
  auditPermissionDecision,
} = require('../../middleware/adminPermission');
const {
  requireStepUp,
  issueStepUpChallenge,
} = require('../../middleware/stepUp');


module.exports = (redisClient) => {

  const router = express.Router();

  // ── Intercept mutating admin requests for audit logging ───────────────────
  router.use(auditLogMiddleware);

  // ── Idempotency protection for all mutating admin routes (POST/PUT/DELETE).
  // GET endpoints (export, audit-logs) are ignored by the middleware. ────────
  router.use(idempotencyMiddleware(redisClient));

  const getPrisma = () => {
    return require('../../../prismaClient');
  };

  // ── Centralized policy-based authorization ───────────────────────────────
  //
  // Every admin route declares the permission it needs. `requirePermission`
  // resolves the caller's roles/scopes to a permission set, keeps the legacy
  // ADMIN_API_KEY path working as a compatibility fallback (treated as the
  // full administrative role), and records an audit entry for each decision.
  const adminAuth = requirePermission(PERMISSIONS.READ);

  // ── Step-up challenge issuance ───────────────────────────────────────────
  //
  // High-impact actions (contract upgrades, treasury changes, bulk exports)
  // require a short-lived, single-use confirmation bound to the action and a
  // hash of the request payload. Clients obtain the challenge here, then
  // replay the action with the returned token in the `x-step-up-token` header.
  router.post(
    '/admin/step-up/challenge',
    requirePermission(PERMISSIONS.OPERATIONAL),
    asyncHandler(async (req, res) => {
      const { action, payload } = req.body || {};
      if (!action || typeof action !== 'string') {
        throw new ApiError('INVALID_INPUT', 'Missing or invalid action');
      }

      const challenge = await issueStepUpChallenge({
        redisClient,
        req,
        action,
        payload,
      });

      auditPermissionDecision(req, {
        permission: PERMISSIONS.OPERATIONAL,
        outcome: 'granted',
        action: 'step_up_challenge_issued',
        metadata: { stepUpAction: action },
      });

      return res.status(201).json({
        success: true,
        ...challenge,
      });
    }),
  );

  // Bulk exports are high-impact: they require the read permission plus a
  // step-up confirmation bound to the export parameters.
  registerAdminExport(
    router,
    requirePermission(PERMISSIONS.READ),
    getPrisma,
    { stepUp: requireStepUp('admin.export') },
  );

/**
 * @openapi
 * /admin/block:
 *   post:
 *     tags:
 *       - v1
 *     description: POST /admin/block
 *     responses:
 *       200:
 *         description: Success
 */
router.post(
  '/admin/block',
  requirePermission(PERMISSIONS.OPERATIONAL),
  asyncHandler(async (req, res, next) => {
    const { prisma, withTransaction } = getPrisma();
    const { address } = req.body;

    if (!address || typeof address !== 'string') {
      return next(new ApiError('INVALID_INPUT', 'Missing or invalid address'));
    }

    try {
      // #613 dropped the unique index on address, so a single `update` keyed on
      // it no longer resolves. An address can now carry several usernames and
      // blocking it has to flag every one of them.
      const flaggedAt = new Date();
      const { count } = await prisma.user.updateMany({
        where: { address, deletedAt: null },
        data: { flaggedAt },
      });

      if (count === 0) {
        return next(new ApiError('NOT_FOUND', 'Address not found'));
      }

      const blocked = await prisma.user.findMany({
        where: { address, deletedAt: null },
        orderBy: PRIMARY_USERNAME_ORDER,
        select: { username: true },
      });
      const usernames = blocked.map((user) => user.username);

      for (const username of usernames) {
        await invalidateFederationCache(redisClient, address, username);
        await recordActivity(prisma, {
          username,
          action: ACTIVITY_ACTIONS.USER_BLOCKED,
          metadata: { address },
          req,
        });
      }
      await invalidateStatsCache(redisClient);

      return res.status(200).json({
        message: 'Address successfully blocked',
        username: usernames[0],
        usernames,
        address,
        flaggedAt,
      });
    } catch (error) {
      return next(error);
    }
  }));

  registerAdminDlqRoutes(
    router,
    requirePermission(PERMISSIONS.OPERATIONAL),
    getPrisma,
  );

  // ── GET /admin/stats/routing ─────────────────────────────────────────────

  /**
   * Returns historical payment routing aggregation statistics (volume, fees, counts)
   * grouped by day, week, or month with optional date-range and asset filtering.
   *
   * Query parameters:
   *  - startDate (optional) YYYY-MM-DD inclusive lower bound on createdAt
   *  - endDate   (optional) YYYY-MM-DD inclusive upper bound on createdAt
   *  - groupBy   (optional) 'day' (default) | 'week' | 'month'
   *  - interval  (optional) alias for groupBy
   *  - assetCode (optional) filter by asset code
   */
  router.get(
    '/admin/stats/routing',
    requirePermission(PERMISSIONS.READ),
    validateSchema({ query: adminRoutingStatsQuerySchema }),
    asyncHandler(async (req, res) => {
      const { startDate, endDate, groupBy, interval, assetCode } = req.query;
      const { prisma } = getPrisma();

      const resolvedGroupBy = interval || groupBy || 'day';

      const cacheKey = buildRoutingStatsCacheKey({
        startDate,
        endDate,
        groupBy: resolvedGroupBy,
        assetCode,
      });

      const stats = await getCachedStats(
        redisClient,
        () =>
          getRoutingStats({
            prisma,
            startDate,
            endDate,
            groupBy: resolvedGroupBy,
            assetCode,
          }),
        { key: cacheKey },
      );

      return res.status(200).json({
        success: true,
        ...stats,
      });
    }),
  );

  registerAdminUserRoutes(
    router,
    requirePermission(PERMISSIONS.CONFIGURATION),
    getPrisma,
  );

  // ── GET /admin/audit-logs ────────────────────────────────────────────────

  /**
   * Retrieves recent admin audit logs.
   *
   * Query parameters:
   *  - limit (optional) integer between 1 and 100, default 50
   */
  
/**
 * @openapi
 * /admin/audit-logs:
 *   get:
 *     tags:
 *       - v1
 *     description: GET /admin/audit-logs
 *     responses:
 *       200:
 *         description: Success
 */
router.get(
    '/admin/audit-logs',
    requirePermission(PERMISSIONS.READ),
    validateSchema({ query: adminAuditLogsQuerySchema }),
    asyncHandler(async (req, res) => {
      const { prisma } = getPrisma();
      const limit = req.query.limit;
      const logs = await prisma.auditLog.findMany({
        take: limit,
        orderBy: { createdAt: 'desc' },
      });

      return res.status(200).json({
        success: true,
        count: logs.length,
        data: logs,
      });
    }),
  );

  return router;
};

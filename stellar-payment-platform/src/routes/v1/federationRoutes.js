const express = require('express');
const crypto = require('crypto');
const { prisma } = require('../../../prismaClient');
const { normalizeNameTag, etagCache, USER_DATABASE } = require('../../db');
const { PRIMARY_USERNAME_ORDER } = require('../../utils');
const {
  federationNameKey,
  federationIdKey,
  federationLookupCached,
} = require('../../cache');
const { validateSchema } = require('../../middleware/validateSchema');
const { ApiError } = require('../../errors');
const { federationQuerySchema } = require('../../schemas');
const { asyncHandler } = require('../../middleware/asyncHandler');
const { observeSli, statusClassFromStatusCode } = require('../../metrics/sloMetrics');

/**
 * Canonical JSON serialization: object keys are sorted recursively so the
 * same logical payload always produces the same byte sequence (and ETag).
 */
function canonicalize(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function computeEtag(body) {
  const digest = crypto.createHash('sha256').update(canonicalize(body)).digest('base64url');
  return `"${digest}"`;
}

function etagMatches(ifNoneMatch, etag) {
  if (!ifNoneMatch) return false;
  if (ifNoneMatch.trim() === '*') return true;
  return ifNoneMatch
    .split(',')
    .map((candidate) => candidate.trim().replace(/^W\//, ''))
    .some((candidate) => candidate === etag);
}

/**
 * Attaches a strong ETag derived from the canonical response body, honors
 * If-None-Match with a 304, and sets caching headers. Authorization-dependent
 * responses are never shared-cached.
 */
function federationEtag({ isPublic }) {
  return (req, res, next) => {
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      const etag = computeEtag(body);
      res.set('ETag', etag);

      const publicResponse = typeof isPublic === 'function' ? isPublic(req) : Boolean(isPublic);
      if (publicResponse) {
        res.set('Cache-Control', 'public, max-age=0, must-revalidate');
      } else {
        res.set('Cache-Control', 'private, no-store');
        res.set('Vary', 'Authorization');
      }

      if (etagMatches(req.headers['if-none-match'], etag)) {
        res.status(304);
        return res.end();
      }

      return originalJson(body);
    };
    next();
  };
}

module.exports = (redisClient) => {
  const router = express.Router();

/**
 * @openapi
 * /federation:
 *   get:
 *     tags:
 *       - v1
 *     description: >-
 *       Public federation lookup. This endpoint is intentionally unauthenticated
 *       and does not require a request principal: federation addresses are
 *       public directory data, so no ownership context is applied here.
 *     parameters:
 *       - in: query
 *         name: q
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: type
 *         schema:
 *           type: string
 *           enum: [id, name]
 *     responses:
 *       200:
 *         description: Success
 *       404:
 *         description: Address or name tag not found
 */
router.get(
  '/federation',
  etagCache,
  // Federation lookups are public metadata, but responses may vary by
  // authorization (e.g. hidden/deleted accounts); keep them out of shared
  // caches unless the request is unauthenticated.
  federationEtag({ isPublic: (req) => !req.headers.authorization }),
  validateSchema({ query: federationQuerySchema }),
  asyncHandler(async (req, res, next) => {
    // NOTE: Public read — no principal/ownership check by design (#383).
    const { q: queryValue, type } = req.query;
    const startedAt = process.hrtime.bigint();
    const operation = type === 'id' ? 'federation_lookup_id' : 'federation_lookup_name';

    const recordOutcome = (statusCode) => {
      observeSli({
        operation,
        statusClass: statusClassFromStatusCode(statusCode),
        durationSeconds: Number(process.hrtime.bigint() - startedAt) / 1e9,
      });
    };

    try {
      if (type === 'id') {
        const cacheKey = federationIdKey(queryValue);
        const cached = await federationLookupCached(cacheKey, async () => {
          // #613 — an address can have several usernames; a reverse lookup
          // resolves to the primary one.
          const row = await prisma.user.findFirst({
            where: { address: { equals: queryValue, mode: 'insensitive' }, deletedAt: null },
            select: { username: true, address: true, memoType: true, memo: true },
            orderBy: PRIMARY_USERNAME_ORDER,
          });

          if (!row) return null;

          const domain = process.env.DOMAIN || 'localhost';
          const stellar_address = row.username.includes('*') ? row.username : `${row.username}*${domain}`;
          const response = {
            stellar_address,
            account_id: row.address,
          };
          if (row.memoType) {
            response.memo_type = row.memoType;
            response.memo = row.memo;
          }
          return response;
        });

        if (!cached) {
          recordOutcome(404);
          const notFoundError = new Error('Address not found');
          notFoundError.statusCode = 404;
          return next(notFoundError);
        }

        recordOutcome(200);
        return res.json(cached);
      } else if (type === 'name' || !type) {
        const nameTag = normalizeNameTag(queryValue);
        const queryName = nameTag.toLowerCase();
        const cacheKey = federationNameKey(queryName);

        const cached = await federationLookupCached(cacheKey, async () => {
          const row = await prisma.user.findFirst({
            where: { username: queryName, deletedAt: null },
            select: { username: true, address: true, memoType: true, memo: true },
          });

          const address = row?.address || USER_DATABASE[queryName];
          if (!address) return null;

          const response = {
            stellar_address: queryName,
            account_id: address,
          };
          if (row?.memoType) {
            response.memo_type = row.memoType;
            response.memo = row.memo;
          }
          return response;
        });

        if (!cached) {
          recordOutcome(404);
          const notFoundError = new Error('Name tag not found');
          notFoundError.statusCode = 404;
          return next(notFoundError);
        }

        recordOutcome(200);
        return res.json(cached);
      } else {
        recordOutcome(400);
        return next(
          new ApiError('INVALID_INPUT', "Unsupported query type. Supported types: 'id', 'name'"),
        );
      }
    } catch (error) {
      console.log("FEDERATION LOOKUP ERROR:", error);
      recordOutcome(500);
      const dbError = new Error('Database lookup failed', { cause: error });
      dbError.statusCode = 500;
      return next(dbError);
    }
  }),
  );

  return router;
};

module.exports.canonicalize = canonicalize;
module.exports.computeEtag = computeEtag;
module.exports.etagMatches = etagMatches;
module.exports.federationEtag = federationEtag;
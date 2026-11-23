'use strict';

/**
 * #599 — Self-service activity trail.
 *
 * Records the account-affecting events a user can review for their own
 * username. Writes never propagate a failure to the caller: an activity row is
 * a record of the request, not part of it, so a logging outage must not turn a
 * successful registration into a 500.
 */

const { logger } = require('../logger');

// #382 — Per-network Horizon stream cursors. A cursor is only ever advanced in
// the same transaction that records the effects of the page it covers, so a
// crash mid-page replays that page instead of skipping it. Replays are safe
// because effect recording is idempotent on (network, paging_token, effect_id).
const STREAM_CURSOR_MODEL = 'streamCursor';
const STREAM_EFFECT_MODEL = 'streamEffect';

const ACTIVITY_ACTIONS = {
  USER_REGISTERED: 'user.registered',
  USER_UNREGISTERED: 'user.unregistered',
  ALIAS_REMOVED: 'alias.removed',
  USER_TRANSFERRED: 'user.transferred',
  USER_BLOCKED: 'user.blocked',
  WEBHOOK_CREATED: 'webhook.created',
  WEBHOOK_DELETED: 'webhook.deleted',
};

const MAX_METADATA_BYTES = 2 * 1024;
const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 20;

const clientIp = (req) => {
  const forwarded = req?.headers?.['x-forwarded-for'];
  if (forwarded) {
    const first = typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : forwarded[0];
    if (first) return first;
  }
  return req?.ip || req?.socket?.remoteAddress || null;
};

/**
 * Drops metadata that would bloat a row. The trail is meant to be skimmed, so
 * an oversized blob is worth less than the event it belongs to.
 */
const boundMetadata = (metadata) => {
  if (metadata === null || metadata === undefined) return null;
  try {
    if (Buffer.byteLength(JSON.stringify(metadata), 'utf8') > MAX_METADATA_BYTES) {
      return { truncated: true };
    }
    return metadata;
  } catch {
    return null;
  }
};

/**
 * Writes one activity row. Resolves to null instead of throwing when the write
 * fails, so callers can await it inline without guarding.
 */
const recordActivity = async (prisma, { username, action, metadata = null, req = null }) => {
  if (!username || !action) return null;

  try {
    return await prisma.activityLog.create({
      data: {
        username,
        action,
        metadata: boundMetadata(metadata),
        ipAddress: req ? clientIp(req) : null,
      },
    });
  } catch (err) {
    logger.error(err, `[activity] Failed to record ${action} for ${username}`);
    return null;
  }
};

const streamCursorDelegate = (prisma) => prisma[STREAM_CURSOR_MODEL] || null;
const streamEffectDelegate = (prisma) => prisma[STREAM_EFFECT_MODEL] || null;

/**
 * Reads the last committed cursor for a network, or null when the stream has
 * never been processed. Callers resume Horizon scans from this value.
 */
const getStreamCursor = async (prisma, network) => {
  if (!network) throw new Error('network is required');
  const delegate = streamCursorDelegate(prisma);
  if (!delegate) return null;

  const row = await delegate.findUnique({ where: { network } });
  return row ? row.cursor : null;
};

/**
 * Processes one page of effects and commits the new cursor atomically.
 *
 * `effects` must already be normalized to `{ effectId, pagingToken, payload }`.
 * The whole page is written in a single transaction: either every effect is
 * recorded and the cursor advances, or nothing changes and the page is
 * replayed on the next poll. Duplicate effects (same network + paging token +
 * effect id) are skipped, so replaying a page is idempotent.
 *
 * @returns {{ committed: boolean, cursor: string|null, recorded: number }}
 */
const commitStreamPage = async (prisma, { network, effects = [], cursor, applyEffects = null }) => {
  if (!network) throw new Error('network is required');
  if (!cursor) throw new Error('cursor is required');

  const cursorDelegate = streamCursorDelegate(prisma);
  const effectDelegate = streamEffectDelegate(prisma);
  if (!cursorDelegate || !effectDelegate) {
    throw new Error('stream cursor storage is not available');
  }

  return prisma.$transaction(async (tx) => {
    let recorded = 0;

    for (const effect of effects) {
      if (!effect || !effect.effectId || !effect.pagingToken) continue;

      const existing = await tx[STREAM_EFFECT_MODEL].findUnique({
        where: {
          network_pagingToken_effectId: {
            network,
            pagingToken: effect.pagingToken,
            effectId: effect.effectId,
          },
        },
      });
      if (existing) continue;

      await tx[STREAM_EFFECT_MODEL].create({
        data: {
          network,
          pagingToken: effect.pagingToken,
          effectId: effect.effectId,
          payload: effect.payload ?? null,
        },
      });
      recorded += 1;
    }

    // Side effects that must land with the cursor (e.g. payment rows) run
    // inside the same transaction so they cannot outlive a rolled-back cursor.
    if (typeof applyEffects === 'function') {
      await applyEffects(tx, { network, effects });
    }

    await tx[STREAM_CURSOR_MODEL].upsert({
      where: { network },
      create: { network, cursor },
      update: { cursor },
    });

    return { committed: true, cursor, recorded };
  });
};

/**
 * Parses the optional `startDate` / `endDate` query params.
 * @returns {{ range: object|null, error: string|null }}
 */
const parseDateRange = ({ startDate, endDate } = {}) => {
  const bounds = {};

  if (startDate) {
    const gte = new Date(startDate);
    if (Number.isNaN(gte.getTime())) return { range: null, error: 'Invalid startDate' };
    bounds.gte = gte;
  }

  if (endDate) {
    const lte = new Date(endDate);
    if (Number.isNaN(lte.getTime())) return { range: null, error: 'Invalid endDate' };
    bounds.lte = lte;
  }

  if (bounds.gte && bounds.lte && bounds.gte > bounds.lte) {
    return { range: null, error: 'startDate must not be after endDate' };
  }

  return { range: Object.keys(bounds).length > 0 ? bounds : null, error: null };
};

/**
 * One page of a user's trail, newest first. `id` breaks ties so rows written in
 * the same millisecond keep a stable order across pages.
 */
const listActivity = async (prisma, { username, page = 1, limit = DEFAULT_PAGE_SIZE, range = null }) => {
  const take = Math.min(MAX_PAGE_SIZE, Math.max(1, limit));
  const skip = (Math.max(1, page) - 1) * take;
  const where = { username, ...(range && { createdAt: range }) };

  const [total, rows] = await Promise.all([
    prisma.activityLog.count({ where }),
    prisma.activityLog.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip,
      take,
    }),
  ]);

  return { rows, total };
};

// ip_address is intentionally excluded: admin-initiated actions (e.g. blocks)
// are recorded under the target user's trail with the admin's IP, which would
// leak the admin's address to the user viewing their own activity.
const serializeActivity = (row) => ({
  id: row.id,
  action: row.action,
  metadata: row.metadata ?? null,
  created_at: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
});

module.exports = {
  ACTIVITY_ACTIONS,
  recordActivity,
  listActivity,
  parseDateRange,
  serializeActivity,
  clientIp,
  getStreamCursor,
  commitStreamPage,
  MAX_METADATA_BYTES,
  MAX_PAGE_SIZE,
  DEFAULT_PAGE_SIZE,
};

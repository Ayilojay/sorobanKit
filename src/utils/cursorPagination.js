'use strict';

/**
 * Opaque cursor pagination for mutable collections.
 *
 * Cursors encode { createdAt, id } in base64-JSON for stable tie-break ordering.
 * A snapshot boundary (snapshotAt) is embedded in the cursor so that records
 * inserted after the first page are excluded from subsequent pages.
 *
 * Collection type is embedded in the cursor to prevent cross-collection reuse.
 */

const CURSOR_VERSION = 1;

class CursorError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'CursorError';
    this.code = code || 'CURSOR_INVALID';
  }
}

function encodeCursor({ createdAt, id, collection, snapshotAt }) {
  const payload = JSON.stringify({ v: CURSOR_VERSION, createdAt, id, collection, snapshotAt });
  return Buffer.from(payload, 'utf8').toString('base64url');
}

function decodeCursor(cursor, expectedCollection) {
  let payload;
  try {
    payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new CursorError('Malformed cursor', 'CURSOR_MALFORMED');
  }

  if (payload.v !== CURSOR_VERSION) {
    throw new CursorError(`Unsupported cursor version: ${payload.v}`, 'CURSOR_VERSION_MISMATCH');
  }

  if (payload.collection !== expectedCollection) {
    throw new CursorError(
      `Cursor is for collection "${payload.collection}", expected "${expectedCollection}"`,
      'CURSOR_COLLECTION_MISMATCH'
    );
  }

  if (!payload.createdAt || !payload.id || !payload.snapshotAt) {
    throw new CursorError('Cursor missing required fields', 'CURSOR_MALFORMED');
  }

  return {
    createdAt: payload.createdAt,
    id: payload.id,
    collection: payload.collection,
    snapshotAt: payload.snapshotAt,
  };
}

/**
 * Build the WHERE clause additions for cursor-based pagination.
 *
 * Returns:
 *   snapshotAt  — ISO timestamp; records created after this are excluded
 *   afterCreatedAt / afterId — tie-break position for the next page
 */
function buildCursorQuery(cursor, collection) {
  if (!cursor) {
    return { snapshotAt: new Date().toISOString(), afterCreatedAt: null, afterId: null };
  }
  const decoded = decodeCursor(cursor, collection);
  return {
    snapshotAt: decoded.snapshotAt,
    afterCreatedAt: decoded.createdAt,
    afterId: decoded.id,
  };
}

/**
 * Given the last item in a result page, produce the next-page cursor.
 * Returns null when there are no more results.
 */
function buildNextCursor({ items, hasMore, collection, snapshotAt }) {
  if (!hasMore || !items || items.length === 0) return null;
  const last = items[items.length - 1];
  return encodeCursor({
    createdAt: last.createdAt instanceof Date ? last.createdAt.toISOString() : last.createdAt,
    id: last.id,
    collection,
    snapshotAt,
  });
}

module.exports = { encodeCursor, decodeCursor, buildCursorQuery, buildNextCursor, CursorError };

'use strict';

const {
  encodeCursor,
  decodeCursor,
  buildCursorQuery,
  buildNextCursor,
  CursorError,
} = require('./cursorPagination');

const COLLECTION = 'payments';
const SNAP = '2024-01-01T00:00:00.000Z';

describe('encodeCursor / decodeCursor', () => {
  it('round-trips a cursor', () => {
    const cursor = encodeCursor({ createdAt: SNAP, id: 'abc123', collection: COLLECTION, snapshotAt: SNAP });
    const decoded = decodeCursor(cursor, COLLECTION);
    expect(decoded.id).toBe('abc123');
    expect(decoded.collection).toBe(COLLECTION);
  });

  it('throws CURSOR_MALFORMED for garbage input', () => {
    expect(() => decodeCursor('!!!notbase64!!!', COLLECTION)).toThrow(CursorError);
  });

  it('throws CURSOR_COLLECTION_MISMATCH for wrong collection', () => {
    const cursor = encodeCursor({ createdAt: SNAP, id: 'x', collection: 'activity', snapshotAt: SNAP });
    expect(() => decodeCursor(cursor, COLLECTION)).toThrow(CursorError);
  });
});

describe('buildCursorQuery', () => {
  it('returns a fresh snapshotAt when no cursor given', () => {
    const result = buildCursorQuery(null, COLLECTION);
    expect(result.snapshotAt).toBeTruthy();
    expect(result.afterId).toBeNull();
  });

  it('returns decoded fields from a valid cursor', () => {
    const cursor = encodeCursor({ createdAt: SNAP, id: 'xyz', collection: COLLECTION, snapshotAt: SNAP });
    const result = buildCursorQuery(cursor, COLLECTION);
    expect(result.snapshotAt).toBe(SNAP);
    expect(result.afterId).toBe('xyz');
  });

  it('throws for a cross-collection cursor', () => {
    const cursor = encodeCursor({ createdAt: SNAP, id: 'z', collection: 'activity', snapshotAt: SNAP });
    expect(() => buildCursorQuery(cursor, COLLECTION)).toThrow(CursorError);
  });
});

describe('buildNextCursor', () => {
  it('returns null when hasMore is false', () => {
    const items = [{ id: '1', createdAt: SNAP }];
    expect(buildNextCursor({ items, hasMore: false, collection: COLLECTION, snapshotAt: SNAP })).toBeNull();
  });

  it('returns null when items is empty', () => {
    expect(buildNextCursor({ items: [], hasMore: true, collection: COLLECTION, snapshotAt: SNAP })).toBeNull();
  });

  it('encodes the last item', () => {
    const items = [
      { id: '1', createdAt: '2024-01-01T00:00:00.000Z' },
      { id: '2', createdAt: '2024-01-02T00:00:00.000Z' },
    ];
    const cursor = buildNextCursor({ items, hasMore: true, collection: COLLECTION, snapshotAt: SNAP });
    expect(cursor).toBeTruthy();
    const decoded = decodeCursor(cursor, COLLECTION);
    expect(decoded.id).toBe('2');
  });
});

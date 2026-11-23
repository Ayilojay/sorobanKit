'use strict';

const express = require('express');
const request = require('supertest');
const { idempotencyMiddleware, IDEMPOTENCY_HEADER } = require('../middleware/idempotency');

// The in-memory fallback path is exercised by passing a null/falsey redisClient.
const buildApp = (method, path, handler) => {
  const app = express();
  app.use(express.json());
  app.use(idempotencyMiddleware(null));
  app[method.toLowerCase()](path, handler);
  return app;
};

// A minimal in-memory stand-in for the database-backed idempotency store. It
// models the unique constraint on the hashed replay key and the transaction
// boundary that persists the record alongside the business command.
const createFakeStore = () => {
  const records = new Map();
  const state = { commits: 0, rollbacks: 0 };

  const store = {
    records,
    state,
    // Returns the existing record for a key, if any.
    find: (key) => records.get(key) || null,
    // Inserts a record, enforcing the unique constraint on the hashed key.
    insert: (key, record) => {
      if (records.has(key)) {
        const err = new Error('duplicate key value violates unique constraint');
        err.code = '23505';
        throw err;
      }
      records.set(key, record);
      return record;
    },
    // Runs a unit of work inside a transaction boundary. The business command
    // and the idempotency record are committed together or not at all.
    transaction: async (fn) => {
      const snapshot = new Map(records);
      try {
        const result = await fn(store);
        state.commits += 1;
        return result;
      } catch (err) {
        records.clear();
        for (const [k, v] of snapshot) records.set(k, v);
        state.rollbacks += 1;
        throw err;
      }
    },
    // Retention cleanup: removes records whose expiry has passed.
    cleanup: (now = Date.now()) => {
      let removed = 0;
      for (const [key, record] of records) {
        if (record.expiresAt <= now) {
          records.delete(key);
          removed += 1;
        }
      }
      return removed;
    },
  };

  return store;
};

describe('idempotency middleware — mutating methods', () => {
  test('caches and replays a successful POST response for duplicate keys', async () => {
    let calls = 0;
    const handler = (req, res) => {
      calls += 1;
      res.status(201).json({ created: calls });
    };
    const app = buildApp('post', '/things', handler);

    const first = await request(app)
      .post('/things')
      .set(IDEMPOTENCY_HEADER, 'key-1')
      .send({});
    const second = await request(app)
      .post('/things')
      .set(IDEMPOTENCY_HEADER, 'key-1')
      .send({});

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(second.headers['x-idempotent-replay']).toBe('true');
    // The handler must only run once — the duplicate is served from cache.
    expect(calls).toBe(1);
  });

  test('caches and replays a successful DELETE response for duplicate keys', async () => {
    let calls = 0;
    const handler = (req, res) => {
      calls += 1;
      res.status(200).json({ deleted: true });
    };
    const app = buildApp('delete', '/things/:id', handler);

    const first = await request(app)
      .delete('/things/42')
      .set(IDEMPOTENCY_HEADER, 'del-key');
    const second = await request(app)
      .delete('/things/42')
      .set(IDEMPOTENCY_HEADER, 'del-key');

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.headers['x-idempotent-replay']).toBe('true');
    expect(calls).toBe(1);
  });

  test('does not replay for read-only GET requests', async () => {
    let calls = 0;
    const handler = (req, res) => {
      calls += 1;
      res.status(200).json({ n: calls });
    };
    const app = buildApp('get', '/things', handler);

    const first = await request(app).get('/things').set(IDEMPOTENCY_HEADER, 'get-key');
    const second = await request(app).get('/things').set(IDEMPOTENCY_HEADER, 'get-key');

    expect(first.body).not.toEqual(second.body);
    expect(second.headers['x-idempotent-replay']).toBeUndefined();
    expect(calls).toBe(2);
  });

  test('different keys are treated as distinct requests', async () => {
    let calls = 0;
    const handler = (req, res) => {
      calls += 1;
      res.status(201).json({ created: calls });
    };
    const app = buildApp('post', '/things', handler);

    await request(app).post('/things').set(IDEMPOTENCY_HEADER, 'a').send({});
    await request(app).post('/things').set(IDEMPOTENCY_HEADER, 'b').send({});

    expect(calls).toBe(2);
  });

  test('rejects overly long idempotency keys', async () => {
    const handler = (req, res) => res.status(201).json({ ok: true });
    const app = buildApp('post', '/things', handler);

    const res = await request(app)
      .post('/things')
      .set(IDEMPOTENCY_HEADER, 'x'.repeat(200))
      .send({});

    expect(res.status).toBe(400);
  });
});

describe('idempotency store — DB-backed fallback', () => {
  test('persists the record and business outcome in the same transaction', async () => {
    const store = createFakeStore();
    let businessWrites = 0;

    await store.transaction(async (tx) => {
      businessWrites += 1;
      tx.insert('hashed-key-1', {
        fingerprint: 'fp-1',
        status: 201,
        body: { created: true },
        expiresAt: Date.now() + 60_000,
      });
    });

    expect(businessWrites).toBe(1);
    expect(store.state.commits).toBe(1);
    expect(store.state.rollbacks).toBe(0);
    expect(store.find('hashed-key-1')).toMatchObject({ fingerprint: 'fp-1', status: 201 });
  });

  test('rolls back the idempotency record when the business command fails', async () => {
    const store = createFakeStore();

    await expect(
      store.transaction(async (tx) => {
        tx.insert('hashed-key-2', {
          fingerprint: 'fp-2',
          status: 201,
          body: {},
          expiresAt: Date.now() + 60_000,
        });
        throw new Error('business command failed');
      })
    ).rejects.toThrow('business command failed');

    expect(store.state.rollbacks).toBe(1);
    expect(store.state.commits).toBe(0);
    // The record must not survive a rolled-back transaction.
    expect(store.find('hashed-key-2')).toBeNull();
  });

  test('unique constraint makes concurrent duplicate inserts converge', async () => {
    const store = createFakeStore();
    const record = {
      fingerprint: 'fp-3',
      status: 201,
      body: { created: true },
      expiresAt: Date.now() + 60_000,
    };

    const attempt = () =>
      store.transaction(async (tx) => {
        const existing = tx.find('hashed-key-3');
        if (existing) return existing;
        return tx.insert('hashed-key-3', record);
      });

    const results = await Promise.allSettled([attempt(), attempt(), attempt()]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');

    // At least one attempt wins; the unique constraint prevents duplicates.
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    expect(store.records.size).toBe(1);
    expect(store.find('hashed-key-3')).toMatchObject({ fingerprint: 'fp-3' });
  });

  test('rejects a second insert for the same hashed key with a unique violation', async () => {
    const store = createFakeStore();
    const record = { fingerprint: 'fp-4', status: 201, body: {}, expiresAt: Date.now() + 60_000 };

    store.insert('hashed-key-4', record);
    expect(() => store.insert('hashed-key-4', record)).toThrow(/unique constraint/);
    expect(store.records.size).toBe(1);
  });

  test('retention cleanup removes only expired records', async () => {
    const store = createFakeStore();
    const now = Date.now();

    store.insert('expired-1', { fingerprint: 'a', status: 201, body: {}, expiresAt: now - 1_000 });
    store.insert('expired-2', { fingerprint: 'b', status: 201, body: {}, expiresAt: now - 5_000 });
    store.insert('fresh-1', { fingerprint: 'c', status: 201, body: {}, expiresAt: now + 60_000 });

    const removed = store.cleanup(now);

    expect(removed).toBe(2);
    expect(store.find('expired-1')).toBeNull();
    expect(store.find('expired-2')).toBeNull();
    expect(store.find('fresh-1')).not.toBeNull();
    expect(store.records.size).toBe(1);
  });
});

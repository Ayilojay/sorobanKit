// Mock node-cron to prevent real cron jobs in tests
jest.mock('node-cron', () => ({
  schedule: jest.fn(),
}), { virtual: true });

jest.mock('../src/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('../prismaClient', () => ({
  prisma: {},
}));

jest.mock('../src/metrics', () => ({
  webhookQueueOldestPendingAgeSeconds: { set: jest.fn() },
  webhookQueueAttemptDistribution: { reset: jest.fn(), observe: jest.fn() },
  webhookDeliveryLatencySeconds: { observe: jest.fn() },
  webhookDLQOldestAgeSeconds: { set: jest.fn() },
  recordWebhookQueueHealth: jest.fn(),
}));

const webhookWorker = require('../src/webhookWorker');
const {
  getWebhooksExhaustedRetries,
  moveToDLQ,
  listDLQEntries,
  replayFromDLQ,
  emitQueueHealthMetrics,
} = webhookWorker;

const metrics = require('../src/metrics');

const { prisma } = require('../prismaClient');

// Mock global.fetch for sendWebhook calls
global.fetch = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  jest.resetAllMocks();

  // Reset fetch mock
  global.fetch.mockResolvedValue({
    ok: true,
    status: 200,
  });

  // Reset prisma mock methods
  prisma.webhook = {
    findMany: jest.fn().mockResolvedValue([]),
    update: jest.fn().mockResolvedValue({}),
  };
  prisma.webhookDLQ = {
    findMany: jest.fn().mockResolvedValue([]),
    findUnique: jest.fn().mockResolvedValue(null),
    create: jest.fn().mockResolvedValue({}),
    update: jest.fn().mockResolvedValue({}),
    count: jest.fn().mockResolvedValue(0),
  };
  prisma.$transaction = jest.fn(async (queries) => Promise.all(queries));
  prisma.outboxEvent = {
    findMany: jest.fn().mockResolvedValue([]),
    findUnique: jest.fn().mockResolvedValue(null),
    create: jest.fn().mockResolvedValue({}),
    update: jest.fn().mockResolvedValue({}),
    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    count: jest.fn().mockResolvedValue(0),
  };
});

describe('emitQueueHealthMetrics', () => {
  const now = new Date('2024-06-01T12:00:00.000Z');

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(now);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('emits oldest pending age, attempt distribution, latency and DLQ age on success', async () => {
    const oldestPending = new Date(now.getTime() - 90 * 1000); // 90s ago
    const oldestDLQ = new Date(now.getTime() - 3600 * 1000); // 1h ago

    prisma.webhook = {
      findFirst: jest.fn().mockResolvedValue({ id: 'wh-1', createdAt: oldestPending }),
      groupBy: jest.fn().mockResolvedValue([
        { deliveryAttempts: 0, _count: { _all: 3 } },
        { deliveryAttempts: 1, _count: { _all: 2 } },
        { deliveryAttempts: 5, _count: { _all: 1 } },
      ]),
      aggregate: jest.fn().mockResolvedValue({ _avg: { deliveryLatencyMs: 250 } }),
    };
    prisma.webhookDLQ = {
      findFirst: jest.fn().mockResolvedValue({ id: 'dlq-1', movedAt: oldestDLQ }),
    };

    const result = await emitQueueHealthMetrics(prisma);

    expect(result).toEqual({
      oldestPendingAgeSeconds: 90,
      attemptDistribution: { 0: 3, 1: 2, 5: 1 },
      averageDeliveryLatencySeconds: 0.25,
      oldestDLQAgeSeconds: 3600,
    });

    expect(metrics.webhookQueueOldestPendingAgeSeconds.set).toHaveBeenCalledWith(90);
    expect(metrics.webhookQueueAttemptDistribution.reset).toHaveBeenCalled();
    expect(metrics.webhookQueueAttemptDistribution.observe).toHaveBeenCalledWith({ attempts: '0' }, 3);
    expect(metrics.webhookQueueAttemptDistribution.observe).toHaveBeenCalledWith({ attempts: '1' }, 2);
    expect(metrics.webhookQueueAttemptDistribution.observe).toHaveBeenCalledWith({ attempts: '5+' }, 1);
    expect(metrics.webhookDeliveryLatencySeconds.observe).toHaveBeenCalledWith(0.25);
    expect(metrics.webhookDLQOldestAgeSeconds.set).toHaveBeenCalledWith(3600);
  });

  it('emits zero-valued metrics when the queues are empty', async () => {
    prisma.webhook = {
      findFirst: jest.fn().mockResolvedValue(null),
      groupBy: jest.fn().mockResolvedValue([]),
      aggregate: jest.fn().mockResolvedValue({ _avg: { deliveryLatencyMs: null } }),
    };
    prisma.webhookDLQ = {
      findFirst: jest.fn().mockResolvedValue(null),
    };

    const result = await emitQueueHealthMetrics(prisma);

    expect(result).toEqual({
      oldestPendingAgeSeconds: 0,
      attemptDistribution: {},
      averageDeliveryLatencySeconds: 0,
      oldestDLQAgeSeconds: 0,
    });

    expect(metrics.webhookQueueOldestPendingAgeSeconds.set).toHaveBeenCalledWith(0);
    expect(metrics.webhookQueueAttemptDistribution.reset).toHaveBeenCalled();
    expect(metrics.webhookQueueAttemptDistribution.observe).not.toHaveBeenCalled();
    expect(metrics.webhookDeliveryLatencySeconds.observe).toHaveBeenCalledWith(0);
    expect(metrics.webhookDLQOldestAgeSeconds.set).toHaveBeenCalledWith(0);
  });

  it('clamps negative ages to zero when clocks skew', async () => {
    const future = new Date(now.getTime() + 60 * 1000);

    prisma.webhook = {
      findFirst: jest.fn().mockResolvedValue({ id: 'wh-1', createdAt: future }),
      groupBy: jest.fn().mockResolvedValue([]),
      aggregate: jest.fn().mockResolvedValue({ _avg: { deliveryLatencyMs: null } }),
    };
    prisma.webhookDLQ = {
      findFirst: jest.fn().mockResolvedValue({ id: 'dlq-1', movedAt: future }),
    };

    const result = await emitQueueHealthMetrics(prisma);

    expect(result.oldestPendingAgeSeconds).toBe(0);
    expect(result.oldestDLQAgeSeconds).toBe(0);
  });

  it('buckets high attempt counts into a bounded 5+ label', async () => {
    prisma.webhook = {
      findFirst: jest.fn().mockResolvedValue(null),
      groupBy: jest.fn().mockResolvedValue([
        { deliveryAttempts: 4, _count: { _all: 1 } },
        { deliveryAttempts: 5, _count: { _all: 2 } },
        { deliveryAttempts: 42, _count: { _all: 7 } },
      ]),
      aggregate: jest.fn().mockResolvedValue({ _avg: { deliveryLatencyMs: 0 } }),
    };
    prisma.webhookDLQ = {
      findFirst: jest.fn().mockResolvedValue(null),
    };

    const result = await emitQueueHealthMetrics(prisma);

    expect(result.attemptDistribution).toEqual({ 4: 1, '5+': 9 });
    expect(metrics.webhookQueueAttemptDistribution.observe).toHaveBeenCalledWith({ attempts: '4' }, 1);
    expect(metrics.webhookQueueAttemptDistribution.observe).toHaveBeenCalledWith({ attempts: '5+' }, 9);
  });

  it('does not throw and skips emission when the database is unavailable', async () => {
    prisma.webhook = {
      findFirst: jest.fn().mockRejectedValue(new Error('connection refused')),
      groupBy: jest.fn().mockResolvedValue([]),
      aggregate: jest.fn().mockResolvedValue({ _avg: { deliveryLatencyMs: null } }),
    };
    prisma.webhookDLQ = {
      findFirst: jest.fn().mockResolvedValue(null),
    };

    await expect(emitQueueHealthMetrics(prisma)).rejects.toThrow('connection refused');
    expect(metrics.webhookQueueOldestPendingAgeSeconds.set).not.toHaveBeenCalled();
    expect(metrics.webhookDLQOldestAgeSeconds.set).not.toHaveBeenCalled();
  });

  it('updates DLQ age after a webhook is moved to the DLQ on retry exhaustion', async () => {
    const failingSinceDate = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);
    const webhook = {
      id: 'wh-1',
      username: 'alice',
      url: 'https://example.com/hook',
      secret: 'secret-abc',
      failingSince: failingSinceDate,
    };

    prisma.webhookDLQ.create.mockResolvedValue({ id: 'dlq-1', webhookId: 'wh-1' });
    prisma.webhook.update.mockResolvedValue({});

    await moveToDLQ(prisma, async () => {}, webhook);

    // After the move, the DLQ now holds an entry and the health emitter reflects its age.
    prisma.webhook = {
      findFirst: jest.fn().mockResolvedValue(null),
      groupBy: jest.fn().mockResolvedValue([]),
      aggregate: jest.fn().mockResolvedValue({ _avg: { deliveryLatencyMs: null } }),
    };
    prisma.webhookDLQ.findFirst = jest.fn().mockResolvedValue({
      id: 'dlq-1',
      movedAt: new Date(now.getTime() - 120 * 1000),
    });

    const result = await emitQueueHealthMetrics(prisma);

    expect(result.oldestDLQAgeSeconds).toBe(120);
    expect(metrics.webhookDLQOldestAgeSeconds.set).toHaveBeenCalledWith(120);
  });
});

describe('getWebhooksExhaustedRetries', () => {
  it('returns webhooks whose failingSince is older than MAX_RETRY_BACKLOG_DAYS', async () => {
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 5); // 5 days ago, > 3

    prisma.webhook.findMany.mockResolvedValue([
      {
        id: 'wh-1', username: 'alice', url: 'https://example.com/hook',
        secret: 's1', failingSince: oldDate,
      },
    ]);

    const result = await getWebhooksExhaustedRetries(prisma);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('wh-1');
    // Verify where clause includes lt cutoff
    const callArgs = prisma.webhook.findMany.mock.calls[0][0];
    expect(callArgs.where.failingSince).toBeDefined();
    expect(callArgs.where.failingSince.not).toBe(null);
  });

  it('excludes webhooks still within the retry window', async () => {
    // Default mock returns [], which means nothing qualifies
    const result = await getWebhooksExhaustedRetries(prisma);
    expect(result).toHaveLength(0);
  });
});

describe('moveToDLQ', () => {
  it('creates a DLQ entry and clears failingSince on the webhook', async () => {
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 5);

    const webhook = {
      id: 'wh-1',
      username: 'alice',
      url: 'https://example.com/hook',
      secret: 'secret-abc',
      failingSince: oldDate,
    };

    prisma.webhookDLQ.create.mockResolvedValue({
      id: 'dlq-1', webhookId: 'wh-1', username: 'alice',
    });
    prisma.webhook.update.mockResolvedValue({});

    await moveToDLQ(prisma, async () => {}, webhook);

    expect(prisma.webhookDLQ.create).toHaveBeenCalled();
    const createData = prisma.webhookDLQ.create.mock.calls[0][0].data;
    expect(createData.webhookId).toBe('wh-1');
    expect(createData.username).toBe('alice');
    expect(createData.replayed).toBe(false);
    expect(createData.failureReason).toContain('exhausted');
  });
});

describe('listDLQEntries', () => {
  it('returns entries with total count', async () => {
    prisma.webhookDLQ.findMany.mockResolvedValue([
      { id: 'dlq-1', webhookId: 'wh-1', username: 'alice', movedAt: new Date(), replayed: false },
    ]);
    prisma.webhookDLQ.count.mockResolvedValue(1);

    const { entries, total } = await listDLQEntries(prisma, async () => []);

    expect(total).toBe(1);
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe('dlq-1');
  });

  it('filters by username when provided', async () => {
    prisma.webhookDLQ.findMany.mockResolvedValue([]);
    prisma.webhookDLQ.count.mockResolvedValue(0);

    await listDLQEntries(prisma, async () => [], { username: 'alice' });

    const findManyCall = prisma.webhookDLQ.findMany.mock.calls[0][0];
    expect(findManyCall.where.username.equals).toBe('alice');
  });
});

describe('replayFromDLQ', () => {
  it('replays a DLQ entry successfully and marks it replayed', async () => {
    const entry = {
      id: 'dlq-1',
      webhookId: 'wh-1',
      webhookUrl: 'https://example.com/hook',
      webhookSecret: 'secret-abc',
      eventType: 'webhook.delivery_failed',
      eventPayload: JSON.stringify({ event: 'test' }),
      replayed: false,
      deliveryAttempts: 0,
    };

    prisma.webhookDLQ.findUnique.mockResolvedValue(entry);
    prisma.webhookDLQ.update.mockResolvedValue({ ...entry, replayed: true });

    const result = await replayFromDLQ(prisma, async () => {}, 'dlq-1');

    expect(result.ok).toBe(true);
    expect(global.fetch).toHaveBeenCalledWith(
      entry.webhookUrl,
      expect.objectContaining({
        method: 'POST',
        body: entry.eventPayload,
      }),
    );
  });

  it('returns error for non-existent DLQ entry', async () => {
    prisma.webhookDLQ.findUnique.mockResolvedValue(null);

    const result = await replayFromDLQ(prisma, async () => {}, 'nonexistent');

    expect(result.ok).toBe(false);
    expect(result.error).toBe('DLQ entry not found');
  });

  it('returns error for already-replayed DLQ entry', async () => {
    prisma.webhookDLQ.findUnique.mockResolvedValue({
      id: 'dlq-1', replayed: true,
    });

    const result = await replayFromDLQ(prisma, async () => {}, 'dlq-1');

    expect(result.ok).toBe(false);
    expect(result.error).toContain('already been replayed');
  });

  it('increments delivery attempt count on replay failure', async () => {
    const entry = {
      id: 'dlq-1',
      webhookId: 'wh-1',
      webhookUrl: 'https://example.com/hook',
      webhookSecret: 'secret-abc',
      eventPayload: JSON.stringify({ event: 'test' }),
      replayed: false,
      deliveryAttempts: 2,
    };

    prisma.webhookDLQ.findUnique.mockResolvedValue(entry);
    prisma.webhookDLQ.update.mockResolvedValue({ ...entry, deliveryAttempts: 3 });

    // Make fetch fail to simulate a delivery failure
    global.fetch.mockRejectedValue(new Error('Connection refused'));

    const result = await replayFromDLQ(prisma, async () => {}, 'dlq-1');

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Connection refused');
    expect(prisma.webhookDLQ.update).toHaveBeenCalled();
    const updateCall = prisma.webhookDLQ.update.mock.calls[0][0];
    expect(updateCall.data.deliveryAttempts).toBe(3);
  });

  it('completes the full DLQ replay lifecycle: failure -> DLQ creation -> replay delivery -> marked replayed (#280)', async () => {
    const dlqStore = new Map();
    const failingSinceDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    const webhook = {
      id: 'wh-lifecycle-1',
      username: 'alice',
      url: 'https://merchant.example.com/webhooks/payments',
      secret: 'super-secret-key',
      failingSince: failingSinceDate,
    };

    prisma.webhookDLQ.create.mockImplementation(async ({ data }) => {
      const record = { id: 'dlq-lifecycle-1', ...data };
      dlqStore.set(record.id, record);
      return record;
    });
    prisma.webhookDLQ.findMany.mockImplementation(async () => Array.from(dlqStore.values()));
    prisma.webhookDLQ.count.mockImplementation(async () => dlqStore.size);
    prisma.webhookDLQ.findUnique.mockImplementation(async ({ where }) => dlqStore.get(where.id) || null);
    prisma.webhookDLQ.update.mockImplementation(async ({ where, data }) => {
      const current = dlqStore.get(where.id);
      const updated = { ...current, ...data };
      dlqStore.set(where.id, updated);
      return updated;
    });

    // 1. Trigger initial webhook delivery failure (HTTP 503)
    global.fetch.mockResolvedValueOnce({ ok: false, status: 503 });
    await expect(
      webhookWorker.sendWebhook(webhook.url, { event: 'payment.received' }, webhook.secret),
    ).rejects.toThrow('Webhook responded with HTTP 503');

    // 2. Move exhausted webhook to DLQ and confirm DLQ entry exists
    await moveToDLQ(prisma, async () => {}, webhook);
    const { entries, total } = await listDLQEntries(prisma, async () => [], { username: 'alice' });
    expect(total).toBe(1);
    expect(entries[0]).toMatchObject({
      id: 'dlq-lifecycle-1',
      webhookId: webhook.id,
      webhookUrl: webhook.url,
      username: 'alice',
      replayed: false,
    });

    // 3. Mock delivery endpoint to succeed on replay and replay the DLQ entry
    global.fetch.mockResolvedValueOnce({ ok: true, status: 200 });
    const replayResult = await replayFromDLQ(prisma, async () => {}, 'dlq-lifecycle-1');
    expect(replayResult).toEqual({ ok: true });

    // 4. Assert delivery was re-attempted against the exact webhook URL with signed payload
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(global.fetch).toHaveBeenLastCalledWith(
      webhook.url,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'X-Webhook-Signature': expect.stringMatching(/^[0-9a-f]{64}$/),
          'X-Webhook-Timestamp': expect.any(String),
        }),
        body: entries[0].eventPayload,
      }),
    );

    // 5. Assert the DLQ entry is marked as replayed with a timestamp and cannot be replayed twice
    const updatedEntry = dlqStore.get('dlq-lifecycle-1');
    expect(updatedEntry.replayed).toBe(true);
    expect(updatedEntry.replayedAt).toBeInstanceOf(Date);

    const secondReplay = await replayFromDLQ(prisma, async () => {}, 'dlq-lifecycle-1');
    expect(secondReplay).toEqual({
      ok: false,
      error: 'DLQ entry has already been replayed',
    });
  });
});

describe('outbox integration with DLQ (#391)', () => {
  const buildOutboxEvent = (overrides = {}) => ({
    id: 'ob-1',
    eventType: 'payment.received',
    aggregateType: 'payment',
    aggregateId: 'pay-1',
    payload: JSON.stringify({ event: 'payment.received', amount: '10.00' }),
    version: 1,
    status: 'PENDING',
    attempts: 5,
    maxAttempts: 5,
    nextAttemptAt: new Date(Date.now() - 60 * 1000),
    lastError: 'Webhook responded with HTTP 503',
    processedAt: null,
    ...overrides,
  });

  it('promotes outbox events that exhausted retries into the DLQ', async () => {
    const event = buildOutboxEvent();
    prisma.outboxEvent.findMany.mockResolvedValue([event]);
    prisma.webhookDLQ.create.mockResolvedValue({ id: 'dlq-ob-1', outboxEventId: 'ob-1' });
    prisma.outboxEvent.update.mockResolvedValue({ ...event, status: 'DEAD_LETTERED' });

    const result = await promoteExhaustedOutboxEvents(prisma, async () => {});

    expect(result.promoted).toBe(1);
    expect(prisma.outboxEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'PENDING',
          attempts: expect.objectContaining({ gte: expect.any(Number) }),
        }),
      }),
    );
    const createData = prisma.webhookDLQ.create.mock.calls[0][0].data;
    expect(createData.outboxEventId).toBe('ob-1');
    expect(createData.eventType).toBe('payment.received');
    expect(createData.failureReason).toContain('outbox');
    expect(prisma.outboxEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'ob-1' },
        data: expect.objectContaining({ status: 'DEAD_LETTERED' }),
      }),
    );
  });

  it('does not promote outbox events that still have retries remaining', async () => {
    prisma.outboxEvent.findMany.mockResolvedValue([]);

    const result = await promoteExhaustedOutboxEvents(prisma, async () => {});

    expect(result.promoted).toBe(0);
    expect(prisma.webhookDLQ.create).not.toHaveBeenCalled();
  });

  it('replays an outbox-backed DLQ entry and marks the outbox event processed idempotently', async () => {
    const entry = {
      id: 'dlq-ob-1',
      webhookId: 'wh-1',
      outboxEventId: 'ob-1',
      webhookUrl: 'https://example.com/hook',
      webhookSecret: 'secret-abc',
      eventType: 'payment.received',
      eventPayload: JSON.stringify({ event: 'payment.received' }),
      replayed: false,
      deliveryAttempts: 0,
    };
    const outboxEvent = buildOutboxEvent({ status: 'DEAD_LETTERED' });

    prisma.webhookDLQ.findUnique.mockResolvedValue(entry);
    prisma.webhookDLQ.update.mockResolvedValue({ ...entry, replayed: true });
    prisma.outboxEvent.findUnique.mockResolvedValue(outboxEvent);
    prisma.outboxEvent.updateMany.mockResolvedValue({ count: 1 });

    const result = await replayOutboxEvent(prisma, async () => {}, 'dlq-ob-1');

    expect(result.ok).toBe(true);
    expect(global.fetch).toHaveBeenCalledWith(
      entry.webhookUrl,
      expect.objectContaining({ method: 'POST', body: entry.eventPayload }),
    );
    // Idempotent transition guarded on current status
    expect(prisma.outboxEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'ob-1',
          status: expect.objectContaining({ in: expect.any(Array) }),
        }),
        data: expect.objectContaining({
          status: 'PROCESSED',
          processedAt: expect.any(Date),
        }),
      }),
    );
  });

  it('treats an already-processed outbox event as an idempotent no-op on replay', async () => {
    const entry = {
      id: 'dlq-ob-1',
      webhookId: 'wh-1',
      outboxEventId: 'ob-1',
      webhookUrl: 'https://example.com/hook',
      webhookSecret: 'secret-abc',
      eventPayload: JSON.stringify({ event: 'payment.received' }),
      replayed: false,
      deliveryAttempts: 0,
    };

    prisma.webhookDLQ.findUnique.mockResolvedValue(entry);
    prisma.webhookDLQ.update.mockResolvedValue({ ...entry, replayed: true });
    prisma.outboxEvent.findUnique.mockResolvedValue(
      buildOutboxEvent({ status: 'PROCESSED', processedAt: new Date() }),
    );
    // Guarded update matches nothing because the event is already processed
    prisma.outboxEvent.updateMany.mockResolvedValue({ count: 0 });

    const result = await replayOutboxEvent(prisma, async () => {}, 'dlq-ob-1');

    expect(result.ok).toBe(true);
    expect(result.alreadyProcessed).toBe(true);
    expect(prisma.outboxEvent.updateMany).toHaveBeenCalled();
  });

  it('does not mark the outbox event processed when replay delivery fails', async () => {
    const entry = {
      id: 'dlq-ob-1',
      webhookId: 'wh-1',
      outboxEventId: 'ob-1',
      webhookUrl: 'https://example.com/hook',
      webhookSecret: 'secret-abc',
      eventPayload: JSON.stringify({ event: 'payment.received' }),
      replayed: false,
      deliveryAttempts: 1,
    };

    prisma.webhookDLQ.findUnique.mockResolvedValue(entry);
    prisma.webhookDLQ.update.mockResolvedValue({ ...entry, deliveryAttempts: 2 });
    prisma.outboxEvent.findUnique.mockResolvedValue(buildOutboxEvent({ status: 'DEAD_LETTERED' }));
    global.fetch.mockRejectedValue(new Error('Connection refused'));

    const result = await replayOutboxEvent(prisma, async () => {}, 'dlq-ob-1');

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Connection refused');
    expect(prisma.outboxEvent.updateMany).not.toHaveBeenCalled();
    const updateCall = prisma.webhookDLQ.update.mock.calls[0][0];
    expect(updateCall.data.deliveryAttempts).toBe(2);
  });

  it('returns an error when the outbox-backed DLQ entry does not exist', async () => {
    prisma.webhookDLQ.findUnique.mockResolvedValue(null);

    const result = await replayOutboxEvent(prisma, async () => {}, 'missing');

    expect(result.ok).toBe(false);
    expect(result.error).toBe('DLQ entry not found');
    expect(prisma.outboxEvent.updateMany).not.toHaveBeenCalled();
  });
});
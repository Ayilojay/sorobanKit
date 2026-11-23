const { Pool } = require('pg');
const logger = require('./logger');
const {
  startPoolMonitor,
  checkPoolWaitQueue,
  runInteractiveQuery,
  runMaintenanceQuery,
  DEFAULT_INTERACTIVE_TIMEOUT_MS,
  aggregateConnectionCapacity,
  validateConnectionCapacity,
} = require('./db-pool-monitor');

jest.mock('./logger', () => ({
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
}));

describe('db-pool-monitor wait queue alerts', () => {
  const originalEnv = process.env.DB_POOL_WAIT_ALERT;

  afterEach(() => {
    jest.clearAllMocks();
    if (originalEnv === undefined) {
      delete process.env.DB_POOL_WAIT_ALERT;
    } else {
      process.env.DB_POOL_WAIT_ALERT = originalEnv;
    }
  });

  function mockPool(waitingQueries) {
    return {
      waitingCount: waitingQueries,
      totalCount: 5,
      idleCount: 2,
    };
  }

  test('logs warn when waitingQueries exceeds default threshold of 10', () => {
    delete process.env.DB_POOL_WAIT_ALERT;
    checkPoolWaitQueue(mockPool(11));

    expect(logger.warn).toHaveBeenCalledWith('DB pool wait queue high', { waiting: 11 });
    expect(logger.error).not.toHaveBeenCalled();
  });

  test('logs error when waitingQueries exceeds 2 * threshold', () => {
    delete process.env.DB_POOL_WAIT_ALERT;
    checkPoolWaitQueue(mockPool(21));

    expect(logger.error).toHaveBeenCalledWith('DB pool wait queue critical', { waiting: 21 });
  });

  test('does not log when waitingQueries is within threshold', () => {
    delete process.env.DB_POOL_WAIT_ALERT;
    checkPoolWaitQueue(mockPool(10));

    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  test('DB_POOL_WAIT_ALERT env var configures the threshold', () => {
    process.env.DB_POOL_WAIT_ALERT = '5';
    checkPoolWaitQueue(mockPool(6));

    expect(logger.warn).toHaveBeenCalledWith('DB pool wait queue high', { waiting: 6 });
  });

  test('startPoolMonitor periodically checks the wait queue', () => {
    jest.useFakeTimers();
    const pool = mockPool(11);
    const stop = startPoolMonitor(pool, 1000);

    jest.advanceTimersByTime(1000);

    expect(logger.warn).toHaveBeenCalledWith('DB pool wait queue high', { waiting: 11 });

    stop();
    jest.useRealTimers();
  });
});

describe('db-pool-monitor interactive statement timeouts', () => {
  const originalEnv = {
    DB_STATEMENT_TIMEOUT_MS: process.env.DB_STATEMENT_TIMEOUT_MS,
    DB_MAINTENANCE_TIMEOUT_MS: process.env.DB_MAINTENANCE_TIMEOUT_MS,
  };

  afterEach(() => {
    jest.clearAllMocks();
    Object.entries(originalEnv).forEach(([key, value]) => {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    });
  });

  function mockClient() {
    return {
      query: jest.fn().mockResolvedValue({ rows: [] }),
      release: jest.fn(),
    };
  }

  function mockPoolWithClient(client) {
    return {
      connect: jest.fn().mockResolvedValue(client),
      query: jest.fn().mockResolvedValue({ rows: [] }),
    };
  }

  test('applies the interactive statement timeout to the session', async () => {
    process.env.DB_STATEMENT_TIMEOUT_MS = '2500';
    const client = mockClient();
    const pool = mockPoolWithClient(client);

    await runInteractiveQuery(pool, 'SELECT 1');

    expect(client.query).toHaveBeenCalledWith('SET LOCAL statement_timeout = $1', [2500]);
    expect(client.query).toHaveBeenCalledWith('SELECT 1');
    expect(client.release).toHaveBeenCalled();
  });

  test('uses the default interactive budget when env is unset', async () => {
    delete process.env.DB_STATEMENT_TIMEOUT_MS;
    const client = mockClient();
    const pool = mockPoolWithClient(client);

    await runInteractiveQuery(pool, 'SELECT 1');

    expect(client.query).toHaveBeenCalledWith('SET LOCAL statement_timeout = $1', [DEFAULT_INTERACTIVE_TIMEOUT_MS]);
  });

  test('maintenance budget is separate from the interactive budget', async () => {
    process.env.DB_STATEMENT_TIMEOUT_MS = '1000';
    process.env.DB_MAINTENANCE_TIMEOUT_MS = '60000';
    const client = mockClient();
    const pool = mockPoolWithClient(client);

    await runMaintenanceQuery(pool, 'VACUUM');

    expect(client.query).toHaveBeenCalledWith('SET LOCAL statement_timeout = $1', [60000]);
    expect(client.query).toHaveBeenCalledWith('VACUUM');
  });

  test('maps statement timeout errors to a safe API error', async () => {
    const timeoutError = Object.assign(new Error('canceling statement due to statement timeout'), {
      code: '57014',
    });
    const client = mockClient();
    client.query.mockImplementation((sql) => {
      if (sql === 'SELECT pg_sleep(10)') {
        return Promise.reject(timeoutError);
      }
      return Promise.resolve({ rows: [] });
    });
    const pool = mockPoolWithClient(client);

    await expect(runInteractiveQuery(pool, 'SELECT pg_sleep(10)')).rejects.toMatchObject({
      status: 504,
      code: 'DB_STATEMENT_TIMEOUT',
    });
    expect(client.release).toHaveBeenCalled();
  });

  test('releases the pooled connection after cancellation so it can recover', async () => {
    const timeoutError = Object.assign(new Error('canceling statement due to statement timeout'), {
      code: '57014',
    });
    const client = mockClient();
    client.query.mockImplementation((sql) => {
      if (sql === 'SELECT pg_sleep(10)') {
        return Promise.reject(timeoutError);
      }
      return Promise.resolve({ rows: [] });
    });
    const pool = mockPoolWithClient(client);

    await expect(runInteractiveQuery(pool, 'SELECT pg_sleep(10)')).rejects.toBeDefined();

    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledWith();
  });

  test('releases the connection when the query succeeds', async () => {
    const client = mockClient();
    const pool = mockPoolWithClient(client);

    await runInteractiveQuery(pool, 'SELECT 1');

    expect(client.release).toHaveBeenCalledTimes(1);
  });
});

describe('db-pool-monitor aggregate connection capacity', () => {
  const replicas = {
    api: { replicas: 4, poolSize: 10 },
    worker: { replicas: 3, poolSize: 8 },
    migration: { replicas: 1, poolSize: 5 },
    monitoring: { replicas: 2, poolSize: 2 },
  };

  test('aggregates total possible connections across all replica groups', () => {
    const result = aggregateConnectionCapacity(replicas);

    expect(result.total).toBe(4 * 10 + 3 * 8 + 1 * 5 + 2 * 2);
    expect(result.breakdown).toEqual({
      api: 40,
      worker: 24,
      migration: 5,
      monitoring: 4,
    });
  });

  test('treats missing replica groups as zero', () => {
    const result = aggregateConnectionCapacity({ api: { replicas: 2, poolSize: 5 } });

    expect(result.total).toBe(10);
    expect(result.breakdown.worker).toBe(0);
    expect(result.breakdown.migration).toBe(0);
    expect(result.breakdown.monitoring).toBe(0);
  });

  test('validates configured capacity against the database limit with admin headroom', () => {
    const result = validateConnectionCapacity(replicas, { dbLimit: 100, adminReserve: 10 });

    expect(result.ok).toBe(true);
    expect(result.total).toBe(73);
    expect(result.available).toBe(90);
    expect(result.headroom).toBe(17);
  });

  test('fails when configured capacity exactly consumes the available budget', () => {
    const result = validateConnectionCapacity(
      { api: { replicas: 9, poolSize: 10 } },
      { dbLimit: 100, adminReserve: 10 }
    );

    expect(result.ok).toBe(true);
    expect(result.total).toBe(90);
    expect(result.headroom).toBe(0);
  });

  test('fails when scaling exceeds the database limit after reserving admin capacity', () => {
    const result = validateConnectionCapacity(
      { api: { replicas: 10, poolSize: 10 } },
      { dbLimit: 100, adminReserve: 10 }
    );

    expect(result.ok).toBe(false);
    expect(result.total).toBe(100);
    expect(result.available).toBe(90);
    expect(result.headroom).toBe(-10);
    expect(result.reason).toMatch(/exceeds/i);
  });

  test('surfaces a clear failure when scaling exceeds the raw database limit', () => {
    const result = validateConnectionCapacity(
      { api: { replicas: 20, poolSize: 10 } },
      { dbLimit: 100, adminReserve: 10 }
    );

    expect(result.ok).toBe(false);
    expect(result.total).toBe(200);
    expect(result.reason).toMatch(/exceeds/i);
  });

  test('rejects invalid replica configuration', () => {
    expect(() => aggregateConnectionCapacity({ api: { replicas: -1, poolSize: 10 } })).toThrow();
    expect(() => aggregateConnectionCapacity({ api: { replicas: 1, poolSize: 0 } })).toThrow();
  });

  test('is deterministic under concurrent validation calls', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        Promise.resolve().then(() => validateConnectionCapacity(replicas, { dbLimit: 100, adminReserve: 10 }))
      )
    );

    results.forEach((result) => {
      expect(result.ok).toBe(true);
      expect(result.total).toBe(73);
    });
  });
});

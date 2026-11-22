const { Pool } = require('pg');
const logger = require('./logger');
const { startPoolMonitor, checkPoolWaitQueue } = require('./db-pool-monitor');

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

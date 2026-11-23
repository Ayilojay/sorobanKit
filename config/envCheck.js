'use strict';

/**
 * Startup environment validation.
 *
 * Fails fast on missing required configuration and warns about optional
 * configuration that enables Redis-backed features.
 */

const REQUIRED_VARS = [
  'DATABASE_URL',
  'JWT_SECRET',
  'STELLAR_NETWORK',
];

// Minimum tool versions required for the local development bootstrap.
const MIN_NODE_MAJOR = 18;
const MIN_POSTGRES_MAJOR = 14;
const MIN_REDIS_MAJOR = 6;
const MIN_DOCKER_MAJOR = 20;

// Patterns that indicate a production-looking database target. The bootstrap
// must never point at production resources.
const PRODUCTION_DB_PATTERNS = [
  /prod/i,
  /\.rds\.amazonaws\.com/i,
  /\.neon\.tech/i,
  /\.supabase\.co/i,
  /\.azure\.com/i,
  /\.render\.com/i,
  /\.herokuapp\.com/i,
];

function parseMajor(version) {
  if (version === undefined || version === null) return null;
  const match = String(version).trim().match(/^v?(\d+)/);
  if (!match) return null;
  return Number.parseInt(match[1], 10);
}

function checkToolVersions(tools = {}) {
  const errors = [];

  const nodeVersion = tools.node !== undefined ? tools.node : process.versions && process.versions.node;
  const nodeMajor = parseMajor(nodeVersion);
  if (nodeMajor === null) {
    errors.push(
      `Unable to determine Node.js version (got "${nodeVersion}"). ` +
        `Install Node.js ${MIN_NODE_MAJOR}+ (e.g. via nvm: "nvm install ${MIN_NODE_MAJOR}").`
    );
  } else if (nodeMajor < MIN_NODE_MAJOR) {
    errors.push(
      `Node.js ${nodeVersion} is too old; the local bootstrap requires Node.js ${MIN_NODE_MAJOR}+. ` +
        `Upgrade with "nvm install ${MIN_NODE_MAJOR} && nvm use ${MIN_NODE_MAJOR}".`
    );
  }

  const postgresMajor = parseMajor(tools.postgres);
  if (postgresMajor !== null && postgresMajor < MIN_POSTGRES_MAJOR) {
    errors.push(
      `PostgreSQL ${tools.postgres} is too old; the local bootstrap requires PostgreSQL ${MIN_POSTGRES_MAJOR}+. ` +
        'Upgrade Postgres or use the Docker Compose service (docker compose up postgres).'
    );
  }

  const redisMajor = parseMajor(tools.redis);
  if (redisMajor !== null && redisMajor < MIN_REDIS_MAJOR) {
    errors.push(
      `Redis ${tools.redis} is too old; the local bootstrap requires Redis ${MIN_REDIS_MAJOR}+. ` +
        'Upgrade Redis or use the Docker Compose service (docker compose up redis).'
    );
  }

  const dockerMajor = parseMajor(tools.docker);
  if (dockerMajor !== null && dockerMajor < MIN_DOCKER_MAJOR) {
    errors.push(
      `Docker ${tools.docker} is too old; the local bootstrap requires Docker ${MIN_DOCKER_MAJOR}+. ` +
        'Upgrade Docker Desktop or the docker engine.'
    );
  }

  return errors;
}

function checkNotProduction(env = {}) {
  const errors = [];

  const nodeEnv = env.NODE_ENV && String(env.NODE_ENV).trim().toLowerCase();
  if (nodeEnv === 'production') {
    errors.push(
      'NODE_ENV=production is not allowed for the local development bootstrap. ' +
        'Unset NODE_ENV or set NODE_ENV=development before running the bootstrap.'
    );
  }

  const databaseUrl = env.DATABASE_URL && String(env.DATABASE_URL).trim();
  if (databaseUrl) {
    const matched = PRODUCTION_DB_PATTERNS.find((pattern) => pattern.test(databaseUrl));
    if (matched) {
      errors.push(
        `DATABASE_URL looks like a production database (${databaseUrl}). ` +
          'The local bootstrap refuses to touch production resources; point DATABASE_URL at a local ' +
          'Postgres instance (e.g. postgres://postgres:postgres@localhost:5432/app_dev).'
      );
    }
  }

  return errors;
}

// Features that require a Redis connection when enabled.
const REDIS_DEPENDENT_FLAGS = [
  'ENABLE_IDEMPOTENCY',
  'ENABLE_RATE_LIMITER',
  'ENABLE_FEDERATION_CACHE',
  'ENABLE_WEBHOOK_WORKER',
];

function isEnabled(value) {
  if (value === undefined || value === null) return false;
  const normalized = String(value).trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function checkEnv(env = process.env, options = {}) {
  const errors = [];
  const warnings = [];

  for (const name of REQUIRED_VARS) {
    if (!env[name] || String(env[name]).trim() === '') {
      errors.push(`Missing required environment variable: ${name}`);
    }
  }

  if (options.checkTools) {
    errors.push(...checkToolVersions(options.tools || {}));
  }

  if (options.checkProduction) {
    errors.push(...checkNotProduction(env));
  }

  const redisUrl = env.REDIS_URL && String(env.REDIS_URL).trim();
  if (!redisUrl) {
    const enabledFeatures = REDIS_DEPENDENT_FLAGS.filter((flag) => isEnabled(env[flag]));
    if (enabledFeatures.length > 0) {
      warnings.push(
        `REDIS_URL is not set but Redis-dependent features are enabled (${enabledFeatures.join(', ')}). ` +
          'Idempotency, rate limiting, federation caching, and the webhook worker will fail to connect. ' +
          'Set REDIS_URL (e.g. redis://localhost:6379) or start Redis via the Docker Compose profile.'
      );
    }
  }

  return { errors, warnings };
}

function validateEnv(env = process.env, logger = console, options = {}) {
  const { errors, warnings } = checkEnv(env, options);

  for (const warning of warnings) {
    if (logger && typeof logger.warn === 'function') {
      logger.warn(`[env] ${warning}`);
    }
  }

  if (errors.length > 0) {
    for (const error of errors) {
      if (logger && typeof logger.error === 'function') {
        logger.error(`[env] ${error}`);
      }
    }
    throw new Error(`Invalid environment configuration:\n${errors.join('\n')}`);
  }

  return true;
}

module.exports = {
  checkEnv,
  validateEnv,
  checkToolVersions,
  checkNotProduction,
  REQUIRED_VARS,
  REDIS_DEPENDENT_FLAGS,
  MIN_NODE_MAJOR,
  MIN_POSTGRES_MAJOR,
  MIN_REDIS_MAJOR,
  MIN_DOCKER_MAJOR,
  PRODUCTION_DB_PATTERNS,
};

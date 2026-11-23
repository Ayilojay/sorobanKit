'use strict';

/**
 * Local development seed.
 *
 * Populates an empty database with 50 users, 10 webhooks, 20 payment intents
 * and 2 API keys so a new contributor can exercise the API without hand-
 * building fixtures.
 *
 * Re-running is safe. Every record is upserted on its natural key and all
 * identities (addresses, usernames, intent ids, API key hashes) are derived
 * from a fixed seed, so a second run updates the same rows instead of
 * inserting a new set. Webhook delivery timestamps are the deliberate
 * exception: they are relative to the current time so the healthy /
 * recently-failing / past-the-DLQ-cutoff states stay meaningful as the data
 * ages.
 *
 *   npm run db:seed              populate (or refresh) the seed data
 *   npm run db:seed -- --reset   delete the seed's own rows first
 */

const crypto = require('crypto');
const { StrKey } = require('@stellar/stellar-sdk');
const { v5: uuidv5 } = require('uuid');
require('dotenv').config();

const { logger } = require('../src/logger');
const { normalizeNameTag, RESERVED_NAMES } = require('../src/utils');

// Names are built from these rather than a generator library so the usernames,
// which are the users' primary key, cannot shift under a dependency upgrade and
// leave a second set of rows behind on the next run.
const FIRST_NAMES = [
  'ada', 'bello', 'chidi', 'dalia', 'emeka', 'farida', 'gwen', 'hassan',
  'imani', 'juno', 'kemi', 'lars', 'mira', 'nadia', 'olu', 'priya',
  'quinn', 'rosa', 'sami', 'tunde', 'uma', 'viktor', 'wren', 'zora',
];

const LAST_NAMES = [
  'abiola', 'bergman', 'castillo', 'diallo', 'eriksen', 'fontaine', 'garcia',
  'haddad', 'ibrahim', 'jensen', 'kowalski', 'lindqvist', 'mensah', 'novak',
  'okafor', 'pereira', 'quintero', 'rahman', 'silva', 'takahashi', 'ustinov',
  'varga', 'whitfield', 'zhang',
];

const USER_COUNT = 50;
const WEBHOOK_COUNT = 10;
const PAYMENT_INTENT_COUNT = 20;
const API_KEY_COUNT = 2;

// The first ALIAS_ADDRESS_COUNT addresses carry ALIASES_PER_ADDRESS usernames
// each so reverse (type=id) federation lookups and the isPrimary tiebreak have
// something to resolve against.
const ALIAS_ADDRESS_COUNT = 3;
const ALIASES_PER_ADDRESS = 3;

// webhookWorker moves a webhook to the DLQ once it has been failing for longer
// than this, so the seed straddles the boundary on purpose.
const MAX_RETRY_BACKLOG_DAYS = 3;

// The app itself only ever writes "pending" today; the rest exist so dashboard
// and status-filter work has data to read.
const PAYMENT_STATUSES = ['pending', 'processing', 'completed', 'failed'];

const API_KEY_PREFIX = 'sk_live_';
const DAY_MS = 24 * 60 * 60 * 1000;

// Stellar assets carry seven decimal places. Monetary columns are stored as
// exact integer "units" (1 unit = 1e-7 of the asset) so no float rounding can
// creep into balances. Keep this in sync with the Prisma schema and the
// migration that introduced amountUnits / feeUnits / assetPrecision.
const ASSET_PRECISION = 7;
const UNITS_PER_ASSET = 10n ** BigInt(ASSET_PRECISION);

// Ledger rows are network-scoped: the same transaction hash can legitimately
// exist on testnet and mainnet, so every transaction row must carry an
// explicit network to satisfy the composite unique constraint.
const DEFAULT_NETWORK = 'testnet';

// ---------------------------------------------------------------------------
// Deterministic derivation
// ---------------------------------------------------------------------------

const digest = (label) =>
  crypto.createHash('sha256').update(`stellar-tags:seed:${label}`).digest();

const stellarAddress = (label) => StrKey.encodeEd25519PublicKey(digest(`address:${label}`));

const UUID_NAMESPACE = uuidv5('seed.stellar-tags.local', uuidv5.DNS);
const stableId = (label) => uuidv5(label, UUID_NAMESPACE);

// Anchored rather than relative to now so createdAt does not churn between runs.
const EPOCH = Date.parse('2026-01-01T00:00:00.000Z');
const anchoredDate = (label, spanDays) =>
  new Date(EPOCH + (digest(`date:${label}`).readUInt32BE(0) % (spanDays * DAY_MS)));

// ---------------------------------------------------------------------------
// Monetary helpers
// ---------------------------------------------------------------------------

/**
 * Converts a decimal string (e.g. "12.3456789") to exact integer units at the
 * given precision. Rejects inputs with more fractional digits than the
 * precision can represent rather than silently rounding, so a bad seed value
 * fails loudly instead of writing a subtly wrong balance.
 */
const toUnits = (value, precision = ASSET_PRECISION) => {
  const str = String(value).trim();
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(str);
  if (!match) {
    throw new Error(`Cannot convert "${value}" to units: not a decimal number`);
  }
  const [, sign, whole, fraction = ''] = match;
  if (fraction.length > precision) {
    throw new Error(
      `Cannot convert "${value}" to units: more than ${precision} fractional digits`,
    );
  }
  const padded = fraction.padEnd(precision, '0');
  const units = BigInt(whole) * 10n ** BigInt(precision) + BigInt(padded || '0');
  return sign === '-' ? -units : units;
};

/**
 * Converts integer units back to a decimal string at the given precision.
 * Trailing zeros are trimmed but at least one fractional digit is kept so the
 * value round-trips through toUnits().
 */
const fromUnits = (units, precision = ASSET_PRECISION) => {
  const value = BigInt(units);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const divisor = 10n ** BigInt(precision);
  const whole = abs / divisor;
  const fraction = (abs % divisor).toString().padStart(precision, '0').replace(/0+$/, '');
  const body = fraction.length > 0 ? `${whole}.${fraction}` : `${whole}.0`;
  return negative ? `-${body}` : body;
};

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

/**
 * A stable, readable local part per user index. The trailing number keeps the
 * combinations distinct well past USER_COUNT and keeps reserved names such as
 * "admin" or "support" out of the registry.
 */
const localName = (index) => {
  const h = digest(`username:${index}`);
  const first = FIRST_NAMES[h.readUInt16BE(0) % FIRST_NAMES.length];
  const last = LAST_NAMES[h.readUInt16BE(2) % LAST_NAMES.length];
  const suffix = h.readUInt16BE(4) % 10000;
  const local = `${first}.${last}${suffix}`;
  return RESERVED_NAMES.includes(local) ? `${local}x` : local;
};

const memoFor = (index) => {
  switch (index % 4) {
    case 1:
      return { memoType: 'text', memo: `invoice-${String(index).padStart(4, '0')}` };
    case 2:
      return { memoType: 'id', memo: String(100000 + index) };
    case 3:
      return { memoType: 'hash', memo: digest(`memo:${index}`).toString('hex') };
    default:
      return { memoType: null, memo: null };
  }
};

/**
 * Builds the user rows. Addresses come straight off the hash chain, so
 * `--reset` can always find the rows this script owns.
 */
const buildUsers = () => {
  const users = [];
  let addressSlot = 0;

  while (users.length < USER_COUNT) {
    const address = stellarAddress(addressSlot);
    const aliasCount =
      addressSlot < ALIAS_ADDRESS_COUNT
        ? Math.min(ALIASES_PER_ADDRESS, USER_COUNT - users.length)
        : 1;

    for (let alias = 0; alias < aliasCount; alias++) {
      const index = users.length;
      const username = normalizeNameTag(localName(index)).toLowerCase();

      users.push({
        username,
        address,
        // The first username registered for an address is its primary.
        isPrimary: alias === 0,
        ...memoFor(index),
        createdAt: anchoredDate(`user:${index}`, 365),
        // Every 17th user is flagged and every 23rd soft-deleted, so the
        // moderation and purge paths have rows without swamping the list
        // endpoints with hidden records.
        flaggedAt: index % 17 === 16 ? anchoredDate(`flag:${index}`, 30) : null,
        deletedAt: index % 23 === 22 ? anchoredDate(`delete:${index}`, 30) : null,
      });
    }

    addressSlot++;
  }

  return users;
};

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

/**
 * Spreads the webhooks across four delivery states: never attempted, healthy,
 * failing but still inside the retry window, and failing past the cutoff where
 * webhookWorker moves the record to the DLQ.
 */
const webhookState = (index, now) => {
  if (index < 2) {
    return { lastSentAt: null, failingSince: null };
  }
  if (index < 7) {
    return { lastSentAt: new Date(now - (index + 1) * 3600 * 1000), failingSince: null };
  }
  if (index < 9) {
    return {
      lastSentAt: new Date(now - 2 * 3600 * 1000),
      failingSince: new Date(now - (MAX_RETRY_BACKLOG_DAYS - 2) * DAY_MS),
    };
  }
  return {
    lastSentAt: new Date(now - 6 * 3600 * 1000),
    failingSince: new Date(now - (MAX_RETRY_BACKLOG_DAYS + 2) * DAY_MS),
  };
};

const buildWebhooks = (users, now = Date.now()) => {
  const owners = users.filter((u) => u.isPrimary && !u.deletedAt).slice(0, WEBHOOK_COUNT);

  return owners.map((owner, index) => ({
    id: stableId(`webhook:${index}`),
    username: owner.username,
    url: `https://webhook-${index}.merchant.localhost/stellar-tags`,
    // Same shape as the 32 random bytes the register endpoint issues.
    secret: digest(`webhook-secret:${index}`).toString('hex'),
    events: index % 3 === 0 ? ['payment.received'] : ['*'],
    createdAt: anchoredDate(`webhook:${index}`, 180),
    ...webhookState(index, now),
  }));
};

// ---------------------------------------------------------------------------
// Payment intents
// ---------------------------------------------------------------------------

// Seven decimal places, matching Stellar's asset precision.
const amountFor = (index) => {
  const raw = digest(`amount:${index}`).readUInt32BE(0) % 50_000_000;
  return ((raw + 1) / 10_000).toFixed(7);
};

const buildPaymentIntents = (users) => {
  const addresses = [...new Set(users.map((u) => u.address))];

  return Array.from({ length: PAYMENT_INTENT_COUNT }, (_, index) => {
    const status = PAYMENT_STATUSES[index % PAYMENT_STATUSES.length];

    return {
      id: stableId(`payment-intent:${index}`),
      externalId: `seed-intent-${String(index).padStart(3, '0')}`,
      from: addresses[index % addresses.length],
      to: addresses[(index + 7) % addresses.length],
      amount: amountFor(index),
      asset: index % 3 === 0 ? 'XLM' : 'USDC',
      ...memoFor(index),
      metadata: {
        invoice: `INV-${String(index).padStart(5, '0')}`,
        customer: `${localName(index)} ltd`,
        source: 'seed',
      },
      status,
      createdAt: anchoredDate(`payment-intent:${index}`, 90),
    };
  });
};

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

/**
 * Builds Payment rows using the exact monetary columns. The legacy Float
 * `amount` / `fee` fields are no longer written; instead each row carries
 * integer `amountUnits` / `feeUnits` at `assetPrecision` decimal places.
 *
 * The natural key is (transactionHash, network): the same hash may exist on
 * multiple networks, so we always set an explicit network (default testnet)
 * to satisfy the composite unique constraint.
 */
const buildPayments = (users, { network = DEFAULT_NETWORK } = {}) => {
  const addresses = [...new Set(users.map((u) => u.address))];

  return Array.from({ length: PAYMENT_INTENT_COUNT }, (_, index) => {
    const amountStr = amountFor(index);
    // Fee is a small deterministic fraction of the amount, also exact.
    const feeStr = fromUnits(toUnits(amountStr) / 1000n);

    return {
      id: stableId(`payment:${index}`),
      transactionHash: digest(`tx-hash:${index}`).toString('hex'),
      network,
      from: addresses[index % addresses.length],
      to: addresses[(index + 7) % addresses.length],
      asset: index % 3 === 0 ? 'XLM' : 'USDC',
      assetPrecision: ASSET_PRECISION,
      amountUnits: toUnits(amountStr),
      feeUnits: toUnits(feeStr),
      status: PAYMENT_STATUSES[index % PAYMENT_STATUSES.length],
      createdAt: anchoredDate(`payment:${index}`, 90),
    };
  });
};

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

/**
 * Derives the two keys from the fixed seed so the raw values can be printed
 * for local use and re-derived on every run. Only the hash is stored, matching
 * what POST /auth/api-keys does.
 */
const buildApiKeys = () => {
  const specs = [
    { label: 'primary', name: 'Local development key', scopes: ['read', 'write'], revoked: false },
    { label: 'revoked', name: 'Revoked key (auth failure path)', scopes: ['read'], revoked: true },
  ].slice(0, API_KEY_COUNT);

  return specs.map((spec, index) => {
    // Derived from the fixed seed, so every run produces the same raw key and
    // the same hash. That makes the upsert below idempotent: a re-run updates
    // the existing row instead of minting a new key.
    const rawKey = API_KEY_PREFIX + digest(`api-key:${spec.label}`).toString('hex');

    return {
      rawKey,
      record: {
        id: stableId(`api-key:${spec.label}`),
        name: spec.name,
        ownerId: `seed-owner-${index}`,
        keyHash: crypto.createHash('sha256').update(rawKey).digest('hex'),
        keyPrefix: rawKey.slice(0, 12),
        scopes: spec.scopes,
        expiresAt: null,
        revokedAt: spec.revoked ? anchoredDate(`api-key-revoked:${spec.label}`, 30) : null,
        revokedBy: spec.revoked ? 'seed' : null,
        createdAt: anchoredDate(`api-key:${spec.label}`, 200),
      },
    };
  });
};

/**
 * The active (non-revoked) seed key, or null if the seed defines none. Used to
 * export TEST_ADMIN_API_KEY for the test suite.
 */
const activeApiKey = (apiKeys = buildApiKeys()) => {
  const active = apiKeys.find(({ record }) => !record.revokedAt);
  return active ? active.rawKey : null;
};

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

// Default safe hostnames. Operators can extend this list via the
// SEED_ALLOWED_HOSTS env var (comma-separated), e.g.
//   SEED_ALLOWED_HOSTS=localhost,db,my-dev-box.internal
const DEFAULT_ALLOWED_HOSTS = ['localhost', '127.0.0.1', '::1', 'postgres', 'db'];

const isLocalDatabase = (url, env = process.env) => {
  try {
    const { hostname } = new URL(url);
    const extra = (env.SEED_ALLOWED_HOSTS || '')
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean);
    const allowed = new Set([...DEFAULT_ALLOWED_HOSTS, ...extra]);
    return allowed.has(hostname);
  } catch {
    return false;
  }
};

const assertSeedable = (env = process.env) => {
  if (!env.DATABASE_URL) {
    throw new Error(
      'DATABASE_URL is not set. The seed needs a real database, see .env.example.',
    );
  }
  if (!isLocalDatabase(env.DATABASE_URL, env) && env.SEED_ALLOW_REMOTE !== '1') {
    throw new Error(
      'DATABASE_URL does not point at a local database (and is not in SEED_ALLOWED_HOSTS). ' +
      'Set SEED_ALLOW_REMOTE=1 to override.',
    );
  }
};

const resetSeedData = async (prisma, { users, webhooks, paymentIntents, payments, apiKeys }) => {
  // Webhooks cascade from their user, but the seed deletes them explicitly so a
  // reset stays correct if an owner has since been removed by hand.
  await prisma.webhook.deleteMany({ where: { id: { in: webhooks.map((w) => w.id) } } });
  await prisma.paymentIntent.deleteMany({
    where: { id: { in: paymentIntents.map((p) => p.id) } },
  });
  if (payments && payments.length > 0) {
    // Payments are keyed on (transactionHash, network); delete by id which is
    // stable across runs.
    await prisma.payment.deleteMany({ where: { id: { in: payments.map((p) => p.id) } } });
  }
  await prisma.apiKey.deleteMany({ where: { id: { in: apiKeys.map((k) => k.record.id) } } });
  await prisma.user.deleteMany({
    where: { address: { in: [...new Set(users.map((u) => u.address))] } },
  });
};

const writeSeedData = async (prisma, { users, webhooks, paymentIntents, payments, apiKeys }) => {
  for (const user of users) {
    const { username, ...rest } = user;
    await prisma.user.upsert({
      where: { username },
      create: { username, ...rest },
      update: rest,
    });
  }

  for (const webhook of webhooks) {
    const { username, url, ...rest } = webhook;
    await prisma.webhook.upsert({
      where: { username_url: { username, url } },
      create: { username, url, ...rest },
      update: rest,
    });
  }

  for (const intent of paymentIntents) {
    const { id, ...rest } = intent;
    await prisma.paymentIntent.upsert({ where: { id }, create: { id, ...rest }, update: rest });
  }

  if (payments) {
    for (const payment of payments) {
      const { id, transactionHash, network, ...rest } = payment;
      // Upsert on the composite natural key so a re-run updates the same row
      // rather than inserting a duplicate. The network is always explicit so
      // the (transactionHash, network) unique constraint is satisfied.
      await prisma.payment.upsert({
        where: { transactionHash_network: { transactionHash, network } },
        create: { id, transactionHash, network, ...rest },
        update: rest,
      });
    }
  }

  for (const { record } of apiKeys) {
    // Upsert on the stable id (not the hash) so a re-run with the same derived
    // key updates the existing row rather than inserting a duplicate.
    const { id, keyHash, ...rest } = record;
    await prisma.apiKey.upsert({
      where: { id },
      create: { id, keyHash, ...rest },
      update: { keyHash, ...rest },
    });
  }
};

const seedDatabase = async ({ reset = false, dryRun = false } = {}) => {
  assertSeedable();

  const users = buildUsers();
  const data = {
    users,
    webhooks: buildWebhooks(users),
    paymentIntents: buildPaymentIntents(users),
    payments: buildPayments(users),
    apiKeys: buildApiKeys(),
  };

  if (dryRun) {
    logger.info('[seed] --dry-run: would upsert the following records (no writes performed):');
    logger.info(`  ${data.users.length} users`);
    logger.info(`  ${data.webhooks.length} webhooks`);
    logger.info(`  ${data.paymentIntents.length} payment intents`);
    logger.info(`  ${data.payments.length} payments`);
    logger.info(`  ${data.apiKeys.length} API keys`);
    return;
  }

  logger.warn(
    '⚠ WARNING: This will modify the database at ' +
      (process.env.DATABASE_URL || '(DATABASE_URL not set)') +
      '. Press Ctrl-C within 5 seconds to abort.',
  );

  // Required after assertSeedable: importing earlier would bind the fallback
  // mock in prismaClient when DATABASE_URL is missing, and the seed would
  // report success while writing nothing.
  const { prisma } = require('../prismaClient');

  try {
    if (reset) {
      logger.info('Deleting existing seed records...');
      await resetSeedData(prisma, data);
    }

    await writeSeedData(prisma, data);

    logger.info(
      `Seeded ${data.users.length} users, ${data.webhooks.length} webhooks, ` +
        `${data.paymentIntents.length} payment intents, ${data.payments.length} payments, ` +
        `${data.apiKeys.length} API keys.`,
    );
    for (const { rawKey, record } of data.apiKeys) {
      const state = record.revokedAt ? 'revoked' : 'active';
      logger.info(`API key (${state}) ${record.name}: ${rawKey}`);
    }

    // Machine-readable line so CI / test startup can capture the active key:
    //   TEST_ADMIN_API_KEY=$(npm run db:seed --silent | sed -n 's/^TEST_ADMIN_API_KEY=//p')
    const activeKey = activeApiKey(data.apiKeys);
    if (activeKey) {
      // Written to stdout (not the logger) so it survives --silent and is easy
      // to grep regardless of log formatting.
      process.stdout.write(`TEST_ADMIN_API_KEY=${activeKey}\n`);
    }
  } finally {
    await prisma.$disconnect();
  }
};

if (require.main === module) {
  seedDatabase({
    reset: process.argv.includes('--reset'),
    dryRun: process.argv.includes('--dry-run'),
  }).catch((error) => {
    logger.error(error, 'Seeding failed');
    process.exitCode = 1;
  });
}

module.exports = {
  buildUsers,
  buildWebhooks,
  buildPaymentIntents,
  buildPayments,
  buildApiKeys,
  activeApiKey,
  resetSeedData,
  writeSeedData,
  assertSeedable,
  isLocalDatabase,
  seedDatabase,
  toUnits,
  fromUnits,
  DEFAULT_ALLOWED_HOSTS,
  DEFAULT_NETWORK,
  ASSET_PRECISION,
  USER_COUNT,
  WEBHOOK_COUNT,
  PAYMENT_INTENT_COUNT,
  API_KEY_COUNT,
  PAYMENT_STATUSES,
  MAX_RETRY_BACKLOG_DAYS,
};
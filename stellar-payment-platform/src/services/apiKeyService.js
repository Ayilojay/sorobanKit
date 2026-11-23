'use strict';

const crypto = require('crypto');
const { prisma } = require('../../prismaClient');

const DEFAULT_OVERLAP_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_OVERLAP_MS = 7 * 24 * 60 * 60 * 1000; // 7 days cap
const KEY_PREFIX = 'sk_';
const RAW_KEY_BYTES = 32;
const REDACTED = '[REDACTED]';

const hashKey = (key) => crypto.createHash('sha256').update(key).digest('hex');

const safeCompareHash = (incomingHash, storedHash) => {
  if (typeof incomingHash !== 'string' || typeof storedHash !== 'string') {
    return false;
  }
  const incoming = Buffer.from(incomingHash, 'hex');
  const stored = Buffer.from(storedHash, 'hex');
  if (incoming.length !== stored.length) return false;
  return crypto.timingSafeEqual(incoming, stored);
};

const generateRawKey = () => `${KEY_PREFIX}${crypto.randomBytes(RAW_KEY_BYTES).toString('hex')}`;

const resolveOverlapMs = (options = {}) => {
  const requested = options.overlapMs;
  if (requested === undefined || requested === null) return DEFAULT_OVERLAP_MS;
  const parsed = Number(requested);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error('overlapMs must be a non-negative finite number');
  }
  return Math.min(parsed, MAX_OVERLAP_MS);
};

const emitAuditEvent = async (event) => {
  try {
    if (prisma.auditEvent && typeof prisma.auditEvent.create === 'function') {
      await prisma.auditEvent.create({
        data: {
          action: event.action,
          actor: event.actor || null,
          targetType: 'ApiKey',
          targetId: event.targetId || null,
          metadata: event.metadata ? JSON.stringify(event.metadata) : null,
          createdAt: new Date(),
        },
      });
    }
  } catch (err) {
    // Audit emission must never break the primary operation.
    // eslint-disable-next-line no-console
    console.error('Failed to emit audit event', event.action, err && err.message);
  }
};

const redactKeyRecord = (record) => {
  if (!record || typeof record !== 'object') return record;
  const { keyHash, rawKey, key, ...rest } = record;
  return { ...rest, keyHash: keyHash ? REDACTED : keyHash, rawKey: undefined, key: undefined };
};

const redactKeyRecords = (records) =>
  Array.isArray(records) ? records.map(redactKeyRecord) : records;

const isExpired = (record, now = new Date()) => {
  if (record.expiresAt && record.expiresAt <= now) return true;
  if (record.overlapExpiresAt && record.overlapExpiresAt <= now) return true;
  return false;
};

const validateApiKey = async (key) => {
  if (typeof key !== 'string' || !key.trim()) return null;

  const keyHash = hashKey(key);
  const record = await prisma.apiKey.findUnique({ where: { keyHash } });
  const hashMatches = safeCompareHash(
    keyHash,
    record?.keyHash || '0'.repeat(64),
  );
  if (!record || !hashMatches) return null;
  if (record.revokedAt) return null;
  if (isExpired(record)) return null;
  return record;
};

const rotateApiKey = async (actor, keyId, options = {}) => {
  if (!keyId || typeof keyId !== 'string') {
    throw new Error('keyId is required');
  }

  const overlapMs = resolveOverlapMs(options);
  const now = new Date();
  const overlapExpiresAt = new Date(now.getTime() + overlapMs);

  const predecessor = await prisma.apiKey.findUnique({ where: { id: keyId } });
  if (!predecessor) {
    throw new Error(`API key not found: ${keyId}`);
  }
  if (predecessor.revokedAt) {
    throw new Error('Cannot rotate a revoked API key');
  }

  const rawKey = generateRawKey();
  const keyHash = hashKey(rawKey);

  const result = await prisma.$transaction(async (tx) => {
    const successor = await tx.apiKey.create({
      data: {
        keyHash,
        name: options.name || `${predecessor.name || 'key'} (rotated)`,
        ownerId: predecessor.ownerId || null,
        scopes: predecessor.scopes || null,
        predecessorId: predecessor.id,
        overlapExpiresAt,
        expiresAt: options.expiresAt || predecessor.expiresAt || null,
      },
    });

    await tx.apiKey.update({
      where: { id: predecessor.id },
      data: {
        successorId: successor.id,
        overlapExpiresAt,
      },
    });

    return successor;
  });

  await emitAuditEvent({
    action: 'api_key.rotated',
    actor,
    targetId: result.id,
    metadata: {
      predecessorId: predecessor.id,
      successorId: result.id,
      overlapExpiresAt: overlapExpiresAt.toISOString(),
      overlapMs,
    },
  });

  // Raw key material is returned exactly once and never persisted.
  return {
    ...redactKeyRecord(result),
    rawKey,
    predecessorId: predecessor.id,
    successorId: result.id,
    overlapExpiresAt,
  };
};

const revokeApiKey = async (actor, keyId, options = {}) => {
  if (!keyId || typeof keyId !== 'string') {
    throw new Error('keyId is required');
  }

  const existing = await prisma.apiKey.findUnique({ where: { id: keyId } });
  if (!existing) {
    throw new Error(`API key not found: ${keyId}`);
  }

  const revokedAt = new Date();
  const updated = await prisma.apiKey.update({
    where: { id: keyId },
    data: {
      revokedAt,
      revokedBy: actor || null,
      overlapExpiresAt: null,
    },
  });

  await emitAuditEvent({
    action: 'api_key.revoked',
    actor,
    targetId: keyId,
    metadata: {
      reason: options.reason || null,
      revokedAt: revokedAt.toISOString(),
      predecessorId: existing.predecessorId || null,
      successorId: existing.successorId || null,
    },
  });

  return redactKeyRecord(updated);
};

module.exports = {
  hashKey,
  safeCompareHash,
  validateApiKey,
  rotateApiKey,
  revokeApiKey,
  redactKeyRecord,
  redactKeyRecords,
  generateRawKey,
  resolveOverlapMs,
  DEFAULT_OVERLAP_MS,
  MAX_OVERLAP_MS,
};
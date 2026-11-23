'use strict';

const crypto = require('crypto');
const { prisma } = require('../../prismaClient');

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

const validateApiKey = async (key) => {
  if (typeof key !== 'string' || !key.trim()) return null;

  const keyHash = hashKey(key);
  const record = await prisma.apiKey.findUnique({ where: { keyHash } });
  const hashMatches = safeCompareHash(
    keyHash,
    record?.keyHash || '0'.repeat(64),
  );
  if (!record || !hashMatches) return null;
  if (record.revokedAt || (record.expiresAt && record.expiresAt <= new Date())) {
    return null;
  }
  return record;
};

module.exports = { hashKey, safeCompareHash, validateApiKey };

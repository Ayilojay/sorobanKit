'use strict';

const crypto = require('crypto');
const { Keypair, Networks } = require('@stellar/stellar-sdk');
const { getRedisClient } = require('../config/redis');
const { logger } = require('../utils/logger');

const CHALLENGE_TTL_MS = parseInt(process.env.CHALLENGE_TTL_MS, 10) || 300_000; // 5 min
const CHALLENGE_PREFIX = 'challenge:';
const DOMAIN = process.env.SERVICE_DOMAIN || 'sorobankit.local';

function challengeKey(nonce) {
  return `${CHALLENGE_PREFIX}${nonce}`;
}

/**
 * Issue a single-use challenge bound to an address, domain, and network.
 * Returns the nonce and the full challenge string to be signed.
 */
async function issueChallenge({ address, network = 'testnet' }) {
  const nonce = crypto.randomBytes(32).toString('hex');
  const issuedAt = Date.now();
  const payload = {
    address,
    domain: DOMAIN,
    network,
    nonce,
    issuedAt,
  };

  const redis = getRedisClient();
  if (!redis) throw new Error('Redis unavailable: cannot issue challenge');

  await redis.set(challengeKey(nonce), JSON.stringify(payload), 'PX', CHALLENGE_TTL_MS);

  const challengeString = `${DOMAIN}:${network}:${address}:${nonce}:${issuedAt}`;
  return { nonce, challengeString, expiresInMs: CHALLENGE_TTL_MS };
}

/**
 * Atomically consume the nonce and verify the signature against the
 * account's current signer set at or above weight threshold.
 */
async function verifyChallenge({ nonce, signature, signerKey, ownershipService }) {
  const redis = getRedisClient();
  if (!redis) throw new Error('Redis unavailable: cannot verify challenge');

  const raw = await redis.getdel(challengeKey(nonce));
  if (!raw) {
    const err = new Error('Challenge not found or already used');
    err.code = 'CHALLENGE_INVALID';
    throw err;
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    const err = new Error('Corrupt challenge payload');
    err.code = 'CHALLENGE_INVALID';
    throw err;
  }

  const { address, domain, network, issuedAt } = payload;

  if (domain !== DOMAIN) {
    const err = new Error('Challenge domain mismatch');
    err.code = 'CHALLENGE_DOMAIN_MISMATCH';
    throw err;
  }

  const expectedNetwork = process.env.STELLAR_NETWORK || 'testnet';
  if (network !== expectedNetwork) {
    const err = new Error('Challenge network mismatch');
    err.code = 'CHALLENGE_NETWORK_MISMATCH';
    throw err;
  }

  const challengeString = `${domain}:${network}:${address}:${nonce}:${issuedAt}`;

  let keypair;
  try {
    keypair = Keypair.fromPublicKey(signerKey);
  } catch {
    const err = new Error('Invalid signer public key');
    err.code = 'CHALLENGE_BAD_SIGNER';
    throw err;
  }

  const messageBuffer = Buffer.from(challengeString, 'utf8');
  const signatureBuffer = Buffer.from(signature, 'base64');
  const valid = keypair.verify(messageBuffer, signatureBuffer);
  if (!valid) {
    const err = new Error('Signature verification failed');
    err.code = 'CHALLENGE_SIG_INVALID';
    throw err;
  }

  const isOwner = await ownershipService.verifyOwnership(address, signerKey);
  if (!isOwner) {
    const err = new Error('Signer is not an authorized key for this account');
    err.code = 'CHALLENGE_NOT_OWNER';
    throw err;
  }

  return { address, signerKey, verifiedAt: Date.now() };
}

module.exports = { issueChallenge, verifyChallenge, CHALLENGE_TTL_MS };

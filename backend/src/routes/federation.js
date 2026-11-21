const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { getFederationRecord } = require('../services/federation');

const CACHE_CONTROL_SUCCESS = 'public, max-age=300, stale-while-revalidate=60';
const CACHE_CONTROL_NOT_FOUND = 'no-store';
const CACHE_CONTROL_CHALLENGE = 'no-store';

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const CHALLENGE_PREFIX = 'stellar-federation-ownership';

// In-memory store of issued challenges keyed by a random challenge id.
// Each entry records the account it was issued for so a proof cannot be
// replayed against a different account.
const challenges = new Map();

function computeETag(body) {
  const hash = crypto.createHash('sha256').update(body).digest('hex');
  return `"${hash}"`;
}

function pruneExpiredChallenges(now = Date.now()) {
  for (const [id, entry] of challenges) {
    if (entry.expiresAt <= now) {
      challenges.delete(id);
    }
  }
}

function buildChallengeMessage({ account, challengeId, nonce, expiresAt }) {
  return [
    `${CHALLENGE_PREFIX} verification`,
    `account: ${account}`,
    `challenge: ${challengeId}`,
    `nonce: ${nonce}`,
    `expires: ${new Date(expiresAt).toISOString()}`,
  ].join('\n');
}

router.get('/', async (req, res, next) => {
  try {
    const { username } = req.query;

    if (!username) {
      res.set('Cache-Control', CACHE_CONTROL_NOT_FOUND);
      return res.status(400).json({ error: 'username query parameter is required' });
    }

    const record = await getFederationRecord(username);

    if (!record) {
      res.set('Cache-Control', CACHE_CONTROL_NOT_FOUND);
      return res.status(404).json({ error: 'Federation record not found' });
    }

    const body = JSON.stringify(record);
    const etag = computeETag(body);

    res.set('Cache-Control', CACHE_CONTROL_SUCCESS);
    res.set('ETag', etag);

    if (req.headers['if-none-match'] === etag) {
      return res.status(304).end();
    }

    res.type('application/json').send(body);
  } catch (err) {
    next(err);
  }
});

// Issue a fresh ownership challenge for the selected federation account.
router.post('/challenge', async (req, res, next) => {
  try {
    const { username, account } = req.body || {};

    if (!username || !account) {
      res.set('Cache-Control', CACHE_CONTROL_CHALLENGE);
      return res.status(400).json({ error: 'username and account are required' });
    }

    const record = await getFederationRecord(username);

    if (!record) {
      res.set('Cache-Control', CACHE_CONTROL_CHALLENGE);
      return res.status(404).json({ error: 'Federation record not found' });
    }

    pruneExpiredChallenges();

    const now = Date.now();
    const expiresAt = now + CHALLENGE_TTL_MS;
    const challengeId = crypto.randomBytes(16).toString('hex');
    const nonce = crypto.randomBytes(16).toString('hex');
    const message = buildChallengeMessage({ account, challengeId, nonce, expiresAt });

    challenges.set(challengeId, {
      username,
      account,
      nonce,
      message,
      expiresAt,
    });

    res.set('Cache-Control', CACHE_CONTROL_CHALLENGE);
    res.status(201).json({
      challengeId,
      account,
      message,
      expiresAt: new Date(expiresAt).toISOString(),
      expiresInSeconds: Math.floor(CHALLENGE_TTL_MS / 1000),
    });
  } catch (err) {
    next(err);
  }
});

// Submit a signed proof for a previously issued challenge.
router.post('/challenge/verify', async (req, res, next) => {
  try {
    const { challengeId, account, signature } = req.body || {};

    if (!challengeId || !account || !signature) {
      res.set('Cache-Control', CACHE_CONTROL_CHALLENGE);
      return res.status(400).json({ error: 'challengeId, account, and signature are required' });
    }

    const entry = challenges.get(challengeId);

    if (!entry) {
      res.set('Cache-Control', CACHE_CONTROL_CHALLENGE);
      return res.status(404).json({ error: 'Challenge not found or already used', code: 'challenge_not_found' });
    }

    if (entry.expiresAt <= Date.now()) {
      challenges.delete(challengeId);
      res.set('Cache-Control', CACHE_CONTROL_CHALLENGE);
      return res.status(410).json({ error: 'Challenge expired', code: 'challenge_expired' });
    }

    if (entry.account !== account) {
      res.set('Cache-Control', CACHE_CONTROL_CHALLENGE);
      return res.status(409).json({
        error: 'Challenge was issued for a different account',
        code: 'account_mismatch',
      });
    }

    // Single-use: consume the challenge regardless of verification outcome.
    challenges.delete(challengeId);

    res.set('Cache-Control', CACHE_CONTROL_CHALLENGE);
    res.status(200).json({
      verified: true,
      username: entry.username,
      account: entry.account,
      challengeId,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

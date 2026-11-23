'use strict';

const { ApiError } = require('../errors');
const {
  hashKey,
  safeCompareHash,
  validateApiKey,
} = require('../services/apiKeyService');

const API_KEY_SCOPE_POLICY = [
  {
    scope: 'admin',
    matches: ({ path }) => /^\/admin(?:\/|$)/.test(path),
  },
  {
    scope: 'read',
    methods: new Set(['GET', 'HEAD']),
    matches: () => true,
  },
  {
    scope: 'write',
    methods: new Set(['POST', 'PUT', 'PATCH', 'DELETE']),
    matches: () => true,
  },
];

const normalizeApiPath = (path) =>
  path
    .replace(/^\/api\/v\d+(?=\/|$)/, '')
    .replace(/^\/api(?=\/|$)/, '') || '/';

const requiredScopeForRequest = ({ method, path }) => {
  const request = { method: method.toUpperCase(), path: normalizeApiPath(path) };
  if (request.method === 'OPTIONS') return null;

  const policy = API_KEY_SCOPE_POLICY.find(
    ({ methods, matches }) =>
      (!methods || methods.has(request.method)) && matches(request),
  );
  return policy?.scope ?? null;
};

const getRequestApiKey = (req) => {
  const headerKey = req.headers['x-api-key'];
  const queryKey = req.query?.api_key;
  const authorization = req.headers.authorization;
  const bearerKey =
    typeof authorization === 'string' && /^Bearer sk_live_/i.test(authorization)
      ? authorization.slice(7)
      : null;
  const apiKey = headerKey || queryKey || bearerKey;
  return typeof apiKey === 'string' && apiKey.trim() ? apiKey.trim() : null;
};

const apiKeyAuthentication = async (req, res, next) => {
  const apiKey = getRequestApiKey(req);
  if (!apiKey) {
    req.apiKeyRecord = null;
    return next();
  }

  try {
    if (
      process.env.ADMIN_API_KEY &&
      safeCompareHash(hashKey(apiKey), hashKey(process.env.ADMIN_API_KEY))
    ) {
      // Compatibility fallback: the static ADMIN_API_KEY env var predates the
      // managed key store and cannot participate in rotation. It is marked so
      // downstream auditing can distinguish it from managed key records.
      req.apiKeyRecord = {
        id: 'legacy-admin-key',
        scopes: ['admin'],
        source: 'legacy-env',
        legacy: true,
        predecessorId: null,
        successorId: null,
        overlapExpiresAt: null,
      };
      return next();
    }

    const record = await validateApiKey(apiKey);
    if (!record) {
      return next(new ApiError('UNAUTHENTICATED', 'Invalid or expired API key'));
    }

    // validateApiKey already filters revoked keys and keys past their overlap
    // window; re-check here so a stale or custom validator cannot leak them.
    if (record.revokedAt) {
      return next(new ApiError('UNAUTHENTICATED', 'Invalid or expired API key'));
    }
    if (record.overlapExpiresAt && Date.parse(record.overlapExpiresAt) <= Date.now()) {
      return next(new ApiError('UNAUTHENTICATED', 'Invalid or expired API key'));
    }

    // Attach rotation lineage so downstream handlers and audit logs can trace
    // predecessor/successor relationships across an overlapping rotation.
    req.apiKeyRecord = {
      ...record,
      source: record.source || 'managed',
      legacy: false,
      predecessorId: record.predecessorId ?? null,
      successorId: record.successorId ?? null,
      overlapExpiresAt: record.overlapExpiresAt ?? null,
    };
    return next();
  } catch (err) {
    return next(
      new ApiError('SERVICE_UNAVAILABLE', 'API key authentication is unavailable', {
        cause: err,
      }),
    );
  }
};

const apiKeyScopeMiddleware = (req, res, next) => {
  if (!req.apiKeyRecord) return next();

  const requiredScope = requiredScopeForRequest(req);
  if (!requiredScope) return next();

  const scopes = Array.isArray(req.apiKeyRecord.scopes)
    ? req.apiKeyRecord.scopes
    : [];
  if (scopes.includes('admin') || scopes.includes(requiredScope)) return next();

  return next(
    new ApiError('FORBIDDEN', 'Insufficient API key scope', {
      details: [
        {
          field: 'scopes',
          message: `This endpoint requires the ${requiredScope} scope.`,
        },
      ],
    }),
  );
};

module.exports = {
  API_KEY_SCOPE_POLICY,
  normalizeApiPath,
  requiredScopeForRequest,
  getRequestApiKey,
  apiKeyAuthentication,
  apiKeyScopeMiddleware,
};

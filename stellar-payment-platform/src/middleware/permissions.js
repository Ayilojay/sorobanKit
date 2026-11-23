'use strict';

/**
 * Centralized policy-based permissions for administrative operations.
 *
 * Replaces the previous single broad administrative capability with
 * granular read / operational / configuration permissions. Every admin
 * route MUST declare the permission it requires via `requirePermission`.
 */

const PERMISSIONS = Object.freeze({
  // Read-only visibility into administrative state.
  ADMIN_READ: 'admin:read',
  ADMIN_READ_AUDIT: 'admin:read:audit',
  ADMIN_READ_METRICS: 'admin:read:metrics',

  // Operational actions that affect runtime behavior but not configuration.
  ADMIN_OPERATE: 'admin:operate',
  ADMIN_OPERATE_REPLAY: 'admin:operate:replay',
  ADMIN_OPERATE_RETRY: 'admin:operate:retry',
  ADMIN_OPERATE_PAUSE: 'admin:operate:pause',

  // Configuration-changing actions.
  ADMIN_CONFIGURE: 'admin:configure',
  ADMIN_CONFIGURE_KEYS: 'admin:configure:keys',
  ADMIN_CONFIGURE_POLICY: 'admin:configure:policy',
  ADMIN_CONFIGURE_WEBHOOKS: 'admin:configure:webhooks',
});

const ROLES = Object.freeze({
  VIEWER: 'viewer',
  OPERATOR: 'operator',
  ADMIN: 'admin',
  SUPER_ADMIN: 'super_admin',
});

/**
 * Role -> permission mapping. Permissions are additive: a higher role
 * inherits everything granted to lower roles.
 */
const ROLE_PERMISSIONS = Object.freeze({
  [ROLES.VIEWER]: Object.freeze([
    PERMISSIONS.ADMIN_READ,
    PERMISSIONS.ADMIN_READ_METRICS,
  ]),
  [ROLES.OPERATOR]: Object.freeze([
    PERMISSIONS.ADMIN_READ,
    PERMISSIONS.ADMIN_READ_METRICS,
    PERMISSIONS.ADMIN_READ_AUDIT,
    PERMISSIONS.ADMIN_OPERATE,
    PERMISSIONS.ADMIN_OPERATE_REPLAY,
    PERMISSIONS.ADMIN_OPERATE_RETRY,
    PERMISSIONS.ADMIN_OPERATE_PAUSE,
  ]),
  [ROLES.ADMIN]: Object.freeze([
    PERMISSIONS.ADMIN_READ,
    PERMISSIONS.ADMIN_READ_METRICS,
    PERMISSIONS.ADMIN_READ_AUDIT,
    PERMISSIONS.ADMIN_OPERATE,
    PERMISSIONS.ADMIN_OPERATE_REPLAY,
    PERMISSIONS.ADMIN_OPERATE_RETRY,
    PERMISSIONS.ADMIN_OPERATE_PAUSE,
    PERMISSIONS.ADMIN_CONFIGURE,
    PERMISSIONS.ADMIN_CONFIGURE_KEYS,
    PERMISSIONS.ADMIN_CONFIGURE_POLICY,
    PERMISSIONS.ADMIN_CONFIGURE_WEBHOOKS,
  ]),
  [ROLES.SUPER_ADMIN]: Object.freeze([
    PERMISSIONS.ADMIN_READ,
    PERMISSIONS.ADMIN_READ_METRICS,
    PERMISSIONS.ADMIN_READ_AUDIT,
    PERMISSIONS.ADMIN_OPERATE,
    PERMISSIONS.ADMIN_OPERATE_REPLAY,
    PERMISSIONS.ADMIN_OPERATE_RETRY,
    PERMISSIONS.ADMIN_OPERATE_PAUSE,
    PERMISSIONS.ADMIN_CONFIGURE,
    PERMISSIONS.ADMIN_CONFIGURE_KEYS,
    PERMISSIONS.ADMIN_CONFIGURE_POLICY,
    PERMISSIONS.ADMIN_CONFIGURE_WEBHOOKS,
  ]),
});

const VALID_PERMISSIONS = new Set(Object.values(PERMISSIONS));

/**
 * Resolve the caller's role from the authenticated identity / API key.
 *
 * The authentication middleware is expected to populate `req.auth` (or
 * `req.user` / `req.apiKey`) with a role. We accept several shapes for
 * backwards compatibility but always normalize to a known role.
 *
 * @param {object} req Express request
 * @returns {string|null} resolved role or null when unauthenticated
 */
function resolveRole(req) {
  if (!req) return null;

  const candidates = [];

  if (req.auth && typeof req.auth === 'object') {
    candidates.push(req.auth.role, req.auth.scope);
  }
  if (req.user && typeof req.user === 'object') {
    candidates.push(req.user.role);
  }
  if (req.apiKey && typeof req.apiKey === 'object') {
    candidates.push(req.apiKey.role);
  }
  candidates.push(req.adminRole);

  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const normalized = candidate.trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(ROLE_PERMISSIONS, normalized)) {
      return normalized;
    }
  }

  return null;
}

/**
 * Check whether a role grants a permission.
 *
 * @param {string|null} role
 * @param {string} permission
 * @returns {boolean}
 */
function roleHasPermission(role, permission) {
  if (!role || !permission) return false;
  const granted = ROLE_PERMISSIONS[role];
  if (!granted) return false;
  return granted.includes(permission);
}

/**
 * Resolve the effective permissions for a role.
 *
 * @param {string|null} role
 * @returns {string[]}
 */
function permissionsForRole(role) {
  if (!role) return [];
  const granted = ROLE_PERMISSIONS[role];
  return granted ? granted.slice() : [];
}

function forbidden(res, permission, role) {
  const body = {
    error: 'FORBIDDEN',
    message: 'Insufficient permissions for this operation',
    requiredPermission: permission,
  };
  if (res && typeof res.status === 'function') {
    return res.status(403).json(body);
  }
  return body;
}

/**
 * Express middleware factory enforcing a single permission.
 *
 * On success attaches audit context to `req`:
 *   - req.permission        the required permission
 *   - req.adminRole         the resolved role
 *   - req.permissions       the effective permissions for the role
 *
 * Denies with 403 FORBIDDEN when the caller lacks the permission.
 *
 * @param {string} permission one of PERMISSIONS
 * @returns {Function} Express middleware
 */
function requirePermission(permission) {
  if (!VALID_PERMISSIONS.has(permission)) {
    throw new Error(`Unknown permission: ${permission}`);
  }

  return function permissionMiddleware(req, res, next) {
    const role = resolveRole(req);

    if (!role) {
      return forbidden(res, permission, null);
    }

    if (!roleHasPermission(role, permission)) {
      return forbidden(res, permission, role);
    }

    // Attach resolved permission context for downstream auditing.
    req.permission = permission;
    req.adminRole = role;
    req.permissions = permissionsForRole(role);

    return next();
  };
}

/**
 * Middleware factory requiring ALL of the given permissions.
 *
 * @param {string[]} permissions
 * @returns {Function}
 */
function requireAllPermissions(permissions) {
  if (!Array.isArray(permissions) || permissions.length === 0) {
    throw new Error('requireAllPermissions requires a non-empty array');
  }
  permissions.forEach((p) => {
    if (!VALID_PERMISSIONS.has(p)) {
      throw new Error(`Unknown permission: ${p}`);
    }
  });

  return function allPermissionsMiddleware(req, res, next) {
    const role = resolveRole(req);
    if (!role) {
      return forbidden(res, permissions[0], null);
    }
    for (const permission of permissions) {
      if (!roleHasPermission(role, permission)) {
        return forbidden(res, permission, role);
      }
    }
    req.permission = permissions[0];
    req.permissionsRequired = permissions.slice();
    req.adminRole = role;
    req.permissions = permissionsForRole(role);
    return next();
  };
}

/**
 * Middleware factory requiring ANY of the given permissions.
 *
 * @param {string[]} permissions
 * @returns {Function}
 */
function requireAnyPermission(permissions) {
  if (!Array.isArray(permissions) || permissions.length === 0) {
    throw new Error('requireAnyPermission requires a non-empty array');
  }
  permissions.forEach((p) => {
    if (!VALID_PERMISSIONS.has(p)) {
      throw new Error(`Unknown permission: ${p}`);
    }
  });

  return function anyPermissionMiddleware(req, res, next) {
    const role = resolveRole(req);
    if (!role) {
      return forbidden(res, permissions[0], null);
    }
    const matched = permissions.find((p) => roleHasPermission(role, p));
    if (!matched) {
      return forbidden(res, permissions[0], role);
    }
    req.permission = matched;
    req.permissionsRequired = permissions.slice();
    req.adminRole = role;
    req.permissions = permissionsForRole(role);
    return next();
  };
}

module.exports = {
  PERMISSIONS,
  ROLES,
  ROLE_PERMISSIONS,
  VALID_PERMISSIONS,
  resolveRole,
  roleHasPermission,
  permissionsForRole,
  requirePermission,
  requireAllPermissions,
  requireAnyPermission,
};
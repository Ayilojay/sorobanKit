const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

/**
 * Middleware that records admin actions in the AuditLog table.
 *
 * The insert is fire-and-forget: it is scheduled with setImmediate so it
 * runs after the response lifecycle, and any failure is logged without
 * being propagated to the response.
 *
 * Tenant isolation: every audit entry is stamped with the acting user's
 * tenant (merchant) id so merchant-owned records stay scoped. Cross-tenant
 * admin access is only permitted for explicitly flagged admins, and the
 * bypass is recorded on the entry itself (audited) rather than silently
 * widening the query scope.
 */
function auditLog(action) {
  return (req, res, next) => {
    const user = req.user || null;
    const tenantId = user ? user.tenantId || user.merchantId || null : null;
    const isAdmin = Boolean(user && user.isAdmin);
    const requestedTenantId = req.params && req.params.tenantId
      ? req.params.tenantId
      : null;

    // An admin may act across tenants, but only when the target tenant is
    // explicitly provided. The bypass is captured on the audit entry so it
    // can be reviewed later.
    const crossTenantBypass = Boolean(
      isAdmin && requestedTenantId && requestedTenantId !== tenantId
    );

    const entry = {
      action,
      userId: user ? user.id : null,
      tenantId,
      targetTenantId: requestedTenantId,
      crossTenantBypass,
      method: req.method,
      path: req.originalUrl,
      ip: req.ip,
      createdAt: new Date(),
    };

    setImmediate(() => {
      prisma.auditLog
        .create({ data: entry })
        .catch((err) => {
          // console.error is the single allowed exception to the backend
          // `no-console` rule (see eslint.config.mjs) for top-level catch blocks.
          console.error('Failed to write audit log entry:', err);
        });
    });

    next();
  };
}

module.exports = auditLog;

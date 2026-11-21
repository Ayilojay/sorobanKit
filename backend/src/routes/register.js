const express = require('express');
const { StrKey } = require('@stellar/stellar-sdk');
const { PrismaClient } = require('@prisma/client');
const { ApiError } = require('../errors');
const { rejectNestedObjects } = require('../middleware/rejectNestedObjects');

const router = express.Router();
const prisma = new PrismaClient();

// Tenant-scoped repository access for merchant-owned records.
//
// Decision (issue #397): we use typed query extensions rather than PostgreSQL
// row-level security. RLS would require a per-request `SET LOCAL app.tenant_id`
// on every pooled connection and a migration touching every merchant-owned
// table; a Prisma client extension keeps the tenant predicate in one place,
// is testable without a live DB session, and fails closed when no tenant is
// supplied. Cross-tenant access is only possible through the explicit
// `forAdmin` escape hatch below, which requires an audited admin identity.
function tenantScopedClient(tenantId) {
  if (!tenantId || typeof tenantId !== 'string') {
    throw new ApiError('TENANT_REQUIRED', 'A tenant identity is required for merchant-owned records');
  }

  return prisma.$extends({
    query: {
      account: {
        async $allOperations({ args, query }) {
          args.where = { ...(args.where || {}), tenantId };
          return query(args);
        },
      },
    },
  });
}

// Explicit, audited admin bypass for cross-tenant access. Every call is
// recorded with the acting admin so cross-tenant reads/writes are traceable.
function adminClient({ adminId, reason }) {
  if (!adminId || typeof adminId !== 'string') {
    throw new ApiError('ADMIN_REQUIRED', 'Admin bypass requires an authenticated admin identity');
  }
  if (!reason || typeof reason !== 'string') {
    throw new ApiError('ADMIN_REASON_REQUIRED', 'Admin bypass requires an audit reason');
  }

  return prisma.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          // eslint-disable-next-line no-console
          console.info('[audit] admin cross-tenant access', { adminId, reason, model, operation });
          return query(args);
        },
      },
    },
  });
}

router.post('/register', rejectNestedObjects, async (req, res, next) => {
  try {
    const { address, memo, tenantId } = req.body || {};

    if (!address || typeof address !== 'string') {
      throw new ApiError('INVALID_INPUT', 'address is required');
    }

    if (!StrKey.isValidEd25519PublicKey(address)) {
      throw new ApiError('INVALID_INPUT', 'Invalid Stellar address');
    }

    if (!tenantId || typeof tenantId !== 'string') {
      throw new ApiError('INVALID_INPUT', 'tenantId is required');
    }

    const accounts = tenantScopedClient(tenantId);

    const existing = await accounts.account.findFirst({ where: { address } });
    if (existing) {
      // Idempotent re-registration: same username+address pair already exists.
      return res.status(200).json({ ok: true, already_registered: true });
    }

    const account = await accounts.account.create({
      data: { address, memo: memo || null, tenantId },
    });

    res.status(201).json({ ok: true, already_registered: false, address: account.address, memo: account.memo });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.tenantScopedClient = tenantScopedClient;
module.exports.adminClient = adminClient;

const express = require('express');
const { StrKey } = require('@stellar/stellar-sdk');
const { PrismaClient } = require('@prisma/client');
const { ApiError } = require('../errors');
const { rejectNestedObjects } = require('../middleware/rejectNestedObjects');

const router = express.Router();
const prisma = new PrismaClient();

// Soft-delete / username reuse semantics (issue #406):
// - A soft-deleted account keeps its address reserved for RESERVATION_MS.
// - During the reservation window, re-registration by the original owner is
//   treated as a restore and requires proof (the original memo).
// - After the reservation expires, the address becomes reusable by anyone.
// - All transitions run inside a transaction so concurrent delete/restore/
//   register calls cannot produce multiple owners.
const RESERVATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function isReservationActive(deletedAt) {
  if (!deletedAt) return false;
  return Date.now() - new Date(deletedAt).getTime() < RESERVATION_MS;
}

router.post('/register', rejectNestedObjects, async (req, res, next) => {
  try {
    const { address, memo } = req.body || {};

    if (!address || typeof address !== 'string') {
      throw new ApiError('INVALID_INPUT', 'address is required');
    }

    if (!StrKey.isValidEd25519PublicKey(address)) {
      throw new ApiError('INVALID_INPUT', 'Invalid Stellar address');
    }

    const result = await prisma.$transaction(async (tx) => {
      const existing = await tx.account.findUnique({ where: { address } });

      if (existing && !existing.deletedAt) {
        // Idempotent re-registration: same username+address pair already exists.
        return { status: 200, body: { ok: true, already_registered: true } };
      }

      if (existing && existing.deletedAt) {
        if (isReservationActive(existing.deletedAt)) {
          // Reservation window: only the original owner may restore, and only
          // with proof (the memo recorded at original registration).
          const providedMemo = memo || null;
          if (providedMemo !== (existing.memo || null)) {
            throw new ApiError(
              'USERNAME_RESERVED',
              'Address is reserved; restoration requires the original memo as proof'
            );
          }

          const restored = await tx.account.update({
            where: { address },
            data: { deletedAt: null },
          });

          return {
            status: 200,
            body: {
              ok: true,
              already_registered: false,
              restored: true,
              address: restored.address,
              memo: restored.memo,
            },
          };
        }

        // Reservation expired: the address is reusable. Reclaim the record
        // atomically so a concurrent registration cannot also claim it.
        const reclaimed = await tx.account.updateMany({
          where: { address, deletedAt: existing.deletedAt },
          data: { memo: memo || null, deletedAt: null },
        });

        if (reclaimed.count === 0) {
          throw new ApiError('CONFLICT', 'Address was concurrently claimed; retry');
        }

        return {
          status: 201,
          body: {
            ok: true,
            already_registered: false,
            reused: true,
            address,
            memo: memo || null,
          },
        };
      }

      const account = await tx.account.create({
        data: { address, memo: memo || null },
      });

      return {
        status: 201,
        body: {
          ok: true,
          already_registered: false,
          address: account.address,
          memo: account.memo,
        },
      };
    });

    res.status(result.status).json(result.body);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.RESERVATION_MS = RESERVATION_MS;

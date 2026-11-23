const express = require('express');
const { getContractStatus, upgradeContract } = require('../../services/contractService');
const { ApiError } = require('../../errors');
const { requirePermission } = require('../../middleware/requirePermission');
const { requireStepUp } = require('../../middleware/requireStepUp');
const { computePayloadHash } = require('../../services/stepUpService');

const router = express.Router();

router.get('/contract/status', async (req, res, next) => {
  try {
    const status = await getContractStatus();
    return res.status(200).json(status);
  } catch (error) {
    if (error.message.includes('not set')) {
      return next(new ApiError('SERVICE_UNAVAILABLE', 'Contract configuration is missing', {
        cause: error,
        retryable: false,
      }));
    }
    return next(new ApiError('INTERNAL_ERROR', 'Failed to fetch contract status', { cause: error }));
  }
});

const STEP_UP_ACTION = 'contract.upgrade';

function buildUpgradePayload(body) {
  const { contractId, targetWasmHash, nonce } = body || {};
  return { contractId, targetWasmHash, nonce };
}

function validateUpgradePayload(payload) {
  const errors = [];
  if (typeof payload.contractId !== 'string' || payload.contractId.trim() === '') {
    errors.push('contractId is required');
  }
  if (typeof payload.targetWasmHash !== 'string' || !/^[0-9a-fA-F]{64}$/.test(payload.targetWasmHash)) {
    errors.push('targetWasmHash must be a 64-character hex string');
  }
  if (typeof payload.nonce !== 'string' || payload.nonce.trim() === '') {
    errors.push('nonce is required');
  }
  return errors;
}

router.post(
  '/contract/upgrade',
  requirePermission('contract:configure'),
  async (req, res, next) => {
    try {
      const payload = buildUpgradePayload(req.body);
      const validationErrors = validateUpgradePayload(payload);
      if (validationErrors.length > 0) {
        return next(new ApiError('VALIDATION_ERROR', 'Invalid contract upgrade payload', {
          details: { errors: validationErrors },
          retryable: false,
        }));
      }

      const payloadHash = computePayloadHash(STEP_UP_ACTION, payload);

      return requireStepUp({
        action: STEP_UP_ACTION,
        payloadHash,
        actorId: req.user && req.user.id,
      })(req, res, async (stepUpError) => {
        if (stepUpError) {
          return next(stepUpError);
        }
        try {
          const result = await upgradeContract({
            contractId: payload.contractId,
            targetWasmHash: payload.targetWasmHash,
            nonce: payload.nonce,
            actorId: req.user && req.user.id,
            stepUpChallengeId: req.stepUp && req.stepUp.challengeId,
            payloadHash,
          });
          return res.status(202).json(result);
        } catch (error) {
          if (error.code === 'STEP_UP_PAYLOAD_MISMATCH') {
            return next(new ApiError('STEP_UP_PAYLOAD_MISMATCH', 'Step-up challenge does not match the requested payload', {
              cause: error,
              retryable: false,
            }));
          }
          if (error.code === 'STEP_UP_EXPIRED') {
            return next(new ApiError('STEP_UP_EXPIRED', 'Step-up challenge has expired', {
              cause: error,
              retryable: true,
            }));
          }
          if (error.code === 'STEP_UP_ALREADY_USED') {
            return next(new ApiError('STEP_UP_ALREADY_USED', 'Step-up challenge has already been used', {
              cause: error,
              retryable: false,
            }));
          }
          if (error.code === 'CONTRACT_UPGRADE_CONFLICT') {
            return next(new ApiError('CONFLICT', 'Contract upgrade is already in progress', {
              cause: error,
              retryable: true,
            }));
          }
          return next(new ApiError('INTERNAL_ERROR', 'Failed to upgrade contract', { cause: error }));
        }
      });
    } catch (error) {
      return next(new ApiError('INTERNAL_ERROR', 'Failed to process contract upgrade', { cause: error }));
    }
  }
);

module.exports = router;
const express = require('express');
const { getContractStatus } = require('../../services/contractService');
const { ApiError } = require('../../errors');

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

module.exports = router;

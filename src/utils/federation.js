'use strict';

/**
 * SEP-2 Federation response validator.
 *
 * SEP-2 defines two query types:
 *   - name: ?q=stellar_address&type=name  → resolves stellar_address to account_id
 *   - id:   ?q=account_id&type=id         → resolves account_id to stellar_address
 *
 * Reference: https://stellar.org/protocol/sep-2
 */

const STELLAR_ADDRESS_RE = /^[^*]+\*[^*]+\.[^*]+$/;
const ACCOUNT_ID_RE = /^G[A-Z2-7]{55}$/;

const REQUIRED_NAME_FIELDS = ['stellar_address', 'account_id'];
const REQUIRED_ID_FIELDS = ['stellar_address', 'account_id'];
const ALLOWED_FIELDS = new Set([
  'stellar_address',
  'account_id',
  'memo_type',
  'memo',
  'federation_server',
]);
const VALID_MEMO_TYPES = new Set(['text', 'id', 'hash']);

class FederationValidationError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'FederationValidationError';
    this.code = code || 'FEDERATION_INVALID';
  }
}

function validateNameResponse(response) {
  if (!response || typeof response !== 'object') {
    throw new FederationValidationError('Response must be a JSON object', 'FEDERATION_BAD_RESPONSE');
  }

  for (const field of REQUIRED_NAME_FIELDS) {
    if (!(field in response)) {
      throw new FederationValidationError(
        `Missing required field: ${field}`,
        'FEDERATION_MISSING_FIELD'
      );
    }
  }

  if (!STELLAR_ADDRESS_RE.test(response.stellar_address)) {
    throw new FederationValidationError(
      `Invalid stellar_address format: ${response.stellar_address}`,
      'FEDERATION_BAD_ADDRESS'
    );
  }

  if (!ACCOUNT_ID_RE.test(response.account_id)) {
    throw new FederationValidationError(
      `Invalid account_id format: ${response.account_id}`,
      'FEDERATION_BAD_ACCOUNT_ID'
    );
  }

  _validateMemo(response);
  return true;
}

function validateIdResponse(response) {
  if (!response || typeof response !== 'object') {
    throw new FederationValidationError('Response must be a JSON object', 'FEDERATION_BAD_RESPONSE');
  }

  for (const field of REQUIRED_ID_FIELDS) {
    if (!(field in response)) {
      throw new FederationValidationError(
        `Missing required field: ${field}`,
        'FEDERATION_MISSING_FIELD'
      );
    }
  }

  if (!ACCOUNT_ID_RE.test(response.account_id)) {
    throw new FederationValidationError(
      `Invalid account_id format: ${response.account_id}`,
      'FEDERATION_BAD_ACCOUNT_ID'
    );
  }

  if (!STELLAR_ADDRESS_RE.test(response.stellar_address)) {
    throw new FederationValidationError(
      `Invalid stellar_address format: ${response.stellar_address}`,
      'FEDERATION_BAD_ADDRESS'
    );
  }

  _validateMemo(response);
  return true;
}

function _validateMemo(response) {
  const hasMemoType = 'memo_type' in response;
  const hasMemo = 'memo' in response;

  if (hasMemoType !== hasMemo) {
    throw new FederationValidationError(
      'memo_type and memo must both be present or both absent',
      'FEDERATION_MEMO_MISMATCH'
    );
  }

  if (hasMemoType) {
    if (!VALID_MEMO_TYPES.has(response.memo_type)) {
      throw new FederationValidationError(
        `Invalid memo_type: ${response.memo_type}. Must be one of: ${[...VALID_MEMO_TYPES].join(', ')}`,
        'FEDERATION_BAD_MEMO_TYPE'
      );
    }
    if (response.memo_type === 'text' && typeof response.memo !== 'string') {
      throw new FederationValidationError('memo must be a string when memo_type is text', 'FEDERATION_BAD_MEMO');
    }
    if (response.memo_type === 'id' && !Number.isInteger(Number(response.memo))) {
      throw new FederationValidationError('memo must be a numeric string when memo_type is id', 'FEDERATION_BAD_MEMO');
    }
  }
}

function validateFederationResponse(response, type) {
  if (type === 'name') return validateNameResponse(response);
  if (type === 'id') return validateIdResponse(response);
  throw new FederationValidationError(`Unknown query type: ${type}`, 'FEDERATION_UNKNOWN_TYPE');
}

module.exports = {
  validateFederationResponse,
  validateNameResponse,
  validateIdResponse,
  FederationValidationError,
};

'use strict';

/**
 * Machine-readable error codes and the HTTP status each maps to.
 *
 * The code is the stable part of the contract: clients branch on it rather
 * than on status alone or on message text, which is free to be reworded.
 */
const ERROR_CODES = {
  INVALID_INPUT: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  GONE: 410,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  VALIDATION_FAILED: 422,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  UPSTREAM_ERROR: 502,
  SERVICE_UNAVAILABLE: 503,
};

/**
 * Fallback message per code, so `new ApiError(CODE)` never sends the raw code
 * as a human-facing message.
 */
const DEFAULT_MESSAGES = {
  INVALID_INPUT: 'Invalid request',
  UNAUTHENTICATED: 'Authentication required',
  FORBIDDEN: 'Forbidden',
  NOT_FOUND: 'Not Found',
  METHOD_NOT_ALLOWED: 'Method Not Allowed',
  GONE: 'Gone',
  CONFLICT: 'Conflict',
  PAYLOAD_TOO_LARGE: 'Payload Too Large',
  UNSUPPORTED_MEDIA_TYPE: 'Unsupported Media Type',
  VALIDATION_FAILED: 'Request validation failed',
  RATE_LIMITED: 'Too many requests, please try again later.',
  INTERNAL_ERROR: 'Internal Server Error',
  UPSTREAM_ERROR: 'Upstream request failed',
  SERVICE_UNAVAILABLE: 'Service Unavailable',
};

/**
 * An error carrying everything the response envelope needs.
 *
 * Throw or pass to `next()` from anywhere; the error handler is the only place
 * that turns one into a response.
 */
class ApiError extends Error {
  /**
   * @param {keyof typeof ERROR_CODES} code
   * @param {string} [message] defaults to the code's generic message
   * @param {{ details?: unknown[], statusCode?: number, retryable?: boolean, cause?: unknown }} [options]
   */
  constructor(code, message, options = {}) {
    const resolvedCode = Object.hasOwn(ERROR_CODES, code) ? code : 'INTERNAL_ERROR';
    super(message || DEFAULT_MESSAGES[resolvedCode] || resolvedCode, { cause: options.cause });

    this.name = 'ApiError';
    this.code = resolvedCode;
    this.statusCode = options.statusCode || ERROR_CODES[resolvedCode];
    if (typeof options.retryable === 'boolean') {
      this.retryable = options.retryable;
    }
    if (options.details) {
      this.details = options.details;
    }
  }
}

/** Reverse lookup for errors that carry only a status (thrown by libraries). */
const RETRYABLE_ERROR_CODES = new Set([
  'RATE_LIMITED',
  'INTERNAL_ERROR',
  'UPSTREAM_ERROR',
  'SERVICE_UNAVAILABLE',
]);

const codeForStatus = (statusCode) =>
  Object.keys(ERROR_CODES).find((code) => ERROR_CODES[code] === statusCode) ||
  (statusCode >= 500 ? 'INTERNAL_ERROR' : 'INVALID_INPUT');

const safeDetails = (details) => {
  if (!Array.isArray(details)) return undefined;
  const fields = details
    .filter((detail) =>
      detail &&
      typeof detail.field === 'string' &&
      typeof detail.message === 'string',
    )
    .slice(0, 20)
    .map(({ field, message }) => ({
      field: field.slice(0, 128),
      message: message.slice(0, 256),
    }));
  return fields.length ? fields : undefined;
};

/**
 * Builds the response body. Kept separate from the handler so the shape has a
 * single definition that non-handler responders (rate limiter, 404) reuse.
 *
 * @returns {{ success: false, error: { code: string, message: string, retryable: boolean, details?: { field: string, message: string }[] } }}
 */
const errorBody = (
  code,
  message,
  { details, correlationId, referenceId, retryable } = {},
) => {
  const sanitizedDetails = safeDetails(details);
  return {
    success: false,
    error: {
      code,
      message,
      retryable: retryable ?? RETRYABLE_ERROR_CODES.has(code),
      ...(sanitizedDetails ? { details: sanitizedDetails } : {}),
    },
    ...(correlationId ? { correlation_id: correlationId } : {}),
    ...(referenceId ? { reference_id: referenceId } : {}),
  };
};

module.exports = {
  ApiError,
  ERROR_CODES,
  DEFAULT_MESSAGES,
  RETRYABLE_ERROR_CODES,
  codeForStatus,
  errorBody,
};

'use strict';

const DEFAULT_FEDERATION_DOMAIN = 'localhost';

const VALID_MEMO_TYPES = ['text', 'id', 'hash'];
const MEMO_ID_RE = /^\d+$/;
const MEMO_HASH_RE = /^[0-9a-fA-F]{64}$/;

const RESERVED_NAMES = ['admin', 'root', 'support', 'system', 'stellar', 'api', 'help'];

// #613 — an address may carry at most this many federation usernames
// (one primary plus up to four aliases).
const MAX_USERNAMES_PER_ADDRESS = 5;

// #613 — Prisma orderBy that resolves an address to its primary username:
// the row flagged primary wins, with oldest-registered as the tiebreak so
// the result stays stable if no row is flagged (e.g. legacy data).
const PRIMARY_USERNAME_ORDER = [{ isPrimary: 'desc' }, { createdAt: 'asc' }];

function normalizeNameTag(value) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) return '';
  return trimmed.includes('*') ? trimmed : `${trimmed}*${DEFAULT_FEDERATION_DOMAIN}`;
}

function validateMemo(memoType, memo) {
  const isMemoEmpty = memo === undefined || memo === null || memo === '';
  const isTypeEmpty = memoType === undefined || memoType === null || memoType === '';

  if (isTypeEmpty && isMemoEmpty) return null;
  if (!isTypeEmpty && isMemoEmpty) return 'memo is required when memo_type is provided.';
  if (isTypeEmpty && !isMemoEmpty) return 'memo_type is required when memo is provided.';
  if (!VALID_MEMO_TYPES.includes(memoType)) {
    return `memo_type must be one of: ${VALID_MEMO_TYPES.join(', ')}.`;
  }
  if (typeof memo !== 'string') {
    return 'memo must be a string.';
  }
  if (memoType === 'text') {
    // Check if memo contains the replacement character (U+FFFD), which indicates
    // that invalid UTF-8 bytes were decoded by Node.js. We reject these because
    // the original client data was not valid UTF-8 and would cause issues with
    // the Stellar SDK downstream.
    if (memo.includes('\uFFFD')) {
      return 'memo of type text must contain valid UTF-8 characters.';
    }
    // Validate that when encoded as UTF-8, it doesn't exceed 28 bytes
    const byteLength = Buffer.byteLength(memo, 'utf8');
    if (byteLength > 28) {
      return 'memo of type text must not exceed 28 bytes.';
    }
  }
  if (memoType === 'id') {
    if (!MEMO_ID_RE.test(memo) || BigInt(memo) > 18446744073709551615n) {
      return 'memo of type id must be a valid 64-bit unsigned integer.';
    }
  }
  if (memoType === 'hash' && !MEMO_HASH_RE.test(memo)) {
    return 'memo of type hash must be a 64-character hex string (32 bytes).';
  }
  return null;
}

const USER_DATABASE = {
  'client*localhost': 'GAPUQZH3WZUXHEMUGZN5ZYU4D4GHCFEMOGUINU6MF345GBD2QXNYYIEQ',
  'lekan*localhost': 'GAPUQZH3WZUXHEMUGZN5ZYU4D4GHCFEMOGUINU6MF345GBD2QXNYYIEQ',
};

// #175 — exponential backoff with jitter for webhook retry scheduling.
// Delay for `attempt` (1-based) is base * factor^(attempt-1), capped at `max`,
// then randomised by ±`jitter` (fraction, default 0.1 = ±10%).
const DEFAULT_RETRY_FACTOR = 2;
const DEFAULT_RETRY_JITTER = 0.1;

function exponentialDelay(attempt, base, max, jitter = DEFAULT_RETRY_JITTER, factor = DEFAULT_RETRY_FACTOR) {
  const safeAttempt = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 1;
  const safeBase = Number.isFinite(base) && base > 0 ? base : 0;
  const safeMax = Number.isFinite(max) && max > 0 ? max : Infinity;
  const safeFactor = Number.isFinite(factor) && factor > 0 ? factor : DEFAULT_RETRY_FACTOR;
  const safeJitter = Number.isFinite(jitter) && jitter >= 0 ? jitter : DEFAULT_RETRY_JITTER;

  const raw = safeBase * Math.pow(safeFactor, safeAttempt - 1);
  const capped = Math.min(raw, safeMax);
  const spread = capped * safeJitter;
  const jittered = capped + (Math.random() * 2 - 1) * spread;
  return Math.max(0, Math.round(jittered));
}

const shouldFallbackToLocalRegistry = (error) => {
  const code = typeof error?.code === 'string' ? error.code : '';
  const message = typeof error?.message === 'string' ? error.message : '';
  return (
    code.startsWith('P10') ||
    ['P2021', 'P2023', 'P2028', 'P2001'].includes(code) ||
    /DATABASE_URL|connect|relation|table|timeout/i.test(message)
  );
};

// #378 — shared decimal-safe Stellar amount boundary. All conversions use
// string/BigInt arithmetic so no value ever passes through a JS float.
const STELLAR_DECIMALS = 7;
const STELLAR_SCALE = 10n ** BigInt(STELLAR_DECIMALS);
const STELLAR_MAX_UNITS = 9223372036854775807n; // int64 max
const STELLAR_MIN_UNITS = -9223372036854775808n; // int64 min
const AMOUNT_RE = /^(\d+)(?:\.(\d+))?$/;

class AmountError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'AmountError';
    this.code = code;
  }
}

function parseAmount(value, options = {}) {
  const { decimals = STELLAR_DECIMALS, allowNegative = false, allowZero = true } = options;
  if (typeof value !== 'string') {
    throw new AmountError('amount must be a decimal string.', 'AMOUNT_NOT_STRING');
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new AmountError('amount must not be empty.', 'AMOUNT_EMPTY');
  }
  let negative = false;
  let body = trimmed;
  if (body.startsWith('-')) {
    if (!allowNegative) {
      throw new AmountError('amount must not be negative.', 'AMOUNT_NEGATIVE');
    }
    negative = true;
    body = body.slice(1);
  } else if (body.startsWith('+')) {
    throw new AmountError('amount must not use a leading plus sign.', 'AMOUNT_BAD_NOTATION');
  }
  if (/[eE]/.test(body)) {
    throw new AmountError('amount must not use scientific notation.', 'AMOUNT_BAD_NOTATION');
  }
  const match = AMOUNT_RE.exec(body);
  if (!match) {
    throw new AmountError('amount must be a plain decimal string.', 'AMOUNT_BAD_NOTATION');
  }
  const whole = match[1];
  const fraction = match[2] || '';
  if (fraction.length > decimals) {
    throw new AmountError(`amount must not exceed ${decimals} decimal places.`, 'AMOUNT_PRECISION');
  }
  const padded = fraction.padEnd(decimals, '0');
  const units = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(padded || '0');
  const signed = negative ? -units : units;
  if (signed > STELLAR_MAX_UNITS || signed < STELLAR_MIN_UNITS) {
    throw new AmountError('amount exceeds the int64 range.', 'AMOUNT_OVERFLOW');
  }
  if (!allowZero && signed === 0n) {
    throw new AmountError('amount must be greater than zero.', 'AMOUNT_ZERO');
  }
  return signed;
}

function formatAmount(units, options = {}) {
  const { decimals = STELLAR_DECIMALS } = options;
  const value = typeof units === 'bigint' ? units : BigInt(units);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  const fraction = (abs % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  const body = fraction ? `${whole}.${fraction}` : whole.toString();
  return negative ? `-${body}` : body;
}

function isValidAmount(value, options = {}) {
  try {
    parseAmount(value, options);
    return true;
  } catch (error) {
    if (error instanceof AmountError) return false;
    throw error;
  }
}

function validateAmount(value, options = {}) {
  try {
    parseAmount(value, options);
    return null;
  } catch (error) {
    if (error instanceof AmountError) return error.message;
    throw error;
  }
}

module.exports = {
  normalizeNameTag,
  validateMemo,
  RESERVED_NAMES,
  MAX_USERNAMES_PER_ADDRESS,
  PRIMARY_USERNAME_ORDER,
  VALID_MEMO_TYPES,
  USER_DATABASE,
  shouldFallbackToLocalRegistry,
  exponentialDelay,
  DEFAULT_RETRY_FACTOR,
  DEFAULT_RETRY_JITTER,
  STELLAR_DECIMALS,
  STELLAR_MAX_UNITS,
  STELLAR_MIN_UNITS,
  AmountError,
  parseAmount,
  formatAmount,
  isValidAmount,
  validateAmount,
};

// src/utils/amounts.js
//
// Shared amount utilities.
//
// Canonical amounts are always represented as decimal-safe strings (e.g.
// "1234.5678"). Token precision is applied only at the UI boundary, when
// formatting for display or when parsing localized user input back into a
// canonical string. All arithmetic on the decimal portion is performed with
// string manipulation only — no Number conversion — so no floating-point
// round-trip loss can occur.

/**
 * Default token precision map for known assets.
 * Values represent the number of decimal places supported by each asset.
 */
export const DEFAULT_TOKEN_PRECISION = Object.freeze({
  BTC: 8,
  ETH: 18,
  USDC: 6,
  USDT: 6,
  DAI: 18,
  SOL: 9,
  XRP: 6,
  ADA: 6,
  DOT: 10,
  MATIC: 18,
  AVAX: 18,
  LINK: 18,
  LTC: 8,
  BCH: 8,
  XLM: 7,
  ATOM: 6,
  ALGO: 6,
  FTM: 18,
  NEAR: 24,
  ARB: 18,
  OP: 18,
});

/**
 * Fallback precision used when an asset is unknown and no precision is given.
 */
export const DEFAULT_PRECISION = 6;

const DECIMAL_SEPARATOR_FALLBACK = '.';
const MINUS_SIGNS = ['-', '\u2212', '\u2012', '\u2013', '\u2014'];

/**
 * Resolve the precision for a given asset / explicit precision.
 *
 * @param {string} [asset] - Asset symbol, e.g. "ETH".
 * @param {number} [precision] - Explicit precision override.
 * @returns {number} Non-negative integer precision.
 */
export function resolvePrecision(asset, precision) {
  if (precision !== undefined && precision !== null) {
    if (!Number.isInteger(precision) || precision < 0) {
      throw new RangeError(`Invalid precision: ${precision}`);
    }
    return precision;
  }
  if (asset && Object.prototype.hasOwnProperty.call(DEFAULT_TOKEN_PRECISION, asset)) {
    return DEFAULT_TOKEN_PRECISION[asset];
  }
  return DEFAULT_PRECISION;
}

/**
 * Validate that a canonical amount string does not exceed the given precision.
 *
 * @param {string} amountString - Canonical decimal string.
 * @param {number} precision - Maximum allowed decimal places.
 * @returns {boolean} True when the amount is within precision bounds.
 */
export function isWithinPrecision(amountString, precision) {
  if (typeof amountString !== 'string') return false;
  const normalized = normalizeCanonical(amountString);
  if (normalized === null) return false;
  const { fraction } = splitCanonical(normalized);
  return fraction.length <= precision;
}

/**
 * Assert that a canonical amount string is within precision bounds.
 * Throws a RangeError otherwise.
 *
 * @param {string} amountString - Canonical decimal string.
 * @param {number} precision - Maximum allowed decimal places.
 * @returns {string} The (normalized) amount string.
 */
export function assertWithinPrecision(amountString, precision) {
  if (!isWithinPrecision(amountString, precision)) {
    throw new RangeError(
      `Amount "${amountString}" exceeds precision of ${precision} decimal places`,
    );
  }
  return normalizeCanonical(amountString);
}

/**
 * Truncate a canonical amount string to the given precision without rounding.
 *
 * @param {string} amountString - Canonical decimal string.
 * @param {number} precision - Maximum allowed decimal places.
 * @returns {string} Canonical amount string truncated to precision.
 */
export function truncateToPrecision(amountString, precision) {
  const normalized = normalizeCanonical(amountString);
  if (normalized === null) {
    throw new TypeError(`Invalid amount string: ${amountString}`);
  }
  const { sign, integer, fraction } = splitCanonical(normalized);
  const truncatedFraction = fraction.slice(0, precision);
  return joinCanonical(sign, integer, truncatedFraction);
}

/**
 * Split a normalized canonical string into sign / integer / fraction parts.
 *
 * @param {string} normalized - Normalized canonical string.
 * @returns {{ sign: string, integer: string, fraction: string }}
 */
function splitCanonical(normalized) {
  const sign = normalized.startsWith('-') ? '-' : '';
  const unsigned = sign ? normalized.slice(1) : normalized;
  const dotIndex = unsigned.indexOf('.');
  if (dotIndex === -1) {
    return { sign, integer: unsigned, fraction: '' };
  }
  return {
    sign,
    integer: unsigned.slice(0, dotIndex),
    fraction: unsigned.slice(dotIndex + 1),
  };
}

/**
 * Join sign / integer / fraction parts into a canonical string.
 *
 * @param {string} sign - "" or "-".
 * @param {string} integer - Integer digits.
 * @param {string} fraction - Fraction digits (may be empty).
 * @returns {string} Canonical string.
 */
function joinCanonical(sign, integer, fraction) {
  const intPart = integer === '' ? '0' : integer;
  if (fraction === '') {
    return `${sign}${intPart}`;
  }
  return `${sign}${intPart}.${fraction}`;
}

/**
 * Normalize a canonical amount string:
 *  - trims whitespace
 *  - accepts a leading "+" or "-"
 *  - strips thousands separators (commas)
 *  - ensures a leading "0" before the decimal point
 *  - strips trailing zeros in the fraction (but keeps at least one digit
 *    if a decimal point was present? No — canonical form drops the point when
 *    the fraction is empty)
 *
 * Returns null when the input is not a valid decimal string.
 *
 * @param {string} input
 * @returns {string|null}
 */
export function normalizeCanonical(input) {
  if (typeof input !== 'string') return null;
  let s = input.trim();
  if (s === '') return null;

  let sign = '';
  if (s[0] === '+' || s[0] === '-') {
    sign = s[0] === '-' ? '-' : '';
    s = s.slice(1);
  }

  // Strip grouping separators.
  s = s.replace(/,/g, '');

  if (s === '') return null;

  const dotIndex = s.indexOf('.');
  let integer;
  let fraction;
  if (dotIndex === -1) {
    integer = s;
    fraction = '';
  } else {
    integer = s.slice(0, dotIndex);
    fraction = s.slice(dotIndex + 1);
    if (fraction.indexOf('.') !== -1) return null;
  }

  if (integer === '') integer = '0';
  if (!/^\d+$/.test(integer)) return null;
  if (fraction !== '' && !/^\d+$/.test(fraction)) return null;

  // Strip leading zeros in the integer part (keep at least one digit).
  integer = integer.replace(/^0+(?=\d)/, '');

  // Strip trailing zeros in the fraction part.
  fraction = fraction.replace(/0+$/, '');

  // Zero is never negative.
  if (integer === '0' && fraction === '') {
    sign = '';
  }

  return joinCanonical(sign, integer, fraction);
}

/**
 * Determine the decimal separator used by a locale.
 *
 * @param {string} locale
 * @returns {string}
 */
function getDecimalSeparator(locale) {
  try {
    const parts = new Intl.NumberFormat(locale).formatToParts(1.1);
    const sep = parts.find((p) => p.type === 'decimal');
    if (sep && sep.value) return sep.value;
  } catch {
    // fall through
  }
  return DECIMAL_SEPARATOR_FALLBACK;
}

/**
 * Determine the grouping separator used by a locale (may be empty string).
 *
 * @param {string} locale
 * @returns {string}
 */
function getGroupSeparator(locale) {
  try {
    const parts = new Intl.NumberFormat(locale).formatToParts(1234567.1);
    const sep = parts.find((p) => p.type === 'group');
    if (sep && sep.value) return sep.value;
  } catch {
    // fall through
  }
  return '';
}

/**
 * Format a canonical amount string for display using the given locale and
 * token precision. Precision is applied by truncation (never rounding) so
 * the displayed value never exceeds the canonical value.
 *
 * @param {string} amountString - Canonical decimal string.
 * @param {object} [options]
 * @param {string} [options.locale='en-US'] - BCP 47 locale.
 * @param {number} [options.precision] - Explicit precision override.
 * @param {string} [options.asset] - Asset symbol used to look up precision.
 * @param {boolean} [options.useGrouping=true] - Whether to group thousands.
 * @param {boolean} [options.trimTrailingZeros=false] - Drop trailing zeros in
 *   the fraction (still respecting precision).
 * @param {string} [options.currency] - Optional ISO currency for Intl.
 * @returns {string} Localized amount string.
 */
export function formatAmount(amountString, options = {}) {
  const {
    locale = 'en-US',
    precision,
    asset,
    useGrouping = true,
    trimTrailingZeros = false,
    currency,
  } = options;

  const normalized = normalizeCanonical(amountString);
  if (normalized === null) {
    throw new TypeError(`Invalid amount string: ${amountString}`);
  }

  const resolvedPrecision = resolvePrecision(asset, precision);
  const { sign, integer, fraction } = splitCanonical(normalized);

  let displayFraction = fraction.slice(0, resolvedPrecision);
  if (trimTrailingZeros) {
    displayFraction = displayFraction.replace(/0+$/, '');
  }

  // Format the integer part with grouping via Intl, but keep the fraction
  // as an exact string so no floating-point conversion occurs.
  let formattedInteger;
  try {
    const intFormatter = new Intl.NumberFormat(locale, {
      useGrouping,
      maximumFractionDigits: 0,
    });
    // Formatting the integer part as a Number is safe for values up to
    // Number.MAX_SAFE_INTEGER; for larger values we fall back to manual
    // grouping to avoid precision loss.
    if (integer.length <= 15) {
      formattedInteger = intFormatter.format(Number(integer));
    } else {
      formattedInteger = groupDigits(integer, locale, useGrouping);
    }
  } catch {
    formattedInteger = groupDigits(integer, locale, useGrouping);
  }

  const decimalSeparator = getDecimalSeparator(locale);
  const signPrefix = sign === '-' ? '-' : '';

  let result;
  if (displayFraction === '') {
    result = `${signPrefix}${formattedInteger}`;
  } else {
    result = `${signPrefix}${formattedInteger}${decimalSeparator}${displayFraction}`;
  }

  if (currency) {
    try {
      const currencyFormatter = new Intl.NumberFormat(locale, {
        style: 'currency',
        currency,
        minimumFractionDigits: 0,
        maximumFractionDigits: 0,
      });
      const parts = currencyFormatter.formatToParts(0);
      const prefix = parts
        .filter((p) => p.type !== 'integer' && p.type !== 'group' && p.type !== 'decimal' && p.type !== 'fraction')
        .map((p) => p.value)
        .join('');
      // Place currency symbol before the amount for simplicity.
      result = `${prefix}${result}`;
    } catch {
      // ignore invalid currency
    }
  }

  return result;
}

/**
 * Manually group integer digits according to the locale's grouping separator.
 *
 * @param {string} integer - Integer digits (no sign).
 * @param {string} locale
 * @param {boolean} useGrouping
 * @returns {string}
 */
function groupDigits(integer, locale, useGrouping) {
  if (!useGrouping) return integer;
  const groupSep = getGroupSeparator(locale);
  if (!groupSep) return integer;
  let out = '';
  let count = 0;
  for (let i = integer.length - 1; i >= 0; i -= 1) {
    out = integer[i] + out;
    count += 1;
    if (count % 3 === 0 && i !== 0) {
      out = groupSep + out;
    }
  }
  return out;
}

/**
 * Parse localized user input back into a canonical decimal string.
 * Uses string manipulation only — no Number conversion.
 *
 * @param {string} input - Localized amount input.
 * @param {object} [options]
 * @param {string} [options.locale='en-US'] - BCP 47 locale.
 * @param {number} [options.precision] - Explicit precision override.
 * @param {string} [options.asset] - Asset symbol used to look up precision.
 * @param {boolean} [options.strict=true] - When true, throws on invalid input
 *   or precision overflow. When false, returns null instead.
 * @returns {string|null} Canonical amount string, or null when invalid and
 *   strict is false.
 */
export function parseAmount(input, options = {}) {
  const { locale = 'en-US', precision, asset, strict = true } = options;

  const fail = (message) => {
    if (strict) throw new TypeError(message);
    return null;
  };

  if (typeof input !== 'string') {
    return fail(`Invalid amount input: ${input}`);
  }

  let s = input.trim();
  if (s === '') {
    return fail('Empty amount input');
  }

  // Detect and strip sign.
  let sign = '';
  for (const minus of MINUS_SIGNS) {
    if (s.startsWith(minus)) {
      sign = '-';
      s = s.slice(minus.length).trim();
      break;
    }
  }
  if (s.startsWith('+')) {
    s = s.slice(1).trim();
  }

  // Strip currency symbols and whitespace (non-digit, non-separator chars).
  const decimalSeparator = getDecimalSeparator(locale);
  const groupSeparator = getGroupSeparator(locale);

  // Remove grouping separators.
  if (groupSeparator) {
    s = s.split(groupSeparator).join('');
  }
  // Also strip common grouping separators that may appear regardless of locale.
  s = s.replace(/[\s\u00a0\u202f]/g, '');
  s = s.replace(/[,'`]/g, (m) => (m === groupSeparator ? '' : m));

  // Strip any leading currency symbols / letters.
  s = s.replace(/^[^\d.,]+/, '');
  // Strip any trailing non-numeric characters (e.g. currency codes).
  s = s.replace(/[^\d.,]+$/, '');

  if (s === '') {
    return fail(`Invalid amount input: ${input}`);
  }

  // Normalize the decimal separator to ".".
  if (decimalSeparator !== '.') {
    s = s.split(decimalSeparator).join('.');
  }

  // If there are multiple dots, treat the last as the decimal separator and
  // strip the rest as grouping (best-effort for ambiguous input).
  const dotCount = (s.match(/\./g) || []).length;
  if (dotCount > 1) {
    const lastDot = s.lastIndexOf('.');
    const intPart = s.slice(0, lastDot).replace(/\./g, '');
    const fracPart = s.slice(lastDot + 1);
    s = `${intPart}.${fracPart}`;
  }

  // Validate the numeric shape.
  if (!/^\d*(\.\d*)?$/.test(s)) {
    return fail(`Invalid amount input: ${input}`);
  }

  const normalized = normalizeCanonical(`${sign}${s}`);
  if (normalized === null) {
    return fail(`Invalid amount input: ${input}`);
  }

  const resolvedPrecision = resolvePrecision(asset, precision);
  if (!isWithinPrecision(normalized, resolvedPrecision)) {
    return fail(
      `Amount "${input}" exceeds precision of ${resolvedPrecision} decimal places`,
    );
  }

  return normalized;
}

/**
 * Compare two canonical amount strings.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} -1, 0, or 1.
 */
export function compareAmounts(a, b) {
  const na = normalizeCanonical(a);
  const nb = normalizeCanonical(b);
  if (na === null || nb === null) {
    throw new TypeError('Invalid amount string');
  }
  const sa = splitCanonical(na);
  const sb = splitCanonical(nb);

  const aNeg = sa.sign === '-';
  const bNeg = sb.sign === '-';
  if (aNeg !== bNeg) return aNeg ? -1 : 1;

  const magnitudeCompare = compareMagnitude(sa, sb);
  return aNeg ? -magnitudeCompare : magnitudeCompare;
}

function compareMagnitude(a, b) {
  const intA = a.integer;
  const intB = b.integer;
  if (intA.length !== intB.length) {
    return intA.length < intB.length ? -1 : 1;
  }
  if (intA !== intB) {
    return intA < intB ? -1 : 1;
  }
  const maxLen = Math.max(a.fraction.length, b.fraction.length);
  const fracA = a.fraction.padEnd(maxLen, '0');
  const fracB = b.fraction.padEnd(maxLen, '0');
  if (fracA === fracB) return 0;
  return fracA < fracB ? -1 : 1;
}

export default DEFAULT_TOKEN_PRECISION;
'use strict';

/**
 * src/services/statsService.js
 *
 * Service for calculating payment routing statistics and aggregation data.
 */

/**
 * Helper to extract bucket key from a Date based on interval.
 *
 * @param {Date|string} date
 * @param {'day'|'week'|'month'} interval
 * @returns {string} Bucket key formatted as:
 *   - 'day':   YYYY-MM-DD
 *   - 'week':  YYYY-MM-DD (Monday representing start of week in UTC)
 *   - 'month': YYYY-MM
 */
const getBucketKey = (date, interval) => {
  const d = new Date(date);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');

  if (interval === 'month') {
    return `${year}-${month}`;
  }

  if (interval === 'week') {
    // Start of week (Monday) in UTC
    const dayOfWeek = d.getUTCDay(); // 0 is Sunday, 1 is Monday, ..., 6 is Saturday
    const diff = (dayOfWeek === 0 ? -6 : 1) - dayOfWeek;
    const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + diff));
    const mYear = monday.getUTCFullYear();
    const mMonth = String(monday.getUTCMonth() + 1).padStart(2, '0');
    const mDay = String(monday.getUTCDate()).padStart(2, '0');
    return `${mYear}-${mMonth}-${mDay}`;
  }

  // Default: 'day' -> YYYY-MM-DD
  return `${year}-${month}-${day}`;
};

/**
 * Builds the Prisma `where` clause for the optional date-range filters.
 *
 * @param {string|undefined} startDate - ISO date string (YYYY-MM-DD).
 * @param {string|undefined} endDate   - ISO date string (YYYY-MM-DD).
 * @returns {object} Prisma where clause fragment.
 */
const buildDateFilter = (startDate, endDate) => {
  if (!startDate && !endDate) return {};

  const filter = {};
  if (startDate) {
    const start = new Date(startDate);
    start.setUTCHours(0, 0, 0, 0);
    filter.gte = start;
  }
  if (endDate) {
    const end = new Date(endDate);
    end.setUTCHours(23, 59, 59, 999);
    filter.lte = end;
  }
  return { createdAt: filter };
};

/**
 * Retrieves historical payment routing statistics aggregated by day, week, or month.
 *
 * @param {object} opts
 * @param {object} opts.prisma - Prisma client instance.
 * @param {string} [opts.startDate] - Inclusive start date (YYYY-MM-DD).
 * @param {string} [opts.endDate] - Inclusive end date (YYYY-MM-DD).
 * @param {'day'|'week'|'month'} [opts.groupBy='day'] - Grouping interval.
 * @param {'day'|'week'|'month'} [opts.interval] - Alias for groupBy.
 * @param {string} [opts.assetCode] - Optional asset filter.
 * @returns {Promise<object>} Grouped aggregation statistics and summary.
 */
/**
 * Snaps a date string to the Monday of its ISO week (for startDate) or the
 * Sunday of its ISO week (for endDate). Without this, a weekly query with a
 * date range that starts or ends mid-week produces partial week buckets near
 * month boundaries, which look wrong in the response.
 *
 * @param {string} dateStr - YYYY-MM-DD
 * @param {'start'|'end'} side
 * @returns {string} Adjusted YYYY-MM-DD
 */
const snapToWeekBoundary = (dateStr, side) => {
  const d = new Date(dateStr);
  d.setUTCHours(0, 0, 0, 0);
  const dow = d.getUTCDay(); // 0 = Sun, 1 = Mon, …, 6 = Sat
  if (side === 'start') {
    const daysBack = dow === 0 ? 6 : dow - 1;
    if (daysBack > 0) d.setUTCDate(d.getUTCDate() - daysBack);
  } else {
    const daysForward = dow === 0 ? 0 : 7 - dow;
    if (daysForward > 0) d.setUTCDate(d.getUTCDate() + daysForward);
  }
  return d.toISOString().slice(0, 10);
};

/**
 * Formats an exact integer unit amount as a fixed-precision decimal string.
 *
 * @param {bigint} units - Amount expressed in the asset's smallest unit.
 * @param {number} precision - Number of decimal places for the asset.
 * @returns {string} Decimal string, e.g. formatUnits(1234567n, 7) === '0.1234567'.
 */
const formatUnits = (units, precision) => {
  const p = Number.isInteger(precision) && precision >= 0 ? precision : 7;
  const value = BigInt(units);
  const negative = value < 0n;
  const abs = negative ? -value : value;

  if (p === 0) {
    return `${negative ? '-' : ''}${abs.toString()}`;
  }

  const divisor = 10n ** BigInt(p);
  const whole = abs / divisor;
  const fraction = (abs % divisor).toString().padStart(p, '0');
  return `${negative ? '-' : ''}${whole.toString()}.${fraction}`;
};

const getRoutingStats = async ({
  prisma,
  startDate,
  endDate,
  groupBy,
  interval,
  assetCode,
}) => {
  const selectedInterval = interval || groupBy || 'day';

  // Snap date range to ISO week boundaries so weekly buckets near month
  // boundaries contain the full week's data rather than a partial slice.
  let effectiveStartDate = startDate;
  let effectiveEndDate = endDate;
  if (selectedInterval === 'week') {
    if (effectiveStartDate) effectiveStartDate = snapToWeekBoundary(effectiveStartDate, 'start');
    if (effectiveEndDate) effectiveEndDate = snapToWeekBoundary(effectiveEndDate, 'end');
  }

  const where = {
    ...buildDateFilter(effectiveStartDate, effectiveEndDate),
  };

  if (assetCode) {
    where.assetCode = assetCode;
  }

  const records = await prisma.payment.findMany({
    where,
    select: {
      id: true,
      createdAt: true,
      amountUnits: true,
      feeUnits: true,
      assetCode: true,
      assetPrecision: true,
      status: true,
    },
    orderBy: { createdAt: 'asc' },
  });

  // All monetary values are stored as exact integer units (BigInt) alongside
  // the asset's precision. Summing integers avoids floating-point drift; the
  // conversion to a decimal string happens once, at the end, per precision.
  let totalVolumeUnits = 0n;
  let totalFeesUnits = 0n;
  let totalCount = 0;

  const buckets = new Map();

  for (const record of records) {
    const amountUnits = BigInt(record.amountUnits ?? 0);
    const feeUnits = BigInt(record.feeUnits ?? 0);
    const precision = Number.isInteger(record.assetPrecision) ? record.assetPrecision : 7;

    totalVolumeUnits += amountUnits;
    totalFeesUnits += feeUnits;
    totalCount += 1;

    const bucketKey = getBucketKey(record.createdAt, selectedInterval);
    if (!buckets.has(bucketKey)) {
      buckets.set(bucketKey, {
        period: bucketKey,
        volumeUnits: 0n,
        feesUnits: 0n,
        count: 0,
        // Highest precision seen in the bucket; used to render decimal strings.
        precision: 0,
      });
    }

    const bucket = buckets.get(bucketKey);
    bucket.volumeUnits += amountUnits;
    bucket.feesUnits += feeUnits;
    bucket.count += 1;
    if (precision > bucket.precision) bucket.precision = precision;
  }

  const data = Array.from(buckets.values()).map((bucket) => ({
    period: bucket.period,
    volume: formatUnits(bucket.volumeUnits, bucket.precision),
    fees: formatUnits(bucket.feesUnits, bucket.precision),
    count: bucket.count,
  }));

  // Summary precision: the highest precision across all records, defaulting to
  // the platform's canonical 7 decimals when there are no records.
  const summaryPrecision = records.reduce(
    (max, record) =>
      Number.isInteger(record.assetPrecision) && record.assetPrecision > max
        ? record.assetPrecision
        : max,
    0,
  );
  const effectiveSummaryPrecision = records.length > 0 ? summaryPrecision : 7;

  return {
    interval: selectedInterval,
    startDate: startDate || null,
    endDate: endDate || null,
    summary: {
      total_volume: formatUnits(totalVolumeUnits, effectiveSummaryPrecision),
      total_fees: formatUnits(totalFeesUnits, effectiveSummaryPrecision),
      total_count: totalCount,
    },
    data,
  };
};

const { shouldFallbackToLocalRegistry } = require('../utils');

const SERVER_START_TIME = Date.now();

async function fetchAdminStats(prisma, poolGet) {
  let totalRegisteredUsers;
  let activeTokens;

  try {
    [totalRegisteredUsers, activeTokens] = await prisma.$transaction([
      prisma.user.count(),
      prisma.user.count({ where: { flaggedAt: null } }),
    ]);
  } catch (error) {
    if (!shouldFallbackToLocalRegistry(error)) throw error;

    const totalCountRow = await poolGet(
      'SELECT COUNT(*) AS totalCount FROM username_registry',
    );
    const activeCountRow = await poolGet(
      'SELECT COUNT(*) AS activeCount FROM username_registry WHERE flagged_at IS NULL',
    );
    totalRegisteredUsers = Number(totalCountRow?.totalCount || 0);
    activeTokens = Number(activeCountRow?.activeCount || 0);
  }

  return {
    total_registered_users: totalRegisteredUsers,
    active_tokens: activeTokens,
    platform_uptime_seconds: Math.floor(process.uptime()),
    platform_uptime_started_at: new Date(SERVER_START_TIME).toISOString(),
  };
}

module.exports = {
  getRoutingStats,
  getBucketKey,
  buildDateFilter,
  snapToWeekBoundary,
  fetchAdminStats,
  formatUnits,
  SERVER_START_TIME,
};

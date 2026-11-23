/**
 * Payment draft persistence.
 *
 * Drafts are stored in localStorage under a single key. Only whitelisted,
 * non-secret fields are persisted. Each draft is bound to the account and
 * network it was created under and carries an expiry timestamp. Drafts that
 * are expired, malformed, or bound to a different account/network are
 * discarded on load.
 */

const STORAGE_KEY = 'payment-dashboard:payment-drafts';

/** Default time-to-live for a draft, in milliseconds (24 hours). */
export const DEFAULT_DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Fields that are safe to persist. Anything not listed here is dropped.
 * Never add secrets (card numbers, CVV, full account numbers, tokens, etc.).
 */
export const PERSISTED_FIELDS = Object.freeze([
  'id',
  'recipientName',
  'recipientAccountId',
  'amount',
  'currency',
  'memo',
  'createdAt',
  'updatedAt',
]);

/** Metadata fields stored alongside each draft. */
const META_FIELDS = Object.freeze(['accountId', 'networkId', 'expiresAt']);

function getStorage() {
  try {
    if (typeof globalThis !== 'undefined' && globalThis.localStorage) {
      return globalThis.localStorage;
    }
  } catch {
    // Accessing localStorage can throw (e.g. disabled storage).
  }
  return null;
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pickFields(source, fields) {
  const result = {};
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(source, field)) {
      result[field] = source[field];
    }
  }
  return result;
}

/**
 * Strip a draft down to the whitelisted, non-secret fields.
 */
export function sanitizeDraft(draft) {
  if (!isPlainObject(draft)) {
    return null;
  }
  return pickFields(draft, PERSISTED_FIELDS);
}

function readRaw() {
  const storage = getStorage();
  if (!storage) {
    return {};
  }
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeRaw(data) {
  const storage = getStorage();
  if (!storage) {
    return false;
  }
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
}

function isValidDraftEntry(entry) {
  if (!isPlainObject(entry)) {
    return false;
  }
  if (!isPlainObject(entry.draft)) {
    return false;
  }
  if (typeof entry.accountId !== 'string' || entry.accountId === '') {
    return false;
  }
  if (typeof entry.networkId !== 'string' || entry.networkId === '') {
    return false;
  }
  if (typeof entry.expiresAt !== 'number' || !Number.isFinite(entry.expiresAt)) {
    return false;
  }
  return true;
}

/**
 * Determine whether a stored entry is compatible with the current context.
 */
function isCompatible(entry, context, now) {
  if (!isValidDraftEntry(entry)) {
    return false;
  }
  if (entry.expiresAt <= now) {
    return false;
  }
  if (entry.accountId !== context.accountId) {
    return false;
  }
  if (entry.networkId !== context.networkId) {
    return false;
  }
  return true;
}

/**
 * Load all drafts compatible with the given account/network context.
 * Incompatible, expired, or malformed entries are discarded from storage.
 *
 * @param {{accountId: string, networkId: string}} context
 * @param {{now?: number}} [options]
 * @returns {Array<object>} sanitized drafts
 */
export function loadDrafts(context, options = {}) {
  const now = typeof options.now === 'number' ? options.now : Date.now();
  const raw = readRaw();
  const kept = {};
  const drafts = [];

  for (const [id, entry] of Object.entries(raw)) {
    if (isCompatible(entry, context, now)) {
      const sanitized = sanitizeDraft(entry.draft);
      if (sanitized) {
        kept[id] = {
          ...pickFields(entry, META_FIELDS),
          draft: sanitized,
        };
        drafts.push(sanitized);
      }
    }
  }

  // Persist the pruned set so discarded drafts do not linger.
  writeRaw(kept);
  return drafts;
}

/**
 * Save (create or update) a draft for the given account/network context.
 * Only whitelisted fields are persisted.
 *
 * @param {object} draft must include a non-empty string `id`
 * @param {{accountId: string, networkId: string}} context
 * @param {{now?: number, ttlMs?: number}} [options]
 * @returns {boolean} whether the draft was persisted
 */
export function saveDraft(draft, context, options = {}) {
  if (!isPlainObject(draft) || typeof draft.id !== 'string' || draft.id === '') {
    return false;
  }
  if (!isPlainObject(context) || typeof context.accountId !== 'string' || context.accountId === '') {
    return false;
  }
  if (typeof context.networkId !== 'string' || context.networkId === '') {
    return false;
  }

  const sanitized = sanitizeDraft(draft);
  if (!sanitized) {
    return false;
  }

  const now = typeof options.now === 'number' ? options.now : Date.now();
  const ttlMs = typeof options.ttlMs === 'number' && options.ttlMs > 0
    ? options.ttlMs
    : DEFAULT_DRAFT_TTL_MS;

  const raw = readRaw();
  raw[draft.id] = {
    accountId: context.accountId,
    networkId: context.networkId,
    expiresAt: now + ttlMs,
    draft: sanitized,
  };

  return writeRaw(raw);
}

/**
 * Delete a single draft by id.
 *
 * @param {string} id
 * @returns {boolean} whether the draft existed and was removed
 */
export function deleteDraft(id) {
  if (typeof id !== 'string' || id === '') {
    return false;
  }
  const raw = readRaw();
  if (!Object.prototype.hasOwnProperty.call(raw, id)) {
    return false;
  }
  delete raw[id];
  writeRaw(raw);
  return true;
}

/**
 * Clear all stored drafts.
 *
 * @returns {boolean} whether the clear operation succeeded
 */
export function clearDrafts() {
  const storage = getStorage();
  if (!storage) {
    return false;
  }
  try {
    storage.removeItem(STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

/**
 * Discard drafts that are no longer compatible with the given context.
 * Useful after an account or network change.
 *
 * @param {{accountId: string, networkId: string}} context
 * @param {{now?: number}} [options]
 * @returns {number} number of drafts discarded
 */
export function discardIncompatibleDrafts(context, options = {}) {
  const now = typeof options.now === 'number' ? options.now : Date.now();
  const raw = readRaw();
  const kept = {};
  let discarded = 0;

  for (const [id, entry] of Object.entries(raw)) {
    if (isCompatible(entry, context, now)) {
      kept[id] = entry;
    } else {
      discarded += 1;
    }
  }

  if (discarded > 0) {
    writeRaw(kept);
  }
  return discarded;
}

export { STORAGE_KEY };
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  DRAFT_STORAGE_KEY,
  DRAFT_VERSION,
  DEFAULT_DRAFT_TTL_MS,
  ALLOWED_DRAFT_FIELDS,
  FORBIDDEN_DRAFT_FIELDS,
  saveDraft,
  loadDraft,
  clearDraft,
  deleteDraft,
  isDraftExpired,
  isDraftCompatible,
  sanitizeDraft,
  getDraftStorageKey,
} from './paymentDrafts.js';

const ACCOUNT_A = 'acct_alpha';
const ACCOUNT_B = 'acct_beta';
const NETWORK_A = 'net_mainnet';
const NETWORK_B = 'net_testnet';

function makeDraft(overrides = {}) {
  return {
    amount: '100.00',
    currency: 'USD',
    recipient: 'GB33BUKB20201555555555',
    memo: 'invoice 42',
    ...overrides,
  };
}

function makeContext(overrides = {}) {
  return {
    accountId: ACCOUNT_A,
    networkId: NETWORK_A,
    ...overrides,
  };
}

function createMemoryStorage() {
  const store = new Map();
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => {
      store.set(key, String(value));
    },
    removeItem: (key) => {
      store.delete(key);
    },
    clear: () => store.clear(),
    key: (index) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size;
    },
    _store: store,
  };
}

describe('paymentDrafts', () => {
  let storage;

  beforeEach(() => {
    storage = createMemoryStorage();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('constants', () => {
    it('exposes a stable storage key and version', () => {
      expect(typeof DRAFT_STORAGE_KEY).toBe('string');
      expect(DRAFT_STORAGE_KEY.length).toBeGreaterThan(0);
      expect(DRAFT_VERSION).toBeDefined();
    });

    it('defines a positive default TTL', () => {
      expect(DEFAULT_DRAFT_TTL_MS).toBeGreaterThan(0);
    });

    it('lists allowed fields and never overlaps with forbidden fields', () => {
      expect(Array.isArray(ALLOWED_DRAFT_FIELDS)).toBe(true);
      expect(ALLOWED_DRAFT_FIELDS.length).toBeGreaterThan(0);
      expect(Array.isArray(FORBIDDEN_DRAFT_FIELDS)).toBe(true);
      expect(FORBIDDEN_DRAFT_FIELDS.length).toBeGreaterThan(0);
      for (const field of FORBIDDEN_DRAFT_FIELDS) {
        expect(ALLOWED_DRAFT_FIELDS).not.toContain(field);
      }
    });

    it('treats secret-like fields as forbidden', () => {
      const forbidden = FORBIDDEN_DRAFT_FIELDS.map((f) => f.toLowerCase());
      expect(forbidden).toEqual(
        expect.arrayContaining(['cardnumber', 'cvv', 'cvc', 'pin', 'password', 'secret', 'token'])
      );
    });
  });

  describe('getDraftStorageKey', () => {
    it('binds the storage key to account and network', () => {
      const keyA = getDraftStorageKey(makeContext());
      const keyB = getDraftStorageKey(makeContext({ accountId: ACCOUNT_B }));
      const keyC = getDraftStorageKey(makeContext({ networkId: NETWORK_B }));
      expect(keyA).not.toBe(keyB);
      expect(keyA).not.toBe(keyC);
      expect(keyB).not.toBe(keyC);
    });

    it('is deterministic for the same context', () => {
      expect(getDraftStorageKey(makeContext())).toBe(getDraftStorageKey(makeContext()));
    });

    it('rejects missing context identifiers', () => {
      expect(() => getDraftStorageKey({ accountId: ACCOUNT_A })).toThrow();
      expect(() => getDraftStorageKey({ networkId: NETWORK_A })).toThrow();
      expect(() => getDraftStorageKey({})).toThrow();
    });
  });

  describe('sanitizeDraft', () => {
    it('keeps only allowed fields', () => {
      const sanitized = sanitizeDraft(
        makeDraft({ unexpected: 'value', internalFlag: true })
      );
      for (const key of Object.keys(sanitized)) {
        expect(ALLOWED_DRAFT_FIELDS).toContain(key);
      }
      expect(sanitized).not.toHaveProperty('unexpected');
      expect(sanitized).not.toHaveProperty('internalFlag');
    });

    it('preserves allowed field values', () => {
      const draft = makeDraft();
      const sanitized = sanitizeDraft(draft);
      for (const field of ALLOWED_DRAFT_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(draft, field)) {
          expect(sanitized[field]).toEqual(draft[field]);
        }
      }
    });

    it('strips forbidden secret fields', () => {
      const sanitized = sanitizeDraft(
        makeDraft({ cardNumber: '4242424242424242', cvv: '123', pin: '0000' })
      );
      expect(sanitized).not.toHaveProperty('cardNumber');
      expect(sanitized).not.toHaveProperty('cvv');
      expect(sanitized).not.toHaveProperty('pin');
    });

    it('handles null and non-object input safely', () => {
      expect(sanitizeDraft(null)).toEqual({});
      expect(sanitizeDraft(undefined)).toEqual({});
      expect(sanitizeDraft('string')).toEqual({});
    });
  });

  describe('saveDraft', () => {
    it('persists allowed fields bound to account and network', () => {
      const result = saveDraft(makeDraft(), makeContext(), storage);
      expect(result).toBeTruthy();

      const raw = storage.getItem(getDraftStorageKey(makeContext()));
      expect(raw).not.toBeNull();

      const parsed = JSON.parse(raw);
      expect(parsed.version).toBe(DRAFT_VERSION);
      expect(parsed.accountId).toBe(ACCOUNT_A);
      expect(parsed.networkId).toBe(NETWORK_A);
      expect(parsed.draft.amount).toBe('100.00');
      expect(parsed.draft.currency).toBe('USD');
      expect(parsed.draft.recipient).toBe('GB33BUKB20201555555555');
    });

    it('does not persist secret fields', () => {
      saveDraft(
        makeDraft({ cardNumber: '4242424242424242', cvv: '123', password: 'hunter2' }),
        makeContext(),
        storage
      );
      const raw = storage.getItem(getDraftStorageKey(makeContext()));
      expect(raw).not.toContain('4242424242424242');
      expect(raw).not.toContain('hunter2');
      const parsed = JSON.parse(raw);
      expect(parsed.draft).not.toHaveProperty('cardNumber');
      expect(parsed.draft).not.toHaveProperty('cvv');
      expect(parsed.draft).not.toHaveProperty('password');
    });

    it('records an expiry timestamp based on the provided TTL', () => {
      const ttl = 60_000;
      saveDraft(makeDraft(), makeContext(), storage, { ttlMs: ttl });
      const parsed = JSON.parse(storage.getItem(getDraftStorageKey(makeContext())));
      expect(parsed.expiresAt).toBe(Date.now() + ttl);
    });

    it('uses the default TTL when none is provided', () => {
      saveDraft(makeDraft(), makeContext(), storage);
      const parsed = JSON.parse(storage.getItem(getDraftStorageKey(makeContext())));
      expect(parsed.expiresAt).toBe(Date.now() + DEFAULT_DRAFT_TTL_MS);
    });

    it('rejects invalid TTL values', () => {
      expect(() => saveDraft(makeDraft(), makeContext(), storage, { ttlMs: 0 })).toThrow();
      expect(() => saveDraft(makeDraft(), makeContext(), storage, { ttlMs: -1 })).toThrow();
      expect(() => saveDraft(makeDraft(), makeContext(), storage, { ttlMs: NaN })).toThrow();
    });

    it('rejects missing context', () => {
      expect(() => saveDraft(makeDraft(), {}, storage)).toThrow();
    });

    it('rejects missing storage', () => {
      expect(() => saveDraft(makeDraft(), makeContext(), null)).toThrow();
    });

    it('overwrites a previous draft for the same account and network', () => {
      saveDraft(makeDraft({ amount: '10.00' }), makeContext(), storage);
      saveDraft(makeDraft({ amount: '20.00' }), makeContext(), storage);
      const parsed = JSON.parse(storage.getItem(getDraftStorageKey(makeContext())));
      expect(parsed.draft.amount).toBe('20.00');
    });

    it('keeps drafts for different accounts isolated', () => {
      saveDraft(makeDraft({ amount: '10.00' }), makeContext(), storage);
      saveDraft(makeDraft({ amount: '20.00' }), makeContext({ accountId: ACCOUNT_B }), storage);
      const a = JSON.parse(storage.getItem(getDraftStorageKey(makeContext())));
      const b = JSON.parse(
        storage.getItem(getDraftStorageKey(makeContext({ accountId: ACCOUNT_B })))
      );
      expect(a.draft.amount).toBe('10.00');
      expect(b.draft.amount).toBe('20.00');
    });

    it('keeps drafts for different networks isolated', () => {
      saveDraft(makeDraft({ amount: '10.00' }), makeContext(), storage);
      saveDraft(makeDraft({ amount: '20.00' }), makeContext({ networkId: NETWORK_B }), storage);
      const a = JSON.parse(storage.getItem(getDraftStorageKey(makeContext())));
      const b = JSON.parse(
        storage.getItem(getDraftStorageKey(makeContext({ networkId: NETWORK_B })))
      );
      expect(a.draft.amount).toBe('10.00');
      expect(b.draft.amount).toBe('20.00');
    });

    it('propagates storage write failures', () => {
      const failing = {
        ...createMemoryStorage(),
        setItem: () => {
          throw new Error('quota exceeded');
        },
      };
      expect(() => saveDraft(makeDraft(), makeContext(), failing)).toThrow(/quota exceeded/);
    });
  });

  describe('loadDraft', () => {
    it('returns the saved draft for a matching context', () => {
      saveDraft(makeDraft(), makeContext(), storage);
      const loaded = loadDraft(makeContext(), storage);
      expect(loaded).not.toBeNull();
      expect(loaded.amount).toBe('100.00');
      expect(loaded.currency).toBe('USD');
    });

    it('returns null when no draft exists', () => {
      expect(loadDraft(makeContext(), storage)).toBeNull();
    });

    it('returns null for a different account', () => {
      saveDraft(makeDraft(), makeContext(), storage);
      expect(loadDraft(makeContext({ accountId: ACCOUNT_B }), storage)).toBeNull();
    });

    it('returns null for a different network', () => {
      saveDraft(makeDraft(), makeContext(), storage);
      expect(loadDraft(makeContext({ networkId: NETWORK_B }), storage)).toBeNull();
    });

    it('returns null and clears an expired draft', () => {
      saveDraft(makeDraft(), makeContext(), storage, { ttlMs: 1_000 });
      vi.advanceTimersByTime(1_001);
      expect(loadDraft(makeContext(), storage)).toBeNull();
      expect(storage.getItem(getDraftStorageKey(makeContext()))).toBeNull();
    });

    it('returns the draft just before expiry', () => {
      saveDraft(makeDraft(), makeContext(), storage, { ttlMs: 1_000 });
      vi.advanceTimersByTime(999);
      expect(loadDraft(makeContext(), storage)).not.toBeNull();
    });

    it('returns null and clears a draft with a mismatched version', () => {
      saveDraft(makeDraft(), makeContext(), storage);
      const key = getDraftStorageKey(makeContext());
      const parsed = JSON.parse(storage.getItem(key));
      parsed.version = DRAFT_VERSION + 999;
      storage.setItem(key, JSON.stringify(parsed));
      expect(loadDraft(makeContext(), storage)).toBeNull();
      expect(storage.getItem(key)).toBeNull();
    });

    it('returns null and clears a draft bound to a different account in the payload', () => {
      saveDraft(makeDraft(), makeContext(), storage);
      const key = getDraftStorageKey(makeContext());
      const parsed = JSON.parse(storage.getItem(key));
      parsed.accountId = ACCOUNT_B;
      storage.setItem(key, JSON.stringify(parsed));
      expect(loadDraft(makeContext(), storage)).toBeNull();
      expect(storage.getItem(key)).toBeNull();
    });

    it('returns null and clears a draft bound to a different network in the payload', () => {
      saveDraft(makeDraft(), makeContext(), storage);
      const key = getDraftStorageKey(makeContext());
      const parsed = JSON.parse(storage.getItem(key));
      parsed.networkId = NETWORK_B;
      storage.setItem(key, JSON.stringify(parsed));
      expect(loadDraft(makeContext(), storage)).toBeNull();
      expect(storage.getItem(key)).toBeNull();
    });

    it('returns null and clears corrupted JSON', () => {
      const key = getDraftStorageKey(makeContext());
      storage.setItem(key, '{not valid json');
      expect(loadDraft(makeContext(), storage)).toBeNull();
      expect(storage.getItem(key)).toBeNull();
    });

    it('returns null and clears payloads missing required metadata', () => {
      const key = getDraftStorageKey(makeContext());
      storage.setItem(key, JSON.stringify({ draft: makeDraft() }));
      expect(loadDraft(makeContext(), storage)).toBeNull();
      expect(storage.getItem(key)).toBeNull();
    });

    it('strips any secret fields that were injected into storage', () => {
      saveDraft(makeDraft(), makeContext(), storage);
      const key = getDraftStorageKey(makeContext());
      const parsed = JSON.parse(storage.getItem(key));
      parsed.draft.cardNumber = '4242424242424242';
      parsed.draft.cvv = '123';
      storage.setItem(key, JSON.stringify(parsed));
      const loaded = loadDraft(makeContext(), storage);
      expect(loaded).not.toBeNull();
      expect(loaded).not.toHaveProperty('cardNumber');
      expect(loaded).not.toHaveProperty('cvv');
    });

    it('rejects missing context', () => {
      expect(() => loadDraft({}, storage)).toThrow();
    });

    it('rejects missing storage', () => {
      expect(() => loadDraft(makeContext(), null)).toThrow();
    });
  });

  describe('isDraftExpired', () => {
    it('returns false for a future expiry', () => {
      expect(isDraftExpired({ expiresAt: Date.now() + 1_000 })).toBe(false);
    });

    it('returns true at and past the expiry boundary', () => {
      expect(isDraftExpired({ expiresAt: Date.now() })).toBe(true);
      expect(isDraftExpired({ expiresAt: Date.now() - 1 })).toBe(true);
    });

    it('treats missing or invalid expiry as expired', () => {
      expect(isDraftExpired({})).toBe(true);
      expect(isDraftExpired(null)).toBe(true);
      expect(isDraftExpired({ expiresAt: 'not-a-number' })).toBe(true);
    });
  });

  describe('isDraftCompatible', () => {
    it('returns true for matching account, network, and version', () => {
      const record = {
        version: DRAFT_VERSION,
        accountId: ACCOUNT_A,
        networkId: NETWORK_A,
        draft: makeDraft(),
        expiresAt: Date.now() + 1_000,
      };
      expect(isDraftCompatible(record, makeContext())).toBe(true);
    });

    it('returns false when the account differs', () => {
      const record = {
        version: DRAFT_VERSION,
        accountId: ACCOUNT_A,
        networkId: NETWORK_A,
        draft: makeDraft(),
        expiresAt: Date.now() + 1_000,
      };
      expect(isDraftCompatible(record, makeContext({ accountId: ACCOUNT_B }))).toBe(false);
    });

    it('returns false when the network differs', () => {
      const record = {
        version: DRAFT_VERSION,
        accountId: ACCOUNT_A,
        networkId: NETWORK_A,
        draft: makeDraft(),
        expiresAt: Date.now() + 1_000,
      };
      expect(isDraftCompatible(record, makeContext({ networkId: NETWORK_B }))).toBe(false);
    });

    it('returns false when the version differs', () => {
      const record = {
        version: DRAFT_VERSION + 1,
        accountId: ACCOUNT_A,
        networkId: NETWORK_A,
        draft: makeDraft(),
        expiresAt: Date.now() + 1_000,
      };
      expect(isDraftCompatible(record, makeContext())).toBe(false);
    });

    it('returns false for null or malformed records', () => {
      expect(isDraftCompatible(null, makeContext())).toBe(false);
      expect(isDraftCompatible({}, makeContext())).toBe(false);
    });
  });

  describe('clearDraft', () => {
    it('removes the draft for the given context', () => {
      saveDraft(makeDraft(), makeContext(), storage);
      clearDraft(makeContext(), storage);
      expect(storage.getItem(getDraftStorageKey(makeContext()))).toBeNull();
    });

    it('is a no-op when no draft exists', () => {
      expect(() => clearDraft(makeContext(), storage)).not.toThrow();
    });

    it('does not affect drafts for other accounts or networks', () => {
      saveDraft(makeDraft(), makeContext(), storage);
      saveDraft(makeDraft(), makeContext({ accountId: ACCOUNT_B }), storage);
      saveDraft(makeDraft(), makeContext({ networkId: NETWORK_B }), storage);

      clearDraft(makeContext(), storage);

      expect(storage.getItem(getDraftStorageKey(makeContext()))).toBeNull();
      expect(
        storage.getItem(getDraftStorageKey(makeContext({ accountId: ACCOUNT_B })))
      ).not.toBeNull();
      expect(
        storage.getItem(getDraftStorageKey(makeContext({ networkId: NETWORK_B })))
      ).not.toBeNull();
    });

    it('rejects missing context', () => {
      expect(() => clearDraft({}, storage)).toThrow();
    });
  });

  describe('deleteDraft', () => {
    it('removes the draft for the given context', () => {
      saveDraft(makeDraft(), makeContext(), storage);
      deleteDraft(makeContext(), storage);
      expect(storage.getItem(getDraftStorageKey(makeContext()))).toBeNull();
    });

    it('is idempotent', () => {
      saveDraft(makeDraft(), makeContext(), storage);
      deleteDraft(makeContext(), storage);
      expect(() => deleteDraft(makeContext(), storage)).not.toThrow();
      expect(storage.getItem(getDraftStorageKey(makeContext()))).toBeNull();
    });

    it('rejects missing context', () => {
      expect(() => deleteDraft({}, storage)).toThrow();
    });
  });

  describe('account and network change invalidation', () => {
    it('does not surface a draft after switching accounts', () => {
      saveDraft(makeDraft(), makeContext(), storage);
      const loaded = loadDraft(makeContext({ accountId: ACCOUNT_B }), storage);
      expect(loaded).toBeNull();
    });

    it('does not surface a draft after switching networks', () => {
      saveDraft(makeDraft(), makeContext(), storage);
      const loaded = loadDraft(makeContext({ networkId: NETWORK_B }), storage);
      expect(loaded).toBeNull();
    });

    it('does not surface a draft after switching back and forth', () => {
      saveDraft(makeDraft(), makeContext(), storage);
      expect(loadDraft(makeContext({ accountId: ACCOUNT_B }), storage)).toBeNull();
      expect(loadDraft(makeContext(), storage)).not.toBeNull();
    });

    it('discards an incompatible draft when loading under a new account', () => {
      saveDraft(makeDraft(), makeContext(), storage);
      const key = getDraftStorageKey(makeContext());
      const parsed = JSON.parse(storage.getItem(key));
      parsed.accountId = ACCOUNT_B;
      storage.setItem(key, JSON.stringify(parsed));

      expect(loadDraft(makeContext(), storage)).toBeNull();
      expect(storage.getItem(key)).toBeNull();
    });
  });

  describe('concurrency and recovery', () => {
    it('recovers from a partial write by returning null and clearing', () => {
      const key = getDraftStorageKey(makeContext());
      storage.setItem(key, '{"version":');
      expect(loadDraft(makeContext(), storage)).toBeNull();
      expect(storage.getItem(key)).toBeNull();
    });

    it('handles concurrent saves by keeping the last write', () => {
      saveDraft(makeDraft({ amount: '1.00' }), makeContext(), storage);
      saveDraft(makeDraft({ amount: '2.00' }), makeContext(), storage);
      const loaded = loadDraft(makeContext(), storage);
      expect(loaded.amount).toBe('2.00');
    });

    it('tolerates storage read failures by returning null', () => {
      const failing = {
        ...createMemoryStorage(),
        getItem: () => {
          throw new Error('read failed');
        },
      };
      expect(loadDraft(makeContext(), failing)).toBeNull();
    });
  });
});
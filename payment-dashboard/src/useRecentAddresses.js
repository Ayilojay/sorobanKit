import { useCallback, useState } from 'react';
import {
  readDraft,
  writeDraft,
  clearDraft,
  DRAFT_KINDS,
} from './draftPersistence';

const STORAGE_KEY = 'recent_transactions';
const MAX_ENTRIES = 5;

/**
 * Reads the recent address list from localStorage.
 * Returns an empty array if nothing is stored, the data is malformed,
 * or the stored draft is expired / bound to a different account or network.
 * @returns {string[]}
 */
function readFromStorage() {
  const stored = readDraft(STORAGE_KEY, DRAFT_KINDS.RECENT_ADDRESSES);
  if (!stored) return [];
  return stored.filter((entry) => typeof entry === 'string');
}

/**
 * Custom hook for managing recently used payment addresses/usernames.
 *
 * Persists up to MAX_ENTRIES entries in localStorage under the
 * "recent_transactions" key.  The most-recently-used entry always
 * appears first.
 *
 * Cleanup audit: this hook uses only useState/useCallback and synchronous
 * localStorage access. It starts no intervals, timeouts, or subscriptions,
 * so no unmount cleanup is required.
 *
 * @returns {{ recentAddresses: string[], saveAddress: (address: string) => void, clearAddresses: () => void }}
 */
export function useRecentAddresses() {
  const [recentAddresses, setRecentAddresses] = useState(/** @type {string[]} */ (readFromStorage()));

  /**
   * Persists a new address/username to the top of the recent list.
   * Duplicates are de-duped (moved to the front) and the list is
   * capped at MAX_ENTRIES.
   *
   * @param {string} address - The resolved recipient address or username to save.
   */
  const saveAddress = useCallback((/** @type {string} */ address) => {
    if (!address || typeof address !== 'string') return;

    const trimmed = address.trim();
    if (!trimmed) return;

    setRecentAddresses((prev) => {
      // Remove existing occurrence to avoid duplicates, then prepend.
      const deduped = prev.filter((entry) => entry !== trimmed);
      const updated = [trimmed, ...deduped].slice(0, MAX_ENTRIES);
      // Only non-secret address/username strings are persisted; the draft
      // module binds them to the active account/network and applies expiry.
      writeDraft(STORAGE_KEY, DRAFT_KINDS.RECENT_ADDRESSES, updated);
      return updated;
    });
  }, []);

  /** Wipes the stored list from both state and localStorage. */
  const clearAddresses = useCallback(() => {
    clearDraft(STORAGE_KEY);
    setRecentAddresses([]);
  }, []);

  return { recentAddresses, saveAddress, clearAddresses };
}
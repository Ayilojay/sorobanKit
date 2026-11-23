import { 
  StellarWalletsKit, 
  WalletNetwork,
  FreighterModule, 
  xBullModule,
  AlbedoModule,
  LobstrModule
} from '@creit.tech/stellar-wallets-kit';
import { useEffect, useRef, useState } from 'react';
import {
  describeApiError,
  getApiErrorDetails,
} from '../api/errorCatalog';

export { API_BASE } from '../api/baseUrl';

export const CONTRACT_ID = 'CDNQ7OMHIFOLZHOKWQLOGDW7CF3DRMKXJC6OULNGNBWF4O4NO2NEIGER';
export const TREASURY_ADDRESS = 'GAAFWEZKDYPXLTQGKQ3F23TXWYQUDAYTDW7P7VUQSVJFW2GWC4Y6LWST';
export const TOKEN_ADDRESS = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
export const DEFAULT_FEDERATION_DOMAIN = 'localhost';
export const HORIZON_BASE = 'https://horizon-testnet.stellar.org';
export const ANALYTICS_WINDOW_MS = 60 * 60 * 1000;
export const ANALYTICS_PAGE_LIMIT = 200;
export const ANALYTICS_MAX_PAGES = 5;
export const ANALYTICS_REFRESH_MS = 60 * 1000;
export const NAV_STORAGE_KEY = 'stellar-nav-open';

let stellarSdkPromise;
export const loadStellarSdk = () => {
  if (!stellarSdkPromise) {
    stellarSdkPromise = import('@stellar/stellar-sdk');
  }
  return stellarSdkPromise;
};

export const normalizeNameTag = (value) => {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }

  return trimmed.includes('*')
    ? trimmed
    : `${trimmed}*${DEFAULT_FEDERATION_DOMAIN}`;
};

/**
 * @typedef {{ address?: string, tag?: string, error?: string }} ResolveRecipientResult
 */

/**
 * @param {string} inputValue
 * @returns {Promise<ResolveRecipientResult>}
 */
export const resolveRecipient = async (inputValue) => {
  const trimmed = inputValue.trim();
  if (!trimmed) {
    return { error: 'Please enter a username or wallet address.' };
  }

  const { StrKey } = await loadStellarSdk();
  if (StrKey.isValidEd25519PublicKey(trimmed)) {
    return { address: trimmed };
  }

  const normalizedTag = normalizeNameTag(trimmed);
  return { tag: normalizedTag };
};

/**
 * Pulls a displayable message out of an API error body.
 *
 * Platform errors (`{ success: false, error: { code, message, details } }`) are
 * resolved through the central error catalog so views never surface raw server
 * messages or internals. Responses that do not come from the platform's error
 * handler (proxy/CDN pages, flat `error`/`detail`/`message` bodies) fall back to
 * the caller-provided message.
 *
 * @param {unknown} data
 * @param {string} fallback
 * @returns {string}
 */
export const apiErrorMessage = (data, fallback) => {
  const described = describeApiError(data, fallback);
  return described.message;
};

/**
 * Field-level validation issues, when the error carries them.
 *
 * @param {unknown} data
 * @returns {unknown[]}
 */
export const apiErrorDetails = (data) => getApiErrorDetails(data);

export const formatUsername = (value) => {
  if (!value) {
    return '';
  }

  return value.split('*')[0];
};

export const formatShortAddress = (value) => {
  if (!value) {
    return '';
  }

  if (value.length < 10) {
    return value;
  }

  return `${value.substring(0, 4)}...${value.substring(52)}`;
};

/**
 * @returns {[boolean, import('react').Dispatch<import('react').SetStateAction<boolean>>]}
 */
export const useNavState = () => {
  const [isNavOpen, setIsNavOpen] = useState(() => {
    const stored = sessionStorage.getItem(NAV_STORAGE_KEY);
    if (stored === 'true' || stored === 'false') {
      return stored === 'true';
    }

    return window.matchMedia('(min-width: 769px)').matches;
  });

  useEffect(() => {
    const mediaQuery = window.matchMedia('(max-width: 768px)');
    /** @param {MediaQueryListEvent} event */
    const syncNav = (event) => {
      if (event.matches) {
        setIsNavOpen(false);
      }
    };

    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener('change', syncNav);
      return () => mediaQuery.removeEventListener('change', syncNav);
    }

    // @ts-expect-error - legacy MediaQueryList API for older browsers
    mediaQuery.addListener(syncNav);
    // @ts-expect-error - legacy MediaQueryList API for older browsers
    return () => mediaQuery.removeListener(syncNav);
  }, []);

  useEffect(() => {
    sessionStorage.setItem(NAV_STORAGE_KEY, String(isNavOpen));
  }, [isNavOpen]);

  return [isNavOpen, setIsNavOpen];
};

/**
 * @typedef {{
 *   menuRef: import('react').RefObject<HTMLDivElement | null>,
 *   isOpen: boolean,
 *   setIsOpen: import('react').Dispatch<import('react').SetStateAction<boolean>>
 * }} WalletMenuState
 */

/**
 * @returns {WalletMenuState}
 */
export const useWalletMenu = () => {
  const menuRef = useRef(/** @type {HTMLDivElement | null} */ (null));
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    /** @param {MouseEvent} event */
    const handleClickOutside = (event) => {
      if (
        menuRef.current &&
        event.target instanceof Node &&
        !menuRef.current.contains(event.target)
      ) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  return { menuRef, isOpen, setIsOpen };
};

// Initialize the multi-wallet kit with strictly V1 syntax
/** @type {import('@creit.tech/stellar-wallets-kit').StellarWalletsKit} */
export const walletKit = new StellarWalletsKit({
  network: WalletNetwork.TESTNET, 
  selectedWalletId: 'freighter',
  modules: [
    new FreighterModule(),
    new xBullModule(),
    new AlbedoModule(),
    new LobstrModule()
  ],
});
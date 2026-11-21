import { lazy, Suspense, useCallback, useEffect, useState } from 'react';

import { toast, Toaster } from "react-hot-toast";
import logger from "./logger";
import LoadingSpinner from './components/LoadingSpinner';
import { HORIZON_BASE, API_BASE, walletKit } from './views/shared';

const Dashboard = lazy(() => import('./views/Dashboard.jsx'));
const HelpPage = lazy(() => import('./views/HelpPage.jsx'));
const AnalyticsPage = lazy(() => import('./views/AnalyticsPage.jsx'));
const HistoryPage = lazy(() => import('./views/HistoryPage.jsx'));
const RegistrationPage = lazy(() => import('./views/RegistrationPage.jsx'));

/**
 * Generate a unique request identifier.
 * @returns {string}
 */
function generateRequestId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const random = (Math.random() * 16) | 0;
    const value = char === 'x' ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

/**
 * Perform a fetch request with an X-Request-ID header.
 * @param {RequestInfo | URL} input
 * @param {RequestInit} [init]
 * @returns {Promise<Response>}
 */
function withRequestId(input, init = {}) {
  const headers = new Headers(init.headers || {});
  if (!headers.has('X-Request-ID')) {
    headers.set('X-Request-ID', generateRequestId());
  }

  return fetch(input, { ...init, headers });
}

/**
 * @param {{ label?: string }} props
 */
function ViewFallback({ label = 'Loading view...' }) {
  return (
    <div className="route-fallback" role="status" aria-live="polite">
      <LoadingSpinner color="text-blue" />
      <span>{label}</span>
    </div>
  );
}

function isTypingTarget(target) {
  if (!target || typeof target.tagName !== 'string') {
    return false;
  }

  const tag = target.tagName.toLowerCase();
  return (
    tag === 'input' ||
    tag === 'textarea' ||
    tag === 'select' ||
    target.isContentEditable === true
  );
}

function ShortcutsModal({ onClose }) {
  return (
    <div
      className="shortcuts-modal-backdrop"
      role="presentation"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 2000,
      }}
    >
      <div
        className="shortcuts-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-modal-title"
        onClick={(event) => event.stopPropagation()}
        style={{
          backgroundColor: '#FFFFFF',
          borderRadius: '8px',
          padding: '24px',
          minWidth: '320px',
          maxWidth: '90vw',
          boxShadow: '0 10px 30px rgba(0, 0, 0, 0.2)',
        }}
      >
        <h2 id="shortcuts-modal-title" style={{ marginTop: 0 }}>
          Keyboard Shortcuts
        </h2>
        <ul style={{ listStyle: 'none', padding: 0, margin: '16px 0' }}>
          {KEYBOARD_SHORTCUTS.map((shortcut) => (
            <li
              key={shortcut.keys}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                gap: '16px',
                padding: '6px 0',
              }}
            >
              <kbd
                style={{
                  fontFamily: 'monospace',
                  backgroundColor: '#F3F4F6',
                  borderRadius: '4px',
                  padding: '2px 6px',
                }}
              >
                {shortcut.keys}
              </kbd>
              <span>{shortcut.description}</span>
            </li>
          ))}
        </ul>
        <button type="button" onClick={onClose} autoFocus>
          Close
        </button>
      </div>
    </div>
  );
}

const PENDING_PAYMENT_STORAGE_KEY = 'handsoff.pendingPayment';
const PENDING_PAYMENT_VERSION = 1;
const TERMINAL_PAYMENT_STATUSES = new Set(['success', 'completed', 'failed', 'error', 'cancelled', 'canceled', 'expired']);

/**
 * Persist only a versioned operation reference for a pending payment.
 * The reference is bound to the account and network so it is only resumed
 * for the matching context.
 * @param {{ operationId: string, account: string, network: string }} ref
 */
function persistPendingPaymentRef(ref) {
  try {
    const payload = {
      version: PENDING_PAYMENT_VERSION,
      operationId: ref.operationId,
      account: ref.account,
      network: ref.network,
      savedAt: Date.now(),
    };
    window.localStorage.setItem(PENDING_PAYMENT_STORAGE_KEY, JSON.stringify(payload));
  } catch (err) {
    logger.error('Failed to persist pending payment reference:', err);
  }
}

/**
 * Read the persisted pending payment reference, validating version and shape.
 * @returns {{ version: number, operationId: string, account: string, network: string, savedAt: number } | null}
 */
function readPendingPaymentRef() {
  try {
    const raw = window.localStorage.getItem(PENDING_PAYMENT_STORAGE_KEY);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw);
    if (
      !parsed ||
      parsed.version !== PENDING_PAYMENT_VERSION ||
      typeof parsed.operationId !== 'string' ||
      !parsed.operationId ||
      typeof parsed.account !== 'string' ||
      typeof parsed.network !== 'string'
    ) {
      clearPendingPaymentRef();
      return null;
    }

    return parsed;
  } catch (err) {
    logger.error('Failed to read pending payment reference:', err);
    clearPendingPaymentRef();
    return null;
  }
}

function clearPendingPaymentRef() {
  try {
    window.localStorage.removeItem(PENDING_PAYMENT_STORAGE_KEY);
  } catch (err) {
    logger.error('Failed to clear pending payment reference:', err);
  }
}

function App() {
const [activeView, setActiveView] = useState('dashboard')
  const [userPublicKey, setUserPublicKey] = useState(() => {
    return readStoredWalletKey()
  })
  const [registrationState, setRegistrationState] = useState("unknown");
  const [isOffline, setIsOffline] = useState(!navigator.onLine);
  const [isShortcutsOpen, setIsShortcutsOpen] = useState(false);

  useEffect(() => {
    const handleOnline = () => setIsOffline(false);
    const handleOffline = () => setIsOffline(true);

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  const WALLET_TIMEOUT_MS = 15_000;

  // Attempt silent reconnection using the persisted public key on app load.
  useEffect(() => {
    const storedKey = readStoredWalletKey();
    if (!storedKey) {
      return;
    }

    let cancelled = false;

    const restore = async () => {
      try {
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Wallet reconnection timed out')), WALLET_TIMEOUT_MS)
        );
        const addressResponse = await Promise.race([walletKit.getAddress(), timeoutPromise]);
        const publicKey = typeof addressResponse === 'string'
          ? addressResponse
          : addressResponse?.address;

        if (cancelled) {
          return;
        }

        if (!publicKey || publicKey !== storedKey) {
          throw new Error('Wallet no longer matches stored key');
        }

        setUserPublicKey(publicKey);
      } catch (err) {
        if (cancelled) {
          return;
        }
        logger.error('Silent wallet reconnection failed:', err);
        clearStoredWalletKey();
        setUserPublicKey('');
      }
    };

    restore();

    return () => {
      cancelled = true;
    };
  }, []);

  // Resume a pending payment after reload by looking up server-side status.
  // Never resubmit the payment; only poll the operation reference.
  useEffect(() => {
    if (!userPublicKey) {
      return;
    }

    const pending = readPendingPaymentRef();
    if (!pending) {
      return;
    }

    if (pending.account !== userPublicKey || pending.network !== HORIZON_BASE) {
      // Reference belongs to a different account/network context; discard it.
      clearPendingPaymentRef();
      return;
    }

    let cancelled = false;

    const resume = async () => {
      try {
        const response = await withRequestId(
          `${API_BASE}/payments/${encodeURIComponent(pending.operationId)}/status?address=${encodeURIComponent(pending.account)}`
        );

        if (cancelled) {
          return;
        }

        if (response.status === 404 || response.status === 410) {
          clearPendingPaymentRef();
          return;
        }

        if (!response.ok) {
          logger.error('Pending payment status lookup failed:', response.status);
          return;
        }

        const data = await response.json();
        if (cancelled) {
          return;
        }

        const status = typeof data?.status === 'string' ? data.status.toLowerCase() : '';
        if (TERMINAL_PAYMENT_STATUSES.has(status)) {
          clearPendingPaymentRef();
          if (status === 'success' || status === 'completed') {
            toast.success('Pending payment completed.');
          } else {
            toast.error('Pending payment did not complete.');
          }
        }
      } catch (err) {
        if (cancelled) {
          return;
        }
        logger.error('Failed to resume pending payment:', err);
      }
    };

    resume();

    return () => {
      cancelled = true;
    };
  }, [userPublicKey]);

  const handleConnectWallet = async () => {
    try {
      await walletKit.openModal({
        onWalletSelected: async (option) => {
          try {
            walletKit.setWallet(option.id);
            /** @type {Promise<never>} */
            const timeoutPromise = new Promise((_, reject) =>
              setTimeout(() => reject(new Error('Wallet connection timed out')), WALLET_TIMEOUT_MS)
            );
            const addressResponse = await Promise.race([walletKit.getAddress(), timeoutPromise]);
            
            // Extract the key carefully to avoid the initialization error
            const publicKey = typeof addressResponse === 'string' 
              ? addressResponse 
              : addressResponse.address;
            
            // Now that publicKey is officially created, we can fetch the user
            const dbResponse = await withRequestId(`${API_BASE}/lookup?address=${encodeURIComponent(publicKey)}`);
            
            if (dbResponse.ok) {
              setRegistrationState("existing");
            } else if (dbResponse.status === 404) {
              setRegistrationState("new");
              handleNavigate("register");
            }

            // Save the address to state so the UI updates
            persistWalletKey(publicKey);
            setUserPublicKey(publicKey);
            logger.debug("Wallet connected successfully.");
          } catch (err) {
            logger.error("Wallet connection failed:", err);
            toast.error("Failed to connect wallet.");
          }
        },
      });

      return { ok: true };
    } catch (error) {
      toast.error("Connection cancelled.");
      logger.error("User closed modal or an error occurred:", error);
      return { ok: false, error: "Wallet connection process cancelled." };
    }
  };

  const handleDisconnectWallet = () => {
    clearStoredWalletKey()
    setUserPublicKey('')
    setBalance(null);
  };

  /** @type {[number | null, (value: number | null) => void]} */
  const [balance, setBalance] = useState(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [balanceError, setBalanceError] = useState("");

  const load

/* … truncated 8075 chars — edit only what you need near the top … */

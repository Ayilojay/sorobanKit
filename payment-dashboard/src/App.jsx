import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';

import { toast, Toaster } from "react-hot-toast";
import logger from "./logger";
import LoadingSpinner from './components/LoadingSpinner';
import { HORIZON_BASE, API_BASE, walletKit } from './views/shared';

const Dashboard = lazy(() => import('./views/Dashboard.jsx'));
const HelpPage = lazy(() => import('./views/HelpPage.jsx'));
const AnalyticsPage = lazy(() => import('./views/AnalyticsPage.jsx'));
const HistoryPage = lazy(() => import('./views/HistoryPage.jsx'));
const RegistrationPage = lazy(() => import('./views/RegistrationPage.jsx'));

const DEFAULT_LOCALE = 'en';
const LOCALE_STORAGE_KEY = 'payment-dashboard.locale';

/**
 * Translation catalogs for dashboard messages and payment-related strings.
 * Keys are shared across locales; missing keys fall back to the default locale
 * and finally to the key itself so the UI never renders blank text.
 */
const CATALOGS = {
  en: {
    'app.loadingView': 'Loading view...',
    'app.shortcutsTitle': 'Keyboard Shortcuts',
    'app.close': 'Close',
    'app.offline': 'You are offline. Some actions may be unavailable.',
    'wallet.connectFailed': 'Failed to connect wallet.',
    'wallet.connectCancelled': 'Connection cancelled.',
    'wallet.connectCancelledDetail': 'Wallet connection process cancelled.',
    'wallet.disconnect': 'Disconnect wallet',
    'wallet.connect': 'Connect wallet',
    'payment.count': '{count, plural, one {# payment} other {# payments}}',
    'payment.pending': '{count, plural, one {# payment pending} other {# payments pending}}',
    'payment.date': 'Payment date',
    'payment.amount': 'Amount',
    'locale.label': 'Language',
  },
  es: {
    'app.loadingView': 'Cargando vista...',
    'app.shortcutsTitle': 'Atajos de teclado',
    'app.close': 'Cerrar',
    'app.offline': 'Estás sin conexión. Algunas acciones pueden no estar disponibles.',
    'wallet.connectFailed': 'No se pudo conectar la billetera.',
    'wallet.connectCancelled': 'Conexión cancelada.',
    'wallet.connectCancelledDetail': 'Proceso de conexión de billetera cancelado.',
    'wallet.disconnect': 'Desconectar billetera',
    'wallet.connect': 'Conectar billetera',
    'payment.count': '{count, plural, one {# pago} other {# pagos}}',
    'payment.pending': '{count, plural, one {# pago pendiente} other {# pagos pendientes}}',
    'payment.date': 'Fecha de pago',
    'payment.amount': 'Importe',
    'locale.label': 'Idioma',
  },
};

const SUPPORTED_LOCALES = Object.keys(CATALOGS);

/**
 * Resolve the initial locale from storage, then the browser, then the default.
 * @returns {string}
 */
function resolveInitialLocale() {
  try {
    const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
    if (stored && SUPPORTED_LOCALES.includes(stored)) {
      return stored;
    }
  } catch (err) {
    logger.debug('Unable to read stored locale:', err);
  }

  const browserLocale = typeof navigator !== 'undefined' ? navigator.language : '';
  const base = (browserLocale || '').split('-')[0];
  return SUPPORTED_LOCALES.includes(base) ? base : DEFAULT_LOCALE;
}

/**
 * Interpolate a message, supporting ICU-style pluralization for `count`.
 * @param {string} template
 * @param {Record<string, unknown>} [values]
 * @param {string} [locale]
 * @returns {string}
 */
function formatMessage(template, values = {}, locale = DEFAULT_LOCALE) {
  if (typeof template !== 'string') {
    return '';
  }

  return template.replace(/\{(\w+), plural, ([^}]*)\}/g, (match, name, body) => {
    const count = Number(values[name]);
    if (!Number.isFinite(count)) {
      return match;
    }

    const branches = {};
    body.replace(/(=\d+|zero|one|two|few|many|other)\s*\{([^}]*)\}/g, (_, key, text) => {
      branches[key] = text;
      return '';
    });

    const pluralRules = typeof Intl !== 'undefined' && Intl.PluralRules
      ? new Intl.PluralRules(locale)
      : null;
    const category = pluralRules ? pluralRules.select(count) : (count === 1 ? 'one' : 'other');
    const chosen = branches[`=${count}`] ?? branches[category] ?? branches.other ?? '';
    return chosen.replace(/#/g, new Intl.NumberFormat(locale).format(count));
  }).replace(/\{(\w+)\}/g, (match, name) => {
    return Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match;
  });
}

/**
 * Format a payment date/time with locale and time-zone awareness.
 * @param {string | number | Date} value
 * @param {string} locale
 * @param {string} [timeZone]
 * @returns {string}
 */
function formatPaymentDate(value, locale = DEFAULT_LOCALE, timeZone) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }

  const resolvedTimeZone = timeZone
    || (typeof Intl !== 'undefined' && Intl.DateTimeFormat
      ? Intl.DateTimeFormat().resolvedOptions().timeZone
      : undefined);

  try {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: resolvedTimeZone,
    }).format(date);
  } catch (err) {
    logger.debug('Payment date formatting failed, using fallback:', err);
    return date.toISOString();
  }
}

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

function ShortcutsModal({ onClose, t }) {
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
          {t('app.shortcutsTitle')}
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
          {t('app.close')}
        </button>
      </div>
    </div>
  );
}

function App() {
const [activeView, setActiveView] = useState('dashboard')
  const [userPublicKey, setUserPublicKey] = useState(() => {
    return readStoredWalletKey()
  })
  const [registrationState, setRegistrationState] = useState("unknown");
  const [isOffline, setIsOffline] = useState(!navigator.onLine);
  const [isShortcutsOpen, setIsShortcutsOpen] = useState(false);
  const [locale, setLocale] = useState(() => resolveInitialLocale());

  const t = useCallback(
    (key, values) => {
      const catalog = CATALOGS[locale] || CATALOGS[DEFAULT_LOCALE];
      const fallback = CATALOGS[DEFAULT_LOCALE];
      const template = catalog[key] ?? fallback[key] ?? key;
      return formatMessage(template, values, locale);
    },
    [locale]
  );

  const formatDate = useCallback(
    (value, timeZone) => formatPaymentDate(value, locale, timeZone),
    [locale]
  );

  const handleLocaleChange = useCallback((nextLocale) => {
    if (!SUPPORTED_LOCALES.includes(nextLocale)) {
      return;
    }
    setLocale(nextLocale);
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, nextLocale);
    } catch (err) {
      logger.debug('Unable to persist locale:', err);
    }
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

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
            toast.error(t('wallet.connectFailed'));
          }
        },
      });

      return { ok: true };
    } catch (error) {
      toast.error(t('wallet.connectCancelled'));
      logger.error("User closed modal or an error occurred:", error);
      return { ok: false, error: t('wallet.connectCancelledDetail') };
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

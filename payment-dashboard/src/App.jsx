import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';

import { toast, Toaster } from "react-hot-toast";
import logger from "./logger";
import LoadingSpinner from './components/LoadingSpinner';
import ThemeToggle from './components/ThemeToggle';
import { useTheme } from './hooks/useTheme';
import { useOnlineStatus } from './hooks/useOnlineStatus';
import { HORIZON_BASE, API_BASE, walletKit } from './views/shared';
import { loadFeatureFlags } from './featureFlags';

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
    'theme.label': 'Theme',
    'theme.light': 'Light',
    'theme.dark': 'Dark',
    'theme.system': 'System',
    'offline.banner': 'You are offline. The dashboard is read-only until your connection returns.',
    'offline.readOnly': 'Read-only while offline',
    'offline.lastUpdated': 'Last updated {time}',
    'offline.neverUpdated': 'Not yet updated',
    'offline.staleData': 'Showing cached data',
    'offline.mutationBlocked': 'This action is unavailable while offline.',
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
    'theme.label': 'Tema',
    'theme.light': 'Claro',
    'theme.dark': 'Oscuro',
    'theme.system': 'Sistema',
    'offline.banner': 'Estás sin conexión. El panel es de solo lectura hasta que vuelva la conexión.',
    'offline.readOnly': 'Solo lectura sin conexión',
    'offline.lastUpdated': 'Última actualización {time}',
    'offline.neverUpdated': 'Aún sin actualizar',
    'offline.staleData': 'Mostrando datos en caché',
    'offline.mutationBlocked': 'Esta acción no está disponible sin conexión.',
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

/**
 * Persistent offline banner announcing read-only mode and data freshness.
 * @param {{ message: string, freshness: string, readOnlyLabel: string }} props
 */
function OfflineBanner({ message, freshness, readOnlyLabel }) {
  return (
    <div
      className="offline-banner"
      role="status"
      aria-live="polite"
      aria-atomic="true"
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 1500,
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: '12px',
        padding: '10px 16px',
        backgroundColor: 'var(--color-warning-surface, #FEF3C7)',
        color: 'var(--color-warning-text, #92400E)',
        borderBottom: '1px solid var(--color-warning-border, #F59E0B)',
        fontSize: '0.875rem',
      }}
    >
      <strong>{readOnlyLabel}</strong>
      <span>{message}</span>
      <span aria-hidden="true">·</span>
      <span>{freshness}</span>
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
        backgroundColor: 'var(--color-overlay, rgba(0, 0, 0, 0.5))',
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
          backgroundColor: 'var(--color-surface, #FFFFFF)',
          color: 'var(--color-text, #111827)',
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
                  backgroundColor: 'var(--color-surface-muted, #F3F4F6)',
                  color: 'var(--color-text, #111827)',
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
  const isOffline = useOnlineStatus();
  const [isShortcutsOpen, setIsShortcutsOpen] = useState(false);
  const [locale, setLocale] = useState(() => resolveInitialLocale());
  const { theme, resolvedTheme, setTheme } = useTheme();
  const [lastUpdatedAt, setLastUpdatedAt] = useState(() => Date.now());

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
    document.documentElement.dataset.theme = resolvedTheme;
    document.documentElement.style.colorScheme = resolvedTheme;
  }, [resolvedTheme]);

  // Track the most recent successful data load so the offline banner can
  // surface a freshness indicator for cached, read-only data.
  useEffect(() => {
    if (!isOffline) {
      setLastUpdatedAt(Date.now());
    }
  }, [isOffline]);

  const lastUpdatedLabel = useMemo(() => {
    if (!lastUpdatedAt) {
      return t('offline.neverUpdated');
    }
    return t('offline.lastUpdated', {
      time: formatPaymentDate(lastUpdatedAt, locale),
    });
  }, [lastUpdatedAt, locale, t]);

  const guardOfflineMutation = useCallback(
    (action) => {
      if (isOffline) {
        toast.error(t('offline.mutationBlocked'));
        return false;
      }
      if (typeof action === 'function') {
        action();
      }
      return true;
    },
    [isOffline, t]
  );

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
    if (!guardOfflineMutation()) {
      return { ok: false, error: t('offline.mutationBlocked') };
    }
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

  const handleThemeChange = useCallback(
    (nextTheme) => {
      setTheme(nextTheme);
    },
    [setTheme]
  );

  const handleNavigate = useCallback(
    (view) => {
      if (view === 'register' && isOffline) {
        toast.error(t('offline.mutationBlocked'));
        return;
      }
      setActiveView(view);
    },
    [isOffline, t]
  );

  /** @type {[number | null, (value: number | null) => void]} */
  const [balance, setBalance] = useState(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [balanceError, setBalanceError] = useState("");

  const handleRefresh = useCallback(() => {
    if (isOffline) {
      toast.error(t('offline.mutationBlocked'));
      return;
    }
    setIsRefreshing(true);
  }, [isOffline, t]);

  const themeToggle = (
    <ThemeToggle
      theme={theme}
      resolvedTheme={resolvedTheme}
      onChange={handleThemeChange}
      label={t('theme.label')}
      options={{
        light: t('theme.light'),
        dark: t('theme.dark'),
        system: t('theme.system'),
      }}
    />
  );

  const offlineBanner = isOffline ? (
    <OfflineBanner
      message={t('offline.banner')}
      freshness={lastUpdatedLabel}
      readOnlyLabel={t('offline.readOnly')}
    />
  ) : null;

  const load

/* … truncated 8075 chars — edit only what you need near the top … */

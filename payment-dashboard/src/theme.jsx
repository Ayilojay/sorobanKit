import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

export const THEME_STORAGE_KEY = 'theme';
export const THEMES = ['light', 'dark', 'system'];

const DARK_QUERY = '(prefers-color-scheme: dark)';
const THEME_COLOR = {
  light: '#ffffff',
  dark: '#0b0f14',
};

function getStorage() {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    return window.localStorage;
  } catch (err) {
    return null;
  }
}

function getMatchMedia() {
  try {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return null;
    }
    return window.matchMedia(DARK_QUERY);
  } catch (err) {
    return null;
  }
}

export function getSystemTheme() {
  const mql = getMatchMedia();
  if (!mql) return 'light';
  return mql.matches ? 'dark' : 'light';
}

export function readStoredTheme() {
  const storage = getStorage();
  if (!storage) return null;
  try {
    const value = storage.getItem(THEME_STORAGE_KEY);
    if (value && THEMES.includes(value)) return value;
    return null;
  } catch (err) {
    return null;
  }
}

export function resolveInitialTheme(storedChoice) {
  const choice = storedChoice === undefined ? readStoredTheme() : storedChoice;
  if (choice === 'light' || choice === 'dark') return choice;
  return getSystemTheme();
}

export function applyTheme(theme) {
  const resolved = theme === 'dark' || theme === 'light' ? theme : resolveInitialTheme(theme);
  if (typeof document === 'undefined') return resolved;

  const root = document.documentElement;
  if (root) {
    root.dataset.theme = resolved;
    root.style.colorScheme = resolved;
  }

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    const color = THEME_COLOR[resolved];
    if (color) meta.setAttribute('content', color);
  }

  return resolved;
}

const ThemeContext = createContext(null);

export function ThemeProvider({ children, initialChoice }) {
  const [choice, setChoiceState] = useState(() => {
    if (initialChoice !== undefined) return initialChoice;
    const stored = readStoredTheme();
    return stored || 'system';
  });

  const [systemTheme, setSystemTheme] = useState(() => getSystemTheme());

  const resolved = choice === 'system' ? systemTheme : choice;

  // Apply theme whenever the resolved value changes.
  useEffect(() => {
    applyTheme(resolved);
  }, [resolved]);

  // Listen for live system preference changes.
  useEffect(() => {
    const mql = getMatchMedia();
    if (!mql) return undefined;

    const handleChange = (event) => {
      setSystemTheme(event.matches ? 'dark' : 'light');
    };

    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', handleChange);
      return () => mql.removeEventListener('change', handleChange);
    }
    if (typeof mql.addListener === 'function') {
      mql.addListener(handleChange);
      return () => mql.removeListener(handleChange);
    }
    return undefined;
  }, []);

  const setChoice = useCallback((next) => {
    const value = THEMES.includes(next) ? next : 'system';
    setChoiceState(value);
    const storage = getStorage();
    if (storage) {
      try {
        if (value === 'system') {
          storage.removeItem(THEME_STORAGE_KEY);
        } else {
          storage.setItem(THEME_STORAGE_KEY, value);
        }
      } catch (err) {
        // Ignore storage failures (private mode, quota, etc.).
      }
    }
  }, []);

  const toggle = useCallback(() => {
    setChoiceState((prev) => {
      const currentResolved = prev === 'system' ? getSystemTheme() : prev;
      const next = currentResolved === 'dark' ? 'light' : 'dark';
      const storage = getStorage();
      if (storage) {
        try {
          storage.setItem(THEME_STORAGE_KEY, next);
        } catch (err) {
          // Ignore storage failures.
        }
      }
      return next;
    });
  }, []);

  const value = useMemo(
    () => ({
      choice,
      resolved,
      systemTheme,
      setChoice,
      toggle,
    }),
    [choice, resolved, systemTheme, setChoice, toggle],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return ctx;
}

export function ThemeToggle({ className, ...rest }) {
  const { resolved, toggle } = useTheme();
  const isDark = resolved === 'dark';
  const label = isDark ? 'Switch to light theme' : 'Switch to dark theme';

  return (
    <button
      type="button"
      className={className}
      onClick={toggle}
      aria-label={label}
      aria-pressed={isDark}
      title={label}
      data-theme-toggle=""
      {...rest}
    >
      <span aria-hidden="true">{isDark ? '\u2600\uFE0F' : '\u{1F319}'}</span>
    </button>
  );
}

export default ThemeProvider;
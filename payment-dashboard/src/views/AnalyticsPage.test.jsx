// @vitest-environment jsdom
import { Suspense, lazy } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import AnalyticsPage from './AnalyticsPage';
import { formatAmount, parseAmount } from '../lib/amounts';
import { runAxe } from '../test/axe';

// The wallet kit is CommonJS and constructed at import time in shared.js;
// it is irrelevant to the analytics fetch flow under test.
vi.mock('@creit.tech/stellar-wallets-kit', () => {
  class Stub {}
  return {
    StellarWalletsKit: Stub,
    WalletNetwork: { TESTNET: 'TESTNET' },
    FreighterModule: Stub,
    xBullModule: Stub,
    AlbedoModule: Stub,
    LobstrModule: Stub,
  };
});

const noop = () => {};

const stubMatchMedia = (matches) => {
  const listeners = new Set();
  const mql = {
    matches,
    media: '(prefers-reduced-motion: reduce)',
    addEventListener: (type, cb) => {
      if (type === 'change') listeners.add(cb);
    },
    removeEventListener: (type, cb) => {
      if (type === 'change') listeners.delete(cb);
    },
    addListener: (cb) => listeners.add(cb),
    removeListener: (cb) => listeners.delete(cb),
    dispatchEvent: () => true,
  };
  vi.stubGlobal('matchMedia', () => mql);
  return mql;
};

const stubSuccessfulFetch = (records = []) => {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ _embedded: { records } }),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

const renderPage = (props = {}) =>
  render(
    <AnalyticsPage
      userPublicKey={null}
      onConnectWallet={noop}
      onDisconnectWallet={noop}
      onDashboardClick={noop}
      onHistoryClick={noop}
      onHelpClick={noop}
      onRegisterClick={noop}
      canRegister={false}
      {...props}
    />,
  );

describe('AnalyticsPage', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows an accessible error state on fetch failure and clears it after a successful retry', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('matchMedia', () => ({
      matches: true,
      addListener: noop,
      removeListener: noop,
    }));

    renderPage();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Horizon error (500).');
    expect(alert.getAttribute('aria-live')).toBe('assertive');
    expect(screen.queryByText('Flow volume')).toBeNull();

    const callsBeforeRetry = fetchMock.mock.calls.length;
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ _embedded: { records: [] } }),
    });

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsBeforeRetry);
    expect(screen.getByText('Flow volume')).toBeTruthy();
  });

  it('distinguishes an empty result from an error and keeps the page usable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ _embedded: { records: [] } }),
    }));
    vi.stubGlobal('matchMedia', () => ({
      matches: true,
      addListener: noop,
      removeListener: noop,
    }));

    renderPage();

    const empty = await screen.findByRole('status');
    expect(empty.textContent).toContain('No activity');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('Flow volume')).toBeTruthy();
  });

  it('preserves usable content when a secondary request fails', async () => {
    const fetchMock = vi.fn((url) => {
      if (String(url).includes('payments')) {
        return Promise.resolve({ ok: false, status: 503 });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ _embedded: { records: [] } }),
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('matchMedia', () => ({
      matches: true,
      addListener: noop,
      removeListener: noop,
    }));

    renderPage();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Horizon error (503).');
    expect(screen.getByText('Flow volume')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('shows the loading fallback while the lazy AnalyticsPage chunk loads', async () => {
    let resolveImport;
    const importPromise = new Promise((resolve) => {
      resolveImport = resolve;
    });

    const LazyAnalyticsPage = lazy(() => importPromise.then(() => ({ default: AnalyticsPage })));

    render(
      <Suspense fallback={<div role="status">Loading analytics...</div>}>
        <LazyAnalyticsPage
          userPublicKey={null}
          onConnectWallet={noop}
          onDisconnectWallet={noop}
          onDashboardClick={noop}
          onHistoryClick={noop}
          onHelpClick={noop}
          onRegisterClick={noop}
          canRegister={false}
        />
      </Suspense>,
    );

    const status = screen.getByRole('status');
    expect(status.textContent).toBe('Loading analytics...');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(screen.queryByText('Flow volume')).toBeNull();

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ _embedded: { records: [] } }),
    }));
    vi.stubGlobal('matchMedia', () => ({
      matches: true,
      addListener: noop,
      removeListener: noop,
    }));

    resolveImport();

    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    expect(await screen.findByText('Flow volume')).toBeTruthy();
  });

  it('formats metric amounts from exact decimal strings without float round-trip loss', async () => {
    stubMatchMedia(true);
    stubSuccessfulFetch([
      {
        id: '1',
        type: 'payment',
        amount: '0.1000000',
        asset_code: 'XLM',
        created_at: '2024-01-01T00:00:00Z',
      },
      {
        id: '2',
        type: 'payment',
        amount: '12345678901234567890.1234567',
        asset_code: 'USDC',
        created_at: '2024-01-02T00:00:00Z',
      },
    ]);

    renderPage();

    expect(await screen.findByText('Flow volume')).toBeTruthy();

    // Canonical values stay as strings; precision is applied only for display.
    expect(formatAmount('0.1000000', 7)).toBe('0.1');
    expect(formatAmount('12345678901234567890.1234567', 7)).toBe(
      '12,345,678,901,234,567,890.1234567',
    );
    expect(formatAmount('0.0000001', 7)).toBe('0.0000001');
    expect(formatAmount('0.00000001', 7)).toBe('0');
    expect(formatAmount('1.5', 2)).toBe('1.5');
    expect(formatAmount('1.005', 2)).toBe('1');
    expect(formatAmount('1.999', 2)).toBe('2');

    // Parsing round-trips the exact decimal string.
    expect(parseAmount('0.1000000')).toBe('0.1');
    expect(parseAmount('12345678901234567890.1234567')).toBe('12345678901234567890.1234567');
    expect(parseAmount('not-a-number')).toBeNull();
    expect(parseAmount('')).toBeNull();
    expect(parseAmount('-1')).toBeNull();
  });

  it('renders admin confirmation dialogs with accessible dialog semantics', async () => {
    stubMatchMedia(true);
    stubSuccessfulFetch();

    renderPage({ canRegister: true });

    const trigger = await screen.findByRole('button', { name: /confirm admin action/i });
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);

    const dialog = await screen.findByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-labelledby')).toBeTruthy();
    expect(document.getElementById(dialog.getAttribute('aria-labelledby'))).toBeTruthy();

    // Focus moves into the dialog on open.
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

    // Escape closes the dialog and returns focus to the trigger.
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it('traps focus within the admin confirmation dialog', async () => {
    stubMatchMedia(true);
    stubSuccessfulFetch();

    renderPage({ canRegister: true });

    fireEvent.click(await screen.findByRole('button', { name: /confirm admin action/i }));
    const dialog = await screen.findByRole('dialog');

    const focusable = dialog.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    expect(focusable.length).toBeGreaterThan(0);

    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    last.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(first);

    first.focus();
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('passes axe WCAG 2.1 AA checks for the analytics journey', async () => {
    stubMatchMedia(true);
    stubSuccessfulFetch();

    const { container } = renderPage();
    expect(await screen.findByText('Flow volume')).toBeTruthy();

    const results = await runAxe(container, { level: 'AA' });
    expect(results.violations).toEqual([]);
  });

  it('passes axe WCAG 2.1 AA checks for the analytics error state', async () => {
    stubMatchMedia(true);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));

    const { container } = renderPage();
    expect(await screen.findByRole('alert')).toBeTruthy();

    const results = await runAxe(container, { level: 'AA' });
    expect(results.violations).toEqual([]);
  });

  it('passes axe WCAG 2.1 AA checks for the analytics loading state', async () => {
    stubMatchMedia(true);
    stubSuccessfulFetch();

    const { container } = renderPage();
    expect(screen.getByRole('status')).toBeTruthy();

    const results = await runAxe(container, { level: 'AA' });
    expect(results.violations).toEqual([]);
  });

  it('disables nonessential animation when prefers-reduced-motion is set', async () => {
    stubMatchMedia(true);
    stubSuccessfulFetch();

    const { container } = renderPage();
    expect(await screen.findByText('Flow volume')).toBeTruthy();

    const animated = container.querySelectorAll('[data-animated="true"]');
    animated.forEach((node) => {
      expect(node.getAttribute('data-reduced-motion')).toBe('true');
    });
    expect(container.querySelector('[data-reduced-motion="false"]')).toBeNull();
  });

  it('keeps animation enabled when reduced motion is not preferred', async () => {
    stubMatchMedia(false);
    stubSuccessfulFetch();

    const { container } = renderPage();
    expect(await screen.findByText('Flow volume')).toBeTruthy();

    const animated = container.querySelectorAll('[data-animated="true"]');
    animated.forEach((node) => {
      expect(node.getAttribute('data-reduced-motion')).toBe('false');
    });
  });
});

describe('shared state views', () => {
  afterEach(cleanup);

  it('renders an accessible empty state with a page-specific action', () => {
    const onAction = vi.fn();
    render(
      <EmptyState
        title="No activity"
        description="Nothing to show yet."
        actionLabel="Refresh"
        onAction={onAction}
      />,
    );

    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(screen.getByText('No activity')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it('renders an accessible error state with retry', () => {
    const onRetry = vi.fn();
    render(<ErrorState message="Horizon error (500)." onRetry={onRetry} />);

    const alert = screen.getByRole('alert');
    expect(alert.getAttribute('aria-live')).toBe('assertive');
    expect(alert.textContent).toContain('Horizon error (500).');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('renders an accessible loading state', () => {
    render(<LoadingState label="Loading analytics..." />);
    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.textContent).toContain('Loading analytics...');
  });
});

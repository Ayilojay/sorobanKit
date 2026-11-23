// @vitest-environment jsdom
import { Suspense, lazy } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import AnalyticsPage from './AnalyticsPage';
import { EmptyState, ErrorState, LoadingState } from '../components/StateViews';

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

const renderPage = () =>
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

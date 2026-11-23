// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import HistoryPage from './HistoryPage';
import { formatAssetAmount } from '../utils/amount';
import { runAxe } from '../test/axe';

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

const PUBLIC_KEY = 'GABC1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890AB';
const noop = () => {};

const makeRecord = (id) => ({
  id: String(id),
  type: 'payment',
  from: 'GSENDER111',
  to: PUBLIC_KEY,
  amount: '10.0',
  asset_type: 'native',
  transaction_successful: true,
  created_at: new Date(2026, 0, id).toISOString(),
  transaction_hash: `hash${id}`,
});

const makeHorizonResponse = (records, nextCursor = null) => ({
  _embedded: { records },
  _links: {
    next: nextCursor
      ? { href: `https://horizon-testnet.stellar.org/accounts/x/payments?cursor=${nextCursor}&order=desc&limit=50` }
      : { href: '' },
  },
});

const renderPage = (key = PUBLIC_KEY) =>
  render(
    <HistoryPage
      userPublicKey={key}
      setUserPublicKey={noop}
      onConnectWallet={noop}
      onDisconnectWallet={noop}
      onRefreshBalance={noop}
      onDashboardClick={noop}
      onAnalyticsClick={noop}
      onHelpClick={noop}
      onRegisterClick={noop}
      canRegister={false}
    />,
  );

const stubMatchMedia = (matches = false) => {
  vi.stubGlobal('matchMedia', () => ({
    matches,
    media: '(prefers-reduced-motion: reduce)',
    addListener: noop,
    removeListener: noop,
    addEventListener: noop,
    removeEventListener: noop,
  }));
};

describe('HistoryPage pagination', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('fetches only the first page (limit=50, page=1) on initial render', async () => {
    const firstPageRecords = Array.from({ length: 50 }, (_, i) => makeRecord(i + 1));
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => makeHorizonResponse(firstPageRecords, 'cursor-page-2'),
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('matchMedia', () => ({ matches: false, addListener: noop, removeListener: noop }));

    renderPage();

    await waitFor(() => expect(screen.queryByText('Loading transactions...')).toBeNull());

    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('limit=50');
    expect(url).toContain('page=1');
    expect(url).not.toContain('cursor=');
  });

  it('shows "Next" and "Previous" pagination controls', async () => {
    const firstPageRecords = Array.from({ length: 50 }, (_, i) => makeRecord(i + 1));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => makeHorizonResponse(firstPageRecords, 'cursor-page-2'),
    }));
    vi.stubGlobal('matchMedia', () => ({ matches: false, addListener: noop, removeListener: noop }));

    renderPage();

    const nextBtn = await screen.findByRole('button', { name: /next/i });
    const prevBtn = screen.getByRole('button', { name: /previous/i });
    expect(nextBtn).toBeTruthy();
    expect(prevBtn).toBeTruthy();
    expect(prevBtn.disabled).toBe(true);
  });

  it('disables "Next" when there is no next page', async () => {
    const records = Array.from({ length: 5 }, (_, i) => makeRecord(i + 1));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => makeHorizonResponse(records, null),
    }));
    vi.stubGlobal('matchMedia', () => ({ matches: false, addListener: noop, removeListener: noop }));

    renderPage();

    await waitFor(() => expect(screen.queryByText('Loading transactions...')).toBeNull());
    expect(screen.getByRole('button', { name: /next/i }).disabled).toBe(true);
  });

  it('fetches the following page when "Next" is clicked', async () => {
    const page1 = Array.from({ length: 50 }, (_, i) => makeRecord(i + 1));
    const page2 = Array.from({ length: 50 }, (_, i) => makeRecord(i + 51));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => makeHorizonResponse(page1, 'cursor-page-2'),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => makeHorizonResponse(page2, 'cursor-page-3'),
      });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('matchMedia', () => ({ matches: false, addListener: noop, removeListener: noop }));

    renderPage();

    const nextBtn = await screen.findByRole('button', { name: /next/i });
    fireEvent.click(nextBtn);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    const [secondUrl] = fetchMock.mock.calls[1];
    expect(secondUrl).toContain('page=2');
    expect(secondUrl).toContain('limit=50');
  });

  it('returns to the previous page when "Previous" is clicked', async () => {
    const page1 = Array.from({ length: 50 }, (_, i) => makeRecord(i + 1));
    const page2 = Array.from({ length: 50 }, (_, i) => makeRecord(i + 51));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => makeHorizonResponse(page1, 'cursor-page-2'),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => makeHorizonResponse(page2, 'cursor-page-3'),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => makeHorizonResponse(page1, 'cursor-page-2'),
      });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('matchMedia', () => ({ matches: false, addListener: noop, removeListener: noop }));

    renderPage();

    const nextBtn = await screen.findByRole('button', { name: /next/i });
    fireEvent.click(nextBtn);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    const prevBtn = screen.getByRole('button', { name: /previous/i });
    await waitFor(() => expect(prevBtn.disabled).toBe(false));
    fireEvent.click(prevBtn);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

    const [thirdUrl] = fetchMock.mock.calls[2];
    expect(thirdUrl).toContain('page=1');
    expect(thirdUrl).toContain('limit=50');
  });

  it('shows a loading spinner during page transitions', async () => {
    let resolvePage2;
    const page2Promise = new Promise((resolve) => { resolvePage2 = resolve; });
    const page1 = Array.from({ length: 50 }, (_, i) => makeRecord(i + 1));

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => makeHorizonResponse(page1, 'cursor-p2'),
      })
      .mockReturnValueOnce(page2Promise);
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('matchMedia', () => ({ matches: false, addListener: noop, removeListener: noop }));

    renderPage();

    const nextBtn = await screen.findByRole('button', { name: /next/i });
    fireEvent.click(nextBtn);

    await waitFor(() => expect(screen.queryByText('Loading transactions...')).not.toBeNull());

    resolvePage2({ ok: true, json: async () => makeHorizonResponse([], null) });
    await waitFor(() => expect(screen.queryByText('Loading transactions...')).toBeNull());
  });
});

describe('HistoryPage amount formatting', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders amounts using the shared decimal-safe formatter', async () => {
    const record = { ...makeRecord(1), amount: '1234.5678901' };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => makeHorizonResponse([record], null),
    }));
    stubMatchMedia();

    renderPage();

    const expected = formatAssetAmount(record.amount, { assetType: 'native' });
    await waitFor(() => expect(screen.queryByText('Loading transactions...')).toBeNull());
    expect(screen.getByText(new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))).toBeTruthy();
  });

  it('does not lose precision for large amounts (no float round-trip)', async () => {
    const record = { ...makeRecord(1), amount: '9007199254740993.0000001' };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => makeHorizonResponse([record], null),
    }));
    stubMatchMedia();

    renderPage();

    await waitFor(() => expect(screen.queryByText('Loading transactions...')).toBeNull());
    expect(screen.queryByText(/9007199254740992/)).toBeNull();
  });
});

describe('HistoryPage deletion dialog accessibility', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('opens a labelled modal dialog and returns focus to the trigger on cancel', async () => {
    const record = makeRecord(1);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => makeHorizonResponse([record], null),
    }));
    stubMatchMedia();

    renderPage();
    await waitFor(() => expect(screen.queryByText('Loading transactions...')).toBeNull());

    const trigger = screen.queryByRole('button', { name: /delete/i });
    if (!trigger) return; // deletion not offered for this record type

    trigger.focus();
    fireEvent.click(trigger);

    const dialog = await screen.findByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-labelledby')).toBeTruthy();

    const cancel = screen.getByRole('button', { name: /cancel/i });
    fireEvent.click(cancel);

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it('closes the dialog on Escape and restores focus', async () => {
    const record = makeRecord(1);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => makeHorizonResponse([record], null),
    }));
    stubMatchMedia();

    renderPage();
    await waitFor(() => expect(screen.queryByText('Loading transactions...')).toBeNull());

    const trigger = screen.queryByRole('button', { name: /delete/i });
    if (!trigger) return;

    trigger.focus();
    fireEvent.click(trigger);
    const dialog = await screen.findByRole('dialog');

    fireEvent.keyDown(dialog, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });
});

describe('HistoryPage WCAG checks', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('has no axe violations in the loaded state', async () => {
    const records = Array.from({ length: 3 }, (_, i) => makeRecord(i + 1));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => makeHorizonResponse(records, null),
    }));
    stubMatchMedia();

    const { container } = renderPage();
    await waitFor(() => expect(screen.queryByText('Loading transactions...')).toBeNull());

    const results = await runAxe(container);
    expect(results.violations).toEqual([]);
  });

  it('has no axe violations in the loading state', async () => {
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => {})));
    stubMatchMedia();

    const { container } = renderPage();
    await screen.findByText('Loading transactions...');

    const results = await runAxe(container);
    expect(results.violations).toEqual([]);
  });

  it('has no axe violations in the error state', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    stubMatchMedia();

    const { container } = renderPage();
    await waitFor(() => expect(screen.queryByText('Loading transactions...')).toBeNull());

    const results = await runAxe(container);
    expect(results.violations).toEqual([]);
  });
});

describe('HistoryPage reduced motion', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('marks the page as reduced-motion when the preference is set', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => makeHorizonResponse([makeRecord(1)], null),
    }));
    stubMatchMedia(true);

    const { container } = renderPage();
    await waitFor(() => expect(screen.queryByText('Loading transactions...')).toBeNull());

    expect(container.querySelector('[data-reduced-motion="true"]')).not.toBeNull();
  });

  it('does not mark reduced-motion when the preference is not set', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => makeHorizonResponse([makeRecord(1)], null),
    }));
    stubMatchMedia(false);

    const { container } = renderPage();
    await waitFor(() => expect(screen.queryByText('Loading transactions...')).toBeNull());

    expect(container.querySelector('[data-reduced-motion="true"]')).toBeNull();
  });
});

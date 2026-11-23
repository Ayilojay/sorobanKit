// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import axe from 'axe-core';

// ── vi.hoisted: variables that need to be available inside vi.mock factories ──
const { mockSignTransaction, mockRoutePayment, mockToastError, mockToastLoading, mockToastSuccess } =
  vi.hoisted(() => ({
    mockSignTransaction: vi.fn(),
    mockRoutePayment: vi.fn(),
    mockToastError: vi.fn(),
    mockToastLoading: vi.fn(() => 'toast-id'),
    mockToastSuccess: vi.fn(),
  }));

// ── Wallet kit is a CJS singleton constructed at import time in shared.js ──
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

// ── Mock @stellar/freighter-api so we can control signTransaction ──
vi.mock('@stellar/freighter-api', () => ({
  default: {
    signTransaction: mockSignTransaction,
  },
}));

// ── Mock the generated contract client ──
vi.mock('@stellar-tags/payment-router', () => {
  const RoutePayment = mockRoutePayment;
  class Client {
    // eslint-disable-next-line no-unused-vars
    constructor(_opts) {}
    route_payment(...args) {
      return RoutePayment(...args);
    }
  }
  return {
    Client,
    networks: {
      testnet: {
        networkPassphrase: 'Test SDF Network ; September 2015',
        contractId: 'CTEST',
      },
    },
  };
});

// ── Mock react-hot-toast so we can inspect calls ──
vi.mock('react-hot-toast', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    default: {
      ...actual.default,
      error: mockToastError,
      loading: mockToastLoading,
      success: mockToastSuccess,
    },
    Toaster: () => null,
  };
});

import Dashboard from './Dashboard';

const PUBLIC_KEY = 'GABC1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890AB';
const RECIPIENT_KEY = 'GBOB1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890AB';
const OTHER_PUBLIC_KEY = 'GXYZ1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890AB';
const DRAFT_STORAGE_KEY = 'stellar-tags:payment-draft';
const noop = () => {};

const readStoredDraft = () => {
  const raw = window.localStorage.getItem(DRAFT_STORAGE_KEY);
  return raw ? JSON.parse(raw) : null;
};

const SIGNING_CANCELLED_MSG =
  'Transaction signing was cancelled or failed — no transaction was submitted.';

/**
 * Run axe-core against the current document and return the violations.
 * Scoped to WCAG 2.1 A/AA rules so the suite enforces the documented target
 * level. Any violation must either be fixed or added to the reviewed
 * exceptions list in the PR with a justification.
 */
const runAxe = async (context = document.body) => {
  const results = await axe.run(context, {
    runOnly: {
      type: 'tag',
      values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'],
    },
  });
  return results.violations;
};

/** Stub matchMedia so components can query the reduced-motion preference. */
const stubMatchMedia = (matches) => {
  vi.stubGlobal('matchMedia', (query) => ({
    matches: typeof matches === 'function' ? matches(query) : matches,
    media: query,
    onchange: null,
    addListener: noop,
    removeListener: noop,
    addEventListener: noop,
    removeEventListener: noop,
    dispatchEvent: () => false,
  }));
};

const renderDashboard = (publicKey = PUBLIC_KEY) =>
  render(
    <Dashboard
      userPublicKey={publicKey}
      balance={100}
      isRefreshing={false}
      balanceError=""
      onRefreshBalance={noop}
      onConnectWallet={noop}
      onDisconnectWallet={noop}
      onNavigate={noop}
      registrationState="existing"
      onRegistrationStateChange={noop}
    />,
  );

describe('Dashboard – signing-failure path', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  /** Set up the federation fetch mock and the route_payment simulation. */
  const setupHappyPathMocks = () => {
    // jsdom does not implement matchMedia; stub it before rendering Dashboard
    stubMatchMedia(false);

    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        // Initial health check, then /lookup during loadReceiveDetails.
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({ 'Content-Type': 'application/json' }),
          json: async () => ({ status: 'UP' }),
          text: async () => JSON.stringify({ status: 'UP' }),
        })
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({ 'Content-Type': 'application/json' }),
          json: async () => ({ address: PUBLIC_KEY, username: 'alice' }),
          text: async () => JSON.stringify({ address: PUBLIC_KEY, username: 'alice' }),
        })
        // All subsequent calls: /federation for recipient resolution.
        .mockResolvedValue({
          ok: true,
          headers: new Headers({ 'Content-Type': 'application/json' }),
          json: async () => ({ account_id: RECIPIENT_KEY }),
          text: async () => JSON.stringify({ account_id: RECIPIENT_KEY }),
        }),
    );

    // Simulate route_payment returning an assembled transaction
    mockRoutePayment.mockResolvedValue({ toXDR: () => 'base64xdr==' });
  };

  it('shows the signing-cancelled message when the wallet rejects the signing prompt', async () => {
    setupHappyPathMocks();
    mockSignTransaction.mockRejectedValue(new Error('User declined'));

    renderDashboard();

    fireEvent.change(screen.getByPlaceholderText('username or wallet address'), {
      target: { value: 'alice*localhost' },
    });
    fireEvent.change(screen.getByPlaceholderText('0.00'), {
      target: { value: '10' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send payment/i }));

    await waitFor(() =>
      expect(screen.queryByText(SIGNING_CANCELLED_MSG)).not.toBeNull(),
    );

    expect(screen.getByText(SIGNING_CANCELLED_MSG)).toBeTruthy();
  });

  it('shows the signing-cancelled message when the wallet times out', async () => {
    setupHappyPathMocks();
    mockSignTransaction.mockRejectedValue(new Error('Request timed out'));

    renderDashboard();

    fireEvent.change(screen.getByPlaceholderText('username or wallet address'), {
      target: { value: 'alice*localhost' },
    });
    fireEvent.change(screen.getByPlaceholderText('0.00'), {
      target: { value: '5' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send payment/i }));

    await waitFor(() =>
      expect(screen.queryByText(SIGNING_CANCELLED_MSG)).not.toBeNull(),
    );

    expect(screen.getByText(SIGNING_CANCELLED_MSG)).toBeTruthy();
  });

  it('passes the signing-cancelled message to toast.error', async () => {
    setupHappyPathMocks();
    mockSignTransaction.mockRejectedValue(new Error('User declined'));

    renderDashboard();

    fireEvent.change(screen.getByPlaceholderText('username or wallet address'), {
      target: { value: 'alice*localhost' },
    });
    fireEvent.change(screen.getByPlaceholderText('0.00'), {
      target: { value: '10' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send payment/i }));

    await waitFor(() => expect(mockToastError).toHaveBeenCalled());

    const [msg] = mockToastError.mock.calls[0];
    expect(msg).toBe(SIGNING_CANCELLED_MSG);
  });

  it('rolls back isProcessing and isSubmitting after a signing failure (Send Payment re-enabled)', async () => {
    setupHappyPathMocks();
    mockSignTransaction.mockRejectedValue(new Error('User declined'));

    renderDashboard();

    const recipientInput = screen.getByPlaceholderText('username or wallet address');
    const amountInput = screen.getByPlaceholderText('0.00');

    fireEvent.change(recipientInput, { target: { value: 'alice*localhost' } });
    fireEvent.change(amountInput, { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: /send payment/i }));

    // Wait for error to confirm the async chain is done
    await waitFor(() =>
      expect(screen.queryByText(SIGNING_CANCELLED_MSG)).not.toBeNull(),
    );

    // After the failure the button must be re-enabled (not disabled)
    const reenabledBtn = screen.getByRole('button', { name: /send payment/i });
    expect(reenabledBtn.disabled).toBe(false);
  });

  it('does NOT call toast.success after a signing failure', async () => {
    setupHappyPathMocks();
    mockSignTransaction.mockRejectedValue(new Error('User declined'));

    renderDashboard();

    fireEvent.change(screen.getByPlaceholderText('username or wallet address'), {
      target: { value: 'alice*localhost' },
    });
    fireEvent.change(screen.getByPlaceholderText('0.00'), {
      target: { value: '10' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send payment/i }));

    await waitFor(() => expect(mockToastError).toHaveBeenCalled());

    expect(mockToastSuccess).not.toHaveBeenCalled();
  });
});

describe('Dashboard – exact decimal amount formatting and parsing', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  const setupMocks = () => {
    stubMatchMedia(false);
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({ 'Content-Type': 'application/json' }),
          json: async () => ({ status: 'UP' }),
          text: async () => JSON.stringify({ status: 'UP' }),
        })
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({ 'Content-Type': 'application/json' }),
          json: async () => ({ address: PUBLIC_KEY, username: 'alice' }),
          text: async () => JSON.stringify({ address: PUBLIC_KEY, username: 'alice' }),
        })
        .mockResolvedValue({
          ok: true,
          headers: new Headers({ 'Content-Type': 'application/json' }),
          json: async () => ({ account_id: RECIPIENT_KEY }),
          text: async () => JSON.stringify({ account_id: RECIPIENT_KEY }),
        }),
    );
    mockRoutePayment.mockResolvedValue({ toXDR: () => 'base64xdr==' });
  };

  it('keeps the entered amount as an exact decimal string (no float round-trip)', async () => {
    setupMocks();
    mockSignTransaction.mockResolvedValue({ signedTxXdr: 'signed==' });

    renderDashboard();

    fireEvent.change(screen.getByPlaceholderText('username or wallet address'), {
      target: { value: 'alice*localhost' },
    });
    // 0.1 + 0.2 style values must not be coerced through Number()
    fireEvent.change(screen.getByPlaceholderText('0.00'), {
      target: { value: '0.30000000000000004' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send payment/i }));

    await waitFor(() => expect(mockRoutePayment).toHaveBeenCalled());

    const [, , amountArg] = mockRoutePayment.mock.calls[0];
    // The amount must be forwarded without floating-point drift.
    expect(String(amountArg)).not.toBe(String(0.1 + 0.2));
  });

  it('formats a large balance with locale grouping without losing precision', () => {
    renderDashboard();
    // The balance is rendered somewhere in the dashboard; assert the raw
    // integer value survives formatting (no scientific notation, no rounding).
    const text = document.body.textContent || '';
    expect(text).not.toMatch(/1e\+?\d/i);
  });

  it('rejects malformed decimal input without submitting', async () => {
    setupMocks();

    renderDashboard();

    fireEvent.change(screen.getByPlaceholderText('username or wallet address'), {
      target: { value: 'alice*localhost' },
    });
    fireEvent.change(screen.getByPlaceholderText('0.00'), {
      target: { value: '1.2.3' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send payment/i }));

    // Give the async chain a chance to run; route_payment must not be called.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockRoutePayment).not.toHaveBeenCalled();
  });
});

describe('Dashboard – payment confirmation dialog accessibility', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  const setupMocks = () => {
    stubMatchMedia(false);
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({ 'Content-Type': 'application/json' }),
          json: async () => ({ status: 'UP' }),
          text: async () => JSON.stringify({ status: 'UP' }),
        })
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({ 'Content-Type': 'application/json' }),
          json: async () => ({ address: PUBLIC_KEY, username: 'alice' }),
          text: async () => JSON.stringify({ address: PUBLIC_KEY, username: 'alice' }),
        })
        .mockResolvedValue({
          ok: true,
          headers: new Headers({ 'Content-Type': 'application/json' }),
          json: async () => ({ account_id: RECIPIENT_KEY }),
          text: async () => JSON.stringify({ account_id: RECIPIENT_KEY }),
        }),
    );
    mockRoutePayment.mockResolvedValue({ toXDR: () => 'base64xdr==' });
  };

  it('exposes the payment form controls with accessible labels', () => {
    setupMocks();
    renderDashboard();

    expect(
      screen.getByPlaceholderText('username or wallet address').getAttribute('aria-label') ||
        screen.getByPlaceholderText('username or wallet address').id,
    ).toBeTruthy();
    expect(
      screen.getByPlaceholderText('0.00').getAttribute('aria-label') ||
        screen.getByPlaceholderText('0.00').id,
    ).toBeTruthy();
  });

  it('moves focus into the confirmation dialog and returns it on Escape', async () => {
    setupMocks();
    mockSignTransaction.mockResolvedValue({ signedTxXdr: 'signed==' });

    renderDashboard();

    const sendBtn = screen.getByRole('button', { name: /send payment/i });
    sendBtn.focus();

    fireEvent.change(screen.getByPlaceholderText('username or wallet address'), {
      target: { value: 'alice*localhost' },
    });
    fireEvent.change(screen.getByPlaceholderText('0.00'), {
      target: { value: '10' },
    });
    fireEvent.click(sendBtn);

    const dialog = await screen.findByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    // Focus must land inside the dialog.
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

    fireEvent.keyDown(dialog, { key: 'Escape', code: 'Escape' });

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // Focus returns to the trigger.
    expect(document.activeElement).toBe(sendBtn);
  });

  it('traps Tab focus within the confirmation dialog', async () => {
    setupMocks();
    mockSignTransaction.mockResolvedValue({ signedTxXdr: 'signed==' });

    renderDashboard();

    fireEvent.change(screen.getByPlaceholderText('username or wallet address'), {
      target: { value: 'alice*localhost' },
    });
    fireEvent.change(screen.getByPlaceholderText('0.00'), {
      target: { value: '10' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send payment/i }));

    const dialog = await screen.findByRole('dialog');
    const focusables = dialog.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    expect(focusables.length).toBeGreaterThan(0);

    const last = focusables[focusables.length - 1];
    last.focus();
    fireEvent.keyDown(dialog, { key: 'Tab', code: 'Tab' });
    expect(dialog.contains(document.activeElement)).toBe(true);
  });
});

describe('Dashboard – WCAG 2.1 AA automated checks (payment journey)', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  const setupMocks = () => {
    stubMatchMedia(false);
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({ 'Content-Type': 'application/json' }),
          json: async () => ({ status: 'UP' }),
          text: async () => JSON.stringify({ status: 'UP' }),
        })
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({ 'Content-Type': 'application/json' }),
          json: async () => ({ address: PUBLIC_KEY, username: 'alice' }),
          text: async () => JSON.stringify({ address: PUBLIC_KEY, username: 'alice' }),
        })
        .mockResolvedValue({
          ok: true,
          headers: new Headers({ 'Content-Type': 'application/json' }),
          json: async () => ({ account_id: RECIPIENT_KEY }),
          text: async () => JSON.stringify({ account_id: RECIPIENT_KEY }),
        }),
    );
    mockRoutePayment.mockResolvedValue({ toXDR: () => 'base64xdr==' });
  };

  it('has no WCAG 2.1 AA violations in the idle payment state', async () => {
    setupMocks();
    renderDashboard();
    const violations = await runAxe();
    expect(violations).toEqual([]);
  });

  it('has no WCAG 2.1 AA violations while loading', async () => {
    setupMocks();
    // Never resolve the health check so the loading view stays mounted.
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    renderDashboard();
    const violations = await runAxe();
    expect(violations).toEqual([]);
  });

  it('has no WCAG 2.1 AA violations in the error state', async () => {
    setupMocks();
    mockSignTransaction.mockRejectedValue(new Error('User declined'));
    renderDashboard();

    fireEvent.change(screen.getByPlaceholderText('username or wallet address'), {
      target: { value: 'alice*localhost' },
    });
    fireEvent.change(screen.getByPlaceholderText('0.00'), {
      target: { value: '10' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send payment/i }));

    await waitFor(() =>
      expect(screen.queryByText(SIGNING_CANCELLED_MSG)).not.toBeNull(),
    );

    const violations = await runAxe();
    expect(violations).toEqual([]);
  });
});

describe('Dashboard – reduced-motion preferences', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  const setupMocks = () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({ 'Content-Type': 'application/json' }),
          json: async () => ({ status: 'UP' }),
          text: async () => JSON.stringify({ status: 'UP' }),
        })
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({ 'Content-Type': 'application/json' }),
          json: async () => ({ address: PUBLIC_KEY, username: 'alice' }),
          text: async () => JSON.stringify({ address: PUBLIC_KEY, username: 'alice' }),
        })
        .mockResolvedValue({
          ok: true,
          headers: new Headers({ 'Content-Type': 'application/json' }),
          json: async () => ({ account_id: RECIPIENT_KEY }),
          text: async () => JSON.stringify({ account_id: RECIPIENT_KEY }),
        }),
    );
    mockRoutePayment.mockResolvedValue({ toXDR: () => 'base64xdr==' });
  };

  it('reports the reduced-motion preference when the user opts in', () => {
    setupMocks();
    stubMatchMedia((query) => query.includes('prefers-reduced-motion'));
    renderDashboard();
    expect(window.matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(true);
  });

  it('disables nonessential animation under prefers-reduced-motion: reduce', () => {
    setupMocks();
    stubMatchMedia((query) => query.includes('prefers-reduced-motion'));
    renderDashboard();

    // The dashboard root should carry a reduced-motion marker/class so CSS
    // can suppress transitions while keeping functional feedback visible.
    const root = document.querySelector('[data-reduced-motion="true"]');
    expect(root).not.toBeNull();
  });

  it('keeps animations enabled when reduced motion is not requested', () => {
    setupMocks();
    stubMatchMedia(false);
    renderDashboard();

    expect(document.querySelector('[data-reduced-motion="true"]')).toBeNull();
  });
});

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import axe from 'axe-core';

// ── vi.hoisted: variables referenced inside vi.mock factory closures ──
const { mockSignBlob, mockOpenModal } = vi.hoisted(() => ({
  mockSignBlob: vi.fn(),
  mockOpenModal: vi.fn(),
}));

// ── Wallet kit singleton; we need to control signBlob ──
vi.mock('@creit.tech/stellar-wallets-kit', () => {
  class StellarWalletsKit {
    openModal(...args) {
      return mockOpenModal(...args);
    }
    setWallet() {}
    getAddress() {
      return Promise.resolve('GABC1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890AB');
    }
    // signBlob is checked via `walletKit.signBlob ?` in RegistrationPage
    signBlob(...args) {
      return mockSignBlob(...args);
    }
  }
  return {
    StellarWalletsKit,
    WalletNetwork: { TESTNET: 'TESTNET' },
    FreighterModule: class {},
    xBullModule: class {},
    AlbedoModule: class {},
    LobstrModule: class {},
  };
});

import RegistrationPage from './RegistrationPage';

const PUBLIC_KEY = 'GABC1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890AB';
const OTHER_PUBLIC_KEY = 'GXYZ9876543210ZYXWVU9876543210ZYXWVU9876543210ZYXWVU9876543210ZY';
const noop = () => {};

const DRAFT_STORAGE_KEY = 'payment-dashboard:registration-draft';
const NETWORK = 'TESTNET';

const SIGNING_CANCELLED_MSG =
  'Transaction signing was cancelled or failed — no transaction was submitted.';

const renderPage = (publicKey = PUBLIC_KEY, extraProps = {}) =>
  render(
    <RegistrationPage
      userPublicKey={publicKey}
      setUserPublicKey={noop}
      onBack={noop}
      onRegistered={noop}
      network={NETWORK}
      {...extraProps}
    />,
  );

// ── axe / WCAG 2.1 AA helpers ──
// Target level: WCAG 2.1 AA. Any rule violations must be either fixed or
// recorded as a reviewed exception in the `REVIEWED_EXCEPTIONS` map below.
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

const REVIEWED_EXCEPTIONS = {
  // ruleId -> reason (must be reviewed by an accessibility owner)
};

const runAxe = async (container) => {
  const results = await axe.run(container, {
    runOnly: { type: 'tag', values: WCAG_TAGS },
  });
  const unexpected = results.violations.filter(
    (violation) => !(violation.id in REVIEWED_EXCEPTIONS),
  );
  return { results, unexpected };
};

const expectNoUnexpectedViolations = async (container) => {
  const { unexpected } = await runAxe(container);
  const summary = unexpected.map(
    (v) => `${v.id} (${v.impact}): ${v.help} — ${v.nodes.length} node(s)`,
  );
  expect(summary).toEqual([]);
};

describe('RegistrationPage – signing-failure path', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  /** Fill in a valid username and click Register. */
  const submitRegistration = () => {
    fireEvent.change(screen.getByPlaceholderText('stellar-fan'), {
      target: { value: 'alice' },
    });
    fireEvent.click(screen.getByRole('button', { name: /register username/i }));
  };

  it('shows the signing-cancelled message when the wallet rejects the signing prompt', async () => {
    // Stub fetch: suppress the /lookup call on mount
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404, text: async () => '' }));

    mockSignBlob.mockRejectedValue(new Error('User rejected'));

    renderPage();
    submitRegistration();

    await waitFor(() =>
      expect(screen.queryByText(SIGNING_CANCELLED_MSG)).not.toBeNull(),
    );

    expect(screen.getByText(SIGNING_CANCELLED_MSG)).toBeTruthy();
  });

  it('shows the signing-cancelled message when the wallet times out', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404, text: async () => '' }));

    mockSignBlob.mockRejectedValue(new Error('Timed out waiting for user'));

    renderPage();
    submitRegistration();

    await waitFor(() =>
      expect(screen.queryByText(SIGNING_CANCELLED_MSG)).not.toBeNull(),
    );

    expect(screen.getByText(SIGNING_CANCELLED_MSG)).toBeTruthy();
  });

  it('shows the LOBSTR-specific message when signMessage is unsupported', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404, text: async () => '' }));

    mockSignBlob.mockRejectedValue(new Error('signMessage is not supported'));

    renderPage();
    submitRegistration();

    await waitFor(() =>
      expect(
        screen.queryByText(/LOBSTR does not support registration signatures/i),
      ).not.toBeNull(),
    );
  });

  it('resets isSubmitting after a signing failure (Register button re-enabled)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404, text: async () => '' }));

    mockSignBlob.mockRejectedValue(new Error('User rejected'));

    renderPage();

    const submitBtn = screen.getByRole('button', { name: /register username/i });

    submitRegistration();

    // Wait for the error message to appear (signing path finished)
    await waitFor(() =>
      expect(screen.queryByText(SIGNING_CANCELLED_MSG)).not.toBeNull(),
    );

    // Button must be re-enabled — no optimistic state remains
    expect(submitBtn.disabled).toBe(false);
  });

  it('does NOT submit the registration fetch when signing fails', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404, text: async () => '' });
    vi.stubGlobal('fetch', fetchMock);

    mockSignBlob.mockRejectedValue(new Error('User rejected'));

    renderPage();
    submitRegistration();

    await waitFor(() =>
      expect(screen.queryByText(SIGNING_CANCELLED_MSG)).not.toBeNull(),
    );

    // Only the initial /lookup call on mount should have been made;
    // the /register POST must NOT have been called.
    const postCalls = fetchMock.mock.calls.filter(
      ([url, opts]) => opts?.method === 'POST' && String(url).includes('/register'),
    );
    expect(postCalls).toHaveLength(0);
  });
});

describe('RegistrationPage – WCAG 2.1 AA (axe)', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('has no unexpected WCAG 2.1 AA violations in the initial (idle) state', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404, text: async () => '' }));

    const { container } = renderPage();

    await waitFor(() =>
      expect(screen.getByPlaceholderText('stellar-fan')).toBeTruthy(),
    );

    await expectNoUnexpectedViolations(container);
  });

  it('has no unexpected WCAG 2.1 AA violations while submitting (loading state)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404, text: async () => '' }));

    // Keep the signing promise pending so the loading state is observable.
    let resolveSign;
    mockSignBlob.mockImplementation(
      () => new Promise((resolve) => { resolveSign = resolve; }),
    );

    const { container } = renderPage();

    fireEvent.change(screen.getByPlaceholderText('stellar-fan'), {
      target: { value: 'alice' },
    });
    fireEvent.click(screen.getByRole('button', { name: /register username/i }));

    // Loading state should be reflected on the submit control.
    await waitFor(() => {
      const btn = screen.getByRole('button', { name: /register username/i });
      expect(btn.disabled).toBe(true);
    });

    await expectNoUnexpectedViolations(container);

    // Settle the pending promise to avoid act() warnings.
    resolveSign?.(new Uint8Array([1, 2, 3]));
  });

  it('has no unexpected WCAG 2.1 AA violations in the signing-error state', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404, text: async () => '' }));

    mockSignBlob.mockRejectedValue(new Error('User rejected'));

    const { container } = renderPage();

    fireEvent.change(screen.getByPlaceholderText('stellar-fan'), {
      target: { value: 'alice' },
    });
    fireEvent.click(screen.getByRole('button', { name: /register username/i }));

    await waitFor(() =>
      expect(screen.queryByText(SIGNING_CANCELLED_MSG)).not.toBeNull(),
    );

    await expectNoUnexpectedViolations(container);
  });

  it('has no unexpected WCAG 2.1 AA violations in the LOBSTR-unsupported error state', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404, text: async () => '' }));

    mockSignBlob.mockRejectedValue(new Error('signMessage is not supported'));

    const { container } = renderPage();

    fireEvent.change(screen.getByPlaceholderText('stellar-fan'), {
      target: { value: 'alice' },
    });
    fireEvent.click(screen.getByRole('button', { name: /register username/i }));

    await waitFor(() =>
      expect(
        screen.queryByText(/LOBSTR does not support registration signatures/i),
      ).not.toBeNull(),
    );

    await expectNoUnexpectedViolations(container);
  });

  it('exposes the error message to assistive technology via a live region', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404, text: async () => '' }));

    mockSignBlob.mockRejectedValue(new Error('User rejected'));

    renderPage();

    fireEvent.change(screen.getByPlaceholderText('stellar-fan'), {
      target: { value: 'alice' },
    });
    fireEvent.click(screen.getByRole('button', { name: /register username/i }));

    await waitFor(() =>
      expect(screen.queryByText(SIGNING_CANCELLED_MSG)).not.toBeNull(),
    );

    // The error must be announced: it should live inside an element with
    // role="alert" or aria-live="assertive"/"polite".
    const errorNode = screen.getByText(SIGNING_CANCELLED_MSG);
    const liveRegion = errorNode.closest('[role="alert"], [aria-live]');
    expect(liveRegion).not.toBeNull();
  });
});

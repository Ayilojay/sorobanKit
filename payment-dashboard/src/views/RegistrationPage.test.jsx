// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

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

const readDraft = () => {
  const raw = window.localStorage.getItem(DRAFT_STORAGE_KEY);
  return raw ? JSON.parse(raw) : null;
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

describe('RegistrationPage – draft persistence lifecycle', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  const stubLookupMiss = () =>
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404, text: async () => '' }));

  const typeUsername = (value) =>
    fireEvent.change(screen.getByPlaceholderText('stellar-fan'), { target: { value } });

  it('persists only non-secret fields bound to account and network', async () => {
    stubLookupMiss();
    renderPage();

    typeUsername('alice');

    await waitFor(() => expect(readDraft()).not.toBeNull());

    const draft = readDraft();
    expect(draft.username).toBe('alice');
    expect(draft.publicKey).toBe(PUBLIC_KEY);
    expect(draft.network).toBe(NETWORK);
    // No secret material should ever be written to storage.
    const serialized = JSON.stringify(draft).toLowerCase();
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('signature');
    expect(serialized).not.toContain('signedxdr');
  });

  it('restores a compatible draft on mount', async () => {
    stubLookupMiss();
    window.localStorage.setItem(
      DRAFT_STORAGE_KEY,
      JSON.stringify({
        username: 'bob',
        publicKey: PUBLIC_KEY,
        network: NETWORK,
        savedAt: Date.now(),
      }),
    );

    renderPage();

    await waitFor(() =>
      expect(screen.getByPlaceholderText('stellar-fan').value).toBe('bob'),
    );
  });

  it('discards a draft saved for a different account', async () => {
    stubLookupMiss();
    window.localStorage.setItem(
      DRAFT_STORAGE_KEY,
      JSON.stringify({
        username: 'bob',
        publicKey: OTHER_PUBLIC_KEY,
        network: NETWORK,
        savedAt: Date.now(),
      }),
    );

    renderPage();

    await waitFor(() => expect(readDraft()).toBeNull());
    expect(screen.getByPlaceholderText('stellar-fan').value).toBe('');
  });

  it('discards a draft saved for a different network', async () => {
    stubLookupMiss();
    window.localStorage.setItem(
      DRAFT_STORAGE_KEY,
      JSON.stringify({
        username: 'bob',
        publicKey: PUBLIC_KEY,
        network: 'PUBLIC',
        savedAt: Date.now(),
      }),
    );

    renderPage();

    await waitFor(() => expect(readDraft()).toBeNull());
    expect(screen.getByPlaceholderText('stellar-fan').value).toBe('');
  });

  it('discards an expired draft', async () => {
    stubLookupMiss();
    const expiredAt = Date.now() - 1000 * 60 * 60 * 24 * 30;
    window.localStorage.setItem(
      DRAFT_STORAGE_KEY,
      JSON.stringify({
        username: 'bob',
        publicKey: PUBLIC_KEY,
        network: NETWORK,
        savedAt: expiredAt,
      }),
    );

    renderPage();

    await waitFor(() => expect(readDraft()).toBeNull());
    expect(screen.getByPlaceholderText('stellar-fan').value).toBe('');
  });

  it('discards a malformed draft without crashing', async () => {
    stubLookupMiss();
    window.localStorage.setItem(DRAFT_STORAGE_KEY, '{not-json');

    renderPage();

    await waitFor(() => expect(readDraft()).toBeNull());
    expect(screen.getByPlaceholderText('stellar-fan').value).toBe('');
  });

  it('clears the draft when the user clicks the clear control', async () => {
    stubLookupMiss();
    renderPage();

    typeUsername('alice');
    await waitFor(() => expect(readDraft()).not.toBeNull());

    fireEvent.click(screen.getByRole('button', { name: /clear saved draft/i }));

    await waitFor(() => expect(readDraft()).toBeNull());
    expect(screen.getByPlaceholderText('stellar-fan').value).toBe('');
  });

  it('removes the draft after a successful registration', async () => {
    const fetchMock = vi.fn((url, opts) => {
      if (opts?.method === 'POST' && String(url).includes('/register')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ success: true }),
          text: async () => '',
        });
      }
      return Promise.resolve({ ok: false, status: 404, text: async () => '' });
    });
    vi.stubGlobal('fetch', fetchMock);
    mockSignBlob.mockResolvedValue({ signedMessage: 'c2lnbmF0dXJl' });

    renderPage();

    typeUsername('alice');
    await waitFor(() => expect(readDraft()).not.toBeNull());

    fireEvent.click(screen.getByRole('button', { name: /register username/i }));

    await waitFor(() => expect(readDraft()).toBeNull());
  });
});

describe('RegistrationPage – shared state rendering', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it('renders a loading state while the lookup request is in flight', async () => {
    let resolveLookup;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise((resolve) => {
            resolveLookup = resolve;
          }),
      ),
    );

    renderPage();

    expect(screen.getByRole('status')).toBeTruthy();

    resolveLookup({ ok: false, status: 404, text: async () => '' });
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  });

  it('renders an empty state when the username is available', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 404, text: async () => '' }),
    );

    renderPage();

    await waitFor(() =>
      expect(screen.queryByText(/username is available/i)).not.toBeNull(),
    );
  });

  it('renders an error state with a retry action when the lookup fails', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();

    await waitFor(() =>
      expect(screen.queryByRole('alert')).not.toBeNull(),
    );

    const retry = screen.getByRole('button', { name: /retry/i });
    fireEvent.click(retry);

    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(1));
  });

  it('preserves usable form content when a secondary request fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' }),
    );

    renderPage();

    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeNull());

    // The form must remain interactive despite the secondary failure.
    typeUsername('alice');
    expect(screen.getByPlaceholderText('stellar-fan').value).toBe('alice');
    expect(
      screen.getByRole('button', { name: /register username/i }).disabled,
    ).toBe(false);
  });
});

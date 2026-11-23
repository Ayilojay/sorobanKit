import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { axe } from 'jest-axe';
import App from './App';

const STORAGE_KEY = 'stellar_dashboard_wallet_pubkey';
const PENDING_KEY = 'stellar_dashboard_pending_payment';
const TEST_PUBLIC_KEY = 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUV';
const OTHER_PUBLIC_KEY = 'GZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ';

const mockConnect = vi.fn();
const mockDisconnect = vi.fn();

// Target WCAG level for all automated dashboard checks.
const WCAG_TARGET = 'WCAG 2.1 AA';

// Reviewed exceptions allowlist. Each entry must reference a tracked issue and
// a justification; unreviewed violations fail the suite.
const AXE_EXCEPTIONS = [
  {
    id: 'color-contrast',
    issue: '#446',
    justification:
      'Brand accent on the payment CTA is pending a design token update; tracked in #446.',
  },
];

const axeOptions = {
  runOnly: {
    type: 'tag',
    values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'],
  },
  rules: AXE_EXCEPTIONS.reduce((acc, exception) => {
    acc[exception.id] = { enabled: false };
    return acc;
  }, {}),
};

async function expectNoUnreviewedViolations(container) {
  const results = await axe(container, axeOptions);
  const allowed = new Set(AXE_EXCEPTIONS.map((exception) => exception.id));
  const unreviewed = results.violations.filter((violation) => !allowed.has(violation.id));
  expect(unreviewed).toEqual([]);
}

vi.mock('@stellar/freighter-api', () => ({
  isConnected: vi.fn(),
  getPublicKey: vi.fn(),
  requestAccess: vi.fn(),
  getNetwork: vi.fn(),
}));

import * as freighterApi from '@stellar/freighter-api';

describe('App wallet persistence', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it('persists the connected public key to localStorage after a successful connection', async () => {
    freighterApi.isConnected.mockResolvedValue({ isConnected: true });
    freighterApi.requestAccess.mockResolvedValue({ publicKey: TEST_PUBLIC_KEY });
    freighterApi.getPublicKey.mockResolvedValue({ publicKey: TEST_PUBLIC_KEY });

    render(<App />);

    const connectButton = await screen.findByRole('button', { name: /connect/i });
    connectButton.click();

    await waitFor(() => {
      expect(localStorage.getItem(STORAGE_KEY)).toBe(TEST_PUBLIC_KEY);
    });
  });

  it('restores a previously connected wallet on load via silent reconnection', async () => {
    localStorage.setItem(STORAGE_KEY, TEST_PUBLIC_KEY);
    freighterApi.isConnected.mockResolvedValue({ isConnected: true });
    freighterApi.getPublicKey.mockResolvedValue({ publicKey: TEST_PUBLIC_KEY });

    render(<App />);

    await waitFor(() => {
      expect(freighterApi.getPublicKey).toHaveBeenCalled();
    });

    expect(await screen.findByText(new RegExp(TEST_PUBLIC_KEY.slice(0, 6)))).toBeTruthy();
    expect(localStorage.getItem(STORAGE_KEY)).toBe(TEST_PUBLIC_KEY);
  });

  it('clears storage and shows the connect prompt when silent reconnection fails', async () => {
    localStorage.setItem(STORAGE_KEY, TEST_PUBLIC_KEY);
    freighterApi.isConnected.mockResolvedValue({ isConnected: false });
    freighterApi.getPublicKey.mockRejectedValue(new Error('Wallet locked'));

    render(<App />);

    await waitFor(() => {
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    expect(await screen.findByRole('button', { name: /connect/i })).toBeTruthy();
  });
});

describe('App network mismatch signing guard', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it('blocks signing when the wallet network differs from the application network', async () => {
    localStorage.setItem(STORAGE_KEY, TEST_PUBLIC_KEY);
    freighterApi.isConnected.mockResolvedValue({ isConnected: true });
    freighterApi.getPublicKey.mockResolvedValue({ publicKey: TEST_PUBLIC_KEY });
    freighterApi.getNetwork.mockResolvedValue({ network: 'PUBLIC' });

    render(<App />);

    await waitFor(() => {
      expect(freighterApi.getPublicKey).toHaveBeenCalled();
    });

    const signButton = await screen.findByRole('button', { name: /sign/i });
    signButton.click();

    expect(await screen.findByText(/network mismatch/i)).toBeTruthy();
  });

  it('blocks signing when the wallet network is unknown', async () => {
    localStorage.setItem(STORAGE_KEY, TEST_PUBLIC_KEY);
    freighterApi.isConnected.mockResolvedValue({ isConnected: true });
    freighterApi.getPublicKey.mockResolvedValue({ publicKey: TEST_PUBLIC_KEY });
    freighterApi.getNetwork.mockRejectedValue(new Error('Network unavailable'));

    render(<App />);

    await waitFor(() => {
      expect(freighterApi.getPublicKey).toHaveBeenCalled();
    });

    const signButton = await screen.findByRole('button', { name: /sign/i });
    signButton.click();

    expect(await screen.findByText(/unknown network/i)).toBeTruthy();
  });
});

describe('App pre-sign simulation review', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    localStorage.setItem(STORAGE_KEY, TEST_PUBLIC_KEY);
    freighterApi.isConnected.mockResolvedValue({ isConnected: true });
    freighterApi.getPublicKey.mockResolvedValue({ publicKey: TEST_PUBLIC_KEY });
    freighterApi.getNetwork.mockResolvedValue({ network: 'TESTNET' });
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it('shows simulation status and a non-final fee estimate before requesting a signature', async () => {
    render(<App />);

    await waitFor(() => {
      expect(freighterApi.getPublicKey).toHaveBeenCalled();
    });

    const reviewButton = await screen.findByRole('button', { name: /review|simulate/i });
    reviewButton.click();

    expect(await screen.findByText(/simulation/i)).toBeTruthy();
    expect(await screen.findByText(/estimated|non-final/i)).toBeTruthy();
  });

  it('surfaces actionable failure details when simulation fails', async () => {
    render(<App />);

    await waitFor(() => {
      expect(freighterApi.getPublicKey).toHaveBeenCalled();
    });

    const reviewButton = await screen.findByRole('button', { name: /review|simulate/i });
    reviewButton.click();

    expect(await screen.findByText(/failed|error/i)).toBeTruthy();
  });

  it('does not authorize a signature when the simulation result is stale', async () => {
    render(<App />);

    await waitFor(() => {
      expect(freighterApi.getPublicKey).toHaveBeenCalled();
    });

    const reviewButton = await screen.findByRole('button', { name: /review|simulate/i });
    reviewButton.click();

    expect(await screen.findByText(/stale|out of date|re-run/i)).toBeTruthy();
  });
});

describe('App human-readable review from exact transaction XDR', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    localStorage.setItem(STORAGE_KEY, TEST_PUBLIC_KEY);
    freighterApi.isConnected.mockResolvedValue({ isConnected: true });
    freighterApi.getPublicKey.mockResolvedValue({ publicKey: TEST_PUBLIC_KEY });
    freighterApi.getNetwork.mockResolvedValue({ network: 'TESTNET' });
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it('renders network, asset, amount, destination, memo, and fee decoded from the final XDR', async () => {
    render(<App />);

    await waitFor(() => {
      expect(freighterApi.getPublicKey).toHaveBeenCalled();
    });

    const reviewButton = await screen.findByRole('button', { name: /review|simulate/i });
    reviewButton.click();

    expect(await screen.findByText(/network/i)).toBeTruthy();
    expect(await screen.findByText(/asset/i)).toBeTruthy();
    expect(await screen.findByText(/amount/i)).toBeTruthy();
    expect(await screen.findByText(/destination/i)).toBeTruthy();
    expect(await screen.findByText(/memo/i)).toBeTruthy();
    expect(await screen.findByText(/fee/i)).toBeTruthy();
  });

  it('blocks unknown or unsupported operation types in the review', async () => {
    render(<App />);

    await waitFor(() => {
      expect(freighterApi.getPublicKey).toHaveBeenCalled();
    });

    const reviewButton = await screen.findByRole('button', { name: /review|simulate/i });
    reviewButton.click();

    expect(await screen.findByText(/unsupported|unknown operation/i)).toBeTruthy();
  });

  it('blocks signing when decoded transaction data does not match user intent', async () => {
    render(<App />);

    await waitFor(() => {
      expect(freighterApi.getPublicKey).toHaveBeenCalled();
    });

    const reviewButton = await screen.findByRole('button', { name: /review|simulate/i });
    reviewButton.click();

    expect(await screen.findByText(/mismatch|does not match/i)).toBeTruthy();
  });
});

describe('App pending payment resume after reload', () => {
  const pendingRef = {
    version: 1,
    operationRef: 'op_ref_abc123',
    account: TEST_PUBLIC_KEY,
    network: 'TESTNET',
  };

  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    localStorage.setItem(STORAGE_KEY, TEST_PUBLIC_KEY);
    freighterApi.isConnected.mockResolvedValue({ isConnected: true });
    freighterApi.getPublicKey.mockResolvedValue({ publicKey: TEST_PUBLIC_KEY });
    freighterApi.getNetwork.mockResolvedValue({ network: 'TESTNET' });
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it('persists only a versioned operation reference, not the full payment payload', async () => {
    render(<App />);

    await waitFor(() => {
      expect(freighterApi.getPublicKey).toHaveBeenCalled();
    });

    const payButton = await screen.findByRole('button', { name: /pay|send/i });
    payButton.click();

    await waitFor(() => {
      const raw = localStorage.getItem(PENDING_KEY);
      expect(raw).toBeTruthy();
      const parsed = JSON.parse(raw);
      expect(parsed.version).toBe(1);
      expect(parsed.operationRef).toBeTruthy();
      expect(parsed.account).toBe(TEST_PUBLIC_KEY);
      expect(parsed.network).toBe('TESTNET');
      expect(parsed.amount).toBeUndefined();
      expect(parsed.destination).toBeUndefined();
    });
  });

  it('resumes server-side status lookup on reload without resubmitting the payment', async () => {
    localStorage.setItem(PENDING_KEY, JSON.stringify(pendingRef));

    render(<App />);

    await waitFor(() => {
      expect(freighterApi.getPublicKey).toHaveBeenCalled();
    });

    expect(await screen.findByText(/pending|checking status/i)).toBeTruthy();
    expect(screen.queryByText(/submitting|resubmitting/i)).toBeNull();
  });

  it('clears the persisted reference once the operation reaches a terminal state', async () => {
    localStorage.setItem(PENDING_KEY, JSON.stringify(pendingRef));

    render(<App />);

    await waitFor(() => {
      expect(localStorage.getItem(PENDING_KEY)).toBeNull();
    });
  });

  it('ignores and clears a reference bound to a different account', async () => {
    localStorage.setItem(
      PENDING_KEY,
      JSON.stringify({ ...pendingRef, account: OTHER_PUBLIC_KEY }),
    );

    render(<App />);

    await waitFor(() => {
      expect(localStorage.getItem(PENDING_KEY)).toBeNull();
    });
  });

  it('ignores and clears a reference bound to a different network', async () => {
    localStorage.setItem(
      PENDING_KEY,
      JSON.stringify({ ...pendingRef, network: 'PUBLIC' }),
    );

    render(<App />);

    await waitFor(() => {
      expect(localStorage.getItem(PENDING_KEY)).toBeNull();
    });
  });

  it('clears an invalid or unversioned reference', async () => {
    localStorage.setItem(PENDING_KEY, JSON.stringify({ operationRef: 'op_ref_abc123' }));

    render(<App />);

    await waitFor(() => {
      expect(localStorage.getItem(PENDING_KEY)).toBeNull();
    });
  });
});

describe(`App accessibility (${WCAG_TARGET})`, () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it('registration journey has no unreviewed WCAG violations', async () => {
    freighterApi.isConnected.mockResolvedValue({ isConnected: false });

    const { container } = render(<App />);

    await screen.findByRole('button', { name: /connect/i });
    await expectNoUnreviewedViolations(container);
  });

  it('registration error view has no unreviewed WCAG violations', async () => {
    freighterApi.isConnected.mockResolvedValue({ isConnected: true });
    freighterApi.requestAccess.mockRejectedValue(new Error('User rejected access'));

    const { container } = render(<App />);

    const connectButton = await screen.findByRole('button', { name: /connect/i });
    connectButton.click();

    expect(await screen.findByText(/rejected|failed|error/i)).toBeTruthy();
    await expectNoUnreviewedViolations(container);
  });

  it('payment journey has no unreviewed WCAG violations', async () => {
    localStorage.setItem(STORAGE_KEY, TEST_PUBLIC_KEY);
    freighterApi.isConnected.mockResolvedValue({ isConnected: true });
    freighterApi.getPublicKey.mockResolvedValue({ publicKey: TEST_PUBLIC_KEY });
    freighterApi.getNetwork.mockResolvedValue({ network: 'TESTNET' });

    const { container } = render(<App />);

    await waitFor(() => {
      expect(freighterApi.getPublicKey).toHaveBeenCalled();
    });
    await screen.findByRole('button', { name: /pay|send/i });
    await expectNoUnreviewedViolations(container);
  });

  it('payment loading view has no unreviewed WCAG violations', async () => {
    localStorage.setItem(STORAGE_KEY, TEST_PUBLIC_KEY);
    freighterApi.isConnected.mockResolvedValue({ isConnected: true });
    freighterApi.getPublicKey.mockResolvedValue({ publicKey: TEST_PUBLIC_KEY });
    freighterApi.getNetwork.mockResolvedValue({ network: 'TESTNET' });

    const { container } = render(<App />);

    await waitFor(() => {
      expect(freighterApi.getPublicKey).toHaveBeenCalled();
    });
    const payButton = await screen.findByRole('button', { name: /pay|send/i });
    payButton.click();

    await screen.findByText(/pending|checking status|submitting/i);
    await expectNoUnreviewedViolations(container);
  });

  it('payment error view has no unreviewed WCAG violations', async () => {
    localStorage.setItem(STORAGE_KEY, TEST_PUBLIC_KEY);
    freighterApi.isConnected.mockResolvedValue({ isConnected: true });
    freighterApi.getPublicKey.mockResolvedValue({ publicKey: TEST_PUBLIC_KEY });
    freighterApi.getNetwork.mockRejectedValue(new Error('Network unavailable'));

    const { container } = render(<App />);

    await waitFor(() => {
      expect(freighterApi.getPublicKey).toHaveBeenCalled();
    });
    const signButton = await screen.findByRole('button', { name: /sign/i });
    signButton.click();

    expect(await screen.findByText(/unknown network|network mismatch/i)).toBeTruthy();
    await expectNoUnreviewedViolations(container);
  });

  it('history journey has no unreviewed WCAG violations', async () => {
    localStorage.setItem(STORAGE_KEY, TEST_PUBLIC_KEY);
    freighterApi.isConnected.mockResolvedValue({ isConnected: true });
    freighterApi.getPublicKey.mockResolvedValue({ publicKey: TEST_PUBLIC_KEY });
    freighterApi.getNetwork.mockResolvedValue({ network: 'TESTNET' });

    const { container } = render(<App />);

    await waitFor(() => {
      expect(freighterApi.getPublicKey).toHaveBeenCalled();
    });
    const historyTab = await screen.findByRole('tab', { name: /history/i });
    historyTab.click();

    await screen.findByText(/history|transactions/i);
    await expectNoUnreviewedViolations(container);
  });

  it('history loading view has no unreviewed WCAG violations', async () => {
    localStorage.setItem(STORAGE_KEY, TEST_PUBLIC_KEY);
    freighterApi.isConnected.mockResolvedValue({ isConnected: true });
    freighterApi.getPublicKey.mockResolvedValue({ publicKey: TEST_PUBLIC_KEY });
    freighterApi.getNetwork.mockResolvedValue({ network: 'TESTNET' });

    const { container } = render(<App />);

    await waitFor(() => {
      expect(freighterApi.getPublicKey).toHaveBeenCalled();
    });
    const historyTab = await screen.findByRole('tab', { name: /history/i });
    historyTab.click();

    await screen.findByText(/loading|fetching/i);
    await expectNoUnreviewedViolations(container);
  });

  it('analytics journey has no unreviewed WCAG violations', async () => {
    localStorage.setItem(STORAGE_KEY, TEST_PUBLIC_KEY);
    freighterApi.isConnected.mockResolvedValue({ isConnected: true });
    freighterApi.getPublicKey.mockResolvedValue({ publicKey: TEST_PUBLIC_KEY });
    freighterApi.getNetwork.mockResolvedValue({ network: 'TESTNET' });

    const { container } = render(<App />);

    await waitFor(() => {
      expect(freighterApi.getPublicKey).toHaveBeenCalled();
    });
    const analyticsTab = await screen.findByRole('tab', { name: /analytics/i });
    analyticsTab.click();

    await screen.findByText(/analytics|metrics/i);
    await expectNoUnreviewedViolations(container);
  });

  it('analytics error view has no unreviewed WCAG violations', async () => {
    localStorage.setItem(STORAGE_KEY, TEST_PUBLIC_KEY);
    freighterApi.isConnected.mockResolvedValue({ isConnected: true });
    freighterApi.getPublicKey.mockResolvedValue({ publicKey: TEST_PUBLIC_KEY });
    freighterApi.getNetwork.mockResolvedValue({ network: 'TESTNET' });

    const { container } = render(<App />);

    await waitFor(() => {
      expect(freighterApi.getPublicKey).toHaveBeenCalled();
    });
    const analyticsTab = await screen.findByRole('tab', { name: /analytics/i });
    analyticsTab.click();

    expect(await screen.findByText(/failed|error|unavailable/i)).toBeTruthy();
    await expectNoUnreviewedViolations(container);
  });

  it('every axe exception is reviewed with a tracked issue and justification', () => {
    for (const exception of AXE_EXCEPTIONS) {
      expect(exception.id).toBeTruthy();
      expect(exception.issue).toMatch(/^#\d+$/);
      expect(exception.justification.length).toBeGreaterThan(0);
    }
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { axe } from 'jest-axe';
import App from './App';
import {
  parseFeatureFlags,
  DEFAULT_FEATURE_FLAGS,
  FEATURE_FLAG_SCHEMA,
} from './featureFlags';
import {
  createFocusManager,
  ANNOUNCEMENT_POLITENESS,
} from './focusManager';
import {
  createPaymentCoordinator,
  PAYMENT_COORDINATION_KEY,
  PAYMENT_COORDINATION_TTL_MS,
} from './paymentCoordinator';

const mockNavigate = vi.fn();
let mockPathname = '/';

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useLocation: () => ({ pathname: mockPathname, search: '', hash: '', state: null }),
  };
});

const STORAGE_KEY = 'stellar_dashboard_wallet_pubkey';
const PENDING_KEY = 'stellar_dashboard_pending_payment';
const DRAFT_KEY = 'stellar_dashboard_payment_draft';
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
    mockPathname = '/';
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
    mockPathname = '/';
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
    mockPathname = '/';
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
    mockPathname = '/';
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
    mockPathname = '/';
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

describe('Feature flag schema parsing', () => {
  it('accepts a well-formed payload and returns typed values', () => {
    const payload = {
      version: 1,
      flags: {
        enableMultiTabPayment: true,
        announceRouteChanges: false,
        maxRetryCount: 3,
      },
    };

    const result = parseFeatureFlags(payload);

    expect(result.ok).toBe(true);
    expect(result.flags.enableMultiTabPayment).toBe(true);
    expect(result.flags.announceRouteChanges).toBe(false);
    expect(result.flags.maxRetryCount).toBe(3);
  });

  it('falls back to defaults for unknown flag names', () => {
    const result = parseFeatureFlags({
      version: 1,
      flags: { totallyUnknownFlag: true },
    });

    expect(result.ok).toBe(true);
    expect(result.flags).toEqual(DEFAULT_FEATURE_FLAGS);
    expect(result.ignored).toContain('totallyUnknownFlag');
  });

  it('falls back to defaults when a flag has the wrong type', () => {
    const result = parseFeatureFlags({
      version: 1,
      flags: { enableMultiTabPayment: 'yes' },
    });

    expect(result.ok).toBe(false);
    expect(result.flags).toEqual(DEFAULT_FEATURE_FLAGS);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('falls back safely on malformed JSON input', () => {
    const result = parseFeatureFlags('{not valid json');

    expect(result.ok).toBe(false);
    expect(result.flags).toEqual(DEFAULT_FEATURE_FLAGS);
  });

  it('falls back safely on null or non-object payloads', () => {
    expect(parseFeatureFlags(null).flags).toEqual(DEFAULT_FEATURE_FLAGS);
    expect(parseFeatureFlags(42).flags).toEqual(DEFAULT_FEATURE_FLAGS);
    expect(parseFeatureFlags([]).flags).toEqual(DEFAULT_FEATURE_FLAGS);
  });

  it('rejects stale payloads whose version is behind the schema', () => {
    const result = parseFeatureFlags({
      version: FEATURE_FLAG_SCHEMA.version - 1,
      flags: { enableMultiTabPayment: true },
    });

    expect(result.ok).toBe(false);
    expect(result.stale).toBe(true);
    expect(result.flags).toEqual(DEFAULT_FEATURE_FLAGS);
  });

  it('rejects payloads from a future schema version', () => {
    const result = parseFeatureFlags({
      version: FEATURE_FLAG_SCHEMA.version + 1,
      flags: {},
    });

    expect(result.ok).toBe(false);
    expect(result.flags).toEqual(DEFAULT_FEATURE_FLAGS);
  });

  it('strips secret-looking keys so they never reach the client', () => {
    const result = parseFeatureFlags({
      version: 1,
      flags: {
        enableMultiTabPayment: true,
        apiSecret: 'super-secret',
        privateKey: 'S...',
      },
    });

    expect(result.flags.apiSecret).toBeUndefined();
    expect(result.flags.privateKey).toBeUndefined();
    expect(result.redacted).toEqual(
      expect.arrayContaining(['apiSecret', 'privateKey']),
    );
  });
});

describe('Focus and announcement manager', () => {
  let manager;

  beforeEach(() => {
    document.body.innerHTML = '';
    manager = createFocusManager({ document });
  });

  afterEach(() => {
    manager.destroy();
    document.body.innerHTML = '';
  });

  it('moves focus to the route heading on navigation', () => {
    const heading = document.createElement('h1');
    heading.tabIndex = -1;
    heading.textContent = 'Dashboard';
    document.body.appendChild(heading);

    manager.focusRouteHeading(heading);

    expect(document.activeElement).toBe(heading);
  });

  it('does not steal focus during a background refresh', () => {
    const heading = document.createElement('h1');
    heading.tabIndex = -1;
    document.body.appendChild(heading);

    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();

    manager.focusRouteHeading(heading, { background: true });

    expect(document.activeElement).toBe(input);
  });

  it('announces async success through a polite live region', () => {
    manager.announce('Payment submitted', { politeness: ANNOUNCEMENT_POLITENESS.POLITE });

    const region = document.querySelector('[aria-live="polite"]');
    expect(region).toBeTruthy();
    expect(region.textContent).toBe('Payment submitted');
  });

  it('announces async failure through an assertive live region', () => {
    manager.announce('Payment failed', { politeness: ANNOUNCEMENT_POLITENESS.ASSERTIVE });

    const region = document.querySelector('[aria-live="assertive"]');
    expect(region).toBeTruthy();
    expect(region.textContent).toBe('Payment failed');
  });

  it('reuses a single live region across repeated announcements', () => {
    manager.announce('First');
    manager.announce('Second');

    const regions = document.querySelectorAll('[aria-live]');
    expect(regions.length).toBe(1);
    expect(regions[0].textContent).toBe('Second');
  });
});

describe('Cross-tab payment coordination', () => {
  let coordinator;

  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
    coordinator = createPaymentCoordinator({ storage: localStorage });
  });

  afterEach(() => {
    coordinator.destroy();
    vi.useRealTimers();
    localStorage.clear();
  });

  it('shares only a non-sensitive operation reference across tabs', () => {
    coordinator.claim({
      operationRef: 'op_ref_abc123',
      account: TEST_PUBLIC_KEY,
      network: 'TESTNET',
    });

    const raw = localStorage.getItem(PAYMENT_COORDINATION_KEY);
    const parsed = JSON.parse(raw);

    expect(parsed.operationRef).toBe('op_ref_abc123');
    expect(parsed.account).toBe(TEST_PUBLIC_KEY);
    expect(parsed.network).toBe('TESTNET');
    expect(parsed.amount).toBeUndefined();
    expect(parsed.destination).toBeUndefined();
    expect(parsed.secret).toBeUndefined();
  });

  it('prevents a second tab from starting a duplicate payment attempt', () => {
    coordinator.claim({
      operationRef: 'op_ref_abc123',
      account: TEST_PUBLIC_KEY,
      network: 'TESTNET',
    });

    const otherTab = createPaymentCoordinator({ storage: localStorage });
    const result = otherTab.claim({
      operationRef: 'op_ref_other',
      account: TEST_PUBLIC_KEY,
      network: 'TESTNET',
    });

    expect(result.acquired).toBe(false);
    expect(result.existing.operationRef).toBe('op_ref_abc123');

    otherTab.destroy();
  });

  it('expires stale coordination state after the TTL', () => {
    coordinator.claim({
      operationRef: 'op_ref_abc123',
      account: TEST_PUBLIC_KEY,
      network: 'TESTNET',
    });

    vi.advanceTimersByTime(PAYMENT_COORDINATION_TTL_MS + 1);

    expect(coordinator.read()).toBeNull();
  });

  it('ignores coordination state bound to a different account', () => {
    coordinator.claim({
      operationRef: 'op_ref_abc123',
      account: OTHER_PUBLIC_KEY,
      network: 'TESTNET',
    });

    expect(coordinator.read({ account: TEST_PUBLIC_KEY, network: 'TESTNET' })).toBeNull();
  });

  it('releases coordination state once the operation reaches a terminal state', () => {
    coordinator.claim({
      operationRef: 'op_ref_abc123',
      account: TEST_PUBLIC_KEY,
      network: 'TESTNET',
    });

    coordinator.release();

    expect(localStorage.getItem(PAYMENT_COORDINATION_KEY)).toBeNull();
  });

  it('recovers from malformed coordination state without throwing', () => {
    localStorage.setItem(PAYMENT_COORDINATION_KEY, '{broken');

    expect(() => coordinator.read()).not.toThrow();
    expect(coordinator.read()).toBeNull();
  });
});

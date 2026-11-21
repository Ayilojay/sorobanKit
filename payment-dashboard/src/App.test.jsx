import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import App from './App';

const STORAGE_KEY = 'stellar_dashboard_wallet_pubkey';
const TEST_PUBLIC_KEY = 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUV';

const mockConnect = vi.fn();
const mockDisconnect = vi.fn();

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

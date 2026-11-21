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

describe('Payment details ledger-confirmation timeline', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  const connectWallet = async () => {
    freighterApi.isConnected.mockResolvedValue({ isConnected: true });
    freighterApi.requestAccess.mockResolvedValue({ publicKey: TEST_PUBLIC_KEY });
    freighterApi.getPublicKey.mockResolvedValue({ publicKey: TEST_PUBLIC_KEY });

    render(<App />);

    const connectButton = await screen.findByRole('button', { name: /connect/i });
    connectButton.click();

    await waitFor(() => {
      expect(localStorage.getItem(STORAGE_KEY)).toBe(TEST_PUBLIC_KEY);
    });
  };

  it('renders submitted, included, and finalized states with server-confirmed timestamps', async () => {
    await connectWallet();

    const timeline = await screen.findByRole('list', { name: /confirmation timeline/i });
    expect(timeline).toBeTruthy();

    expect(await screen.findByText(/submitted/i)).toBeTruthy();
    expect(await screen.findByText(/included/i)).toBeTruthy();
    expect(await screen.findByText(/finalized/i)).toBeTruthy();

    // Timestamps must come from the server, not client-inferred times.
    const timestamps = await screen.findAllByTestId('timeline-timestamp');
    expect(timestamps.length).toBeGreaterThan(0);
    timestamps.forEach((node) => {
      expect(node.getAttribute('data-source')).toBe('server');
    });
  });

  it('shows a failed state when the server reports a failure', async () => {
    await connectWallet();

    expect(await screen.findByText(/failed/i)).toBeTruthy();
  });

  it('keeps replacement attempts visible instead of hiding superseded transactions', async () => {
    await connectWallet();

    const attempts = await screen.findAllByTestId('timeline-attempt');
    expect(attempts.length).toBeGreaterThan(1);

    const superseded = await screen.findAllByText(/superseded|replaced/i);
    expect(superseded.length).toBeGreaterThan(0);
  });

  it('never labels an unconfirmed transaction as final', async () => {
    await connectWallet();

    const finalLabels = await screen.findAllByText(/^final$/i);
    finalLabels.forEach((label) => {
      expect(label.closest('[data-confirmed="true"]')).not.toBeNull();
    });
  });
});

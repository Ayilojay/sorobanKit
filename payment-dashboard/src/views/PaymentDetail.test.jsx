import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, useLocation, useNavigate } from 'react-router-dom';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockGetPayment = vi.fn();

vi.mock('../api/paymentsClient', () => ({
  __esModule: true,
  default: {
    getPayment: (...args) => mockGetPayment(...args),
  },
  getPayment: (...args) => mockGetPayment(...args),
}));

// Auth context mock – tests override the current user per test.
const mockAuthState = { currentUser: null, isAuthenticated: false };

vi.mock('../auth/AuthContext', () => ({
  __esModule: true,
  useAuth: () => mockAuthState,
}));

// Imported after mocks are registered.
import PaymentDetail from './PaymentDetail';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PAYMENT_ID = 'pay_1234567890';

const authorizedUser = {
  id: 'user_1',
  email: 'owner@example.com',
  roles: ['merchant'],
};

const otherUser = {
  id: 'user_2',
  email: 'intruder@example.com',
  roles: ['merchant'],
};

function makePayment(overrides = {}) {
  return {
    id: PAYMENT_ID,
    status: 'authorized',
    amount: 4200,
    currency: 'USD',
    merchantId: 'user_1',
    createdAt: '2024-01-01T00:00:00.000Z',
    expiresAt: '2099-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function setAuth(user) {
  mockAuthState.currentUser = user;
  mockAuthState.isAuthenticated = Boolean(user);
}

// Captures the current location so tests can assert on the URL (query/hash)
// and verify that no credentials leak into it.
let lastLocation = null;
function LocationProbe() {
  lastLocation = useLocation();
  return null;
}

function renderRoute(initialEntry = `/payments/${PAYMENT_ID}`) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <LocationProbe />
      <Routes>
        <Route path="/payments/:paymentId" element={<PaymentDetail />} />
        <Route path="/login" element={<div>Login Page</div>} />
        <Route path="/payments" element={<div>Payments List</div>} />
        <Route path="/forbidden" element={<div>Forbidden Page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

// A component that lets a test simulate a browser refresh by re-navigating
// to the same deep link (MemoryRouter has no real reload).
function RefreshTrigger({ to }) {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate(to, { replace: false })}>
      refresh
    </button>
  );
}

function renderWithRefresh(initialEntry = `/payments/${PAYMENT_ID}`) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <LocationProbe />
      <RefreshTrigger to={initialEntry} />
      <Routes>
        <Route path="/payments/:paymentId" element={<PaymentDetail />} />
        <Route path="/login" element={<div>Login Page</div>} />
        <Route path="/payments" element={<div>Payments List</div>} />
        <Route path="/forbidden" element={<div>Forbidden Page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

function assertNoSecretsInUrl(location) {
  const url = `${location.pathname}${location.search}${location.hash}`;
  const forbidden = [
    /token=/i,
    /access_token/i,
    /bearer/i,
    /authorization/i,
    /signature=/i,
    /sig=/i,
    /secret/i,
    /api[_-]?key/i,
    /password/i,
    /credential/i,
  ];
  for (const pattern of forbidden) {
    expect(url).not.toMatch(pattern);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PaymentDetail deep-link route', () => {
  beforeEach(() => {
    mockGetPayment.mockReset();
    setAuth(null);
    lastLocation = null;
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  describe('authorized access', () => {
    it('renders payment details for the owning user via a deep link', async () => {
      setAuth(authorizedUser);
      mockGetPayment.mockResolvedValueOnce(makePayment());

      renderRoute();

      expect(await screen.findByText(/authorized/i)).toBeInTheDocument();
      expect(mockGetPayment).toHaveBeenCalledTimes(1);
      expect(mockGetPayment).toHaveBeenCalledWith(PAYMENT_ID);
    });

    it('keeps the deep-link URL free of tokens and signing material', async () => {
      setAuth(authorizedUser);
      mockGetPayment.mockResolvedValueOnce(makePayment());

      renderRoute();

      await screen.findByText(/authorized/i);
      expect(lastLocation).not.toBeNull();
      expect(lastLocation.pathname).toBe(`/payments/${PAYMENT_ID}`);
      assertNoSecretsInUrl(lastLocation);
    });

    it('does not append credentials to the URL after fetching', async () => {
      setAuth(authorizedUser);
      mockGetPayment.mockResolvedValueOnce(makePayment());

      renderRoute(`/payments/${PAYMENT_ID}?ref=email`);

      await screen.findByText(/authorized/i);
      // Pre-existing benign query param is preserved, no secrets added.
      expect(lastLocation.search).toBe('?ref=email');
      assertNoSecretsInUrl(lastLocation);
    });
  });

  describe('unauthorized access', () => {
    it('redirects unauthenticated visitors to login without leaking the payment id as a token', async () => {
      setAuth(null);

      renderRoute();

      expect(await screen.findByText('Login Page')).toBeInTheDocument();
      expect(mockGetPayment).not.toHaveBeenCalled();
      assertNoSecretsInUrl(lastLocation);
    });

    it('shows a forbidden state when the user does not own the payment', async () => {
      setAuth(otherUser);
      mockGetPayment.mockRejectedValueOnce(
        Object.assign(new Error('Forbidden'), { status: 403 }),
      );

      renderRoute();

      expect(await screen.findByText(/forbidden/i)).toBeInTheDocument();
      assertNoSecretsInUrl(lastLocation);
    });

    it('does not render payment details for an unauthorized user', async () => {
      setAuth(otherUser);
      mockGetPayment.mockRejectedValueOnce(
        Object.assign(new Error('Forbidden'), { status: 403 }),
      );

      renderRoute();

      await screen.findByText(/forbidden/i);
      expect(screen.queryByText(/authorized/i)).not.toBeInTheDocument();
    });
  });

  describe('not-found', () => {
    it('renders a not-found message for an unknown payment id', async () => {
      setAuth(authorizedUser);
      mockGetPayment.mockRejectedValueOnce(
        Object.assign(new Error('Not Found'), { status: 404 }),
      );

      renderRoute('/payments/does-not-exist');

      expect(await screen.findByText(/not found/i)).toBeInTheDocument();
      expect(mockGetPayment).toHaveBeenCalledWith('does-not-exist');
    });

    it('does not leak secrets in the URL on not-found', async () => {
      setAuth(authorizedUser);
      mockGetPayment.mockRejectedValueOnce(
        Object.assign(new Error('Not Found'), { status: 404 }),
      );

      renderRoute('/payments/does-not-exist');

      await screen.findByText(/not found/i);
      assertNoSecretsInUrl(lastLocation);
    });
  });

  describe('expiry', () => {
    it('renders an expired state for an expired payment', async () => {
      setAuth(authorizedUser);
      mockGetPayment.mockResolvedValueOnce(
        makePayment({
          status: 'expired',
          expiresAt: '2020-01-01T00:00:00.000Z',
        }),
      );

      renderRoute();

      expect(await screen.findByText(/expired/i)).toBeInTheDocument();
    });

    it('treats a payment past its expiresAt as expired even if status is stale', async () => {
      setAuth(authorizedUser);
      mockGetPayment.mockResolvedValueOnce(
        makePayment({
          status: 'authorized',
          expiresAt: '2020-01-01T00:00:00.000Z',
        }),
      );

      renderRoute();

      expect(await screen.findByText(/expired/i)).toBeInTheDocument();
    });

    it('does not leak secrets in the URL on expiry', async () => {
      setAuth(authorizedUser);
      mockGetPayment.mockResolvedValueOnce(
        makePayment({ status: 'expired', expiresAt: '2020-01-01T00:00:00.000Z' }),
      );

      renderRoute();

      await screen.findByText(/expired/i);
      assertNoSecretsInUrl(lastLocation);
    });
  });

  describe('refresh and history navigation', () => {
    it('re-fetches and renders correctly after a refresh of the deep link', async () => {
      setAuth(authorizedUser);
      mockGetPayment
        .mockResolvedValueOnce(makePayment())
        .mockResolvedValueOnce(makePayment());

      const user = userEvent.setup();
      renderWithRefresh();

      await screen.findByText(/authorized/i);
      expect(mockGetPayment).toHaveBeenCalledTimes(1);

      await user.click(screen.getByRole('button', { name: /refresh/i }));

      await waitFor(() => {
        expect(mockGetPayment).toHaveBeenCalledTimes(2);
      });
      expect(await screen.findByText(/authorized/i)).toBeInTheDocument();
      expect(lastLocation.pathname).toBe(`/payments/${PAYMENT_ID}`);
      assertNoSecretsInUrl(lastLocation);
    });

    it('preserves the deep-link URL across refresh (no credential params added)', async () => {
      setAuth(authorizedUser);
      mockGetPayment.mockResolvedValue(makePayment());

      const user = userEvent.setup();
      renderWithRefresh(`/payments/${PAYMENT_ID}`);

      await screen.findByText(/authorized/i);
      await user.click(screen.getByRole('button', { name: /refresh/i }));

      await waitFor(() => {
        expect(mockGetPayment).toHaveBeenCalledTimes(2);
      });
      expect(lastLocation.pathname).toBe(`/payments/${PAYMENT_ID}`);
      expect(lastLocation.search).toBe('');
      assertNoSecretsInUrl(lastLocation);
    });

    it('recovers from a transient error on refresh', async () => {
      setAuth(authorizedUser);
      mockGetPayment
        .mockRejectedValueOnce(
          Object.assign(new Error('Server Error'), { status: 500 }),
        )
        .mockResolvedValueOnce(makePayment());

      const user = userEvent.setup();
      renderWithRefresh();

      expect(await screen.findByText(/error|unable/i)).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /refresh/i }));

      expect(await screen.findByText(/authorized/i)).toBeInTheDocument();
      expect(mockGetPayment).toHaveBeenCalledTimes(2);
    });
  });

  describe('URL safety invariants', () => {
    it('never places bearer credentials or signing material in the URL', async () => {
      setAuth(authorizedUser);
      mockGetPayment.mockResolvedValueOnce(makePayment());

      renderRoute(`/payments/${PAYMENT_ID}`);

      await screen.findByText(/authorized/i);
      const url = `${lastLocation.pathname}${lastLocation.search}${lastLocation.hash}`;
      expect(url).toBe(`/payments/${PAYMENT_ID}`);
      assertNoSecretsInUrl(lastLocation);
    });
  });
});
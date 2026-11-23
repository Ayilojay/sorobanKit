import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PartialDataNotice,
  RetryButton,
} from '../components/states';
import { fetchPaymentDetail } from '../api/paymentsClient';

const PAYMENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function isValidPaymentId(id) {
  return typeof id === 'string' && PAYMENT_ID_PATTERN.test(id);
}

function formatAmount(amount, currency) {
  if (amount === null || amount === undefined || Number.isNaN(Number(amount))) {
    return '—';
  }
  try {
    return new Intl.NumberFormat(undefined, {
      style: currency ? 'currency' : 'decimal',
      currency: currency || undefined,
    }).format(Number(amount));
  } catch (err) {
    return String(amount);
  }
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString();
}

function isExpired(payment) {
  if (!payment) return false;
  if (payment.status === 'expired') return true;
  if (!payment.expiresAt) return false;
  const expiresAt = new Date(payment.expiresAt);
  if (Number.isNaN(expiresAt.getTime())) return false;
  return expiresAt.getTime() <= Date.now();
}

export default function PaymentDetail() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [state, setState] = useState({
    status: 'loading',
    payment: null,
    error: null,
    partial: false,
    partialReason: null,
  });

  const requestRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    if (!isValidPaymentId(id)) {
      setState({
        status: 'not-found',
        payment: null,
        error: null,
        partial: false,
        partialReason: null,
      });
      return;
    }

    const requestId = requestRef.current + 1;
    requestRef.current = requestId;

    setState((prev) => ({
      status: 'loading',
      payment: prev.payment,
      error: null,
      partial: false,
      partialReason: null,
    }));

    try {
      const result = await fetchPaymentDetail(id);

      if (!mountedRef.current || requestRef.current !== requestId) {
        return;
      }

      if (!result || result.notFound) {
        setState({
          status: 'not-found',
          payment: null,
          error: null,
          partial: false,
          partialReason: null,
        });
        return;
      }

      if (result.unauthorized) {
        setState({
          status: 'unauthorized',
          payment: null,
          error: null,
          partial: false,
          partialReason: null,
        });
        return;
      }

      const payment = result.payment || result;

      if (isExpired(payment)) {
        setState({
          status: 'expired',
          payment,
          error: null,
          partial: false,
          partialReason: null,
        });
        return;
      }

      setState({
        status: 'success',
        payment,
        error: null,
        partial: Boolean(result.partial),
        partialReason: result.partialReason || null,
      });
    } catch (err) {
      if (!mountedRef.current || requestRef.current !== requestId) {
        return;
      }

      const statusCode = err && (err.status || err.statusCode);
      if (statusCode === 404) {
        setState({
          status: 'not-found',
          payment: null,
          error: null,
          partial: false,
          partialReason: null,
        });
        return;
      }
      if (statusCode === 401 || statusCode === 403) {
        setState({
          status: 'unauthorized',
          payment: null,
          error: null,
          partial: false,
          partialReason: null,
        });
        return;
      }
      if (statusCode === 410) {
        setState({
          status: 'expired',
          payment: null,
          error: null,
          partial: false,
          partialReason: null,
        });
        return;
      }

      setState({
        status: 'error',
        payment: null,
        error: err,
        partial: false,
        partialReason: null,
      });
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const handleRetry = useCallback(() => {
    load();
  }, [load]);

  const handleBack = useCallback(() => {
    if (window.history && window.history.length > 1) {
      navigate(-1);
    } else {
      navigate('/payments');
    }
  }, [navigate]);

  const header = useMemo(
    () => (
      <div className="payment-detail__header">
        <button type="button" className="payment-detail__back" onClick={handleBack}>
          ← Back
        </button>
        <h1 className="payment-detail__title">Payment details</h1>
      </div>
    ),
    [handleBack],
  );

  if (state.status === 'loading') {
    return (
      <section className="payment-detail" aria-busy="true">
        {header}
        <LoadingState label="Loading payment details…" />
      </section>
    );
  }

  if (state.status === 'not-found') {
    return (
      <section className="payment-detail">
        {header}
        <EmptyState
          title="Payment not found"
          description="This payment may have been removed or the link is incorrect."
          action={
            <Link to="/payments" className="payment-detail__link">
              View all payments
            </Link>
          }
        />
      </section>
    );
  }

  if (state.status === 'unauthorized') {
    return (
      <section className="payment-detail">
        {header}
        <ErrorState
          title="You don't have access to this payment"
          description="Sign in with an account that has permission to view this payment."
          action={
            <Link to="/payments" className="payment-detail__link">
              Back to payments
            </Link>
          }
        />
      </section>
    );
  }

  if (state.status === 'expired') {
    return (
      <section className="payment-detail">
        {header}
        <EmptyState
          title="This payment has expired"
          description="The payment link is no longer valid. Contact the sender for a new link."
          action={
            <Link to="/payments" className="payment-detail__link">
              View all payments
            </Link>
          }
        />
      </section>
    );
  }

  if (state.status === 'error') {
    return (
      <section className="payment-detail">
        {header}
        <ErrorState
          title="We couldn't load this payment"
          description="Something went wrong while fetching the payment details. Please try again."
          action={<RetryButton onRetry={handleRetry} />}
        />
      </section>
    );
  }

  const { payment } = state;

  return (
    <section className="payment-detail">
      {header}
      {state.partial ? (
        <PartialDataNotice
          message={
            state.partialReason ||
            'Some details could not be loaded. Showing the information we have.'
          }
          action={<RetryButton onRetry={handleRetry} label="Refresh" />}
        />
      ) : null}
      <dl className="payment-detail__fields">
        <div className="payment-detail__field">
          <dt>Payment ID</dt>
          <dd>{payment.id || id}</dd>
        </div>
        <div className="payment-detail__field">
          <dt>Status</dt>
          <dd>{payment.status || '—'}</dd>
        </div>
        <div className="payment-detail__field">
          <dt>Amount</dt>
          <dd>{formatAmount(payment.amount, payment.currency)}</dd>
        </div>
        <div className="payment-detail__field">
          <dt>Recipient</dt>
          <dd>{payment.recipient || payment.recipientName || '—'}</dd>
        </div>
        <div className="payment-detail__field">
          <dt>Created</dt>
          <dd>{formatDate(payment.createdAt)}</dd>
        </div>
        <div className="payment-detail__field">
          <dt>Expires</dt>
          <dd>{formatDate(payment.expiresAt)}</dd>
        </div>
      </dl>
    </section>
  );
}
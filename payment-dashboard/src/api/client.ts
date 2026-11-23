import createClient from 'openapi-fetch';
import type { paths } from './generated/openapi';
import { API_BASE } from './baseUrl';

const transport: typeof fetch = (input, init) => globalThis.fetch(input, init);
const createTransport = (baseUrl: string) =>
  createClient<paths>({ baseUrl, fetch: transport });

export const apiClient = createTransport(API_BASE);

const clientForBase = (baseUrl: string) =>
  baseUrl === API_BASE ? apiClient : createTransport(baseUrl);

export const getHealth = (signal?: AbortSignal, baseUrl = API_BASE) =>
  clientForBase(baseUrl).GET('/health', { signal });

export const getFederation = (q: string, type: 'id' | 'name' = 'name') =>
  apiClient.GET('/federation', { params: { query: { q, type } } });

export const getLookup = (address: string) =>
  apiClient.GET('/lookup', { params: { query: { address } } });

/**
 * Authorization credential used to access a payment detail.
 *
 * This value is intentionally kept out of URLs (no bearer tokens or signing
 * material in shareable deep links). It is supplied via the `Authorization`
 * header only, and callers are responsible for obtaining it out-of-band
 * (e.g. from session storage) rather than from the route.
 */
export type PaymentAuth = {
  /** Bearer token or equivalent credential. Sent as `Authorization: Bearer <token>`. */
  token: string;
};

/**
 * Discriminated error kinds surfaced by {@link getPayment} so the detail view
 * can render distinct states without inspecting raw HTTP responses.
 */
export type PaymentErrorKind =
  | 'unauthorized' // 401
  | 'forbidden' // 403
  | 'not-found' // 404
  | 'expired' // 410
  | 'network' // transport failure / abort
  | 'unknown'; // any other non-2xx

export type PaymentError = {
  kind: PaymentErrorKind;
  status?: number;
  message: string;
};

export type PaymentResult =
  | { ok: true; data: paths['/payments/{id}']['get']['responses'][200]['content']['application/json'] }
  | { ok: false; error: PaymentError };

const classifyStatus = (status: number): PaymentErrorKind => {
  switch (status) {
    case 401:
      return 'unauthorized';
    case 403:
      return 'forbidden';
    case 404:
      return 'not-found';
    case 410:
      return 'expired';
    default:
      return 'unknown';
  }
};

const defaultMessage = (kind: PaymentErrorKind): string => {
  switch (kind) {
    case 'unauthorized':
      return 'Authentication required to view this payment.';
    case 'forbidden':
      return 'You are not authorized to view this payment.';
    case 'not-found':
      return 'Payment not found.';
    case 'expired':
      return 'This payment link has expired.';
    case 'network':
      return 'Unable to reach the payment service.';
    default:
      return 'Unable to load payment details.';
  }
};

const isAbortError = (err: unknown): boolean =>
  typeof err === 'object' &&
  err !== null &&
  (err as { name?: string }).name === 'AbortError';

/**
 * Fetch a single payment's details by id.
 *
 * Authorization is passed via the `Authorization` header only; the payment id
 * is the sole value that belongs in a shareable URL. Errors are normalized into
 * a {@link PaymentResult} so the view can distinguish 401/403, 404, and
 * 410/expired responses (plus network/abort and unknown failures).
 */
export const getPayment = async (
  id: string,
  auth?: PaymentAuth,
  signal?: AbortSignal,
  baseUrl = API_BASE,
): Promise<PaymentResult> => {
  const headers: Record<string, string> = {};
  if (auth?.token) {
    headers.Authorization = `Bearer ${auth.token}`;
  }

  try {
    const { data, error, response } = await clientForBase(baseUrl).GET(
      '/payments/{id}',
      {
        params: { path: { id } },
        headers,
        signal,
      },
    );

    if (response.ok && data !== undefined) {
      return { ok: true, data };
    }

    const status = response.status;
    const kind = classifyStatus(status);
    const message =
      (error as { message?: string } | undefined)?.message ??
      defaultMessage(kind);

    return { ok: false, error: { kind, status, message } };
  } catch (err) {
    if (isAbortError(err)) {
      // Re-throw aborts so callers can ignore them as they do elsewhere.
      throw err;
    }
    return {
      ok: false,
      error: {
        kind: 'network',
        message: defaultMessage('network'),
      },
    };
  }
};
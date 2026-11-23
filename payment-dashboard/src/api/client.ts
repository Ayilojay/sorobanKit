import createClient from 'openapi-fetch';
import type { paths } from './generated/openapi';
import { API_BASE } from './baseUrl';
import {
  normalizeApiError,
  type NormalizedApiError,
} from './errorCatalog';

/**
 * Error thrown when a mutation is attempted while the dashboard is offline.
 *
 * The dashboard is strictly read-only while connectivity is lost: mutations are
 * never queued, retried, or persisted. Callers should surface this error to the
 * user and disable the corresponding action until connectivity returns.
 */
export class OfflineMutationError extends Error {
  readonly method: string;
  readonly url: string;

  constructor(method: string, url: string) {
    super(
      `Cannot perform ${method} ${url} while offline. The dashboard is read-only during connectivity loss; mutations are not queued.`,
    );
    this.name = 'OfflineMutationError';
    this.method = method;
    this.url = url;
  }
}

/**
 * Returns true when the browser reports that it is offline.
 *
 * Falls back to `false` in non-browser environments (e.g. tests without a
 * `navigator`, or SSR) so that requests are not blocked unexpectedly.
 */
export const isOffline = (): boolean => {
  if (typeof navigator === 'undefined') return false;
  if (typeof navigator.onLine !== 'boolean') return false;
  return navigator.onLine === false;
};

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const resolveMethod = (input: RequestInfo | URL, init?: RequestInit): string => {
  if (init?.method) return init.method.toUpperCase();
  if (typeof Request !== 'undefined' && input instanceof Request) {
    return input.method.toUpperCase();
  }
  return 'GET';
};

const resolveUrl = (input: RequestInfo | URL): string => {
  if (typeof input === 'string') return input;
  if (typeof URL !== 'undefined' && input instanceof URL) return input.toString();
  if (typeof Request !== 'undefined' && input instanceof Request) return input.url;
  return String(input);
};

const transport: typeof fetch = (input, init) => {
  const method = resolveMethod(input, init);
  if (MUTATION_METHODS.has(method) && isOffline()) {
    // Reject immediately; never queue or retry mutations while offline.
    return Promise.reject(new OfflineMutationError(method, resolveUrl(input)));
  }
  return globalThis.fetch(input, init);
};

const createTransport = (baseUrl: string) =>
  createClient<paths>({ baseUrl, fetch: transport });

export const apiClient = createTransport(API_BASE);

const clientForBase = (baseUrl: string) =>
  baseUrl === API_BASE ? apiClient : createTransport(baseUrl);

/**
 * Normalize an openapi-fetch result into a discriminated union so views can
 * render actionable, accessible recovery guidance without touching raw
 * server payloads.
 */
export type ApiResult<T> =
  | { ok: true; data: T; response: Response }
  | { ok: false; error: NormalizedApiError; response: Response };

const normalize = <T>(
  result: { data?: T; error?: unknown; response: Response },
): ApiResult<T> => {
  if (result.error !== undefined || !result.response.ok) {
    return {
      ok: false,
      error: normalizeApiError(result.error, result.response),
      response: result.response,
    };
  }
  return { ok: true, data: result.data as T, response: result.response };
};

export const getLookup = (address: string) =>
  apiClient.GET('/lookup', { params: { query: { address } } });

/**
 * Freshness metadata for cached, read-only data shown by the dashboard.
 *
 * Only eligible non-secret data is cached. Signing material and financial
 * operations are never persisted. Views use this accessor to render freshness
 * indicators (e.g. "last updated X ago" / "stale").
 */
export interface FreshnessMetadata {
  /** Whether the data was served from cache rather than a live response. */
  fromCache: boolean;
  /** Epoch milliseconds when the cached data was captured, if known. */
  cachedAt: number | null;
  /** Whether the dashboard is currently offline. */
  offline: boolean;
  /** Age of the cached data in milliseconds, if known. */
  ageMs: number | null;
}

const freshnessListeners = new Set<(meta: FreshnessMetadata) => void>();

let lastCachedAt: number | null = null;

const buildFreshness = (): FreshnessMetadata => {
  const offline = isOffline();
  const ageMs = lastCachedAt === null ? null : Date.now() - lastCachedAt;
  return {
    fromCache: offline,
    cachedAt: lastCachedAt,
    offline,
    ageMs,
  };
};

/**
 * Records that eligible non-secret data was captured for offline display.
 * Called by the caching layer when a successful read is stored.
 */
export const recordCacheWrite = (cachedAt: number = Date.now()): void => {
  lastCachedAt = cachedAt;
  const meta = buildFreshness();
  freshnessListeners.forEach((listener) => listener(meta));
};

/**
 * Returns the current freshness metadata used by views to render indicators.
 */
export const getFreshness = (): FreshnessMetadata => buildFreshness();

/**
 * Subscribes to freshness changes (cache writes and connectivity transitions).
 * Returns an unsubscribe function.
 */
export const subscribeFreshness = (
  listener: (meta: FreshnessMetadata) => void,
): (() => void) => {
  freshnessListeners.add(listener);
  return () => {
    freshnessListeners.delete(listener);
  };
};

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  const notify = () => {
    const meta = buildFreshness();
    freshnessListeners.forEach((listener) => listener(meta));
  };
  window.addEventListener('online', notify);
  window.addEventListener('offline', notify);
}

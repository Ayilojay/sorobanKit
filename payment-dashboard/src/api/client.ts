import createClient from 'openapi-fetch';
import type { paths } from './generated/openapi';
import { API_BASE } from './baseUrl';
import {
  normalizeApiError,
  type NormalizedApiError,
} from './errorCatalog';

const transport: typeof fetch = (input, init) => globalThis.fetch(input, init);
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

export const getHealth = async (
  signal?: AbortSignal,
  baseUrl = API_BASE,
): Promise<ApiResult<unknown>> =>
  normalize(await clientForBase(baseUrl).GET('/health', { signal }));

export const getFederation = async (
  q: string,
  type: 'id' | 'name' = 'name',
): Promise<ApiResult<unknown>> =>
  normalize(await apiClient.GET('/federation', { params: { query: { q, type } } }));

export const getLookup = async (
  address: string,
): Promise<ApiResult<unknown>> =>
  normalize(await apiClient.GET('/lookup', { params: { query: { address } } }));

export { normalizeApiError };
export type { NormalizedApiError };
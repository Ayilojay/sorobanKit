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

import { afterEach, describe, expect, it, vi } from 'vitest';
import { getFederation } from './client';
import {
  getErrorGuidance,
  isRetryableErrorCode,
  generateReferenceId,
} from './errorCatalog';

describe('OpenAPI API client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends typed query parameters and returns the documented response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          stellar_address: 'alice*localhost',
          account_id: 'GABC',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await getFederation('alice*localhost', 'name');

    expect(result.data).toEqual({
      stellar_address: 'alice*localhost',
      account_id: 'GABC',
    });
    const requestInfo = fetchMock.mock.calls[0][0];
    const requestUrl =
      typeof requestInfo === 'string'
        ? requestInfo
        : 'url' in requestInfo
          ? requestInfo.url
          : requestInfo.href;
    expect(new URL(requestUrl).searchParams.get('q')).toBe('alice*localhost');
    expect(new URL(requestUrl).searchParams.get('type')).toBe('name');
  });

  it('keeps standardized errors available as typed transport errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            success: false,
            error: {
              code: 'NOT_FOUND',
              message: 'Name tag not found',
              retryable: false,
            },
          }),
          { status: 404, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    const result = await getFederation('missing*localhost');

    expect(result.error?.error).toMatchObject({
      code: 'NOT_FOUND',
      retryable: false,
    });
  });
});

describe('central error catalog', () => {
  it('maps known codes to safe messages, remediation, and retryability', () => {
    const guidance = getErrorGuidance('NOT_FOUND');

    expect(guidance.code).toBe('NOT_FOUND');
    expect(guidance.message).toBe('Name tag not found');
    expect(guidance.remediation).toBeTruthy();
    expect(guidance.retryable).toBe(false);
    expect(guidance.referenceId).toMatch(/^[A-Za-z0-9-]+$/);
  });

  it('marks transient codes as retryable', () => {
    expect(isRetryableErrorCode('RATE_LIMITED')).toBe(true);
    expect(isRetryableErrorCode('INTERNAL_ERROR')).toBe(true);
    expect(isRetryableErrorCode('NOT_FOUND')).toBe(false);
  });

  it('falls back safely for unknown codes without exposing server internals', () => {
    const guidance = getErrorGuidance('SOME_UNMAPPED_CODE', {
      serverMessage: 'stack trace at /srv/app/internal.ts:42 secret=abc',
    });

    expect(guidance.code).toBe('UNKNOWN_ERROR');
    expect(guidance.message).not.toContain('stack trace');
    expect(guidance.message).not.toContain('secret');
    expect(guidance.message).not.toContain('/srv/app');
    expect(guidance.remediation).toBeTruthy();
    expect(guidance.retryable).toBe(false);
    expect(guidance.referenceId).toMatch(/^[A-Za-z0-9-]+$/);
  });

  it('generates unique reference IDs', () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateReferenceId()));
    expect(ids.size).toBe(50);
    for (const id of ids) {
      expect(id).toMatch(/^[A-Za-z0-9-]+$/);
    }
  });
});

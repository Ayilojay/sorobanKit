import { afterEach, describe, expect, it, vi } from 'vitest';
import { getFederation } from './client';

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

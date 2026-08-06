import { describe, expect, test } from 'bun:test';

import { fetchAssetFollowingRedirects } from '../lib/assetRedirects';

interface RecordedRequest {
  authorization: string | null;
  url: string;
  userAgent: string | null;
}

// A fetch stub that serves a scripted redirect chain and records what each
// hop was asked with.
function createFetchStub(routes: Record<string, Response>) {
  const requests: RecordedRequest[] = [];
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    requests.push({
      authorization: headers.get('authorization'),
      url,
      userAgent: headers.get('user-agent'),
    });
    const response = routes[url];
    if (response == null) {
      throw new Error(`Unexpected fetch: ${url}`);
    }
    return Promise.resolve(response.clone());
  }) as typeof fetch;
  return { fetchImpl, requests };
}

const HEADERS = {
  Authorization: 'Bearer token-123',
  'User-Agent': 'pierre-diffshub',
};

function redirectTo(location: string): Response {
  return new Response(null, { headers: { location }, status: 302 });
}

const IMAGE = () =>
  new Response('png-bytes', {
    headers: { 'content-type': 'image/png' },
    status: 200,
  });

describe('fetchAssetFollowingRedirects', () => {
  test('follows a cross-origin hop (dotcom attachment → signed S3 URL) without credentials', async () => {
    const { fetchImpl, requests } = createFetchStub({
      'https://github.com/user-attachments/assets/abc': redirectTo(
        'https://prod-assets.s3.amazonaws.com/abc?X-Amz-Signature=sig'
      ),
      'https://prod-assets.s3.amazonaws.com/abc?X-Amz-Signature=sig': IMAGE(),
    });

    const response = await fetchAssetFollowingRedirects(
      'https://github.com/user-attachments/assets/abc',
      HEADERS,
      fetchImpl
    );

    expect(response.status).toBe(200);
    expect(requests).toHaveLength(2);
    expect(requests[0].authorization).toBe('Bearer token-123');
    // The signed URL carries auth in its query string; S3 rejects requests
    // that also present an Authorization header.
    expect(requests[1].authorization).toBeNull();
    expect(requests[1].userAgent).toBe('pierre-diffshub');
  });

  test('resolves relative Location values against the current target', async () => {
    const { fetchImpl, requests } = createFetchStub({
      'https://ghe.company.com/user-attachments/assets/xyz': redirectTo(
        '/storage/user/xyz?token=signed'
      ),
      'https://ghe.company.com/storage/user/xyz?token=signed': IMAGE(),
    });

    const response = await fetchAssetFollowingRedirects(
      'https://ghe.company.com/user-attachments/assets/xyz',
      HEADERS,
      fetchImpl
    );

    expect(response.status).toBe(200);
    expect(requests[1].url).toBe(
      'https://ghe.company.com/storage/user/xyz?token=signed'
    );
    expect(requests[1].authorization).toBeNull();
  });

  test('stops after the hop limit and returns the last redirect', async () => {
    const { fetchImpl, requests } = createFetchStub({
      'https://ghe.company.com/a': redirectTo('https://ghe.company.com/b'),
      'https://ghe.company.com/b': redirectTo('https://ghe.company.com/c'),
      'https://ghe.company.com/c': redirectTo('https://ghe.company.com/d'),
      'https://ghe.company.com/d': redirectTo('https://ghe.company.com/e'),
    });

    const response = await fetchAssetFollowingRedirects(
      'https://ghe.company.com/a',
      HEADERS,
      fetchImpl
    );

    expect(response.status).toBe(302);
    // Initial request plus three hops.
    expect(requests).toHaveLength(4);
  });

  test('returns a redirect with no Location as-is', async () => {
    const { fetchImpl, requests } = createFetchStub({
      'https://ghe.company.com/a': new Response(null, { status: 302 }),
    });

    const response = await fetchAssetFollowingRedirects(
      'https://ghe.company.com/a',
      HEADERS,
      fetchImpl
    );

    expect(response.status).toBe(302);
    expect(requests).toHaveLength(1);
  });

  test('passes a non-redirect response straight through', async () => {
    const { fetchImpl, requests } = createFetchStub({
      'https://ghe.company.com/avatars/u/1': IMAGE(),
    });

    const response = await fetchAssetFollowingRedirects(
      'https://ghe.company.com/avatars/u/1',
      HEADERS,
      fetchImpl
    );

    expect(response.status).toBe(200);
    expect(requests).toHaveLength(1);
    expect(requests[0].authorization).toBe('Bearer token-123');
  });
});

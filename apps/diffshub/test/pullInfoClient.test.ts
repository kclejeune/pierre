import { afterEach, describe, expect, test } from 'bun:test';

import { fetchPullInfo } from '../lib/pullInfoClient';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('fetchPullInfo', () => {
  test('forwards an explicit browser cache mode', async () => {
    let requestCache: RequestCache | undefined;
    globalThis.fetch = ((_input, init) => {
      requestCache = init?.cache;
      return Promise.resolve(Response.json({ number: '12' }));
    }) as typeof fetch;

    await fetchPullInfo(
      { number: '12', owner: 'acme', repo: 'widgets' },
      'token',
      undefined,
      'reload'
    );

    expect(requestCache).toBe('reload');
  });
});

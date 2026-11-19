import { afterEach, describe, expect, test } from 'bun:test';

import { clearPrefetches } from '../lib/prefetchStore';
import { fetchPullInfo, prefetchPullInfo } from '../lib/pullInfoClient';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearPrefetches();
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

  test('a forced refresh drops a held prefetch for later plain reads', async () => {
    const pull = { number: '12', owner: 'acme', repo: 'widgets' };
    const titles = ['before edit', 'after edit', 'after edit'];
    globalThis.fetch = ((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(
        Response.json({ number: '12', title: titles.shift() })
      )) as typeof fetch;

    // A hover prefetched the pre-edit response.
    await prefetchPullInfo(pull, 'token');
    // The edit's refresh reads afresh...
    const refreshed = await fetchPullInfo(pull, 'token', undefined, 'reload');
    expect((refreshed as { title?: string }).title).toBe('after edit');
    // ...and the next plain read must not take the older prefetch.
    const next = await fetchPullInfo(pull, 'token');
    expect((next as { title?: string }).title).toBe('after edit');
  });
});

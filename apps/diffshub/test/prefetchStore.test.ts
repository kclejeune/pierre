import { afterEach, describe, expect, test } from 'bun:test';

import { clearPrefetches, prefetchOnce, takeOrLoad } from '@/lib/prefetchStore';

afterEach(() => clearPrefetches());

describe('prefetchStore', () => {
  test('a prefetch serves one read with the same token', async () => {
    let loads = 0;
    const prefetch = () => {
      loads += 1;
      return Promise.resolve('prefetched');
    };
    const live = () => Promise.resolve('live');
    prefetchOnce('/api/pull-details?a', 'tok', prefetch);
    // A second prefetch while one is held reuses it.
    prefetchOnce('/api/pull-details?a', 'tok', prefetch);
    expect(loads).toBe(1);
    expect(await takeOrLoad('/api/pull-details?a', 'other', live)).toBe('live');
    expect(await takeOrLoad('/api/pull-details?a', 'tok', live)).toBe(
      'prefetched'
    );
    // Single-use: the next read goes to the network.
    expect(await takeOrLoad('/api/pull-details?a', 'tok', live)).toBe('live');
  });

  test('a failed prefetch falls back to a fresh fetch', async () => {
    prefetchOnce('/api/review-threads?b', undefined, () =>
      Promise.reject(new Error('rate limited'))
    );
    expect(
      await takeOrLoad('/api/review-threads?b', undefined, () =>
        Promise.resolve('live')
      )
    ).toBe('live');
  });
});

import { afterEach, describe, expect, test } from 'bun:test';

import {
  clearPrefetches,
  discardTagged,
  PrefetchGroup,
  prefetchOnce,
  takeOrLoad,
} from '@/lib/prefetchStore';

afterEach(() => clearPrefetches());

describe('prefetchStore', () => {
  test('a prefetch serves one read with the same token', async () => {
    let loads = 0;
    const prefetch = () => {
      loads += 1;
      return Promise.resolve('prefetched');
    };
    const live = () => Promise.resolve('live');
    void prefetchOnce('/api/pull-details?a', 'tok', prefetch);
    // A second prefetch while one is held reuses it.
    void prefetchOnce('/api/pull-details?a', 'tok', prefetch);
    expect(loads).toBe(1);
    expect(await takeOrLoad('/api/pull-details?a', 'other', live)).toBe('live');
    expect(await takeOrLoad('/api/pull-details?a', 'tok', live)).toBe(
      'prefetched'
    );
    // Single-use: the next read goes to the network.
    expect(await takeOrLoad('/api/pull-details?a', 'tok', live)).toBe('live');
  });

  test('a failed prefetch falls back to a fresh fetch', async () => {
    void prefetchOnce('/api/review-threads?b', undefined, () =>
      Promise.reject(new Error('rate limited'))
    );
    expect(
      await takeOrLoad('/api/review-threads?b', undefined, () =>
        Promise.resolve('live')
      )
    ).toBe('live');
  });

  // A load that settles only when told to, or rejects when aborted.
  function pendingLoad() {
    let aborted = false;
    let resolve: (value: string) => void = () => undefined;
    const load = (signal: AbortSignal) =>
      new Promise<string>((done, fail) => {
        resolve = done;
        signal.addEventListener('abort', () => {
          aborted = true;
          fail(new Error('aborted'));
        });
      });
    return {
      load,
      resolve: (value: string) => resolve(value),
      wasAborted: () => aborted,
    };
  }

  test('cancelling a group aborts its untaken prefetches', async () => {
    const pending = pendingLoad();
    const group = new PrefetchGroup();
    void prefetchOnce('/api/pull-info?c', 'tok', pending.load, { group });
    group.cancel();
    expect(pending.wasAborted()).toBe(true);
    // The aborted entry is gone, so the reader fetches for itself.
    expect(
      await takeOrLoad('/api/pull-info?c', 'tok', () => Promise.resolve('live'))
    ).toBe('live');
  });

  test('a taken prefetch survives its group being cancelled', async () => {
    const pending = pendingLoad();
    const group = new PrefetchGroup();
    void prefetchOnce('/api/pull-info?d', 'tok', pending.load, { group });
    const read = takeOrLoad('/api/pull-info?d', 'tok', () =>
      Promise.resolve('live')
    );
    group.cancel();
    pending.resolve('prefetched');
    expect(pending.wasAborted()).toBe(false);
    expect(await read).toBe('prefetched');
  });

  test('a prefetch shared with a live group keeps running', () => {
    const pending = pendingLoad();
    const hover = new PrefetchGroup();
    const neighbors = new PrefetchGroup();
    void prefetchOnce('/api/pull-info?e', 'tok', pending.load, {
      group: hover,
    });
    void prefetchOnce('/api/pull-info?e', 'tok', pending.load, {
      group: neighbors,
    });
    hover.cancel();
    expect(pending.wasAborted()).toBe(false);
    neighbors.cancel();
    expect(pending.wasAborted()).toBe(true);
  });

  test('prefetches started outside any group are never aborted', () => {
    const pending = pendingLoad();
    const group = new PrefetchGroup();
    void prefetchOnce('/api/pull-info?f', 'tok', pending.load);
    // A group joining the entry later doesn't make it abortable.
    void prefetchOnce('/api/pull-info?f', 'tok', pending.load, { group });
    group.cancel();
    expect(pending.wasAborted()).toBe(false);
  });

  test('discardTagged drops only the tagged pull, whatever the token', async () => {
    void prefetchOnce('/api/pull-info?g', 'tok', () => Promise.resolve('g1'), {
      tag: 'acme/widgets#7',
    });
    void prefetchOnce(
      '/api/pull-info?g',
      'other',
      () => Promise.resolve('g2'),
      {
        tag: 'acme/widgets#7',
      }
    );
    void prefetchOnce('/api/pull-info?h', 'tok', () => Promise.resolve('h1'), {
      tag: 'acme/widgets#8',
    });
    discardTagged('acme/widgets#7');
    const fresh = () => Promise.resolve('network');
    expect(await takeOrLoad('/api/pull-info?g', 'tok', fresh)).toBe('network');
    expect(await takeOrLoad('/api/pull-info?g', 'other', fresh)).toBe(
      'network'
    );
    expect(await takeOrLoad('/api/pull-info?h', 'tok', fresh)).toBe('h1');
  });
});

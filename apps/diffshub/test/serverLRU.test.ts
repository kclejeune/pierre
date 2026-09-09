import { describe, expect, setSystemTime, test } from 'bun:test';

import { createAsyncLRU, credentialCacheScope } from '../lib/serverLRU';

describe('createAsyncLRU', () => {
  test('deduplicates pending work and expires resolved values', async () => {
    let calls = 0;
    const cache = createAsyncLRU<string, string>({
      maxEntries: 2,
      ttlMs: 1_000,
    });

    try {
      setSystemTime(new Date('2026-09-08T12:00:00Z'));
      const first = cache.getOrCreate('key', () =>
        Promise.resolve(String(++calls))
      );
      const second = cache.getOrCreate('key', () =>
        Promise.resolve(String(++calls))
      );
      expect(await Promise.all([first, second])).toEqual(['1', '1']);

      setSystemTime(new Date('2026-09-08T12:00:01.001Z'));
      expect(
        await cache.getOrCreate('key', () => Promise.resolve(String(++calls)))
      ).toBe('2');
    } finally {
      setSystemTime();
    }
  });

  test('starts the freshness window after pending work resolves', async () => {
    let finish: ((value: string) => void) | undefined;
    let calls = 0;
    const pending = new Promise<string>((resolve) => {
      finish = resolve;
    });
    const cache = createAsyncLRU<string, string>({
      maxEntries: 2,
      ttlMs: 1_000,
    });

    try {
      setSystemTime(new Date('2026-09-08T12:00:00Z'));
      const first = cache.getOrCreate('key', () => {
        calls += 1;
        return pending;
      });

      setSystemTime(new Date('2026-09-08T12:00:02Z'));
      const second = cache.getOrCreate('key', () =>
        Promise.resolve(String(++calls))
      );
      finish?.('resolved');
      expect(await Promise.all([first, second])).toEqual([
        'resolved',
        'resolved',
      ]);

      setSystemTime(new Date('2026-09-08T12:00:02.500Z'));
      expect(
        await cache.getOrCreate('key', () => Promise.resolve(String(++calls)))
      ).toBe('resolved');
      expect(calls).toBe(1);
    } finally {
      setSystemTime();
    }
  });

  test('evicts least-recently-used and overweight values', async () => {
    let calls = 0;
    const cache = createAsyncLRU<string, string>({
      maxEntries: 2,
      maxWeight: 4,
      ttlMs: 1_000,
      weight: (value) => value.length,
    });
    const load = (key: string, value = key) =>
      cache.getOrCreate(key, () => {
        calls += 1;
        return Promise.resolve(value);
      });

    await load('a');
    await load('b');
    await load('a');
    await load('c');
    await load('b');
    expect(calls).toBe(4);

    await load('large', '12345');
    await load('large', '12345');
    expect(calls).toBe(6);
  });

  test('does not retain rejected work', async () => {
    let calls = 0;
    const cache = createAsyncLRU<string, string>({
      maxEntries: 1,
      ttlMs: 1_000,
    });
    const load = () =>
      cache.getOrCreate('key', () => {
        calls += 1;
        return Promise.reject(new Error('nope'));
      });

    const message = (error: unknown) =>
      error instanceof Error ? error.message : String(error);
    expect(await load().then(() => '', message)).toBe('nope');
    expect(await load().then(() => '', message)).toBe('nope');
    expect(calls).toBe(2);
  });
});

describe('credentialCacheScope', () => {
  test('partitions credentials without retaining the token text', () => {
    const first = credentialCacheScope('secret-one');
    const second = credentialCacheScope('secret-two');

    expect(first).not.toBe(second);
    expect(first).not.toContain('secret-one');
    expect(credentialCacheScope(undefined)).toBe('anonymous');
  });
});

describe('createAsyncLRU cache inspection and invalidation', () => {
  test('reports cached keys and drops them on demand', async () => {
    const cache = createAsyncLRU<string, string>({
      maxEntries: 4,
      ttlMs: 60_000,
    });
    let loads = 0;
    const load = () => {
      loads += 1;
      return Promise.resolve(`value ${loads}`);
    };

    expect(cache.has('a')).toBe(false);
    expect(await cache.getOrCreate('a', load)).toBe('value 1');
    expect(cache.has('a')).toBe(true);
    expect(await cache.getOrCreate('a', load)).toBe('value 1');
    expect(loads).toBe(1);

    cache.delete('a');
    expect(cache.has('a')).toBe(false);
    expect(await cache.getOrCreate('a', load)).toBe('value 2');
    expect(loads).toBe(2);
  });

  test('reports a still-loading key as cached so callers do not double-load', async () => {
    const cache = createAsyncLRU<string, string>({
      maxEntries: 4,
      ttlMs: 60_000,
    });
    let release: ((value: string) => void) | undefined;
    const pending = cache.getOrCreate(
      'a',
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        })
    );

    // getOrCreate defers the creator to a microtask, so let it start before
    // inspecting or releasing it.
    await Promise.resolve();
    expect(cache.has('a')).toBe(true);
    release?.('done');
    expect(await pending).toBe('done');
  });
});

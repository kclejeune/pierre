import { describe, expect, test } from 'bun:test';

import { findQueuePosition, parsePullQueue } from '@/lib/pullQueue';

const items = [
  { path: '/acme/a/pull/1', title: 'one' },
  { path: '/acme/b/pull/2', title: 'two' },
];

describe('pull queue', () => {
  test('finds the open pull, including its commit-range pages', () => {
    expect(findQueuePosition(items, '/acme/b/pull/2')).toBe(1);
    expect(findQueuePosition(items, '/ACME/b/pull/2/')).toBe(1);
    expect(findQueuePosition(items, '/acme/a/pull/1/commits/abc')).toBe(0);
    // A longer number isn't a page under the queued pull.
    expect(findQueuePosition(items, '/acme/a/pull/12')).toBe(-1);
  });

  test('finds commit and compare views through their fromPull parameter', () => {
    expect(
      findQueuePosition(items, '/acme/b/commit/abc123', '/acme/b/pull/2')
    ).toBe(1);
    expect(
      findQueuePosition(items, '/acme/a/compare/abc...def', '/acme/a/pull/1')
    ).toBe(0);
    expect(findQueuePosition(items, '/acme/b/commit/abc123', null)).toBe(-1);
    // Only app-relative paths count; anything else is ignored.
    expect(
      findQueuePosition(
        items,
        '/acme/b/commit/abc123',
        'https://x/acme/b/pull/2'
      )
    ).toBe(-1);
  });

  test('reads stored queues, dropping expired or malformed ones', () => {
    const now = Date.now();
    const stored = (savedAt: number, value: unknown = items) => ({
      items: value,
      savedAt,
    });
    expect(parsePullQueue(stored(now), now)).toEqual(items);
    expect(parsePullQueue(stored(now - 25 * 60 * 60 * 1000), now)).toEqual([]);
    expect(parsePullQueue('nope', now)).toEqual([]);
    expect(parsePullQueue({ savedAt: now, items: 'x' }, now)).toEqual([]);
    expect(parsePullQueue(null, now)).toEqual([]);
    expect(
      parsePullQueue(
        stored(now, [{ path: 'relative', title: 'x' }, items[0]]),
        now
      )
    ).toEqual([items[0]]);
  });
});

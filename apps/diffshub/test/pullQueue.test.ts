import { describe, expect, test } from 'bun:test';

import {
  findQueuePosition,
  parsePullQueue,
  pullQueueId,
  readPullQueueId,
  staleQueueIds,
  withPullQueue,
} from '@/lib/pullQueue';

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
    const listPath = '/pulls?q=is%3Aopen&pull=acme/a/1';
    const stored = (savedAt: number, value: unknown = items) => ({
      items: value,
      listPath,
      savedAt,
    });
    expect(parsePullQueue(stored(now), now)).toEqual({ items, listPath });
    expect(parsePullQueue(stored(now - 25 * 60 * 60 * 1000), now)).toBeNull();
    expect(parsePullQueue('nope', now)).toBeNull();
    expect(parsePullQueue(null, now)).toBeNull();
    expect(parsePullQueue(stored(now, 'x'), now)).toBeNull();
    // The way back must stay on /pulls.
    expect(
      parsePullQueue(
        { items, listPath: 'https://evil.example/', savedAt: now },
        now
      )
    ).toBeNull();
    expect(
      parsePullQueue(
        stored(now, [{ path: 'relative', title: 'x' }, items[0]]),
        now
      )?.items
    ).toEqual([items[0]]);
  });

  test('names a list by its rows', () => {
    const id = pullQueueId(items);
    expect(id).toMatch(/^[0-9a-z]{1,7}$/);
    expect(pullQueueId([...items])).toBe(id);
    expect(pullQueueId([items[1], items[0]])).not.toBe(id);
    // Titles don't change which list it is.
    expect(pullQueueId([{ ...items[0], title: 'renamed' }, items[1]])).toBe(id);
  });

  test('carries the queue id through links and reads it back', () => {
    expect(withPullQueue('/acme/a/pull/1', 'abc')).toBe(
      '/acme/a/pull/1?queue=abc'
    );
    expect(withPullQueue('/acme/a/pull/1?x=1#f', 'abc')).toBe(
      '/acme/a/pull/1?x=1&queue=abc#f'
    );
    expect(readPullQueueId('?queue=abc')).toBe('abc');
    expect(readPullQueueId('?queue=../etc')).toBeNull();
    expect(readPullQueueId('?queue=ABC')).toBeNull();
    expect(readPullQueueId('')).toBeNull();
  });

  test('drops expired, unreadable, and the oldest past the cap', () => {
    const now = 1_000_000_000;
    const saved = new Map<string, number | null>([
      ['stale', now - 25 * 60 * 60 * 1000],
      ['broken', null],
    ]);
    for (let index = 0; index < 12; index++) {
      saved.set(`q${index}`, now - 1000 + index);
    }
    const stale = staleQueueIds(saved, now);
    expect(stale).toContain('stale');
    expect(stale).toContain('broken');
    // Ten live queues stay: the two oldest go.
    expect(stale).toContain('q0');
    expect(stale).toContain('q1');
    expect(stale).not.toContain('q2');
    expect(stale).not.toContain('q11');
    expect(stale).toHaveLength(4);
  });
});

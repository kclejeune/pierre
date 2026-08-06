import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { createFakeWindow } from './helpers/fakeWindow';
import {
  loadRecentDiffs,
  MAX_RECENT_DIFFS,
  mergeRecentDiff,
  type RecentDiff,
  recordRecentDiff,
} from '@/lib/recentDiffs';

let fake: ReturnType<typeof createFakeWindow>;
const originalWindow = globalThis.window;

beforeEach(() => {
  fake = createFakeWindow();
  globalThis.window = fake.window;
});

afterEach(() => {
  globalThis.window = originalWindow;
});

describe('mergeRecentDiff', () => {
  const existing: RecentDiff[] = [
    { path: '/a/b/pull/1', title: 'First', viewedAt: 100 },
    { path: '/c/d/pull/2', viewedAt: 50 },
  ];

  test('moves a revisited path to the front with the new timestamp', () => {
    const merged = mergeRecentDiff(existing, { path: '/c/d/pull/2' }, 200);
    expect(merged.map((entry) => entry.path)).toEqual([
      '/c/d/pull/2',
      '/a/b/pull/1',
    ]);
    expect(merged[0]?.viewedAt).toBe(200);
  });

  test('a new title wins and an absent title preserves the stored one', () => {
    const retitled = mergeRecentDiff(
      existing,
      { path: '/a/b/pull/1', title: 'Renamed' },
      200
    );
    expect(retitled[0]?.title).toBe('Renamed');
    const untitled = mergeRecentDiff(existing, { path: '/a/b/pull/1' }, 200);
    expect(untitled[0]?.title).toBe('First');
  });

  test('caps the list at the maximum', () => {
    const full: RecentDiff[] = Array.from(
      { length: MAX_RECENT_DIFFS },
      (_, i) => ({ path: `/o/r/pull/${i}`, viewedAt: i })
    );
    const merged = mergeRecentDiff(full, { path: '/o/r/pull/new' }, 999);
    expect(merged).toHaveLength(MAX_RECENT_DIFFS);
    expect(merged[0]?.path).toBe('/o/r/pull/new');
  });
});

describe('loadRecentDiffs / recordRecentDiff', () => {
  test('round-trips recorded entries', () => {
    recordRecentDiff({ path: '/a/b/pull/1', title: 'First' });
    recordRecentDiff({ path: '/c/d/pull/2' });
    const loaded = loadRecentDiffs();
    expect(loaded.map((entry) => entry.path)).toEqual([
      '/c/d/pull/2',
      '/a/b/pull/1',
    ]);
    expect(loaded[1]?.title).toBe('First');
  });

  test('drops malformed payloads and invalid entries', () => {
    fake.store.set('diffshub.recent-diffs', 'not json');
    expect(loadRecentDiffs()).toEqual([]);
    fake.store.set(
      'diffshub.recent-diffs',
      JSON.stringify([
        { path: '/ok/path', viewedAt: 1, title: 'Ok' },
        { path: '', viewedAt: 1 },
        { path: '/missing/viewedAt' },
        'not an object',
      ])
    );
    expect(loadRecentDiffs()).toEqual([
      { path: '/ok/path', viewedAt: 1, title: 'Ok' },
    ]);
  });
});

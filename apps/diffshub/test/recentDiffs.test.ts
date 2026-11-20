import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { createFakeWindow } from './helpers/fakeWindow';
import {
  addRecentDiffTitle,
  canonicalRecentPath,
  isRecentDiffPath,
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

  test('drops stored entries that are no longer views', () => {
    // A /owner/repo/pulls list the viewer once recorded, before the
    // dashboard served that path.
    fake.store.set(
      'diffshub.recent-diffs',
      JSON.stringify([
        { path: '/octo/demo/pulls', viewedAt: 2 },
        { path: '/octo/demo/pull/9', viewedAt: 1, title: 'Fix' },
      ])
    );
    expect(loadRecentDiffs()).toEqual([
      { path: '/octo/demo/pull/9', viewedAt: 1, title: 'Fix' },
    ]);
  });
});

describe('canonicalRecentPath', () => {
  test('keeps one form per view', () => {
    expect(canonicalRecentPath('/octo/demo/pull/9/files')).toBe(
      '/octo/demo/pull/9'
    );
    expect(canonicalRecentPath('/octo/demo/pull/9/?queue=q1#diff-a')).toBe(
      '/octo/demo/pull/9'
    );
    expect(canonicalRecentPath('/octo/demo/pull/9/changes/abc1234')).toBe(
      '/octo/demo/commit/abc1234'
    );
    expect(canonicalRecentPath('/a.patch?domain=x.test&queue=q')).toBe(
      '/a.patch?domain=x.test'
    );
    // A commit view keeps its way back to the pull it was opened from.
    expect(
      canonicalRecentPath(
        '/octo/demo/commit/c2?fromPull=%2Focto%2Fdemo%2Fpull%2F12'
      )
    ).toBe('/octo/demo/commit/c2?fromPull=%2Focto%2Fdemo%2Fpull%2F12');
  });

  test('a bare revisit keeps the way back to the pull', () => {
    const fromPull = '/octo/demo/commit/c2?fromPull=%2Focto%2Fdemo%2Fpull%2F12';
    const merged = mergeRecentDiff(
      [{ path: fromPull, title: 'Range', viewedAt: 1 }],
      { path: '/octo/demo/commit/c2' },
      2
    );
    expect(merged).toEqual([{ path: fromPull, title: 'Range', viewedAt: 2 }]);
  });

  test('a malformed stored path is kept apart without breaking the list', () => {
    fake.store.set(
      'diffshub.recent-diffs',
      JSON.stringify([
        { path: '//[', viewedAt: 2 },
        { path: '/octo/demo/pull/9', viewedAt: 1 },
      ])
    );
    expect(() => loadRecentDiffs()).not.toThrow();
  });

  test("another host's paths keep their case apart", () => {
    const merged = mergeRecentDiff(
      [{ path: '/@a.example/Demo/pull/9?domain=t.org', viewedAt: 1 }],
      { path: '/@a.example/demo/pull/9?domain=t.org' },
      2
    );
    expect(merged.map((entry) => entry.path)).toEqual([
      '/@a.example/demo/pull/9?domain=t.org',
      '/@a.example/Demo/pull/9?domain=t.org',
    ]);
  });

  test('a title alone fills in a listed entry and never adds one', () => {
    addRecentDiffTitle({ path: '/octo/demo/pull/9', title: 'Fix' });
    expect(loadRecentDiffs()).toEqual([]);
    recordRecentDiff({ path: '/octo/demo/pull/9' });
    recordRecentDiff({ path: '/octo/demo/pull/7' });
    addRecentDiffTitle({ path: '/octo/demo/pull/9/files', title: 'Fix' });
    expect(loadRecentDiffs().map((entry) => [entry.path, entry.title])).toEqual(
      [
        ['/octo/demo/pull/7', undefined],
        ['/octo/demo/pull/9', 'Fix'],
      ]
    );
  });

  test('merges stored duplicates, keeping the newest and any title', () => {
    fake.store.set(
      'diffshub.recent-diffs',
      JSON.stringify([
        { path: '/Octo/Demo/pull/9#diff-a', viewedAt: 3 },
        { path: '/octo/demo/pull/9/files', viewedAt: 2, title: 'Fix' },
        { path: '/octo/demo/pull/7', viewedAt: 1 },
      ])
    );
    expect(loadRecentDiffs()).toEqual([
      { path: '/Octo/Demo/pull/9', title: 'Fix', viewedAt: 3 },
      { path: '/octo/demo/pull/7', viewedAt: 1 },
    ]);
  });

  test('merging stored duplicates keeps an older way back to the pull', () => {
    const withReturn =
      '/octo/demo/commit/abcdef1?fromPull=%2Focto%2Fdemo%2Fpull%2F12';
    fake.store.set(
      'diffshub.recent-diffs',
      JSON.stringify([
        { path: '/octo/demo/commit/abcdef1', viewedAt: 2 },
        { path: withReturn, title: 'octo/demo#12 @ abcdef1', viewedAt: 1 },
      ])
    );
    expect(loadRecentDiffs()).toEqual([
      { path: withReturn, title: 'octo/demo#12 @ abcdef1', viewedAt: 2 },
    ]);
  });

  test('a revisit through another link replaces the entry', () => {
    const merged = mergeRecentDiff(
      [{ path: '/octo/demo/pull/9', title: 'Fix', viewedAt: 1 }],
      { path: '/OCTO/demo/pull/9/files' },
      2
    );
    expect(merged).toEqual([
      { path: '/OCTO/demo/pull/9', title: 'Fix', viewedAt: 2 },
    ]);
  });
});

describe('isRecentDiffPath', () => {
  test('dashboards and the home page are not views', () => {
    for (const path of [
      '/',
      '/pulls',
      '/pulls?repo=a%2Fb',
      '/a/b/pulls',
      '/a/b/pulls?q=is%3Amerged',
      '/browse',
      '/browse/?repo=a%2Fb',
    ]) {
      expect(isRecentDiffPath(path)).toBe(false);
    }
    for (const path of [
      '/a/b/pull/1',
      '/a/b/tree/main',
      '/pulls-of-x/y/pull/2',
      '/a.patch?domain=x.test',
    ]) {
      expect(isRecentDiffPath(path)).toBe(true);
    }
  });
});

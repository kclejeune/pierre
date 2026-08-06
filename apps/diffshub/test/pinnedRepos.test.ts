import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { createFakeWindow } from './helpers/fakeWindow';
import {
  isRepoPinned,
  loadPinnedRepos,
  MAX_PINNED_REPOS,
  PINNED_REPOS_EVENT,
  savePinnedRepos,
  togglePinnedRepo,
} from '@/lib/pinnedRepos';

let fake: ReturnType<typeof createFakeWindow>;
const originalWindow = globalThis.window;

beforeEach(() => {
  fake = createFakeWindow();
  globalThis.window = fake.window;
});

afterEach(() => {
  globalThis.window = originalWindow;
});

describe('loadPinnedRepos', () => {
  test('returns an empty list when nothing is stored', () => {
    expect(loadPinnedRepos()).toEqual([]);
  });

  test('round-trips saved pins and notifies listeners', () => {
    savePinnedRepos(['oven-sh/bun', 'ziglang/zig']);
    expect(loadPinnedRepos()).toEqual(['oven-sh/bun', 'ziglang/zig']);
    expect(fake.events.map((event) => event.type)).toEqual([
      PINNED_REPOS_EVENT,
    ]);
  });

  test('drops malformed payloads and invalid entries', () => {
    fake.store.set('diffshub.pinned-repos', '{"not":"an array"}');
    expect(loadPinnedRepos()).toEqual([]);
    fake.store.set(
      'diffshub.pinned-repos',
      JSON.stringify(['ok/repo', 'no-slash', 'too/many/parts', 42, 'ok/repo'])
    );
    expect(loadPinnedRepos()).toEqual(['ok/repo']);
  });

  test('caps stored pins at the maximum', () => {
    const many = Array.from({ length: 15 }, (_, i) => `owner/repo${i}`);
    fake.store.set('diffshub.pinned-repos', JSON.stringify(many));
    expect(loadPinnedRepos()).toHaveLength(MAX_PINNED_REPOS);
  });
});

describe('togglePinnedRepo', () => {
  test('adds an unpinned repo and removes a pinned one', () => {
    const added = togglePinnedRepo([], 'oven-sh/bun');
    expect(added).toEqual(['oven-sh/bun']);
    expect(togglePinnedRepo(added, 'oven-sh/bun')).toEqual([]);
  });

  test('matches case-insensitively', () => {
    const repos = ['Oven-sh/Bun'];
    expect(isRepoPinned(repos, 'oven-sh/bun')).toBe(true);
    expect(togglePinnedRepo(repos, 'oven-sh/bun')).toEqual([]);
  });

  test('rejects invalid names and enforces the cap', () => {
    expect(togglePinnedRepo([], 'not-a-repo')).toEqual([]);
    const full = Array.from(
      { length: MAX_PINNED_REPOS },
      (_, i) => `owner/repo${i}`
    );
    expect(togglePinnedRepo(full, 'one/more')).toEqual(full);
  });
});

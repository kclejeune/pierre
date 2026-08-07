import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { createFakeWindow } from './helpers/fakeWindow';
import {
  getPendingReviewStorageKey,
  loadPendingReviewComments,
  savePendingReviewComments,
} from '@/lib/pendingReviewStorage';
import type { PendingReviewComment } from '@/lib/types';

let fake: ReturnType<typeof createFakeWindow>;
const originalWindow = globalThis.window;

beforeEach(() => {
  fake = createFakeWindow();
  globalThis.window = fake.window;
});

afterEach(() => {
  globalThis.window = originalWindow;
});

const PULL = { number: '7', owner: 'octo', repo: 'demo' };

function createEntry(
  overrides: Partial<PendingReviewComment> = {}
): PendingReviewComment {
  return {
    author: { avatarUrl: '/a.png', login: 'octocat' },
    key: 'draft-1',
    message: 'needs a null check',
    path: 'src/index.ts',
    range: { start: 4, side: 'additions', end: 6, endSide: 'additions' },
    ...overrides,
  };
}

describe('pendingReviewStorage', () => {
  test('round-trips entries', () => {
    const storageKey = getPendingReviewStorageKey(PULL);
    savePendingReviewComments(storageKey, [createEntry()]);

    expect(loadPendingReviewComments(storageKey)).toEqual([createEntry()]);
  });

  test('storage keys are scoped per pull request', () => {
    savePendingReviewComments(getPendingReviewStorageKey(PULL), [
      createEntry(),
    ]);
    expect(
      loadPendingReviewComments(
        getPendingReviewStorageKey({ ...PULL, number: '8' })
      )
    ).toEqual([]);
  });

  test('saving an empty batch removes the stored entry', () => {
    const storageKey = getPendingReviewStorageKey(PULL);
    savePendingReviewComments(storageKey, [createEntry()]);
    savePendingReviewComments(storageKey, []);
    expect(fake.store.size).toBe(0);
  });

  test('drops malformed entries instead of failing the whole batch', () => {
    const storageKey = getPendingReviewStorageKey(PULL);
    const valid = createEntry();
    fake.store.set(
      `diffshub.pending-review.${storageKey}`,
      JSON.stringify([
        { key: 'no-range', message: 'x', path: 'a.ts' },
        { ...valid, range: { start: 'four', end: 6 } },
        { ...valid, author: { login: 'octocat' } },
        valid,
      ])
    );
    const loaded = loadPendingReviewComments(storageKey);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.key).toBe('draft-1');
  });

  test('tolerates corrupted JSON and non-array payloads', () => {
    const storageKey = getPendingReviewStorageKey(PULL);
    fake.store.set(`diffshub.pending-review.${storageKey}`, '{not json');
    expect(loadPendingReviewComments(storageKey)).toEqual([]);
    fake.store.set(`diffshub.pending-review.${storageKey}`, '{"a":1}');
    expect(loadPendingReviewComments(storageKey)).toEqual([]);
  });
});

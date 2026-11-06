import { describe, expect, test } from 'bun:test';

import {
  chooseReviewCommit,
  describeOutdatedPendingReview,
  describeStaleReviewEntries,
  describeUnsaveableReviewEntries,
} from '@/lib/reviewCommit';
import type { PendingReviewComment } from '@/lib/types';

const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);

function entry(
  key: string,
  commitId: string | undefined,
  line = 4
): PendingReviewComment {
  return {
    author: { avatarUrl: '', login: 'octocat' },
    ...(commitId == null ? {} : { commitId }),
    key,
    message: 'note',
    path: `src/${key}.ts`,
    range: { start: line, side: 'additions', end: line, endSide: 'additions' },
  };
}

describe('chooseReviewCommit', () => {
  test('uses the rendered head when no entry carries a commit', () => {
    expect(chooseReviewCommit([entry('a', undefined)], NEW)).toEqual({
      commitId: NEW,
      staleEntries: [],
    });
    expect(chooseReviewCommit([], undefined)).toEqual({
      commitId: undefined,
      staleEntries: [],
    });
  });

  test("keeps the entries' commit after the diff reloads at a newer head", () => {
    expect(
      chooseReviewCommit([entry('a', OLD), entry('b', undefined)], NEW)
    ).toEqual({ commitId: OLD, staleEntries: [] });
  });

  test('reports entries on another commit than the rendered head as stale', () => {
    const stale = entry('a', OLD);
    expect(chooseReviewCommit([stale, entry('b', NEW)], NEW)).toEqual({
      commitId: NEW,
      staleEntries: [stale],
    });
  });

  test('falls back to the latest entry when none match the rendered head', () => {
    const stale = entry('a', OLD);
    expect(
      chooseReviewCommit([stale, entry('b', NEW)], 'c'.repeat(40))
    ).toEqual({ commitId: NEW, staleEntries: [stale] });
  });
});

describe('describeStaleReviewEntries', () => {
  test('names a single entry', () => {
    expect(describeStaleReviewEntries([entry('a', OLD, 12)])).toStartWith(
      "1 pending comment was written on an earlier push of this pull request and can't be submitted with the rest (src/a.ts:12)."
    );
  });

  test('previews the first three locations and counts the rest', () => {
    const message = describeStaleReviewEntries(
      ['a', 'b', 'c', 'd', 'e'].map((key) => entry(key, OLD))
    );
    expect(message).toContain(
      '5 pending comments were written on an earlier push'
    );
    expect(message).toContain('(src/a.ts:4, src/b.ts:4, src/c.ts:4, 2 more)');
  });
});

describe('describeUnsaveableReviewEntries', () => {
  test('names the drafts GitHub cannot take', () => {
    expect(
      describeUnsaveableReviewEntries([
        entry('a', undefined, 7),
        entry('b', undefined),
      ])
    ).toStartWith(
      "2 pending comments can't be added to your pending review on GitHub (src/a.ts:7, src/b.ts:4)."
    );
  });
});

describe('describeOutdatedPendingReview', () => {
  test('points at the older review on GitHub', () => {
    expect(describeOutdatedPendingReview([entry('a', NEW, 3)])).toBe(
      "1 draft comment on this push can't be added to your pending review on GitHub, which was started on an earlier push of this pull request (src/a.ts:3). Submit or discard that review on GitHub, then submit again."
    );
  });
});

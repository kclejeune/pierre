import { describe, expect, test } from 'bun:test';

import {
  chooseReviewCommit,
  describeStaleReviewEntries,
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

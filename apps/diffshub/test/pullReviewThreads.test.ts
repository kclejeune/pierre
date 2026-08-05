import { describe, expect, test } from 'bun:test';

import {
  createPullReviewThread,
  groupPullReviewThreads,
  toAnnotationSide,
  toGitHubDiffSide,
} from '../lib/pullReviewThreads';
import type { PullReviewComment } from '../lib/types';

function createComment(
  overrides: Partial<PullReviewComment> & { id: number }
): PullReviewComment {
  return {
    author: { avatarUrl: 'https://avatars.example/u/1', login: 'octocat' },
    body: 'Looks good',
    createdAt: '2026-08-01T12:00:00Z',
    htmlUrl: null,
    inReplyToId: null,
    line: 10,
    path: 'src/index.ts',
    side: 'RIGHT',
    startLine: null,
    startSide: null,
    ...overrides,
  };
}

describe('side mapping', () => {
  test('round-trips between GitHub and annotation sides', () => {
    expect(toAnnotationSide('LEFT')).toBe('deletions');
    expect(toAnnotationSide('RIGHT')).toBe('additions');
    expect(toGitHubDiffSide('deletions')).toBe('LEFT');
    expect(toGitHubDiffSide('additions')).toBe('RIGHT');
  });
});

describe('createPullReviewThread', () => {
  test('anchors a single-line comment', () => {
    const thread = createPullReviewThread(createComment({ id: 1 }));
    expect(thread).toEqual({
      comments: [expect.objectContaining({ id: 1 })],
      key: 'thread-1',
      lineNumber: 10,
      path: 'src/index.ts',
      range: { start: 10, side: 'additions', end: 10, endSide: 'additions' },
      rootId: 1,
      side: 'additions',
    });
  });

  test('anchors a multi-line comment across sides', () => {
    const thread = createPullReviewThread(
      createComment({ id: 2, line: 12, startLine: 8, startSide: 'LEFT' })
    );
    expect(thread?.range).toEqual({
      start: 8,
      side: 'deletions',
      end: 12,
      endSide: 'additions',
    });
  });

  test('returns null for outdated comments without an anchor', () => {
    expect(
      createPullReviewThread(createComment({ id: 3, line: null }))
    ).toBeNull();
    expect(
      createPullReviewThread(createComment({ id: 4, side: null }))
    ).toBeNull();
  });
});

describe('groupPullReviewThreads', () => {
  test('groups replies under their root, following reply chains', () => {
    const threads = groupPullReviewThreads([
      createComment({ id: 1 }),
      createComment({ id: 2, inReplyToId: 1, body: 'First reply' }),
      // GitHub reports replies-to-replies as replying to the intermediate
      // comment, not the root.
      createComment({ id: 3, inReplyToId: 2, body: 'Second reply' }),
      createComment({ id: 4, line: 20, path: 'other.ts' }),
    ]);
    expect(threads).toHaveLength(2);
    expect(threads[0].comments.map((comment) => comment.id)).toEqual([1, 2, 3]);
    expect(threads[1].path).toBe('other.ts');
  });

  test('drops outdated threads and their replies', () => {
    const threads = groupPullReviewThreads([
      createComment({ id: 1, line: null, side: null }),
      createComment({ id: 2, inReplyToId: 1 }),
      createComment({ id: 3 }),
    ]);
    expect(threads).toHaveLength(1);
    expect(threads[0].rootId).toBe(3);
  });

  test('drops replies whose root is missing entirely', () => {
    const threads = groupPullReviewThreads([
      createComment({ id: 2, inReplyToId: 999 }),
    ]);
    expect(threads).toHaveLength(0);
  });
});

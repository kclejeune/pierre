import { describe, expect, test } from 'bun:test';

import {
  buildDetachedCommentSections,
  mergeCommentSections,
} from '../lib/detachedCommentSections';
import { groupReviewCommentsByRoot } from '../lib/pullReviewThreads';
import type {
  DiffsHubSavedCommentItem,
  PullReviewComment,
  PullReviewThreadState,
} from '../lib/types';

function createComment(
  overrides: Partial<PullReviewComment> & { id: number }
): PullReviewComment {
  return {
    author: { avatarUrl: 'https://avatars.example/u/1', login: 'octocat' },
    body: 'Looks good',
    createdAt: '2026-08-01T12:00:00Z',
    htmlUrl: `https://github.example/c/${overrides.id}`,
    inReplyToId: null,
    line: 10,
    path: 'src/index.ts',
    side: 'RIGHT',
    startLine: null,
    startSide: null,
    ...overrides,
  };
}

const resolved: PullReviewThreadState = {
  isResolved: true,
  nodeId: 'T_1',
  resolvedBy: 'octocat',
  viewerCanResolve: true,
  viewerCanUnresolve: true,
};

describe('groupReviewCommentsByRoot', () => {
  test('keeps outdated threads with their replies', () => {
    const byRoot = groupReviewCommentsByRoot([
      createComment({ id: 1, line: null, originalLine: 40 }),
      createComment({ id: 2, inReplyToId: 1, line: null }),
      createComment({ id: 3 }),
      createComment({ id: 4, inReplyToId: 2, line: null }),
      createComment({ id: 5, inReplyToId: 99 }),
    ]);
    expect([...byRoot.keys()]).toEqual([1, 3]);
    expect(byRoot.get(1)?.map((comment) => comment.id)).toEqual([1, 2, 4]);
  });
});

describe('buildDetachedCommentSections', () => {
  const pathToItemId = new Map([['src/index.ts', 'item-0']]);
  const commentFileByItemId = new Map([
    ['item-0', { fileOrder: 0, path: 'src/index.ts' }],
  ]);

  test('an outdated thread carries the code it was written on', () => {
    const snippet = [
      { kind: 'addition' as const, lineNumber: 40, text: 'const a = 1;' },
    ];
    const [outdated] = buildDetachedCommentSections({
      commentFileByItemId,
      pathToItemId,
      states: null,
      threads: [
        [
          createComment({
            id: 1,
            line: null,
            originalLine: 40,
            originalSnippet: snippet,
          }),
        ],
      ],
    });
    expect(outdated?.comments[0]?.detached?.snippet).toEqual(snippet);
  });

  test('lists an outdated thread under its file at its original line', () => {
    const root = createComment({ id: 1, line: null, originalLine: 40 });
    const reply = createComment({
      author: { avatarUrl: '', login: 'hubot' },
      id: 2,
      inReplyToId: 1,
      line: null,
    });
    const [section] = buildDetachedCommentSections({
      commentFileByItemId,
      pathToItemId,
      states: new Map([[1, resolved]]),
      threads: [[root, reply]],
    });
    expect(section).toMatchObject({ fileOrder: 0, itemId: 'item-0' });
    expect(section?.comments[0]).toMatchObject({
      detached: {
        fileInDiff: true,
        htmlUrl: 'https://github.example/c/1',
        outdated: true,
      },
      key: 'thread-1',
      lineNumber: 40,
      lineType: 'context',
      replyCount: 1,
      resolved: true,
      reviewThread: true,
    });
    expect(section?.comments[0]?.participants).toHaveLength(2);
  });

  test('gives a file the diff lacks its own section, after the diff', () => {
    const [section] = buildDetachedCommentSections({
      commentFileByItemId,
      pathToItemId,
      states: null,
      threads: [[createComment({ id: 7, path: 'docs/other.md' })]],
    });
    expect(section?.fileOrder).toBe(Number.MAX_SAFE_INTEGER);
    expect(section?.path).toBe('docs/other.md');
    expect(section?.comments[0]).toMatchObject({
      detached: { fileInDiff: false, outdated: false },
      lineNumber: 10,
    });
    expect(section?.comments[0]?.resolved).toBeUndefined();
  });

  test('falls back to a file-level row without any line', () => {
    const [section] = buildDetachedCommentSections({
      commentFileByItemId,
      pathToItemId,
      states: null,
      threads: [[createComment({ id: 8, line: null })]],
    });
    expect(section?.comments[0]?.lineType).toBe('file');
  });
});

describe('mergeCommentSections', () => {
  const entry = (key: string, lineNumber: number) => ({
    author: { avatarUrl: '', login: 'octocat' },
    itemId: 'item-1',
    key,
    lineNumber,
    lineType: 'context' as const,
    message: key,
    participants: [],
    range: { end: lineNumber, start: lineNumber },
    replyCount: 0,
    side: 'additions' as const,
  });
  const current: DiffsHubSavedCommentItem[] = [
    { comments: [entry('a', 5)], fileOrder: 1, itemId: 'item-1', path: 'b.ts' },
  ];

  test('returns the sections untouched without detached threads', () => {
    expect(mergeCommentSections(current, [])).toBe(current);
  });

  test('appends detached threads to their file and orders files', () => {
    const merged = mergeCommentSections(current, [
      {
        comments: [entry('z', 1)],
        fileOrder: Number.MAX_SAFE_INTEGER,
        itemId: 'github-thread-file:z.ts',
        path: 'z.ts',
      },
      {
        comments: [entry('b', 2)],
        fileOrder: 1,
        itemId: 'item-1',
        path: 'b.ts',
      },
      {
        comments: [entry('c', 3)],
        fileOrder: 0,
        itemId: 'item-0',
        path: 'a.ts',
      },
    ]);
    expect(merged.map((section) => section.path)).toEqual([
      'a.ts',
      'b.ts',
      'z.ts',
    ]);
    expect(merged[1]?.comments.map((comment) => comment.key)).toEqual([
      'a',
      'b',
    ]);
  });
});

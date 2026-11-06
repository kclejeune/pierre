import { parseDiffFromFile } from '@pierre/diffs';
import { describe, expect, test } from 'bun:test';

import { groupPullReviewThreads } from '../lib/pullReviewThreads';
import {
  applyReviewThreadStates,
  readReviewThreadNode,
  readReviewThreadState,
} from '../lib/reviewThreadState';
import { createThreadSavedCommentEvent } from '../lib/savedCommentEvent';
import type { PullReviewComment, PullReviewThreadState } from '../lib/types';

function createComment(
  overrides: Partial<PullReviewComment> & { id: number }
): PullReviewComment {
  return {
    author: { avatarUrl: '', login: 'octocat' },
    body: 'Looks good',
    createdAt: '2026-08-01T12:00:00Z',
    htmlUrl: null,
    inReplyToId: null,
    line: 2,
    path: 'src/index.ts',
    side: 'RIGHT',
    startLine: null,
    startSide: null,
    ...overrides,
  };
}

const graphqlNode = {
  id: 'PRRT_1',
  isResolved: true,
  resolvedBy: { login: 'hubot' },
  viewerCanResolve: false,
  viewerCanUnresolve: true,
};

const resolvedState: PullReviewThreadState = {
  isResolved: true,
  nodeId: 'PRRT_1',
  resolvedBy: 'hubot',
  viewerCanResolve: false,
  viewerCanUnresolve: true,
};

describe('readReviewThreadNode', () => {
  test('maps GraphQL names onto the wire shape', () => {
    expect(readReviewThreadNode(graphqlNode)).toEqual(resolvedState);
  });

  test('treats missing viewer permissions and resolver as absent', () => {
    expect(readReviewThreadNode({ id: 'PRRT_2', isResolved: false })).toEqual({
      isResolved: false,
      nodeId: 'PRRT_2',
      resolvedBy: null,
      viewerCanResolve: false,
      viewerCanUnresolve: false,
    });
  });

  test('rejects nodes without an id or resolved flag', () => {
    expect(readReviewThreadNode({ isResolved: true })).toBeNull();
    expect(readReviewThreadNode({ id: 'PRRT_3' })).toBeNull();
    expect(readReviewThreadNode(null)).toBeNull();
  });
});

describe('readReviewThreadState', () => {
  test('round-trips what the routes send', () => {
    expect(
      readReviewThreadState(JSON.parse(JSON.stringify(resolvedState)))
    ).toEqual(resolvedState);
  });

  test('rejects GraphQL-shaped input', () => {
    expect(readReviewThreadState(graphqlNode)).toBeNull();
  });
});

describe('applyReviewThreadStates', () => {
  test('attaches states by root comment id and leaves others alone', () => {
    const threads = groupPullReviewThreads([
      createComment({ id: 7 }),
      createComment({ id: 8, inReplyToId: 7 }),
      createComment({ id: 9, line: 3 }),
    ]);
    const applied = applyReviewThreadStates(
      threads,
      new Map([[7, resolvedState]])
    );
    expect(applied[0]?.state).toEqual(resolvedState);
    expect(applied[0]?.comments).toHaveLength(2);
    expect(applied[1]).toBe(threads[1]);
  });

  test('marks resolved threads on their sidebar event', () => {
    const fileDiff = parseDiffFromFile(
      { contents: 'a\n', name: 'src/index.ts' },
      { contents: 'a\nb\nc\n', name: 'src/index.ts' }
    );
    const [resolved, open] = applyReviewThreadStates(
      groupPullReviewThreads([
        createComment({ id: 7 }),
        createComment({ id: 9, line: 3 }),
      ]),
      new Map([[7, resolvedState]])
    );
    expect(
      createThreadSavedCommentEvent(fileDiff, 'item', resolved).resolved
    ).toBe(true);
    expect(
      createThreadSavedCommentEvent(fileDiff, 'item', open).resolved
    ).toBeUndefined();
  });
});

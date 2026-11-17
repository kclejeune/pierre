import { describe, expect, test } from 'bun:test';

import { describeReviewThreadsLoad } from '../lib/reviewThreadsLoad';
import type { PullReviewThreadState } from '../lib/types';

function state(isResolved: boolean): PullReviewThreadState {
  return {
    isResolved,
    nodeId: 'node',
    resolvedBy: null,
    viewerCanResolve: true,
    viewerCanUnresolve: true,
  };
}

// A settled pull with threads 1–3, all shown in the diff, 1 resolved.
const SETTLED = {
  attachableRootIds: new Set([1, 2, 3]),
  loadState: 'ready',
  rootIds: [1, 2, 3],
  states: new Map([
    [1, state(true)],
    [2, state(false)],
    [3, state(false)],
  ]),
  statesSettled: true,
  threadsApplied: true,
  threadsFailed: false,
} as const;

describe('describeReviewThreadsLoad', () => {
  test('threads in the diff leave nothing detached', () => {
    expect(describeReviewThreadsLoad(SETTLED)).toEqual({
      kind: 'ready',
      detachedCounts: { resolved: 0, total: 0 },
      resolvedKnown: true,
    });
  });

  test('outdated threads count as detached, with their resolution', () => {
    // Threads 2 and 3 are outdated: grouping dropped them, so only 1 is
    // attachable. GraphQL still reports their state.
    expect(
      describeReviewThreadsLoad({
        ...SETTLED,
        attachableRootIds: new Set([1]),
        states: new Map([
          [1, state(false)],
          [2, state(true)],
          [3, state(false)],
        ]),
      })
    ).toEqual({
      kind: 'ready',
      detachedCounts: { resolved: 1, total: 2 },
      resolvedKnown: true,
    });
  });

  test('a pull whose threads are all outdated settles without waiting', () => {
    expect(
      describeReviewThreadsLoad({
        ...SETTLED,
        attachableRootIds: new Set(),
        threadsApplied: false,
      })
    ).toEqual({
      kind: 'ready',
      detachedCounts: { resolved: 1, total: 3 },
      resolvedKnown: true,
    });
  });

  test('a partial state map leaves resolution unknown', () => {
    // A later GraphQL page failed: thread 3 came back without a state.
    expect(
      describeReviewThreadsLoad({
        ...SETTLED,
        states: new Map([
          [1, state(true)],
          [2, state(false)],
        ]),
      })
    ).toMatchObject({ kind: 'ready', resolvedKnown: false });
  });

  test('resolution is unknown without states (no token)', () => {
    expect(
      describeReviewThreadsLoad({ ...SETTLED, states: null })
    ).toMatchObject({ kind: 'ready', resolvedKnown: false });
  });

  test('waits for attachable threads to reach the diff', () => {
    expect(
      describeReviewThreadsLoad({ ...SETTLED, threadsApplied: false })
    ).toEqual({ kind: 'loading' });
  });

  test('waits for the diff before placing threads', () => {
    expect(
      describeReviewThreadsLoad({
        ...SETTLED,
        attachableRootIds: new Set(),
        loadState: 'streaming',
        threadsApplied: false,
      })
    ).toEqual({ kind: 'loading' });
  });

  test('a pull without threads settles while the diff still streams', () => {
    expect(
      describeReviewThreadsLoad({
        ...SETTLED,
        attachableRootIds: new Set(),
        loadState: 'streaming',
        rootIds: [],
        states: new Map(),
        threadsApplied: false,
      })
    ).toEqual({
      kind: 'ready',
      detachedCounts: { resolved: 0, total: 0 },
      resolvedKnown: true,
    });
  });

  test('an empty diff counts every thread as detached', () => {
    // No viewer mounts for an empty diff, so threads are never applied.
    expect(
      describeReviewThreadsLoad({
        ...SETTLED,
        loadState: 'empty',
        threadsApplied: false,
      })
    ).toEqual({
      kind: 'ready',
      detachedCounts: { resolved: 1, total: 3 },
      resolvedKnown: true,
    });
  });

  test('loading until the comments and states both settle', () => {
    expect(describeReviewThreadsLoad({ ...SETTLED, rootIds: null })).toEqual({
      kind: 'loading',
    });
    expect(
      describeReviewThreadsLoad({ ...SETTLED, statesSettled: false })
    ).toEqual({ kind: 'loading' });
  });

  test('a failed comment fetch is unavailable', () => {
    expect(
      describeReviewThreadsLoad({
        ...SETTLED,
        rootIds: null,
        threadsFailed: true,
      })
    ).toEqual({ kind: 'unavailable' });
  });
});

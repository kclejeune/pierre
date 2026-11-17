import type { PullReviewThreadState, ViewerLoadState } from './types';

// How far the review threads have loaded, for consumers (the pull overview's
// Comments cell) that must not mistake "not fetched yet" or "fetch failed"
// for "this pull has no conversations".
//
// Once `ready`, a pull's conversations are the threads in the diff, counted
// from the sidebar entries (which resolves and replies keep live), plus
// `detachedCounts`: threads that can never reach the diff, because GitHub
// marks them outdated (no current line to anchor to), their file isn't part
// of this diff (e.g. a commit-range view), or there is no viewer at all (an
// empty or failed diff). Those have no card, so their fetched resolution
// stays accurate.
//
// `resolvedKnown` is false unless every thread has a resolution state:
// without a token, when the GraphQL request failed, or when it returned only
// some pages (a later page failed, or the page cap was hit).
export type PullReviewThreadsLoad =
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | {
      kind: 'ready';
      detachedCounts: { resolved: number; total: number };
      resolvedKnown: boolean;
    };

// Derives PullReviewThreadsLoad from usePullReviewThreads' fetch state. Pure
// so the settling and counting rules can be tested without rendering the
// hook.
export function describeReviewThreadsLoad({
  attachableRootIds,
  loadState,
  rootIds,
  states,
  statesSettled,
  threadsApplied,
  threadsFailed,
}: {
  // Roots of the threads that can be shown in this diff: anchored to a
  // current line (or the whole file) in a file the diff contains.
  attachableRootIds: ReadonlySet<number>;
  loadState: ViewerLoadState;
  // The first comment of every review thread on the pull, outdated ones
  // included; null until the comment fetch resolves.
  rootIds: readonly number[] | null;
  // Resolution by root comment id; null without a token or when the request
  // failed. May cover only some threads (see resolvedKnown).
  states: ReadonlyMap<number, PullReviewThreadState> | null;
  // The resolution request finished (or was never sent, without a token).
  statesSettled: boolean;
  // The attachable threads have been injected into the viewer, so the
  // sidebar holds them.
  threadsApplied: boolean;
  threadsFailed: boolean;
}): PullReviewThreadsLoad {
  if (threadsFailed) {
    return { kind: 'unavailable' };
  }
  if (rootIds == null || !statesSettled) {
    return { kind: 'loading' };
  }
  const viewerless = loadState === 'empty' || loadState === 'error';
  // With threads to place, wait until the diff says which files it has and
  // the attachable threads are in it; a pull without threads needn't wait.
  if (
    rootIds.length > 0 &&
    !viewerless &&
    (loadState !== 'ready' || (attachableRootIds.size > 0 && !threadsApplied))
  ) {
    return { kind: 'loading' };
  }
  const detached = viewerless
    ? rootIds
    : rootIds.filter((rootId) => !attachableRootIds.has(rootId));
  return {
    kind: 'ready',
    detachedCounts: {
      resolved: detached.filter(
        (rootId) => states?.get(rootId)?.isResolved === true
      ).length,
      total: detached.length,
    },
    // Coverage, not the map's presence: a partial map leaves some threads'
    // resolution unknown.
    resolvedKnown:
      states != null && rootIds.every((rootId) => states.has(rootId)),
  };
}

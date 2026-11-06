import type { PullReviewThread, PullReviewThreadState } from './types';
import { asRecord } from './untypedJson';

// The PullRequestReviewThread fields a thread's resolution status is read
// from, shared by the pull-comments read and the resolve mutations so both
// return the same shape.
export const REVIEW_THREAD_STATE_FIELDS = `
  id
  isResolved
  resolvedBy { login }
  viewerCanResolve
  viewerCanUnresolve
`;

// Reads a thread state as the app's API routes send it, or null when the id
// or resolved flag is missing.
export function readReviewThreadState(
  value: unknown
): PullReviewThreadState | null {
  const record = asRecord(value);
  if (
    typeof record?.nodeId !== 'string' ||
    record.nodeId === '' ||
    typeof record.isResolved !== 'boolean'
  ) {
    return null;
  }
  return {
    isResolved: record.isResolved,
    nodeId: record.nodeId,
    resolvedBy:
      typeof record.resolvedBy === 'string' ? record.resolvedBy : null,
    viewerCanResolve: record.viewerCanResolve === true,
    viewerCanUnresolve: record.viewerCanUnresolve === true,
  };
}

// Reads a PullRequestReviewThread GraphQL node (REVIEW_THREAD_STATE_FIELDS)
// by mapping its GraphQL names onto the wire shape.
export function readReviewThreadNode(
  node: unknown
): PullReviewThreadState | null {
  const record = asRecord(node);
  return readReviewThreadState({
    ...record,
    nodeId: record?.id,
    resolvedBy: asRecord(record?.resolvedBy)?.login,
  });
}

// Whether two states would render the same (absent counts as its own value).
export function isSameReviewThreadState(
  a: PullReviewThreadState | undefined,
  b: PullReviewThreadState | undefined
): boolean {
  return (
    a === b ||
    (a != null &&
      b != null &&
      a.nodeId === b.nodeId &&
      a.isResolved === b.isResolved &&
      a.resolvedBy === b.resolvedBy &&
      a.viewerCanResolve === b.viewerCanResolve &&
      a.viewerCanUnresolve === b.viewerCanUnresolve)
  );
}

// Attaches each thread's resolution status, keyed by the REST id of the
// thread's first comment (`rootId`).
export function applyReviewThreadStates(
  threads: readonly PullReviewThread[],
  states: ReadonlyMap<number, PullReviewThreadState>
): PullReviewThread[] {
  return threads.map((thread) => {
    const state = states.get(thread.rootId);
    return state == null ? thread : { ...thread, state };
  });
}

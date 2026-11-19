import { notifyPullChanged } from './pullChangeEvents';
import { postPullJSON, type PullRequestRef } from './pullCommentsClient';
import type { PullMergeQueueStatus } from './pullInfoClient';

export type PullMergeMethod = 'merge' | 'rebase' | 'squash';

export interface PullMergeResult {
  message?: string;
  merged: boolean;
  // The resulting merge (or head, for rebases) commit on the base branch.
  sha?: string;
}

// Client wrapper for /api/pull-merge — GitHub's "Merge pull request" button.
// `expectedHeadSha` pins the merge to the head the viewer reviewed; the
// request fails (409, surfaced as APIRequestError) if the branch moved.
export async function mergePullRequest(
  pull: PullRequestRef,
  token: string,
  method: PullMergeMethod,
  expectedHeadSha?: string
): Promise<PullMergeResult> {
  const result = (await postPullJSON('/api/pull-merge', pull, token, {
    expectedHeadSha,
    method,
  })) as PullMergeResult;
  if (result.merged) {
    notifyPullChanged(pull);
  }
  return result;
}

export type MergeQueueAction = 'cancel-auto-merge' | 'dequeue' | 'enqueue';

// Client wrapper for /api/pull-merge-queue: 'enqueue' is GitHub's "Merge when
// ready", which queues the pull now or once its required checks pass.
// Resolves to the pull's queue status afterward (null if the queue is gone).
export async function updateMergeQueue(
  pull: PullRequestRef,
  token: string,
  action: MergeQueueAction,
  expectedHeadSha?: string
): Promise<PullMergeQueueStatus | null> {
  const result = (await postPullJSON('/api/pull-merge-queue', pull, token, {
    action,
    expectedHeadSha,
  })) as { mergeQueue: PullMergeQueueStatus | null };
  return result.mergeQueue;
}

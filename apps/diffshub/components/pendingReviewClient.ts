'use client';

import {
  readStoredGitHubToken,
  storedGitHubTokenHeaders,
} from './githubSession';
import type {
  PendingReviewPayload,
  RemotePendingReview,
} from '@/lib/pendingReview';
import {
  postPullJSON,
  pullParams,
  type PullRequestRef,
  type PullReviewDraftComment,
  type PullReviewEvent,
  requestJSON,
} from '@/lib/pullCommentsClient';

// Browser-side wrappers over /api/pull-review, the viewer's pending review
// on GitHub. Failures throw user-presentable Errors (APIRequestError carries
// the route's `code`, e.g. 'stale-review').

export async function fetchPendingReview(
  pull: PullRequestRef,
  signal?: AbortSignal
): Promise<RemotePendingReview | null> {
  const payload = (await requestJSON(`/api/pull-review?${pullParams(pull)}`, {
    headers: storedGitHubTokenHeaders(),
    signal,
  })) as Partial<PendingReviewPayload>;
  return payload.review ?? null;
}

function postAction(
  pull: PullRequestRef,
  action: string,
  fields: object
): Promise<unknown> {
  return postPullJSON('/api/pull-review', pull, readStoredGitHubToken(), {
    ...fields,
    action,
  });
}

// Adds a draft to the pending review `reviewId`, or (without one) to the
// viewer's pending review, starting one pinned to `commitId` when there is
// none. Resolves to the review's and the new comment's node ids.
export async function addPendingComment(
  pull: PullRequestRef,
  commitId: string,
  reviewId: string | undefined,
  comment: PullReviewDraftComment
): Promise<{ commentId: string; reviewId: string }> {
  const payload = (await postAction(pull, 'add', {
    comment,
    commitId,
    reviewId,
  })) as {
    commentId?: unknown;
    reviewId?: unknown;
  };
  if (
    typeof payload.commentId !== 'string' ||
    typeof payload.reviewId !== 'string'
  ) {
    throw new Error('GitHub returned an unexpected draft payload.');
  }
  return { commentId: payload.commentId, reviewId: payload.reviewId };
}

export async function editPendingComment(
  pull: PullRequestRef,
  commentId: string,
  body: string
): Promise<void> {
  await postAction(pull, 'edit', { body, commentId });
}

export async function deletePendingComment(
  pull: PullRequestRef,
  commentId: string
): Promise<void> {
  await postAction(pull, 'delete', { commentId });
}

export async function submitPendingReview(
  pull: PullRequestRef,
  reviewId: string,
  event: PullReviewEvent,
  body: string
): Promise<void> {
  await postAction(pull, 'submit', { body, event, reviewId });
}

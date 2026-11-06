'use client';

import { readStoredGitHubToken } from './githubSession';
import {
  buildHeaders,
  pullParams,
  type PullRequestRef,
  requestJSON,
} from '@/lib/pullCommentsClient';
import { readReviewThreadState } from '@/lib/reviewThreadState';
import type { PullReviewThreadState } from '@/lib/types';
import { asRecord } from '@/lib/untypedJson';

// Browser-side wrapper over /api/review-threads: marks the review thread
// whose GraphQL node id is `threadId` resolved (or open again) and returns
// GitHub's updated state. Failures throw user-presentable Errors.
export async function setReviewThreadResolved(
  threadId: string,
  resolved: boolean
): Promise<PullReviewThreadState> {
  const payload = await requestJSON('/api/review-threads', {
    method: 'POST',
    headers: {
      ...buildHeaders(readStoredGitHubToken()),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ resolved, threadId }),
  });
  const state = readReviewThreadState(payload);
  if (state == null) {
    throw new Error('GitHub did not return the updated conversation.');
  }
  return state;
}

// The resolution status of the thread a just-posted comment (REST id
// `rootId`) started, so a new conversation gets the same resolve control as
// loaded ones; null when GitHub doesn't list the thread yet.
export async function fetchNewReviewThreadState(
  pull: PullRequestRef,
  rootId: number
): Promise<PullReviewThreadState | null> {
  const params = pullParams(pull);
  params.set('rootId', String(rootId));
  const payload = await requestJSON(`/api/review-threads?${params}`, {
    headers: buildHeaders(readStoredGitHubToken()),
  });
  return readReviewThreadState(asRecord(payload)?.state);
}

// Every review thread's resolution status on `pull`, by the REST id of the
// thread's first comment. Needs a token (GraphQL has no anonymous access).
export async function fetchReviewThreadStates(
  pull: PullRequestRef,
  token: string,
  signal?: AbortSignal
): Promise<Map<number, PullReviewThreadState>> {
  const payload = await requestJSON(`/api/review-threads?${pullParams(pull)}`, {
    headers: buildHeaders(token),
    signal,
  });
  const states = new Map<number, PullReviewThreadState>();
  for (const [rootId, value] of Object.entries(
    asRecord(asRecord(payload)?.threads) ?? {}
  )) {
    const state = readReviewThreadState(value);
    if (state != null) {
      states.set(Number(rootId), state);
    }
  }
  return states;
}

import { type NextRequest } from 'next/server';

import {
  commitErrorResponse,
  sendGitHubGraphQL,
} from '@/lib/githubCommitServer';
import {
  fetchPullMergeQueue,
  readPullBodyRef,
} from '@/lib/githubPullDetailsServer';
import { createJSONResponse } from '@/lib/jsonResponse';
import { parseJSONBody } from '@/lib/parseJSONBody';
import type { MergeQueueAction } from '@/lib/pullMergeClient';
import { withRequestLog } from '@/lib/requestLog';
import { resolveBearerToken } from '@/lib/resolveBearerToken';

// The mutation behind each action. 'enqueue' is GitHub's "Merge when ready":
// a pull that could merge now joins the queue directly (ENQUEUE_NOW), and any
// other gets auto-merge with no method (the queue sets it), which queues it
// once its required checks and reviews pass. Auto-merge alone isn't enough
// for a ready pull: GitHub can refuse it there, or where the repo disables
// auto-merge. 'dequeue' removes a queued pull; 'cancel-auto-merge' drops a
// pending auto-merge before it's queued.
const ENQUEUE_NOW = `mutation ($pullId: ID!, $expectedHeadOid: GitObjectID) {
  enqueuePullRequest(input: { pullRequestId: $pullId, expectedHeadOid: $expectedHeadOid }) { clientMutationId }
}`;
const QUEUE_MUTATIONS: Readonly<Record<MergeQueueAction, string>> = {
  enqueue: `mutation ($pullId: ID!, $expectedHeadOid: GitObjectID) {
    enablePullRequestAutoMerge(input: { pullRequestId: $pullId, expectedHeadOid: $expectedHeadOid }) { clientMutationId }
  }`,
  dequeue: `mutation ($pullId: ID!) {
    dequeuePullRequest(input: { id: $pullId }) { clientMutationId }
  }`,
  'cancel-auto-merge': `mutation ($pullId: ID!) {
    disablePullRequestAutoMerge(input: { pullRequestId: $pullId }) { clientMutationId }
  }`,
};

function isMergeQueueAction(value: unknown): value is MergeQueueAction {
  return typeof value === 'string' && Object.hasOwn(QUEUE_MUTATIONS, value);
}

// Adds the pull to, or removes it from, its base branch's merge queue on the
// viewer's behalf, then answers with where the pull stands afterward, read
// back from GitHub rather than inferred from the mutation. `expectedHeadSha`
// pins an enqueue to the head the viewer reviewed.
async function handlePOST(request: NextRequest) {
  const token = await resolveBearerToken(request);
  if (token == null) {
    return createJSONResponse(
      { error: 'The merge queue requires signing in or saving a token.' },
      { status: 401 }
    );
  }
  const body = await parseJSONBody(request);
  const ref = readPullBodyRef(body);
  const action = body?.action;
  const expectedHeadSha = body?.expectedHeadSha;
  if (
    ref == null ||
    !isMergeQueueAction(action) ||
    (expectedHeadSha != null && typeof expectedHeadSha !== 'string')
  ) {
    return createJSONResponse(
      {
        error:
          'owner, repo, pull, and a valid merge queue action are required.',
      },
      { status: 400 }
    );
  }

  try {
    const { pullId, readyToQueue, status } = await fetchPullMergeQueue(
      ref,
      ref.pull,
      token
    );
    if (pullId == null || status == null) {
      return createJSONResponse(
        { error: "This pull request's base branch has no merge queue." },
        { status: 409 }
      );
    }
    await sendGitHubGraphQL(
      action === 'enqueue' && readyToQueue
        ? ENQUEUE_NOW
        : QUEUE_MUTATIONS[action],
      action === 'enqueue'
        ? { expectedHeadOid: expectedHeadSha, pullId }
        : { pullId },
      token
    );
    const after = await fetchPullMergeQueue(ref, ref.pull, token);
    return createJSONResponse({ mergeQueue: after.status });
  } catch (error) {
    return commitErrorResponse(error);
  }
}

export const POST = withRequestLog(handlePOST);

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

// The mutation behind each action. 'enqueue' turns on auto-merge without a
// method, as `gh pr merge` does on queue branches: GitHub queues the pull now
// if its required checks pass, or once they do. 'dequeue' removes a queued
// pull; 'cancel-auto-merge' drops a pending auto-merge before it's queued.
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
    const { pullId, status } = await fetchPullMergeQueue(ref, ref.pull, token);
    if (pullId == null || status == null) {
      return createJSONResponse(
        { error: "This pull request's base branch has no merge queue." },
        { status: 409 }
      );
    }
    await sendGitHubGraphQL(
      QUEUE_MUTATIONS[action],
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

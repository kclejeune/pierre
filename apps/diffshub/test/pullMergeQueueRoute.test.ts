import { describe, expect, test } from 'bun:test';
import { NextRequest } from 'next/server';

import { POST } from '../app/api/pull-merge-queue/route';
import { useCleanPreferenceRouteEnvironment } from './helpers/preferenceRouteKit';
import { type RecordedRequest, recordFetch } from './helpers/recordFetch';

interface GraphQLBody {
  query: string;
  variables: Record<string, unknown>;
}

const NOT_QUEUED = {
  id: 'PR_7',
  isMergeQueueEnabled: true,
  mergeQueueEntry: null,
  autoMergeRequest: null,
};

function isMutation(request: RecordedRequest): boolean {
  return (request.body as GraphQLBody).query.trimStart().startsWith('mutation');
}

// Answers the pull's queue reads with `before`, then with `after` once a
// mutation has run, and each mutation with an empty payload.
function stubQueue(
  before: Record<string, unknown>,
  after: Record<string, unknown> = before
): RecordedRequest[] {
  let mutated = false;
  return recordFetch((request) => {
    if (isMutation(request)) {
      mutated = true;
      return Response.json({ data: {} });
    }
    return Response.json({
      data: { repository: { pullRequest: mutated ? after : before } },
    });
  });
}

function mutationsIn(requests: RecordedRequest[]): GraphQLBody[] {
  return requests.filter(isMutation).map((r) => r.body as GraphQLBody);
}

function queueRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('https://diffshub.test/api/pull-merge-queue', {
    body: JSON.stringify({
      owner: 'mimosa',
      repo: 'overlay',
      pull: '7',
      ...body,
    }),
    headers: {
      Authorization: 'Bearer ghu_queue',
      'Content-Type': 'application/json',
    },
    method: 'POST',
  });
}

describe('pull-merge-queue', () => {
  useCleanPreferenceRouteEnvironment();

  // Like `gh pr merge` on a queue branch: auto-merge with no method, pinned
  // to the reviewed head, then the pull's status read back from GitHub.
  test('enqueue enables auto-merge pinned to the head sha', async () => {
    const requests = stubQueue(NOT_QUEUED, {
      ...NOT_QUEUED,
      mergeQueueEntry: { position: 4, state: 'QUEUED' },
    });
    const response = await POST(
      queueRequest({ action: 'enqueue', expectedHeadSha: 'abc' })
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      mergeQueue: {
        entry: { position: 4, state: 'QUEUED' },
        pendingAutoMerge: false,
      },
    });
    const [mutation, ...others] = mutationsIn(requests);
    expect(others).toHaveLength(0);
    expect(mutation?.query).toContain('enablePullRequestAutoMerge');
    expect(mutation?.query).not.toContain('mergeMethod');
    expect(mutation?.variables).toEqual({
      expectedHeadOid: 'abc',
      pullId: 'PR_7',
    });
  });

  test('dequeue removes the pull by its node id', async () => {
    const requests = stubQueue(
      { ...NOT_QUEUED, mergeQueueEntry: { position: 1, state: 'QUEUED' } },
      NOT_QUEUED
    );
    const response = await POST(queueRequest({ action: 'dequeue' }));
    expect(await response.json()).toEqual({
      mergeQueue: { entry: null, pendingAutoMerge: false },
    });
    const [mutation] = mutationsIn(requests);
    expect(mutation?.query).toContain('dequeuePullRequest');
    expect(mutation?.variables).toEqual({ pullId: 'PR_7' });
  });

  test('refuses a branch without a merge queue', async () => {
    const requests = stubQueue({ ...NOT_QUEUED, isMergeQueueEnabled: false });
    const response = await POST(queueRequest({ action: 'enqueue' }));
    expect(response.status).toBe(409);
    expect(mutationsIn(requests)).toHaveLength(0);
  });

  test('rejects unknown actions without calling GitHub', async () => {
    const requests = stubQueue(NOT_QUEUED);
    for (const action of ['toString', undefined]) {
      expect((await POST(queueRequest({ action }))).status).toBe(400);
    }
    expect(requests).toHaveLength(0);
  });
});

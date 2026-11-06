import { type NextRequest } from 'next/server';

import {
  commitErrorResponse,
  sendGitHubGraphQL,
} from '@/lib/githubCommitServer';
import { createJSONResponse } from '@/lib/jsonResponse';
import { parseJSONBody } from '@/lib/parseJSONBody';
import { withRequestLog } from '@/lib/requestLog';
import { resolveBearerToken } from '@/lib/resolveBearerToken';
import {
  fetchNewReviewThreadState,
  fetchReviewThreadStates,
} from '@/lib/reviewThreadsServer';
import {
  readReviewThreadNode,
  REVIEW_THREAD_STATE_FIELDS,
} from '@/lib/reviewThreadState';
import { asRecord } from '@/lib/untypedJson';

// Reads and changes pull request review threads' resolution status:
//   GET  ?owner&repo&pull        → {threads}: every thread's state, keyed by
//        the REST id of its first comment
//   GET  ?owner&repo&pull&rootId → {state}: the state of the thread a
//        just-posted comment (REST id `rootId`) started, or null when GitHub
//        doesn't list it yet
//   POST {threadId, resolved}    → resolves or reopens the thread; returns
//        its updated state
// States are {isResolved, nodeId, resolvedBy, viewerCanResolve,
// viewerCanUnresolve}. threadId is a state's nodeId. Everything requires the
// requester's own token: GraphQL has no anonymous access. Thread states are
// read separately from /api/pull-comments so the comments, which don't need
// them, render without waiting on the GraphQL paging.

const SEGMENT = /^[\w.-]+$/;
const NUMBER = /^\d+$/;

async function handleGET(request: NextRequest) {
  const token = await resolveBearerToken(request);
  if (token == null) {
    return createJSONResponse(
      { error: 'Reading conversations requires signing in or saving a token.' },
      { status: 401 }
    );
  }
  const params = request.nextUrl.searchParams;
  const owner = params.get('owner') ?? '';
  const repo = params.get('repo') ?? '';
  const pull = params.get('pull') ?? '';
  const rootId = params.get('rootId');
  if (
    !SEGMENT.test(owner) ||
    !SEGMENT.test(repo) ||
    !NUMBER.test(pull) ||
    (rootId != null && !NUMBER.test(rootId))
  ) {
    return createJSONResponse(
      { error: 'owner, repo, and pull parameters are required.' },
      { status: 400 }
    );
  }
  try {
    if (rootId == null) {
      return createJSONResponse({
        threads: await fetchReviewThreadStates(
          owner,
          repo,
          Number(pull),
          token,
          request.signal
        ),
      });
    }
    return createJSONResponse({
      state: await fetchNewReviewThreadState(
        owner,
        repo,
        Number(pull),
        Number(rootId),
        token,
        request.signal
      ),
    });
  } catch (error) {
    return commitErrorResponse(error);
  }
}

// resolveReviewThread and unresolveReviewThread take the same input and
// return the thread.
function threadMutation(resolved: boolean): {
  field: string;
  query: string;
} {
  const field = resolved ? 'resolveReviewThread' : 'unresolveReviewThread';
  return {
    field,
    query: `mutation ($id: ID!) {
      ${field}(input: { threadId: $id }) {
        thread { ${REVIEW_THREAD_STATE_FIELDS} }
      }
    }`,
  };
}

async function handlePOST(request: NextRequest) {
  const token = await resolveBearerToken(request);
  if (token == null) {
    return createJSONResponse(
      {
        error:
          'Resolving a conversation requires signing in or saving a token.',
      },
      { status: 401 }
    );
  }
  const payload = await parseJSONBody(request);
  const threadId = payload?.threadId;
  const resolved = payload?.resolved;
  if (
    typeof threadId !== 'string' ||
    threadId === '' ||
    typeof resolved !== 'boolean'
  ) {
    return createJSONResponse(
      { error: 'threadId and resolved are required.' },
      { status: 400 }
    );
  }
  const { field, query } = threadMutation(resolved);
  try {
    const data = asRecord(
      await sendGitHubGraphQL(query, { id: threadId }, token)
    );
    const state = readReviewThreadNode(asRecord(data?.[field])?.thread);
    if (state == null) {
      return createJSONResponse(
        { error: 'GitHub did not return the updated conversation.' },
        { status: 502 }
      );
    }
    return createJSONResponse(state);
  } catch (error) {
    return commitErrorResponse(error);
  }
}

export const GET = withRequestLog(handleGET);
export const POST = withRequestLog(handlePOST);

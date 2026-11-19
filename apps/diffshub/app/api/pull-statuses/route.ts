import { type NextRequest } from 'next/server';

import { commitErrorResponse } from '@/lib/githubCommitServer';
import { rejectTokenlessRequestWhenLoginRequired } from '@/lib/githubEnvironment';
import {
  isGitHubTimestamp,
  isValidNodeId,
  MAX_PULL_STATUS_IDS,
} from '@/lib/githubPullSummaries';
import {
  createJSONResponse,
  createPrivateJSONResponse,
} from '@/lib/jsonResponse';
import { readCachedPullStatuses } from '@/lib/pullStatusesServer';
import { withRequestLog } from '@/lib/requestLog';
import { resolveBearerToken } from '@/lib/resolveBearerToken';

// CI and review state for the /pulls rows, read after the list itself
// (?ids= is a comma list of the rows' GraphQL node ids, and the optional
// ?v= the rows' updatedAt in the same order, which keys the server's
// short-lived status cache). The list search
// leaves these out because they cost GitHub more than the search; this
// route reads them in parallel chunks (readPullStatuses) and answers
// { statuses: { [nodeId]: { checks?, reviewDecision? } } }. Pulls the token
// can't read are simply missing from `statuses`.
async function handleGET(request: NextRequest) {
  const rejection = rejectTokenlessRequestWhenLoginRequired(request);
  if (rejection != null) {
    return rejection;
  }
  const idsParam = request.nextUrl.searchParams.get('ids') ?? '';
  const ids = idsParam === '' ? [] : idsParam.split(',');
  if (
    ids.length === 0 ||
    ids.length > MAX_PULL_STATUS_IDS ||
    !ids.every(isValidNodeId)
  ) {
    return createJSONResponse(
      {
        error: `ids must list 1 to ${MAX_PULL_STATUS_IDS} pull request node ids.`,
      },
      { status: 400 }
    );
  }
  const versionsParam = request.nextUrl.searchParams.get('v');
  const versions = versionsParam == null ? [] : versionsParam.split(',');
  if (
    versionsParam != null &&
    (versions.length !== ids.length || !versions.every(isGitHubTimestamp))
  ) {
    return createJSONResponse(
      { error: 'v must list one updatedAt timestamp per id.' },
      { status: 400 }
    );
  }
  const token = await resolveBearerToken(request);
  if (token == null) {
    return createJSONResponse(
      { error: 'A GitHub token is required to read pull request statuses.' },
      { status: 401 }
    );
  }
  try {
    const statuses = await readCachedPullStatuses(ids, versions, token);
    // No browser caching on top of the client's and the server's caches.
    return createPrivateJSONResponse({ statuses }, 0);
  } catch (error) {
    return commitErrorResponse(error);
  }
}

export const GET = withRequestLog(handleGET);

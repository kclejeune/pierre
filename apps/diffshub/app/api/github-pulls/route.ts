import { type NextRequest } from 'next/server';

import {
  commitErrorResponse,
  sendGitHubGraphQL,
} from '@/lib/githubCommitServer';
import { rejectTokenlessRequestWhenLoginRequired } from '@/lib/githubEnvironment';
import { githubFetch } from '@/lib/githubFetch';
import {
  ACTIVE_PULLS_QUERY,
  buildActivePullsVariables,
  decodePullsCursor,
  isReviewRequestScope,
  parseActivePullsPayload,
  parsePullInvolvements,
  type PullAudience,
} from '@/lib/githubPullSummaries';
import {
  createJSONResponse,
  createPrivateJSONResponse,
} from '@/lib/jsonResponse';
import { isValidRepoName, MAX_PINNED_REPOS } from '@/lib/pinnedRepos';
import { DEFAULT_QUERY_TEXT } from '@/lib/pullScopes';
import { hasNarrowingQualifier } from '@/lib/pullSearchQuery';
import { withRequestLog } from '@/lib/requestLog';
import { resolveBearerToken } from '@/lib/resolveBearerToken';

// Pull request lists for the /pulls dashboard: one GraphQL search per page,
// built from the viewer's involvement terms (?involves=, or "anyone"), an
// optional repository scope (?repos=), the query bar's GitHub search text
// (?q=), and a page cursor (?cursor=) echoed back from the previous page.

// GitHub rejects search text much longer than this, so fail fast with a
// message the query bar can show.
const MAX_QUERY_TEXT_LENGTH = 256;

async function handleGET(request: NextRequest) {
  const rejection = rejectTokenlessRequestWhenLoginRequired(request);
  if (rejection != null) {
    return rejection;
  }

  const params = request.nextUrl.searchParams;
  const involvesParam = params.get('involves') ?? '';
  const involves: PullAudience | undefined =
    involvesParam === 'anyone'
      ? 'anyone'
      : parsePullInvolvements(involvesParam);
  if (involves == null) {
    return createJSONResponse(
      {
        error:
          'involves must be anyone or list review-requested, authored, reviewed, commented, or assigned.',
      },
      { status: 400 }
    );
  }
  const reposParam = params.get('repos') ?? '';
  const repos = reposParam === '' ? [] : reposParam.split(',');
  if (repos.length > MAX_PINNED_REPOS || !repos.every(isValidRepoName)) {
    return createJSONResponse(
      { error: 'repos must be a short list of owner/name repositories.' },
      { status: 400 }
    );
  }
  // Requests from before the query bar existed carry no ?q=; they listed
  // open pulls, which is also the bar's default.
  const text = (params.get('q') ?? DEFAULT_QUERY_TEXT).trim();
  if (text.length > MAX_QUERY_TEXT_LENGTH) {
    return createJSONResponse(
      {
        error: `Search text is limited to ${MAX_QUERY_TEXT_LENGTH} characters.`,
      },
      { status: 400 }
    );
  }
  // "Anyone" without a repository scope or a repo:/org:/user: qualifier would
  // search every pull request on the instance.
  if (
    involves === 'anyone' &&
    repos.length === 0 &&
    !hasNarrowingQualifier(text)
  ) {
    return createJSONResponse(
      {
        error:
          'involves=anyone needs repos or a repo:, org:, or user: qualifier.',
      },
      { status: 400 }
    );
  }
  const reviewRequests = params.get('requests') ?? 'direct';
  if (!isReviewRequestScope(reviewRequests)) {
    return createJSONResponse(
      { error: 'requests must be direct or teams.' },
      { status: 400 }
    );
  }
  const cursorParam = params.get('cursor');
  const cursor =
    cursorParam == null ? undefined : decodePullsCursor(cursorParam);
  if (cursorParam != null && cursor == null) {
    return createJSONResponse(
      { error: 'cursor is not a page cursor from this endpoint.' },
      { status: 400 }
    );
  }
  // GitHub's GraphQL search needs a token, and the @me qualifiers resolve to
  // whoever it belongs to.
  const token = await resolveBearerToken(request);
  if (token == null) {
    return createJSONResponse(
      { error: 'A GitHub token is required to search pull requests.' },
      { status: 401 }
    );
  }
  // GraphQL rather than REST search: one request returns the page along
  // with the viewer's involvement per pull.
  try {
    return createPrivateJSONResponse(
      parseActivePullsPayload(
        await sendGitHubGraphQL(
          ACTIVE_PULLS_QUERY,
          buildActivePullsVariables(
            { involves, repos, reviewRequests, text },
            cursor
          ),
          token,
          // A superseded search (the client aborts on each change) stops
          // the GitHub call too.
          (url, init) => githubFetch(url, { ...init, signal: request.signal })
        ),
        cursor
      ),
      30
    );
  } catch (error) {
    return commitErrorResponse(error);
  }
}

export const GET = withRequestLog(handleGET);

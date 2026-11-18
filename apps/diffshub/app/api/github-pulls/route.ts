import { type NextRequest } from 'next/server';

import {
  ACCESS_FIELD_ERRORS,
  commitErrorResponse,
  type GraphQLErrorTolerance,
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
import { isValidMutedAuthor, MAX_MUTED_AUTHORS } from '@/lib/mutedAuthors';
import { isValidRepoName, MAX_PINNED_REPOS } from '@/lib/pinnedRepos';
import { DEFAULT_QUERY_TEXT } from '@/lib/pullScopes';
import { hasNarrowingQualifier } from '@/lib/pullSearchQuery';
import { withRequestLog } from '@/lib/requestLog';
import { resolveBearerToken } from '@/lib/resolveBearerToken';
import { emitLogLine } from '@/lib/serverLog';

// Pull request lists for the /pulls dashboard: one GraphQL search per page,
// built from the viewer's involvement terms (?involves=, or "anyone"), an
// optional repository scope (?repos=), the query bar's GitHub search text
// (?q=), muted authors to leave out (?mute=), and a page cursor (?cursor=)
// echoed back from the previous page.

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
  const muteParam = params.get('mute') ?? '';
  const mutedAuthors = muteParam === '' ? [] : muteParam.split(',');
  if (
    mutedAuthors.length > MAX_MUTED_AUTHORS ||
    !mutedAuthors.every(isValidMutedAuthor)
  ) {
    return createJSONResponse(
      {
        error: `mute must list at most ${MAX_MUTED_AUTHORS} logins or app/ bot names.`,
      },
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
  const scope = { involves, mutedAuthors, repos, reviewRequests, text };
  // GraphQL rather than REST search: one request returns the page along
  // with the viewer's involvement per pull.
  const searchMs: number[] = [];
  const fetchPage = async (pageCursor: typeof cursor) => {
    const startedAt = Date.now();
    const data = await sendGitHubGraphQL(
      ACTIVE_PULLS_QUERY,
      buildActivePullsVariables(scope, pageCursor),
      token,
      // A superseded search (the client aborts on each change) stops the
      // GitHub call too.
      (url, init) => githubFetch(url, { ...init, signal: request.signal }),
      { tolerate: ACTIVE_PULLS_TOLERANCE }
    );
    searchMs.push(Date.now() - startedAt);
    return parseActivePullsPayload(data, pageCursor);
  };
  try {
    let page = await fetchPage(cursor);
    let hiddenCount = page.hiddenCount;
    // Only the first search counts muted pulls; keep it past skipped pages.
    const { mutedCount } = page;
    // Read past pages whose every hit the GitHub App can't read, so the
    // viewer lands on readable rows; time-bounded since GHE searches are slow.
    const skipDeadline = Date.now() + UNREADABLE_SKIP_BUDGET_MS;
    while (
      page.pulls.length === 0 &&
      page.nextCursor != null &&
      Date.now() < skipDeadline
    ) {
      page = await fetchPage(decodePullsCursor(page.nextCursor));
      hiddenCount += page.hiddenCount;
    }
    // Profiles requests that ran several searches or hid unreadable hits.
    if (searchMs.length > 1 || hiddenCount > 0) {
      emitLogLine({
        event: 'github_pulls_search',
        hiddenCount,
        level: 'info',
        searchMs,
      });
    }
    return createPrivateJSONResponse({ ...page, hiddenCount, mutedCount }, 30);
  } catch (error) {
    return commitErrorResponse(error);
  }
}

// How long after the first page a request may keep reading past unreadable
// pages before returning an empty page with a cursor.
const UNREADABLE_SKIP_BUDGET_MS = 3000;

// A GitHub App token searches every repo the user can see but reads only
// those where the app is installed; each other hit is a null node with an
// access error. Those rows are dropped rather than failing the page. The
// paths are ACTIVE_PULLS_QUERY's search aliases.
const ACTIVE_PULLS_TOLERANCE: GraphQLErrorTolerance = {
  types: ACCESS_FIELD_ERRORS,
  paths: [
    ['pulls', 'nodes'],
    ['commented', 'nodes'],
  ],
};

export const GET = withRequestLog(handleGET);

import { type NextRequest } from 'next/server';

import {
  commitErrorResponse,
  sendGitHubGraphQL,
} from '@/lib/githubCommitServer';
import { encodeURLSegment } from '@/lib/githubDiffSource';
import {
  createGitHubAPIURL,
  createGitHubJSONHeaders,
  getGitHubEnvironment,
  rejectTokenlessRequestWhenLoginRequired,
} from '@/lib/githubEnvironment';
import { githubFetch } from '@/lib/githubFetch';
import {
  createGitHubFailureResponse,
  createUnreachableResponse,
  readGitHubJSON,
} from '@/lib/githubProxyResponse';
import {
  ACTIVE_PULLS_QUERY,
  buildActivePullsVariables,
  isReviewRequestScope,
  parseActivePullsPayload,
  parsePullInvolvements,
  parseRepoPullsPayload,
} from '@/lib/githubPullSummaries';
import {
  createJSONResponse,
  createPrivateJSONResponse,
} from '@/lib/jsonResponse';
import { isValidRepoName, MAX_PINNED_REPOS } from '@/lib/pinnedRepos';
import { withRequestLog } from '@/lib/requestLog';
import { resolveBearerToken } from '@/lib/resolveBearerToken';

// Pull request lists for the /pulls dashboard: the "active" list (?involves=,
// a GraphQL search built on @me qualifiers, optionally scoped to one repo for
// pinned-repo cards) and per-repo open pull lists (?repo= alone).

async function handleGET(request: NextRequest) {
  const rejection = rejectTokenlessRequestWhenLoginRequired(request);
  if (rejection != null) {
    return rejection;
  }

  const params = request.nextUrl.searchParams;
  const involvesParam = params.get('involves');
  const repo = params.get('repo');
  if (repo != null && !isValidRepoName(repo)) {
    return createJSONResponse(
      { error: 'repo must look like owner/name.' },
      { status: 400 }
    );
  }

  if (involvesParam != null) {
    const involves = parsePullInvolvements(involvesParam);
    if (involves == null) {
      return createJSONResponse(
        {
          error:
            'involves must list review-requested, authored, reviewed, commented, or assigned.',
        },
        { status: 400 }
      );
    }
    const exclude = params.get('exclude');
    const excludeRepos =
      exclude == null || exclude === '' ? [] : exclude.split(',');
    if (
      excludeRepos.length > MAX_PINNED_REPOS ||
      !excludeRepos.every(isValidRepoName)
    ) {
      return createJSONResponse(
        { error: 'exclude must be a short list of owner/name repos.' },
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
    // The @me qualifiers resolve to whoever the token belongs to, so there
    // is nothing to list without one.
    const token = await resolveBearerToken(request);
    if (token == null) {
      return createJSONResponse(
        { error: 'A GitHub token is required to list your pull requests.' },
        { status: 401 }
      );
    }
    const scope =
      repo != null
        ? { involves, repo, reviewRequests }
        : { excludeRepos, involves, reviewRequests };
    // GraphQL rather than REST search: one request returns the list along
    // with the viewer's involvement per pull.
    try {
      return createPrivateJSONResponse(
        parseActivePullsPayload(
          await sendGitHubGraphQL(
            ACTIVE_PULLS_QUERY,
            buildActivePullsVariables(scope),
            token
          )
        ),
        30
      );
    } catch (error) {
      return commitErrorResponse(error);
    }
  }

  if (repo != null) {
    const [owner, name] = repo.split('/') as [string, string];
    const result = await fetchPullsPayload(
      createGitHubAPIURL(
        getGitHubEnvironment(),
        `/repos/${encodeURLSegment(owner)}/${encodeURLSegment(name)}/pulls`,
        {
          direction: 'desc',
          per_page: '20',
          sort: 'updated',
          state: 'open',
        }
      ),
      await resolveBearerToken(request)
    );
    if (result.error != null) {
      return result.error;
    }
    return createPrivateJSONResponse(
      {
        pulls: parseRepoPullsPayload(owner, name, result.payload),
      },
      30
    );
  }

  return createJSONResponse(
    { error: 'involves or repo is required.' },
    { status: 400 }
  );
}

async function fetchPullsPayload(
  url: string,
  token: string | undefined
): Promise<{ payload?: unknown; error?: Response }> {
  let response: Response;
  try {
    response = await githubFetch(url, {
      headers: createGitHubJSONHeaders(token),
      cache: 'no-store',
    });
  } catch {
    return {
      error: createUnreachableResponse(getGitHubEnvironment(), url),
    };
  }
  if (!response.ok) {
    return {
      error: await createGitHubFailureResponse(response),
    };
  }
  const parsed = await readGitHubJSON(response);
  return parsed.failure != null
    ? { error: parsed.failure }
    : { payload: parsed.data };
}

export const GET = withRequestLog(handleGET);

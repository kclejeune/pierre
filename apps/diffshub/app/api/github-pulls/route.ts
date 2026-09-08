import { type NextRequest } from 'next/server';

import { encodeURLSegment } from '@/lib/githubDiffSource';
import {
  createGitHubAPIURL,
  createGitHubJSONHeaders,
  getGitHubEnvironment,
  rejectTokenlessRequestWhenLoginRequired,
} from '@/lib/githubEnvironment';
import {
  createGitHubFailureResponse,
  createUnreachableResponse,
  readGitHubJSON,
} from '@/lib/githubProxyResponse';
import {
  buildBucketSearchQuery,
  isPullBucket,
  parseRepoPullsPayload,
  parseSearchIssuesPayload,
} from '@/lib/githubPullSummaries';
import { createJSONResponse } from '@/lib/jsonResponse';
import { isValidRepoName, MAX_PINNED_REPOS } from '@/lib/pinnedRepos';
import { withRequestLog } from '@/lib/requestLog';
import { resolveBearerToken } from '@/lib/resolveBearerToken';

// Pull request lists for the /pulls dashboard: cross-repo buckets built on
// @me search qualifiers (optionally scoped to one repo, for pinned-repo cards
// following the active bucket tab), and per-repo open pull lists.

async function handleGET(request: NextRequest) {
  const rejection = rejectTokenlessRequestWhenLoginRequired(request);
  if (rejection != null) {
    return rejection;
  }

  const params = request.nextUrl.searchParams;
  const bucket = params.get('bucket');
  const repo = params.get('repo');
  const environment = getGitHubEnvironment();

  if (bucket != null) {
    if (!isPullBucket(bucket)) {
      return createJSONResponse(
        { error: 'bucket must be created, assigned, or review-requested.' },
        { status: 400 }
      );
    }
    if (repo != null && !isValidRepoName(repo)) {
      return createJSONResponse(
        { error: 'repo must look like owner/name.' },
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
    // The @me qualifiers resolve to whoever the token belongs to, so there
    // is nothing to list without one.
    const token = await resolveBearerToken(request);
    if (token == null) {
      return createJSONResponse(
        { error: 'A GitHub token is required to list your pull requests.' },
        { status: 401 }
      );
    }
    const result = await fetchPullsPayload(
      createGitHubAPIURL(environment, '/search/issues', {
        // advanced_search opts into the post-migration /search/issues
        // semantics ahead of GitHub's legacy cutover; older GHES ignores it.
        advanced_search: 'true',
        order: 'desc',
        per_page: '25',
        q: buildBucketSearchQuery(
          bucket,
          repo != null ? { repo } : { excludeRepos }
        ),
        sort: 'updated',
      }),
      token
    );
    if (result.error != null) {
      return result.error;
    }
    return createJSONResponse(parseSearchIssuesPayload(result.payload));
  }

  if (repo != null) {
    if (!isValidRepoName(repo)) {
      return createJSONResponse(
        { error: 'repo must look like owner/name.' },
        { status: 400 }
      );
    }
    const [owner, name] = repo.split('/') as [string, string];
    const result = await fetchPullsPayload(
      createGitHubAPIURL(
        environment,
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
    return createJSONResponse({
      pulls: parseRepoPullsPayload(owner, name, result.payload),
    });
  }

  return createJSONResponse(
    { error: 'bucket or repo is required.' },
    { status: 400 }
  );
}

async function fetchPullsPayload(
  url: string,
  token: string | undefined
): Promise<{ payload?: unknown; error?: Response }> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: createGitHubJSONHeaders(token),
      cache: 'no-store',
    });
  } catch {
    return { error: createUnreachableResponse(getGitHubEnvironment()) };
  }
  if (!response.ok) {
    return { error: await createGitHubFailureResponse(response) };
  }
  const parsed = await readGitHubJSON(response);
  return parsed.failure != null
    ? { error: parsed.failure }
    : { payload: parsed.data };
}

export const GET = withRequestLog(handleGET);

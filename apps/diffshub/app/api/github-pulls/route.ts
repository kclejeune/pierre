import { type NextRequest } from 'next/server';

import { encodeURLSegment } from '@/lib/githubDiffSource';
import {
  createGitHubAPIURL,
  createGitHubJSONHeaders,
  getGitHubEnvironment,
  resolveRequestGitHubToken,
} from '@/lib/githubEnvironment';
import {
  createGitHubFailureResponse,
  createUnreachableResponse,
} from '@/lib/githubProxyResponse';
import {
  buildBucketSearchQuery,
  isPullBucket,
  parseRepoPullsPayload,
  parseSearchIssuesPayload,
} from '@/lib/githubPullSummaries';
import { createJSONResponse } from '@/lib/jsonResponse';
import { parseBearerToken } from '@/lib/parseBearerToken';
import { isValidRepoName } from '@/lib/pinnedRepos';

// Pull request lists for the /pulls dashboard: cross-repo buckets built on
// @me search qualifiers, and per-repo open pull lists for pinned repos.

export async function GET(request: NextRequest) {
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
    // The @me qualifiers resolve to whoever the token belongs to, so the
    // deployment fallback token must never stand in here: it would silently
    // return the fallback identity's pull requests to anonymous viewers.
    const token = parseBearerToken(request.headers.get('authorization'));
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
        q: buildBucketSearchQuery(bucket),
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
      resolveRequestGitHubToken(request)
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
  return { payload: await response.json() };
}

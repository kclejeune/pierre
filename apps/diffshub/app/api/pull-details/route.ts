import { type NextRequest } from 'next/server';

import { commitErrorResponse } from '@/lib/githubCommitServer';
import {
  fetchPullChecks,
  fetchPullMergeCapabilities,
  fetchPullReviewStates,
  readPullRouteParams,
} from '@/lib/githubPullDetailsServer';
import { createJSONResponse } from '@/lib/jsonResponse';
import type { PullDetailsSupplement } from '@/lib/pullInfoClient';
import {
  rejectTokenlessRequestWhenLoginRequired,
  resolveBearerToken,
} from '@/lib/resolveBearerToken';

const COMMIT_SHA_PATTERN = /^[0-9a-f]{7,40}$/i;

// Optional, slower metadata for the pull-details dropdown. Each companion
// request is independent so an unavailable Checks API does not discard legacy
// statuses, reviewer state, or merge capabilities.
export async function GET(request: NextRequest) {
  const rejection = await rejectTokenlessRequestWhenLoginRequired(request);
  if (rejection != null) {
    return rejection;
  }
  const params = readPullRouteParams(request.nextUrl.searchParams);
  if (params instanceof Response) {
    return params;
  }
  const headSha = request.nextUrl.searchParams.get('head');
  if (headSha == null || !COMMIT_SHA_PATTERN.test(headSha)) {
    return createJSONResponse(
      { error: 'A valid head commit is required.' },
      { status: 400 }
    );
  }

  const repo = { owner: params.owner, repo: params.repo };
  const token = await resolveBearerToken(request);
  try {
    const [reviewStates, checks, mergeCapabilities] = await Promise.all([
      fetchPullReviewStates(repo, params.pull, token).catch(() => null),
      fetchPullChecks(repo, headSha, token).catch(() => null),
      token == null
        ? Promise.resolve(null)
        : fetchPullMergeCapabilities(repo, token).catch(() => null),
    ]);
    const payload: PullDetailsSupplement = {
      checks,
      mergeCapabilities,
      reviewers:
        reviewStates == null
          ? null
          : [...reviewStates].map(([login, reviewer]) => ({
              avatarUrl: reviewer.avatarUrl,
              login,
              state: reviewer.state,
            })),
    };
    return createJSONResponse(payload);
  } catch (error) {
    return commitErrorResponse(error);
  }
}

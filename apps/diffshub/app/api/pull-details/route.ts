import { type NextRequest } from 'next/server';

import { commitErrorResponse } from '@/lib/githubCommitServer';
import { rejectTokenlessRequestWhenLoginRequired } from '@/lib/githubEnvironment';
import {
  fetchPullAccess,
  fetchPullChecks,
  fetchPullReviewStates,
  readPullRouteParams,
} from '@/lib/githubPullDetailsServer';
import { createJSONResponse } from '@/lib/jsonResponse';
import type { PullDetailsSupplement } from '@/lib/pullInfoClient';
import { withRequestLog } from '@/lib/requestLog';
import { resolveBearerToken } from '@/lib/resolveBearerToken';

const COMMIT_SHA_PATTERN = /^[0-9a-f]{7,40}$/i;

// Optional, slower metadata for the pull-details dropdown. Each companion
// request is independent so an unavailable Checks API does not discard legacy
// statuses, reviewer state, merge capabilities, or edit permissions.
async function handleGET(request: NextRequest) {
  const rejection = rejectTokenlessRequestWhenLoginRequired(request);
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
    const [reviewStates, checks, access] = await Promise.all([
      fetchPullReviewStates(repo, params.pull, token).catch(() => null),
      fetchPullChecks(repo, headSha, token).catch(() => null),
      token == null
        ? Promise.resolve(null)
        : fetchPullAccess(repo, params.pull, token).catch(() => null),
    ]);
    const payload: PullDetailsSupplement = {
      checks,
      mergeCapabilities: access?.mergeCapabilities ?? null,
      reviewers:
        reviewStates == null
          ? null
          : [...reviewStates].map(([login, reviewer]) => ({
              avatarUrl: reviewer.avatarUrl,
              login,
              state: reviewer.state,
            })),
      viewerPermissions: access?.viewerPermissions ?? null,
    };
    return createJSONResponse(payload);
  } catch (error) {
    return commitErrorResponse(error);
  }
}

export const GET = withRequestLog(handleGET);

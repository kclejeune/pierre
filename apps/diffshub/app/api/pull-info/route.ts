import { type NextRequest } from 'next/server';

import {
  commitErrorResponse,
  fetchPullData,
  parsePullRefs,
} from '@/lib/githubCommitServer';
import {
  parsePullDetails,
  readPullRouteParams,
} from '@/lib/githubPullDetailsServer';
import { createJSONResponse } from '@/lib/jsonResponse';
import type { PullInfo } from '@/lib/pullInfoClient';
import {
  rejectTokenlessRequestWhenLoginRequired,
  resolveBearerToken,
} from '@/lib/resolveBearerToken';

// The pull request's refs plus metadata carried by pulls/{n}. Keep this first
// chrome request to one GitHub round trip; reviews, checks, and viewer merge
// capabilities arrive via the separate /api/pull-details supplement.
export async function GET(request: NextRequest) {
  const rejection = await rejectTokenlessRequestWhenLoginRequired(request);
  if (rejection != null) {
    return rejection;
  }

  const params = readPullRouteParams(request.nextUrl.searchParams);
  if (params instanceof Response) {
    return params;
  }
  const { owner, pull, repo } = params;

  try {
    const data = await fetchPullData(
      { owner, repo },
      pull,
      await resolveBearerToken(request)
    );
    const refs = parsePullRefs(data, { owner, repo });
    const payload: PullInfo = {
      ...refs,
      details: parsePullDetails(data),
      number: pull,
    };
    return createJSONResponse(payload);
  } catch (error) {
    return commitErrorResponse(error);
  }
}

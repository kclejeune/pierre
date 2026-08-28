import { type NextRequest } from 'next/server';

import {
  commitErrorResponse,
  fetchPullData,
  parsePullRefs,
} from '@/lib/githubCommitServer';
import { rejectTokenlessRequestWhenLoginRequired } from '@/lib/githubEnvironment';
import {
  parsePullDetails,
  readPullRouteParams,
} from '@/lib/githubPullDetailsServer';
import { createJSONResponse } from '@/lib/jsonResponse';
import { parseBearerToken } from '@/lib/parseBearerToken';
import type { PullInfo } from '@/lib/pullInfoClient';

// The pull request's refs plus metadata carried by pulls/{n}. Keep this first
// chrome request to one GitHub round trip; reviews, checks, and viewer merge
// capabilities load lazily when the details panel opens.
export async function GET(request: NextRequest) {
  const rejection = rejectTokenlessRequestWhenLoginRequired(request);
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
      parseBearerToken(request.headers.get('authorization'))
    );
    const refs = parsePullRefs(data, { owner, repo });
    const details = parsePullDetails(data);
    const payload: PullInfo = {
      ...refs,
      details: {
        ...details,
        checks: null,
      },
      number: pull,
    };
    return createJSONResponse(payload);
  } catch (error) {
    return commitErrorResponse(error);
  }
}

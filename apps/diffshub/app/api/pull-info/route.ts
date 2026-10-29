import { type NextRequest } from 'next/server';

import {
  commitErrorResponse,
  fetchPullData,
  parsePullRefs,
  pollPullMergeable,
} from '@/lib/githubCommitServer';
import { rejectTokenlessRequestWhenLoginRequired } from '@/lib/githubEnvironment';
import {
  parsePullDetails,
  readPullRouteParams,
} from '@/lib/githubPullDetailsServer';
import { createPrivateJSONResponse } from '@/lib/jsonResponse';
import type { PullInfo } from '@/lib/pullInfoClient';
import { withRequestLog } from '@/lib/requestLog';
import { resolveBearerToken } from '@/lib/resolveBearerToken';

// The pull request's refs plus metadata carried by pulls/{n}. Keep this first
// chrome request to one GitHub round trip; reviews, checks, and viewer merge
// capabilities arrive via the separate /api/pull-details supplement.
//
// `waitMergeable=1` re-reads the pull briefly while GitHub is still
// computing its mergeability. usePullInfo sends it as a follow-up only when
// the first response came back unknown, so the first request stays fast.
async function handleGET(request: NextRequest) {
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
    const token = await resolveBearerToken(request);
    const data =
      request.nextUrl.searchParams.get('waitMergeable') === '1'
        ? await pollPullMergeable({ owner, repo }, pull, token, {
            afterUnknownRead: true,
          })
        : await fetchPullData({ owner, repo }, pull, token);
    const refs = parsePullRefs(data, { owner, repo });
    const payload: PullInfo = {
      ...refs,
      details: parsePullDetails(data),
      number: pull,
    };
    return createPrivateJSONResponse(payload, 15);
  } catch (error) {
    return commitErrorResponse(error);
  }
}

export const GET = withRequestLog(handleGET);

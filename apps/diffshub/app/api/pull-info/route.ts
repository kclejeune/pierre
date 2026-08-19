import { type NextRequest } from 'next/server';

import {
  commitErrorResponse,
  fetchPullData,
  parsePullRefs,
} from '@/lib/githubCommitServer';
import { rejectTokenlessRequestWhenLoginRequired } from '@/lib/githubEnvironment';
import { createJSONResponse } from '@/lib/jsonResponse';
import { parseBearerToken } from '@/lib/parseBearerToken';
import type { PullInfo } from '@/lib/pullInfoClient';

// The pull request's base/head branches, with their repositories (which
// differ for fork pulls). The patch stream carries none of this, so the
// header's base/head display reads it here. Read-only; on github.com
// anonymous visitors still get public-repo pulls labelled without a login.
export async function GET(request: NextRequest) {
  const rejection = rejectTokenlessRequestWhenLoginRequired(request);
  if (rejection != null) {
    return rejection;
  }

  const params = request.nextUrl.searchParams;
  const owner = params.get('owner');
  const repo = params.get('repo');
  const pull = params.get('pull');
  if (owner == null || repo == null || pull == null || !/^\d+$/.test(pull)) {
    return createJSONResponse(
      { error: 'owner, repo, and pull are required.' },
      { status: 400 }
    );
  }

  try {
    const data = await fetchPullData(
      { owner, repo },
      pull,
      parseBearerToken(request.headers.get('authorization'))
    );
    const payload: PullInfo = {
      ...parsePullRefs(data, { owner, repo }),
      number: pull,
    };
    return createJSONResponse(payload);
  } catch (error) {
    return commitErrorResponse(error);
  }
}

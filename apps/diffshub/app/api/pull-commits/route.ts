import { type NextRequest } from 'next/server';

import { commitErrorResponse } from '@/lib/githubCommitServer';
import {
  fetchPullCommitsListing,
  readPullRouteParams,
} from '@/lib/githubPullDetailsServer';
import { createJSONResponse } from '@/lib/jsonResponse';
import {
  rejectTokenlessRequestWhenLoginRequired,
  resolveBearerToken,
} from '@/lib/resolveBearerToken';

// The pull request's commit listing (oldest first), for the viewer's
// commit-range picker. Read-only; on github.com anonymous visitors can list
// public-repo pulls without a login.
export async function GET(request: NextRequest) {
  const rejection = await rejectTokenlessRequestWhenLoginRequired(request);
  if (rejection != null) {
    return rejection;
  }

  const params = readPullRouteParams(request.nextUrl.searchParams);
  if (params instanceof Response) {
    return params;
  }

  try {
    const commits = await fetchPullCommitsListing(
      { owner: params.owner, repo: params.repo },
      params.pull,
      await resolveBearerToken(request)
    );
    return createJSONResponse({ commits });
  } catch (error) {
    return commitErrorResponse(error);
  }
}

import { type NextRequest } from 'next/server';

import { commitErrorResponse } from '@/lib/githubCommitServer';
import { rejectTokenlessRequestWhenLoginRequired } from '@/lib/githubEnvironment';
import { fetchPullCommitsListing } from '@/lib/githubPullDetailsServer';
import { createJSONResponse } from '@/lib/jsonResponse';
import { parseBearerToken } from '@/lib/parseBearerToken';

// The pull request's commit listing (oldest first), for the viewer's
// commit-range picker. Read-only; on github.com anonymous visitors can list
// public-repo pulls without a login.
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
    const commits = await fetchPullCommitsListing(
      { owner, repo },
      pull,
      parseBearerToken(request.headers.get('authorization'))
    );
    return createJSONResponse({ commits });
  } catch (error) {
    return commitErrorResponse(error);
  }
}

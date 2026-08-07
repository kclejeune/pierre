import { type NextRequest } from 'next/server';

import {
  rejectTokenlessRequestWhenLoginRequired,
  resolveRequestGitHubToken,
} from '@/lib/githubEnvironment';
import {
  loadRepoBrowserTree,
  repoBrowserErrorResponse,
} from '@/lib/githubRepoBrowserServer';
import { createJSONResponse } from '@/lib/jsonResponse';

// Lists a repository's file tree for the browse view: resolves the `ref`
// remainder (branch, tag, sha, or refs/pull/… plus an optional sub-path)
// against the repo and returns every blob path at the resolved commit.
export async function GET(request: NextRequest) {
  const rejection = rejectTokenlessRequestWhenLoginRequired(request);
  if (rejection != null) {
    return rejection;
  }

  const params = request.nextUrl.searchParams;
  const owner = params.get('owner');
  const repo = params.get('repo');
  const ref = params.get('ref') ?? '';
  if (owner == null || owner === '' || repo == null || repo === '') {
    return createJSONResponse(
      { error: 'owner and repo parameters are required.' },
      { status: 400 }
    );
  }

  try {
    return createJSONResponse(
      await loadRepoBrowserTree({ owner, repo }, ref, {
        token: resolveRequestGitHubToken(request),
      })
    );
  } catch (error) {
    return repoBrowserErrorResponse(error);
  }
}
